import assert from "node:assert/strict";
import test from "node:test";
import { formatSenderLabel } from "./mail-participants.ts";

test("thread participant names win over raw addresses", () => {
	assert.equal(
		formatSenderLabel({
			participant_names: "Ada Lovelace,Grace Hopper",
			participants: "ada@x.com,grace@x.com",
			sender: "ada@x.com",
		}).text,
		"Ada Lovelace, Grace Hopper",
	);
});

test("a crowded thread keeps two names and counts the rest", () => {
	assert.equal(
		formatSenderLabel({
			participant_names: "Ada,Grace,Alan,Edsger",
			sender: "ada@x.com",
		}).text,
		"Ada, Grace +2",
	);
});

test("repeated participants collapse to one label", () => {
	assert.equal(
		formatSenderLabel({ participant_names: "Ada,Ada,Ada", sender: "ada@x.com" })
			.text,
		"Ada",
	);
});

test("addresses become readable words instead of truncated local parts", () => {
	assert.equal(formatSenderLabel({ sender: "invoices@stripe.com" }).text, "Invoices");
	assert.equal(formatSenderLabel({ sender: "j_smith@x.com" }).text, "J Smith");
	assert.equal(formatSenderLabel({ sender: "billing.team@x.com" }).text, "Billing Team");
});

test("machine mailboxes surface the sending organisation, not 'no-reply'", () => {
	assert.equal(formatSenderLabel({ sender: "no-reply@github.com" }).text, "Github");
	assert.equal(formatSenderLabel({ sender: "notifications@mail.notion.so" }).text, "Notion");
	assert.equal(
		formatSenderLabel({ sender: "Acme Billing <no-reply@acme.com>" }).text,
		"Acme",
	);
});

test("a display name is used verbatim and quotes are stripped", () => {
	assert.equal(
		formatSenderLabel({ sender_name: '"Acme Support"', sender: "no-reply@acme.com" })
			.text,
		"Acme Support",
	);
	assert.equal(
		formatSenderLabel({ sender_name: "Hesham Mohamed", sender: "h@x.com" }).text,
		"Hesham Mohamed",
	);
});

test("a very long sender still exposes the full value for recovery", () => {
	const long = `${"Bartholomew".repeat(12)}@example.com`;
	const label = formatSenderLabel({ sender: long });
	assert.equal(label.title, long);
	assert.ok(label.text.length > 0);
});

test("rows without any sender information never render blank", () => {
	assert.equal(formatSenderLabel({ sender: "" }).text, "Unknown sender");
	assert.equal(formatSenderLabel({}).text, "Unknown sender");
	assert.equal(
		formatSenderLabel({ participant_names: "  ,  ", sender: "a@b.com" }).text,
		"A",
	);
});
