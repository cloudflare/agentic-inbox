import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { SenderStore } from "../server/senders";
import { createApi } from "../server/api";
import { sendReal, type MailSender } from "../server/outbound";
import { resolveSenderId } from "../shared/senders";
import { hashApiKey } from "../server/api-keys";

const schema = `senders_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db),
	senders = new SenderStore(db);
const info = "info@realadvisor.com",
	privacy = "privacy@realadvisor.com";
const infoBox = "info@ingest.realadvisor.com",
	privacyBox = "privacy@ingest.realadvisor.com",
	all = "all@ingest.realadvisor.com";
const api = createApi(db, { readAttachment: async () => null });
async function call(
	path: string,
	method = "GET",
	body?: unknown,
	key?: string,
) {
	return api.request(`http://127.0.0.1:4311/api/v1/${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			...(key ? { Authorization: `Bearer ${key}` } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	for (const [email, name] of [
		[infoBox, "Info"],
		[privacyBox, "Privacy"],
		[all, "All"],
	])
		await store.createMailbox(email, name);
	await senders.setDefault(info);
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});

async function parent(recipient = privacy) {
	const row = await store.insert(all, {
		sender: "customer@example.test",
		recipient,
		subject: "Privacy request",
		body: "Request",
	});
	assert.ok(row);
	return row;
}

test("Info default, explicit override, and recipient-aware All replies share precedence", async () => {
	const config = await senders.configuration();
	assert.deepEqual(
		config.senders.map((s) => s.email),
		[info, privacy],
	);
	assert.equal(resolveSenderId(config, { mailboxId: all }), info);
	assert.equal(
		resolveSenderId(config, {
			mailboxId: all,
			reply: { recipient: `Privacy <${privacy}>` },
		}),
		privacy,
	);
	assert.equal(
		resolveSenderId(config, {
			mailboxId: all,
			reply: { recipient: `${privacy},${info}` },
		}),
		null,
	);
	assert.equal(
		resolveSenderId(config, {
			mailboxId: all,
			explicit: info,
			draft: privacy,
			reply: { recipient: privacy },
		}),
		info,
	);
	const incoming = await parent();
	for (const [suffix, body, expected] of [
		["emails", { to: "customer@example.test", text: "New" }, info],
		[
			`emails/${incoming.id}/reply`,
			{ to: "customer@example.test", text: "Reply" },
			privacy,
		],
		[
			`emails/${incoming.id}/reply`,
			{
				to: "customer@example.test",
				text: "Override",
				sender_identity_id: info,
			},
			info,
		],
	] as const) {
		const response = await call(`mailboxes/${all}/${suffix}`, "POST", body);
		assert.equal(response.status, 201, await response.clone().text());
		const result = await response.json();
		assert.equal(result.sender_identity_id, expected);
		const saved = await store.message(all, result.id);
		assert.equal(saved.sender, expected);
		if (suffix.includes("reply")) {
			assert.equal(saved.thread_id, incoming.thread_id);
			assert.equal(saved.in_reply_to, incoming.message_id);
		}
	}
});

test("draft identity persists through default changes and sender-only edits are versioned", async () => {
	const incoming = await parent();
	const response = await call(`mailboxes/${all}/drafts`, "POST", {
		body: "Draft",
		draft_mode: "reply",
		draft_source_id: incoming.id,
	});
	assert.equal(response.status, 201, await response.clone().text());
	const draft = await response.json();
	assert.equal(draft.sender_identity_id, privacy);
	await senders.setDefault(privacy);
	await senders.setDefault(info);
	const update = await call(`mailboxes/${all}/drafts`, "POST", {
		draft_id: draft.draft_id,
		draft_version: draft.draft_version,
		body: "Draft",
	});
	assert.equal(update.status, 200);
	assert.equal((await update.json()).sender_identity_id, privacy);
	const changed = await call(`mailboxes/${all}/drafts`, "POST", {
		draft_id: draft.draft_id,
		draft_version: draft.draft_version,
		body: "Draft",
		sender_identity_id: info,
	});
	assert.equal(changed.status, 200);
	assert.notEqual((await changed.json()).draft_version, draft.draft_version);
	const stale = await call(`mailboxes/${all}/drafts`, "POST", {
		draft_id: draft.draft_id,
		draft_version: draft.draft_version,
		body: "Overwrite",
	});
	assert.equal(stale.status, 409);
	const sent = await call(
		`mailboxes/${all}/emails/${incoming.id}/reply`,
		"POST",
		{ draft_id: draft.draft_id, to: "customer@example.test", text: "Draft" },
	);
	assert.equal(sent.status, 201);
	assert.equal((await sent.json()).sender_identity_id, info);
});

