import assert from "node:assert/strict";
import test from "node:test";
import { buildInitialComposeFields } from "./compose-initialization.ts";

const original = {
	id: "message-1",
	folder_id: "inbox",
	message_id: "<message-1@example.com>",
	thread_id: "thread-1",
	sender: "Sender <sender@example.com>",
	recipient: "team@example.com, colleague@example.com",
	cc: "copy@example.com",
	bcc: null,
	subject: "Quarterly <update>",
	body: "<p>Hello <strong>team</strong></p>",
	date: "2026-07-11T09:00:00.000Z",
	read: false,
	starred: false,
	attachments: [],
};

test("draft content remains authoritative over signatures and mode defaults", () => {
	const fields = buildInitialComposeFields({
		composeOptions: {
			mode: "new",
			draftEmail: {
				...original,
				recipient: "draft@example.com",
				cc: "copy@example.com",
				bcc: "blind@example.com",
				subject: "Existing draft",
				body: "<p>Exact draft body</p>",
			},
		},
		signature: { enabled: true, text: "Should not be inserted" },
	});

	assert.deepEqual(fields, {
		to: "draft@example.com",
		cc: "copy@example.com",
		bcc: "blind@example.com",
		showCcBcc: true,
		subject: "Existing draft",
		body: "<p>Exact draft body</p>",
	});
});

test("a People compose action seeds only the observed address", () => {
	const fields = buildInitialComposeFields({
		composeOptions: {
			mode: "new",
			initialTo: "contact@example.com",
		},
		signature: { enabled: true, text: "Team" },
	});

	assert.equal(fields.to, "contact@example.com");
	assert.equal(fields.subject, "");
	assert.match(fields.body, /data-mail-signature="v1"/);
});

test("draft and reply modes never accept a People recipient seed", () => {
	const draft = buildInitialComposeFields({
		composeOptions: {
			mode: "new",
			initialTo: "people@example.com",
			draftEmail: { ...original, recipient: "draft@example.com" },
		},
	});
	const incompleteReply = buildInitialComposeFields({
		composeOptions: {
			mode: "reply",
			initialTo: "people@example.com",
		},
	});

	assert.equal(draft.to, "draft@example.com");
	assert.equal(incompleteReply.to, "");
});

test("reply-all excludes the mailbox and inserts one marked signature", () => {
	const fields = buildInitialComposeFields({
		composeOptions: { mode: "reply-all", originalEmail: original },
		mailboxEmail: "team@example.com",
		signature: { enabled: true, text: "Team\nSupport" },
	});

	assert.equal(fields.to, "Sender <sender@example.com>, colleague@example.com");
	assert.equal(fields.cc, "copy@example.com");
	assert.equal(fields.subject, "Re: Quarterly <update>");
	assert.match(fields.body, /data-mail-signature="v1"/);
	assert.equal(fields.body.match(/data-mail-signature="v1"/g)?.length, 1);
});

test("forward escapes original metadata and keeps the signature before the forwarded tail", () => {
	const fields = buildInitialComposeFields({
		composeOptions: { mode: "forward", originalEmail: original },
		signature: { enabled: true, text: "Regards" },
	});

	assert.equal(fields.subject, "Fwd: Quarterly <update>");
	assert.ok(fields.body.indexOf('data-mail-signature="v1"') < fields.body.indexOf('data-mail-forwarded-message="v1"'));
	assert.match(fields.body, /Quarterly &lt;update&gt;/);
	assert.doesNotMatch(fields.body, /<strong>team<\/strong>/);
});

test("a reply quotes nothing: the thread above the composer already holds it", () => {
	const fields = buildInitialComposeFields({
		composeOptions: { mode: "reply", originalEmail: original },
	});

	assert.equal(fields.body, "");
	assert.doesNotMatch(fields.body, /blockquote/);
	assert.doesNotMatch(fields.body, /data-mail-quoted-reply/);
	assert.doesNotMatch(fields.body, /wrote:/);
	// Recipient and subject are still derived from the original.
	assert.equal(fields.to, "Sender <sender@example.com>");
	assert.equal(fields.subject, "Re: Quarterly <update>");
});

test("reply-all quotes nothing either and keeps every other recipient", () => {
	const fields = buildInitialComposeFields({
		composeOptions: { mode: "reply-all", originalEmail: original },
		mailboxEmail: "team@example.com",
	});

	assert.doesNotMatch(fields.body, /data-mail-quoted-reply/);
	assert.equal(fields.to, "Sender <sender@example.com>, colleague@example.com");
	assert.equal(fields.cc, "copy@example.com");
});

test("a reply seeds the same clean writing space as a new mail", () => {
	for (const mode of ["new", "reply", "reply-all"] as const) {
		const fields = buildInitialComposeFields({
			composeOptions: { mode, originalEmail: original },
			signature: { enabled: true, text: "Hesham" },
		});
		assert.equal(
			fields.body,
			'<p><br></p><div data-mail-signature="v1">Hesham</div>',
			`${mode} must open on an empty paragraph above the signature`,
		);
	}
});

test("an original with no body still yields an empty reply", () => {
	const fields = buildInitialComposeFields({
		composeOptions: { mode: "reply", originalEmail: { ...original, body: "" } },
	});

	assert.equal(fields.body, "");
});

test("reply and forward prefixes are absorbed instead of stacked", () => {
	const subjectOf = (subject: string, mode: "reply" | "forward") =>
		buildInitialComposeFields({
			composeOptions: { mode, originalEmail: { ...original, subject } },
		}).subject;

	assert.equal(subjectOf("Re: Budget", "reply"), "Re: Budget");
	assert.equal(subjectOf("Re:Budget", "reply"), "Re: Budget");
	assert.equal(subjectOf("RE:  Budget", "reply"), "Re: Budget");
	assert.equal(subjectOf("Re: Re: Budget", "reply"), "Re: Budget");
	assert.equal(subjectOf("Budget", "reply"), "Re: Budget");
	assert.equal(subjectOf("Fwd: Budget", "forward"), "Fwd: Budget");
	assert.equal(subjectOf("FW: Budget", "forward"), "Fwd: Budget");
	assert.equal(subjectOf("Budget", "forward"), "Fwd: Budget");
});
