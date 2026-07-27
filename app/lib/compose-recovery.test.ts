import assert from "node:assert/strict";
import test from "node:test";
import {
	clearComposeRecovery,
	composeRecoveryLifecycleForRender,
	hasComposeRecovery,
	peekComposeRecovery,
	readComposeRecovery,
	restoredComposeLifecycle,
	writeComposeRecovery,
} from "./compose-recovery.ts";

test("the in-memory guard restores debounce-window content only to its origin mailbox", () => {
	clearComposeRecovery();
	writeComposeRecovery({
		mailboxId: "team-a@example.com",
		to: "person@example.com",
		cc: "",
		bcc: "",
		subject: "Recovered",
		body: "<p>Latest local edit</p>",
		identity: { id: "draft-1", version: 4 },
		createKey: "draft-create-1",
		attachments: [],
		lifecycle: {
			localRevision: 5,
			savedRevision: 4,
			phase: "failed",
			activeSave: null,
			error: "Network unavailable",
		},
	});

	assert.equal(hasComposeRecovery(), true);
	assert.equal(readComposeRecovery("team-b@example.com"), null);
	assert.equal(
		readComposeRecovery("team-a@example.com")?.body,
		"<p>Latest local edit</p>",
	);
	clearComposeRecovery();
	assert.equal(hasComposeRecovery(), false);
});

test("recovered new and persisted drafts remain unconfirmed until a save succeeds", () => {
	for (const input of [
		{
			localRevision: 1,
			savedRevision: 0,
			phase: "pending" as const,
			activeSave: null,
			error: null,
		},
		{
			localRevision: 8,
			savedRevision: 7,
			phase: "failed" as const,
			activeSave: null,
			error: "Save failed",
		},
		{
			localRevision: 4,
			savedRevision: 3,
			phase: "saving" as const,
			activeSave: { token: 2, revision: 4 },
			error: null,
		},
	]) {
		const restored = restoredComposeLifecycle(input);
		assert.notEqual(restored.localRevision, restored.savedRevision);
		assert.equal(restored.activeSave, null);
		assert.equal(restored.phase, input.phase === "failed" ? "failed" : "pending");
	}
});

test("a render carrying newer fields is snapshotted dirty before effects can run", () => {
	assert.deepEqual(
		composeRecoveryLifecycleForRender(
			{
				localRevision: 4,
				savedRevision: 4,
				phase: "saved",
				activeSave: null,
				error: null,
			},
			true,
		),
		{
			localRevision: 5,
			savedRevision: 4,
			phase: "pending",
			activeSave: null,
			error: null,
		},
	);
});

test("runtime retry can discover and pin the recovery origin before reading route state", () => {
	clearComposeRecovery();
	writeComposeRecovery({
		mailboxId: "origin@example.com",
		to: "person@example.com",
		cc: "",
		bcc: "",
		subject: "Origin scoped",
		body: "<p>Keep me</p>",
		identity: { id: "origin-draft", version: 3 },
		createKey: "origin-create-key",
		attachments: [],
		lifecycle: {
			localRevision: 3,
			savedRevision: 2,
			phase: "pending",
			activeSave: null,
			error: null,
		},
	});

	assert.equal(readComposeRecovery("current-route@example.com"), null);
	assert.equal(peekComposeRecovery()?.mailboxId, "origin@example.com");
	assert.equal(peekComposeRecovery()?.identity?.id, "origin-draft");
	clearComposeRecovery();
});

test("a cleared persisted draft is still work in progress, not an empty composer", () => {
	// The reader deleted the last of a saved draft's content; the 1.2s autosave
	// debounce has not fired yet. Judging emptiness by content alone let the next
	// startCompose replace the composer and lose the deletion outright.
	clearComposeRecovery();
	writeComposeRecovery({
		mailboxId: "team-a@example.com",
		to: "",
		cc: "",
		bcc: "",
		subject: "",
		body: "",
		identity: { id: "draft-1", version: 4 },
		createKey: "draft-create-1",
		attachments: [],
		lifecycle: {
			localRevision: 5,
			savedRevision: 4,
			phase: "pending",
			activeSave: null,
			error: null,
		},
	});
	assert.equal(hasComposeRecovery(), true);
	clearComposeRecovery();
});

test("an untouched composer never parks the next compose request", () => {
	// A pristine composer starts saved with matching revisions, so opening one
	// and immediately hitting Reply must not raise a discard prompt.
	clearComposeRecovery();
	writeComposeRecovery({
		mailboxId: "team-a@example.com",
		to: "",
		cc: "",
		bcc: "",
		subject: "",
		body: "",
		identity: null,
		createKey: "draft-create-2",
		attachments: [],
		lifecycle: {
			localRevision: 0,
			savedRevision: 0,
			phase: "saved",
			activeSave: null,
			error: null,
		},
	});
	assert.equal(hasComposeRecovery(), false);
	clearComposeRecovery();
});