test("invalid, inactive, ambiguous and unauthorized senders fail without sending", async () => {
	assert.equal(
		(
			await call(`mailboxes/${all}/emails`, "POST", {
				sender_identity_id: "spoof@example.test",
				to: "customer@example.test",
				text: "No",
			})
		).status,
		409,
	);
	const incoming = await parent(`${info},${privacy}`);
	assert.equal(
		(
			await call(`mailboxes/${all}/emails/${incoming.id}/reply`, "POST", {
				to: "customer@example.test",
				text: "No",
			})
		).status,
		409,
	);
	await db`UPDATE sender_identities SET active=false WHERE id=${privacy}`;
	try {
		assert.equal(
			(
				await call(`mailboxes/${all}/emails`, "POST", {
					sender_identity_id: privacy,
					to: "customer@example.test",
					text: "No",
				})
			).status,
			409,
		);
		assert.equal(
			(
				await call("inbox-settings", "PATCH", {
					default_sender_identity_id: privacy,
				})
			).status,
			409,
		);
	} finally {
		await db`UPDATE sender_identities SET active=true WHERE id=${privacy}`;
	}
	const key = "inbox_" + "ab".repeat(32);
	await db`INSERT INTO inbox_api_keys (name,prefix,token_hash,mailbox_ids,permissions,created_by) VALUES ('Restricted','inbox_ab',${await hashApiKey(key)},ARRAY[${all},${infoBox}],ARRAY['mail:send','drafts:manage','senders:manage'],'test')`;
	const available = await (
		await call("sender-identities", "GET", undefined, key)
	).json();
	assert.deepEqual(
		available.senders.map((s: { id: string }) => s.id),
		[info],
	);
	assert.equal(
		(
			await call(
				`mailboxes/${all}/emails`,
				"POST",
				{
					sender_identity_id: privacy,
					to: "customer@example.test",
					text: "No",
				},
				key,
			)
		).status,
		403,
	);
	assert.equal(
		(
			await call(
				`mailboxes/${all}/drafts`,
				"POST",
				{ sender_identity_id: privacy, body: "No" },
				key,
			)
		).status,
		403,
	);
	assert.equal(
		(
			await call(
				"inbox-settings",
				"PATCH",
				{ default_sender_identity_id: privacy },
				key,
			)
		).status,
		403,
	);
	assert.equal(
		(
			await call(
				"inbox-settings",
				"PATCH",
				{ default_sender_identity_id: info },
				key,
			)
		).status,
		200,
	);
	const member = createApi(db, {
		mode: "live",
		membershipEnabled: true,
		actorRole: "user",
		actor: "member@realadvisor.com",
		readAttachment: async () => null,
	});
	assert.equal(
		(
			await member.request("http://127.0.0.1:4311/api/v1/inbox-settings", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ default_sender_identity_id: privacy }),
			})
		).status,
		403,
	);
});

