// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// The list projections' SQL fragments, executed against the real migrated
// mailbox schema. Run:
//   node --experimental-strip-types --test workers/lib/list-projection.test.ts

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mailboxMigrations } from "../durableObject/migrations.ts";
import { applySqliteMigrations } from "../testing/sqlite-migrations.test.ts";
import { htmlToSnippet } from "./push/payload.ts";
import {
	hasAttachmentsSql,
	SENDER_DISPLAY_SQL,
	SNIPPET_LENGTH,
	snippetSourceSql,
} from "./list-projection.ts";

// A real styled marketing email: the <head>/<style> block alone is longer than
// the 300 characters the projection used to select, which is why these rows
// rendered a blank snippet in the list.
const MARKETING_BODY = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style type="text/css">
	body { margin: 0; padding: 0; background-color: #f4f4f4; font-family: Helvetica, Arial, sans-serif; }
	.wrapper { width: 100%; table-layout: fixed; background-color: #f4f4f4; padding-bottom: 40px; }
	.main { background-color: #ffffff; margin: 0 auto; width: 100%; max-width: 600px; border-spacing: 0; }
	.button { background-color: #ff6600; color: #ffffff; padding: 12px 24px; border-radius: 4px; }
	@media only screen and (max-width: 600px) { .main { width: 100% !important; } }
</style></head>
<body><div class="wrapper"><h1>Your order has shipped</h1>
<p>Tracking number 1Z999AA10123456784. Arriving Tuesday.</p>
<script>window.analytics.track("email_open");</script>
</div></body></html>`;

function database() {
	const db = new DatabaseSync(":memory:");
	applySqliteMigrations(db, mailboxMigrations);
	const insert = db.prepare(
		`INSERT INTO emails (id, folder_id, subject, sender, sender_name, body, date, thread_id)
		 VALUES (?, 'inbox', ?, ?, ?, ?, ?, ?)`,
	);
	insert.run("m1", "Shipped", "no-reply@shop.example", "Shop Notifications", MARKETING_BODY, "2026-07-20T10:00:00.000Z", "t1");
	insert.run("m2", "Re: Shipped", "sam@acme.example", null, "Thanks, got it.", "2026-07-20T11:00:00.000Z", "t1");
	insert.run("m3", "Blank name", "ops@acme.example", "   ", "<body>Short note.</body>", "2026-07-20T12:00:00.000Z", "t2");
	db.exec(
		`INSERT INTO attachments (id, email_id, filename, mimetype, size)
		 VALUES ('a1', 'm2', 'invoice.pdf', 'application/pdf', 1024)`,
	);
	return db;
}

function projectRows(db: DatabaseSync) {
	return db
		.prepare(
			`SELECT e.id, e.sender, e.sender_name,
				${snippetSourceSql("e")} as snippet,
				${hasAttachmentsSql("e")} as has_attachments
			 FROM emails e ORDER BY e.id`,
		)
		.all() as Array<Record<string, string | number | null>>;
}

test("a styled marketing email projects to human text, not CSS", () => {
	const row = projectRows(database())[0];
	const snippet = htmlToSnippet(String(row.snippet), SNIPPET_LENGTH);

	assert.equal(snippet, "Your order has shipped Tracking number 1Z999AA10123456784. Arriving Tuesday.");
	assert.doesNotMatch(snippet, /background-color|max-width|analytics/);
});

test("the old 300-character prefix would have yielded nothing", () => {
	// Guards the reason the fragment anchors at <body> rather than position 1.
	assert.equal(htmlToSnippet(MARKETING_BODY.slice(0, 300), SNIPPET_LENGTH), "");
});

test("plain-text and short HTML bodies survive the same fragment", () => {
	const rows = projectRows(database());
	assert.equal(htmlToSnippet(String(rows[1].snippet), SNIPPET_LENGTH), "Thanks, got it.");
	assert.equal(htmlToSnippet(String(rows[2].snippet), SNIPPET_LENGTH), "Short note.");
});

test("sender_name is projected and only counted when it holds a real name", () => {
	const rows = projectRows(database());
	assert.equal(rows[0].sender_name, "Shop Notifications");
	assert.equal(rows[1].sender_name, null);

	const display = database()
		.prepare(`SELECT id, ${SENDER_DISPLAY_SQL} as display FROM emails ORDER BY id`)
		.all() as Array<{ display: string }>;
	assert.deepEqual(display.map((row) => row.display), [
		"Shop Notifications",
		"sam@acme.example", // no name captured
		"ops@acme.example", // whitespace-only name is not a name
	]);
});

test("has_attachments reflects the attachments table per message", () => {
	assert.deepEqual(
		projectRows(database()).map((row) => row.has_attachments),
		[0, 1, 0],
	);
});

test("conversation-wide attachment and participant aggregates", () => {
	const rows = database()
		.prepare(
			`SELECT thread_id,
				GROUP_CONCAT(DISTINCT ${SENDER_DISPLAY_SQL}) as participant_names,
				SUM(CASE WHEN EXISTS(
					SELECT 1 FROM attachments a WHERE a.email_id = emails.id
				) THEN 1 ELSE 0 END) as attachment_count
			 FROM emails GROUP BY thread_id ORDER BY thread_id`,
		)
		.all() as Array<{ participant_names: string; attachment_count: number }>;

	// t1 carries the attachment on its reply, not on its latest message.
	assert.equal(rows[0].attachment_count, 1);
	assert.equal(rows[0].participant_names, "Shop Notifications,sam@acme.example");
	assert.equal(rows[1].attachment_count, 0);
});
