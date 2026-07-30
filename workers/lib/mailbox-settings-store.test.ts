import assert from "node:assert/strict";
import test from "node:test";
import {
	MailboxSettingsConflictError,
	mailboxSettingsInForce,
	mergeGeneralMailboxSettings,
	mergeSignatureMailboxSettings,
	updateMailboxSettings,
	type MailboxSettingsBucket,
} from "./mailbox-settings-store.ts";
import {
	SUPERSEDED_SYSTEM_PROMPTS,
	WHISPYR_SYSTEM_PROMPT,
	WISER_SYSTEM_PROMPT,
} from "./prompts.ts";

function racingBucket(
	concurrentUpdate: (settings: Record<string, unknown>) => Record<string, unknown> =
		(settings) => ({ ...settings, fromName: "Concurrent admin" }),
) {
	let etag = "v1";
	let settings: Record<string, unknown> = {
		fromName: "Original",
		signature: { enabled: false, text: "Old" },
		forwarding: { enabled: true },
	};
	let conflictInjected = false;
	const bucket: MailboxSettingsBucket = {
		async get() {
			const snapshot = structuredClone(settings);
			return { etag, json: async () => snapshot };
		},
		async put(_key, value, options) {
			if (!conflictInjected) {
				conflictInjected = true;
				settings = concurrentUpdate(settings);
				etag = "v2";
			}
			if (options.onlyIf.etagMatches !== etag) return null;
			settings = JSON.parse(value);
			etag = "v3";
			return { etag };
		},
	};
	return { bucket, read: () => settings };
}

test("signature CAS retries against the latest ETag without erasing a concurrent unrelated update", async () => {
	const fixture = racingBucket();

	await updateMailboxSettings(
		fixture.bucket,
		"team@example.com",
		(current) => mergeSignatureMailboxSettings(current, { enabled: true, text: "New" }),
	);

	assert.deepEqual(fixture.read(), {
		fromName: "Concurrent admin",
		signature: { enabled: true, text: "New" },
		forwarding: { enabled: true },
	});
});

test("settings CAS stops after the bounded retry budget with a stable conflict", async () => {
	let writes = 0;
	const bucket: MailboxSettingsBucket = {
		async get() {
			return { etag: `v${writes}`, json: async () => ({ fromName: "Team" }) };
		},
		async put() {
			writes++;
			return null;
		},
	};

	await assert.rejects(
		updateMailboxSettings(bucket, "team@example.com", (settings) => settings),
		(error: unknown) =>
			error instanceof MailboxSettingsConflictError &&
			error.message === "Mailbox settings changed concurrently. Please retry.",
	);
	assert.equal(writes, 4);
});

test("general settings CAS preserves the latest signature and unrelated fields", async () => {
	const fixture = racingBucket((settings) => ({
		...settings,
		signature: { enabled: true, text: "Concurrent signature" },
	}));

	await updateMailboxSettings(
		fixture.bucket,
		"team@example.com",
		(current) => mergeGeneralMailboxSettings(current, {
			fromName: "Updated display name",
			signature: { enabled: false, text: "Stale form snapshot" },
		}),
	);

	assert.deepEqual(fixture.read(), {
		fromName: "Updated display name",
		signature: { enabled: true, text: "Concurrent signature" },
		forwarding: { enabled: true },
	});
});

test("served settings show the prompt in force, so the form can't display a superseded default", () => {
	const served = mailboxSettingsInForce(
		{
			fromName: "Wiser team",
			forwarding: { enabled: false, email: "" },
			agentSystemPrompt: SUPERSEDED_SYSTEM_PROMPTS.wiser[0],
		},
		"wiser",
	);

	assert.deepEqual(served, {
		fromName: "Wiser team",
		forwarding: { enabled: false, email: "" },
		agentSystemPrompt: WISER_SYSTEM_PROMPT,
	});
});

test("served settings never rewrite a prompt the user wrote", () => {
	const stored = {
		fromName: "Wiser team",
		agentSystemPrompt: "  Always answer in Arabic and cc Omar.\n",
	};

	assert.deepEqual(mailboxSettingsInForce(stored, "wiser"), stored);
	assert.deepEqual(
		mailboxSettingsInForce(
			{ agentSystemPrompt: WHISPYR_SYSTEM_PROMPT },
			"whispyr",
		),
		{ agentSystemPrompt: WHISPYR_SYSTEM_PROMPT },
	);
});

test("served settings leave an unset prompt unset, so the form keeps its placeholder", () => {
	assert.deepEqual(mailboxSettingsInForce({ fromName: "Wiser team" }, "wiser"), {
		fromName: "Wiser team",
	});
	assert.deepEqual(
		mailboxSettingsInForce({ fromName: "Wiser team", agentSystemPrompt: "" }, "wiser"),
		{ fromName: "Wiser team", agentSystemPrompt: "" },
	);
});