test("live send uses selected From and Reply-To, preserves threading and retry identity", async () => {
	const incoming = await parent();
	const delivered: Parameters<MailSender["send"]>[0][] = [];
	const provider: MailSender = {
		send: async (mail) => {
			delivered.push(mail);
			return { messageId: `<${crypto.randomUUID()}@test>` };
		},
	};
	const requestId = crypto.randomUUID();
	const input = {
		to: "customer@example.test",
		subject: "Re: Privacy request",
		text: "Reply",
	};
	const first = await sendReal(
		db,
		provider,
		all,
		requestId,
		input,
		"test",
		incoming.id,
		true,
	);
	assert.equal(first.sender_identity_id, privacy);
	assert.equal(delivered[0].from, privacy);
	assert.equal(delivered[0].replyTo, privacy);
	assert.equal(delivered[0].headers?.["In-Reply-To"], incoming.message_id);
	assert.equal(
		(await store.message(all, first.id)).thread_id,
		incoming.thread_id,
	);
	await senders.setDefault(privacy);
	const newId = crypto.randomUUID();
	const newSend = await sendReal(db, provider, all, newId, input, "test");
	await senders.setDefault(info);
	const retry = await sendReal(db, provider, all, newId, input, "test");
	assert.deepEqual(retry, newSend);
	assert.equal(retry.sender_identity_id, privacy);
	assert.equal(delivered.length, 2);
	await assert.rejects(
		sendReal(
			db,
			provider,
			all,
			newId,
			{ ...input, sender_identity_id: info },
			"test",
		),
		/different content/,
	);
	await assert.rejects(
		sendReal(
			db,
			provider,
			all,
			crypto.randomUUID(),
			{ ...input, sender_identity_id: privacy },
			"test",
			undefined,
			false,
			{ mailboxIds: [all, infoBox] },
		),
		/does not permit/,
	);
	assert.equal(delivered.length, 2);
});

test("upgrade registers Info and Privacy, picks Info, and backfills existing drafts", async () => {
	const upgradeSchema = `${schema}_upgrade`;
	await admin`CREATE SCHEMA ${admin(upgradeSchema)}`;
	const legacy = connect(process.env.DATABASE_URL, upgradeSchema);
	try {
		const { readFile } = await import("node:fs/promises");
		await legacy.unsafe(
			await readFile(
				new URL("../migrations/001_inbox.sql", import.meta.url),
				"utf8",
			),
		);
		await legacy`CREATE TABLE inbox_api_keys(permissions text[] CONSTRAINT inbox_api_keys_permissions_check CHECK(cardinality(permissions)>0))`;
		for (const mailbox of [infoBox, privacyBox, all]) {
			await legacy`INSERT INTO mailboxes(id,email,name) VALUES (${mailbox},${mailbox},${mailbox})`;
			await legacy`INSERT INTO folders(mailbox_id,id,name) VALUES (${mailbox},'draft','Drafts')`;
		}
		const draft = crypto.randomUUID();
		await legacy`INSERT INTO emails(id,mailbox_id,folder_id,sender,recipient,thread_id,message_id,delivery_status) VALUES (${draft},${all},'draft',${privacy},'customer@example.test',${draft},'<old-draft@test>','draft')`;
		await legacy.unsafe(
			await readFile(
				new URL("../migrations/042_sender_identities.sql", import.meta.url),
				"utf8",
			),
		);
		await legacy.unsafe(
			await readFile(
				new URL("../migrations/043_sender_management.sql", import.meta.url),
				"utf8",
			),
		);
		const config = await new SenderStore(legacy).configuration();
		assert.equal(config.default_sender_identity_id, info);
		assert.deepEqual(
			config.senders.map((s) => s.email),
			[info, privacy],
		);
		assert.equal(
			(await legacy`SELECT sender_identity_id FROM emails WHERE id=${draft}`)[0]
				.sender_identity_id,
			privacy,
		);
		await legacy`DELETE FROM mailboxes WHERE id=${privacyBox}`;
		await assert.rejects(
			new SenderStore(legacy).resolve({ explicit: privacy, mailboxId: all }),
			/unavailable/,
		);
	} finally {
		await legacy.end();
		await admin`DROP SCHEMA ${admin(upgradeSchema)} CASCADE`;
	}
});

test("unmatched recipients use Info even inside the Privacy mailbox", async () => {
	const config = await senders.configuration();
	for (const mailboxId of [all, privacyBox])
		assert.equal(
			resolveSenderId(config, {
				mailboxId,
				reply: { recipient: "unknown@realadvisor.com" },
			}),
			info,
		);
	const incoming = await store.insert(privacyBox, {
		sender: "customer@example.test",
		recipient: "unknown@realadvisor.com",
		subject: "Unmatched",
		body: "Hello",
	});
	const response = await call(
		`mailboxes/${privacyBox}/emails/${incoming!.id}/reply`,
		"POST",
		{ to: "customer@example.test", text: "Reply" },
	);
	assert.equal(response.status, 201, await response.clone().text());
	assert.equal((await response.json()).sender_identity_id, info);
});

