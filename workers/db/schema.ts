// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const folders = sqliteTable("folders", {
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
	is_deletable: integer("is_deletable").notNull().default(1),
});

export const emails = sqliteTable("emails", {
	id: text("id").primaryKey(),
	folder_id: text("folder_id")
		.notNull()
		.references(() => folders.id, { onDelete: "cascade" }),
	subject: text("subject"),
	sender: text("sender"),
	sender_name: text("sender_name"),
	recipient: text("recipient"),
	cc: text("cc"),
	bcc: text("bcc"),
	date: text("date"),
	read: integer("read").default(0),
	starred: integer("starred").default(0),
	body: text("body"),
	in_reply_to: text("in_reply_to"),
	email_references: text("email_references"),
	thread_id: text("thread_id"),
	message_id: text("message_id"),
	raw_headers: text("raw_headers"),
});

export const attachments = sqliteTable("attachments", {
	id: text("id").primaryKey(),
	email_id: text("email_id")
		.notNull()
		.references(() => emails.id, { onDelete: "cascade" }),
	filename: text("filename").notNull(),
	mimetype: text("mimetype").notNull(),
	size: integer("size").notNull(),
	content_id: text("content_id"),
	disposition: text("disposition"),
});

/** Registry of AI chat conversations for a mailbox (messages live in EmailAgent DOs). */
export const agentConversations = sqliteTable("agent_conversations", {
	id: text("id").primaryKey(),
	title: text("title").notNull(),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
	last_message_preview: text("last_message_preview"),
});
