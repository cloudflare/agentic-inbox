import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mailboxMigrations } from "../durableObject/migrations.ts";
import { applySqliteMigrations } from "../testing/sqlite-migrations.test.ts";
import { buildMailSearchPlan } from "./mail-search.ts";
import { SearchQueryError } from "../../shared/mail-search.ts";

// The real migrated mailbox schema, like list-projection.test.ts: a hand-rolled
// stand-in silently drifts from it, and a projection can then select a column
// that does not exist in production without a single test noticing.
const EMAIL_COLUMNS =
	"id, folder_id, subject, sender, recipient, cc, bcc, date, read, starred, " +
	"body, in_reply_to, email_references, thread_id, snooze_source_folder_id, snoozed_until";

function database() {
	const db = new DatabaseSync(":memory:");
	applySqliteMigrations(db, mailboxMigrations);
	db.exec(
		`INSERT OR REPLACE INTO folders (id, name) VALUES ('inbox', 'Inbox'), ('archive', 'Archive'),
			('_cancelled_outbound', 'Retired');`,
	);
	return db;
}

function run(db: DatabaseSync, input: Parameters<typeof buildMailSearchPlan>[0]) {
	const plan = buildMailSearchPlan(input);
	return {
		rows: db.prepare(plan.dataSql).all(...plan.dataParams) as Array<Record<string, unknown>>,
		count: db.prepare(plan.countSql).get(...plan.countParams) as { total: number },
	};
}

test("mail search ANDs free-text terms across mail fields and attachment filenames", () => {
	const db = database();
	db.exec(`
		INSERT INTO emails (${EMAIL_COLUMNS}) VALUES
			('both', 'inbox', 'Renewal ready', 'alice@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-10T10:00:00.000Z', 0, 0, 'Please review the final package', NULL, NULL, 't1', NULL, NULL),
			('one', 'inbox', 'Renewal only', 'bob@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-11T10:00:00.000Z', 0, 0, 'No file here', NULL, NULL, 't2', NULL, NULL);
		INSERT INTO attachments (id, email_id, filename, mimetype, size)
			VALUES ('a1', 'both', 'signed-proposal.pdf', 'application/pdf', 1024);
		INSERT INTO email_body_objects (id, email_id, part_index, content_type, charset, r2_key, byte_length)
			VALUES ('body-both', 'both', 0, 'text/html', 'utf-8', 'email-bodies/both/0.body', 31);
	`);

	const result = run(db, { terms: ["renewal", "proposal"], page: 1, limit: 25 });
	assert.deepEqual(result.rows.map((row) => row.id), ["both"]);
	assert.equal(result.count.total, 1);
	assert.equal(result.rows[0]?.matched_attachment_filename, "signed-proposal.pdf");
	assert.equal(Number(result.rows[0]?.body_external), 1);
	assert.ok(Number(result.rows[0]?.relevance) > 0);
	assert.match(String(result.rows[0]?.snippet), /final package/);
	db.close();
});

test("filename filters return matching mail and an executable total count", () => {
	const db = database();
	db.exec(`
		INSERT INTO emails (${EMAIL_COLUMNS}) VALUES
			('matching', 'inbox', 'Terms', 'alice@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-10T10:00:00.000Z', 0, 0, 'Please review', NULL, NULL, 't1', NULL, NULL),
			('other', 'inbox', 'Notes', 'bob@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-11T10:00:00.000Z', 0, 0, 'Unrelated', NULL, NULL, 't2', NULL, NULL);
		INSERT INTO attachments (id, email_id, filename, mimetype, size) VALUES
			('a1', 'matching', 'signed-terms.pdf', 'application/pdf', 2048),
			('a2', 'other', 'meeting-notes.txt', 'text/plain', 64);
	`);

	const result = run(db, { filename: ["terms.pdf"] });
	assert.deepEqual(result.rows.map((row) => row.id), ["matching"]);
	assert.equal(result.count.total, 1);
	db.close();
});

test("ordinary search executes the complete public 32-token query limit", () => {
	const db = database();
	const terms = Array.from({ length: 32 }, (_, index) => `term${index + 1}`);
	const insert = db.prepare(`INSERT INTO emails (${EMAIL_COLUMNS}) VALUES
		('all-terms', 'inbox', 'Complete query', 'alice@example.com', 'team@example.com', NULL, NULL,
		 '2026-07-10T10:00:00.000Z', 0, 0, ?, NULL, NULL, 't1', NULL, NULL)`);
	insert.run(terms.join(" "));

	const result = run(db, { terms });
	assert.deepEqual(result.rows.map((row) => row.id), ["all-terms"]);
	assert.equal(result.count.total, 1);
	db.close();
});