test("sender CRUD validates duplicates, permissions, live addresses, and preserves history", async () => {
	const input = {
		name: "Support",
		email: "support@realadvisor.com",
		mailbox_id: infoBox,
	};
	const created = await call("sender-identities", "POST", input);
	assert.equal(created.status, 201, await created.clone().text());
	const sender = await created.json();
	assert.equal(
		resolveSenderId(await senders.configuration(), {
			mailboxId: all,
			reply: { recipient: info },
		}),
		info,
	);
	assert.equal(
		resolveSenderId(await senders.configuration(), {
			mailboxId: all,
			reply: { recipient: input.email },
		}),
		sender.id,
	);
	assert.equal(
		(
			await call("sender-identities", "POST", {
				...input,
				email: "SUPPORT@realadvisor.com",
			})
		).status,
		409,
	);
	assert.equal(
		(
			await call(`sender-identities/${sender.id}`, "PUT", {
				...input,
				name: "Customer support",
			})
		).status,
		200,
	);
	const draft = await call(`mailboxes/${all}/drafts`, "POST", {
		body: "Draft",
		sender_identity_id: sender.id,
	});
	assert.equal(draft.status, 201);
	const draftId = (await draft.json()).draft_id;
	const key = "inbox_" + "cd".repeat(32);
	await db`INSERT INTO inbox_api_keys (name,prefix,token_hash,mailbox_ids,permissions,created_by) VALUES ('Sender management','inbox_cd',${await hashApiKey(key)},ARRAY[${privacyBox}],ARRAY['senders:manage'],'test')`;
	assert.equal(
		(
			await call(
				"sender-identities",
				"POST",
				{ ...input, email: "other@realadvisor.com" },
				key,
			)
		).status,
		403,
	);
	assert.equal(
		(
			await call(
				`sender-identities/${sender.id}`,
				"PUT",
				{ ...input, mailbox_id: privacyBox },
				key,
			)
		).status,
		403,
	);
	assert.equal(
		(await call(`sender-identities/${sender.id}`, "DELETE", undefined, key))
			.status,
		403,
	);
	assert.equal((await call(`sender-identities/${info}`, "DELETE")).status, 409);
	const member = createApi(db, {
		mode: "live",
		membershipEnabled: true,
		actorRole: "user",
		actor: "member@realadvisor.com",
		readAttachment: async () => null,
	});
	for (const [method, path, body] of [
		["POST", "sender-identities", input],
		["PUT", `sender-identities/${sender.id}`, input],
		["DELETE", `sender-identities/${sender.id}`, undefined],
	] as const) {
		assert.equal(
			(
				await member.request(`http://127.0.0.1/api/v1/${path}`, {
					method,
					headers: { "Content-Type": "application/json" },
					body: body ? JSON.stringify(body) : undefined,
				})
			).status,
			403,
		);
	}
	await assert.rejects(
		senders.save({ ...input, email: "spoof@external.test" }, { live: true }),
		/approved public address/,
	);
	assert.equal(
		(await call(`sender-identities/${sender.id}`, "DELETE")).status,
		204,
	);
	assert.ok(
		!(await senders.configuration()).senders.some((s) => s.id === sender.id),
	);
	assert.equal(
		(await store.message(all, draftId)).sender_identity_id,
		sender.id,
	);
	await assert.rejects(
		senders.resolve({ mailboxId: all, draft: sender.id }),
		/unavailable/,
	);
	const recreated = await call("sender-identities", "POST", input);
	assert.equal(recreated.status, 201);
	await senders.remove((await recreated.json()).id);
});

