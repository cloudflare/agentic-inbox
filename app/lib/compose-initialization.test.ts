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

test("a reply quotes the message it answers, with the caret above the quote", () => {
	const fields = buildInitialComposeFields({
		composeOptions: { mode: "reply", originalEmail: original },
	});

	assert.match(fields.body, /^<p><br><\/p><blockquote /);
	assert.match(fields.body, /data-mail-quoted-reply="v1"/);
	assert.match(fields.body, /On .*, Sender &lt;sender@example\.com&gt; wrote:/);
	// The original crosses into the editor as escaped plain text, never markup.
	assert.match(fields.body, /Hello team/);
	assert.doesNotMatch(fields.body, /<strong>/);
});

test("reply-all quotes the same original and keeps every other recipient", () => {
	const fields = buildInitialComposeFields({
		composeOptions: { mode: "reply-all", originalEmail: original },
		mailboxEmail: "team@example.com",
	});

	assert.match(fields.body, /data-mail-quoted-reply="v1"/);
	assert.equal(fields.to, "Sender <sender@example.com>, colleague@example.com");
	assert.equal(fields.cc, "copy@example.com");
});

test("a signature sits between the reply and the quote, never below it", () => {
	const fields = buildInitialComposeFields({
		composeOptions: { mode: "reply", originalEmail: original },
		signature: { enabled: true, text: "Hesham" },
	});

	assert.ok(
		fields.body.indexOf("data-mail-signature") <
			fields.body.indexOf("data-mail-quoted-reply"),
		"the signature must be written above the quoted original",
	);
});

test("an original with no body yields a reply with nothing to quote", () => {
	const fields = buildInitialComposeFields({
		composeOptions: { mode: "reply", originalEmail: { ...original, body: "" } },
	});

	assert.equal(fields.body, "<p><br></p>");
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