test("mail search accepts exactly 100 binds and rejects the next combined filter", () => {
	const terms = Array.from({ length: 32 }, (_, index) => `term${index + 1}`);
	assert.doesNotThrow(() => buildMailSearchPlan({
		terms,
		from: "alice@example.com",
		to: "team@example.com",
	}));
	assert.throws(
		() => buildMailSearchPlan({
			terms,
			from: "alice@example.com",
			to: "team@example.com",
			subject: "renewal",
		}),
		(error) =>
			error instanceof SearchQueryError &&
			error.code === "QUERY_TOO_LARGE" &&
			error.message === "Search uses too many combined filters",
	);
});

test("mail search treats repeated structured values as OR and different filters as AND", () => {
	const db = database();
	db.exec(`
		INSERT INTO emails (${EMAIL_COLUMNS}) VALUES
			('alice', 'inbox', 'Renewal', 'alice@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-10T10:00:00.000Z', 0, 0, 'A', NULL, NULL, 't1', NULL, NULL),
			('bob', 'archive', 'Renewal', 'bob@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-09T10:00:00.000Z', 0, 0, 'B', NULL, NULL, 't2', NULL, NULL),
			('carol', 'inbox', 'Renewal', 'carol@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-11T10:00:00.000Z', 0, 0, 'C', NULL, NULL, 't3', NULL, NULL);
	`);
	const result = run(db, {
		from: ["alice", "bob"],
		folder: ["inbox", "archive"],
		subject: ["renewal"],
	});
	assert.deepEqual(result.rows.map((row) => row.id), ["alice", "bob"]);
	db.close();
});

test("mail search defaults to relevance then recency and has stable id pagination", () => {
	const db = database();
	db.exec(`
		INSERT INTO emails (${EMAIL_COLUMNS}) VALUES
			('a', 'inbox', 'Status', 'one@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-10T10:00:00.000Z', 0, 0, 'apollo', NULL, NULL, 't1', NULL, NULL),
			('b', 'inbox', 'Status', 'two@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-10T10:00:00.000Z', 0, 0, 'apollo', NULL, NULL, 't2', NULL, NULL),
			('older-subject', 'inbox', 'Apollo launch', 'three@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-01T10:00:00.000Z', 0, 0, 'details', NULL, NULL, 't3', NULL, NULL);
	`);
	assert.deepEqual(
		run(db, { terms: ["apollo"] }).rows.map((row) => row.id),
		["older-subject", "a", "b"],
	);
	assert.deepEqual(run(db, { terms: ["apollo"], page: 1, limit: 1 }).rows.map((row) => row.id), ["older-subject"]);
	assert.deepEqual(run(db, { terms: ["apollo"], page: 2, limit: 1 }).rows.map((row) => row.id), ["a"]);
	db.close();
});

test("mail search centers snippets on the first body match and escapes LIKE wildcards", () => {
	const db = database();
	const body = `${"preface ".repeat(30)}100% complete with signed terms${" suffix".repeat(20)}`;
	const insert = db.prepare(`INSERT INTO emails (${EMAIL_COLUMNS}) VALUES
		(?, 'inbox', ?, 'one@example.com', 'team@example.com', NULL, NULL,
		 '2026-07-10T10:00:00.000Z', 0, 0, ?, NULL, NULL, 't1', NULL, NULL)`);
	insert.run("literal", "Progress", body);
	insert.run("wildcard-trap", "Anything", "This should not match");

	const result = run(db, { terms: ["100%"] });
	assert.deepEqual(result.rows.map((row) => row.id), ["literal"]);
	assert.match(String(result.rows[0]?.snippet), /100% complete/);
	assert.ok(!String(result.rows[0]?.snippet).startsWith("preface preface"));
	db.close();
});

test("mail search centers on a later term when the first term matches only the subject", () => {
	const db = database();
	const body = `${"opening ".repeat(35)}signed agreement${" closing".repeat(20)}`;
	const insert = db.prepare(`INSERT INTO emails (${EMAIL_COLUMNS}) VALUES
		('message', 'inbox', 'Renewal', 'one@example.com', 'team@example.com', NULL, NULL,
		 '2026-07-10T10:00:00.000Z', 0, 0, ?, NULL, NULL, 't1', NULL, NULL)`);
	insert.run(body);
	const result = run(db, { terms: ["renewal", "signed agreement"] });
	assert.match(String(result.rows[0]?.snippet), /signed agreement/);
	assert.ok(!String(result.rows[0]?.snippet).startsWith("opening opening"));
	db.close();
});

test("explicit sort keeps the selected column and deterministic id tie-break", () => {
	const plan = buildMailSearchPlan({
		terms: ["renewal"],
		sortColumn: "sender",
		sortDirection: "ASC",
	});
	assert.match(plan.dataSql, /ORDER BY e\.sender ASC, e\.id ASC/);
	assert.doesNotMatch(plan.dataSql, /relevance DESC/);
});

