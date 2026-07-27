// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// SQL fragments shared by the three mailbox list projections (flat, drafts,
// threaded). They live outside the Durable Object so they can be executed
// against real SQLite in tests, which the DO module cannot be — it imports
// `cloudflare:workers`.

/**
 * The prose-bearing slice of a stored body. Bodies are raw HTML, so this
 * anchors at `<body` when present: otherwise a large `<head>` of `<style>`
 * rules eats the whole budget and the list renders a blank snippet. The slice
 * stays generous because `htmlToSnippet` does the real text extraction; SQL
 * only keeps the row payload bounded.
 */
export const snippetSourceSql = (alias: string) =>
	`SUBSTR(${alias}.body, CASE WHEN INSTR(LOWER(${alias}.body), '<body') > 0 THEN INSTR(LOWER(${alias}.body), '<body') ELSE 1 END, 4000)`;

/**
 * Attachment presence for one message, served by idx_attachments_email_id_id.
 * The outer column is qualified because an unqualified `id` would bind to
 * `attachments.id` inside the subquery and match every row.
 */
export const hasAttachmentsSql = (alias: string) =>
	`EXISTS(SELECT 1 FROM attachments a WHERE a.email_id = ${alias}.id)`;

/** Display name when the ingest captured a usable one, else the raw address. */
export const SENDER_DISPLAY_SQL = `COALESCE(NULLIF(TRIM(sender_name), ''), sender)`;

/** Characters of human text a list row shows before ellipsis. */
export const SNIPPET_LENGTH = 160;