test("an API key can be granted senders outside its mailboxes and its own default", async () => {
	await senders.setDefault(info);
	const admin = (path: string, method = "GET", body?: unknown) =>
		call(`api-keys${path}`, method, body);
	const base = {
		name: "Mako",
		mailbox_ids: [all],
		permissions: ["mail:send", "drafts:manage", "mail:read"],
	};
	// The default must be usable by the key, and granted senders must exist.
	assert.equal(
		(await admin("", "POST", { ...base, default_sender_identity_id: privacy }))
			.status,
		400,
	);
	assert.equal(
		(await admin("", "POST", { ...base, sender_identity_ids: ["missing"] }))
			.status,
		400,
	);
	const created = await admin("", "POST", base);
	assert.equal(created.status, 201);
	const { id, key } = await created.json();
	const visible = async () =>
		(await call("sender-identities", "GET", undefined, key)).json();
	assert.deepEqual(await visible(), {
		senders: [],
		default_sender_identity_id: null,
	});
	const draft = (body: Record<string, unknown> = {}) =>
		call(`mailboxes/${all}/drafts`, "POST", { body: "Hello", ...body }, key);
	assert.equal((await draft({ sender_identity_id: privacy })).status, 403);

	const granted = await admin(`/${id}`, "PATCH", {
		sender_identity_ids: [privacy],
		default_sender_identity_id: privacy,
	});
	assert.equal(granted.status, 200, await granted.clone().text());
	const config = await visible();
	assert.deepEqual(
		config.senders.map((s: { id: string }) => s.id),
		[privacy],
	);
	assert.equal(config.default_sender_identity_id, privacy);
	const scope = await (await call("config", "GET", undefined, key)).json();
	assert.deepEqual(scope.sender_identity_ids, [privacy]);
	assert.equal(scope.default_sender_identity_id, privacy);
	const listed = (await (await admin("")).json()).find(
		(k: { id: string }) => k.id === id,
	);
	assert.deepEqual(listed.sender_identity_ids, [privacy]);
	assert.equal(listed.default_sender_identity_id, privacy);

	// The key default replaces the workspace default (info); others stay denied.
	const saved = await draft();
	assert.equal(saved.status, 201, await saved.clone().text());
	const [row] =
		await db`SELECT sender_identity_id FROM emails WHERE id=${(await saved.json()).draft_id}`;
	assert.equal(row.sender_identity_id, privacy);
	assert.equal((await draft({ sender_identity_id: info })).status, 403);
	const provider: MailSender = {
		send: async () => ({ messageId: `<${crypto.randomUUID()}@test>` }),
	};
	const sent = await sendReal(
		db,
		provider,
		all,
		crypto.randomUUID(),
		{ to: "customer@example.test", subject: "Hi", text: "Hi" },
		"test",
		undefined,
		false,
		{ mailboxIds: [all], senderIds: [privacy], defaultSenderId: privacy },
	);
	assert.equal(sent.sender_identity_id, privacy);

	// Sender access cannot be edited by keys, widened past validation, or on revoked keys.
	assert.equal(
		(
			await call(
				`api-keys/${id}`,
				"PATCH",
				{ sender_identity_ids: [info] },
				key,
			)
		).status,
		403,
	);
	assert.equal(
		(await admin(`/${id}`, "PATCH", { mailbox_ids: [infoBox] })).status,
		400,
	);
	assert.equal(
		(
			await admin(`/${id}`, "PATCH", {
				sender_identity_ids: [privacy],
				default_sender_identity_id: info,
			})
		).status,
		400,
	);
	// Removing the grant keeps an unavailable default from silently falling back.
	await db`UPDATE inbox_api_keys SET sender_identity_ids='{}' WHERE id=${id}`;
	assert.equal((await visible()).default_sender_identity_id, null);
	assert.equal((await draft()).status, 403);
	assert.equal(
		(
			await admin(`/${id}`, "PATCH", {
				sender_identity_ids: [],
				default_sender_identity_id: null,
			})
		).status,
		200,
	);
	assert.equal((await draft()).status, 403); // workspace default info is outside the key
	assert.equal((await admin(`/${id}`, "DELETE")).status, 204);
	assert.equal(
		(
			await admin(`/${id}`, "PATCH", {
				sender_identity_ids: [privacy],
				default_sender_identity_id: null,
			})
		).status,
		404,
	);
});