test("authoritative planning rejects oversized structured input instead of truncating it", () => {
	assert.throws(
		() => buildMailSearchPlan({ from: Array.from({ length: 9 }, (_, index) => `user-${index}`) }),
		SearchQueryError,
	);
	assert.throws(
		() => buildMailSearchPlan({ filename: "x".repeat(201) }),
		SearchQueryError,
	);
});

test("mail search enforces the Durable Object 50-byte LIKE pattern boundary", () => {
	assert.doesNotThrow(() => buildMailSearchPlan({ terms: ["a".repeat(48)] }));
	assert.throws(
		() => buildMailSearchPlan({ terms: ["a".repeat(49)] }),
		(error) =>
			error instanceof SearchQueryError &&
			error.code === "QUERY_TOO_LARGE" &&
			error.message === "Search value exceeds the mailbox pattern limit",
	);
});

test("mail search counts LIKE escape expansion and UTF-8 bytes", () => {
	assert.doesNotThrow(() => buildMailSearchPlan({ terms: ["%".repeat(24)] }));
	assert.throws(
		() => buildMailSearchPlan({ terms: ["%".repeat(25)] }),
		SearchQueryError,
	);
	assert.doesNotThrow(() => buildMailSearchPlan({ terms: ["€".repeat(16)] }));
	assert.throws(
		() => buildMailSearchPlan({ terms: ["€".repeat(17)] }),
		SearchQueryError,
	);
});

test("mail search applies the LIKE byte limit to every structured LIKE filter", () => {
	for (const options of [
		{ from: "a".repeat(49) },
		{ to: "a".repeat(49) },
		{ subject: "a".repeat(49) },
		{ filename: "a".repeat(49) },
	]) {
		assert.throws(() => buildMailSearchPlan(options), SearchQueryError);
	}
});

test("search rows carry the sender name and attachment flag the shared row renders", () => {
	// Search and Saved View results render the same EmailRow as the folder
	// lists. Omitting these two columns dropped the display name back to the raw
	// address and silently lost every paperclip.
	const db = database();
	db.exec(`
		INSERT INTO emails (id, folder_id, subject, sender, sender_name, recipient, date, body, thread_id)
		VALUES
			('named', 'inbox', 'Renewal ready', 'no-reply@shop.example', 'Shop Notifications',
			 'team@example.com', '2026-07-10T10:00:00.000Z', 'Renewal package attached', 't1'),
			('bare', 'inbox', 'Renewal notes', 'sam@acme.example', NULL,
			 'team@example.com', '2026-07-11T10:00:00.000Z', 'Renewal follow up', 't2'),
			('blank', 'inbox', 'Renewal draft', 'ops@acme.example', '   ',
			 'team@example.com', '2026-07-12T10:00:00.000Z', 'Renewal draft body', 't3');
		INSERT INTO attachments (id, email_id, filename, mimetype, size)
			VALUES ('a1', 'named', 'invoice.pdf', 'application/pdf', 1024);
	`);

	const rows = new Map(
		run(db, { terms: ["renewal"] }).rows.map((row) => [String(row.id), row]),
	);
	assert.equal(rows.size, 3);
	assert.equal(rows.get("named")?.sender_name, "Shop Notifications");
	assert.equal(Number(rows.get("named")?.has_attachments), 1);
	// A missing or whitespace-only name still has to reach the row, which falls
	// back to the address itself.
	assert.equal(rows.get("bare")?.sender_name, null);
	assert.equal(Number(rows.get("bare")?.has_attachments), 0);
	assert.equal(rows.get("blank")?.sender_name, "   ");
	assert.equal(Number(rows.get("blank")?.has_attachments), 0);
	db.close();
});

test("attachment presence is per message, not per thread", () => {
	const db = database();
	db.exec(`
		INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body, thread_id)
		VALUES
			('carrier', 'inbox', 'Renewal', 'a@example.com', 'team@example.com',
			 '2026-07-10T10:00:00.000Z', 'Renewal one', 'shared'),
			('sibling', 'inbox', 'Renewal', 'b@example.com', 'team@example.com',
			 '2026-07-11T10:00:00.000Z', 'Renewal two', 'shared');
		INSERT INTO attachments (id, email_id, filename, mimetype, size)
			VALUES ('a1', 'carrier', 'terms.pdf', 'application/pdf', 512);
	`);
	const rows = new Map(
		run(db, { terms: ["renewal"] }).rows.map((row) => [String(row.id), row]),
	);
	assert.equal(Number(rows.get("carrier")?.has_attachments), 1);
	assert.equal(Number(rows.get("sibling")?.has_attachments), 0);
	db.close();
});
