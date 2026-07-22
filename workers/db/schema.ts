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

export const memoryFiles = sqliteTable("memory_files", {
	id: text("id").primaryKey(),
	title: text("title"),
	tags: text("tags"),
	content: text("content"),
	r2_key: text("r2_key").notNull(),
	status: text("status").notNull().default("ready"),
	source_type: text("source_type").notNull().default("text"),
	error_message: text("error_message"),
	word_count: integer("word_count"),
	token_count: integer("token_count"),
	summary: text("summary"),
	source_kind: text("source_kind").notNull().default("manual"),
	source_uri: text("source_uri"),
	external_id: text("external_id"),
	parent_id: text("parent_id"),
	checksum: text("checksum"),
	draft_eligible: integer("draft_eligible").notNull().default(1),
	last_indexed_at: text("last_indexed_at"),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
});

export const memoryChunks = sqliteTable("memory_chunks", {
	id: text("id").primaryKey(),
	memory_file_id: text("memory_file_id").notNull().references(() => memoryFiles.id, { onDelete: "cascade" }),
	heading: text("heading"),
	content: text("content").notNull(),
	start_offset: integer("start_offset").notNull(),
	end_offset: integer("end_offset").notNull(),
	token_count: integer("token_count"),
	created_at: text("created_at").notNull(),
});

export const memoryFacts = sqliteTable("memory_facts", {
	id: text("id").primaryKey(),
	kind: text("kind").notNull(),
	value: text("value").notNull(),
	status: text("status").notNull().default("suggested"),
	confidence: integer("confidence"),
	source_chunk_id: text("source_chunk_id").references(() => memoryChunks.id, { onDelete: "set null" }),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
});

export const templates = sqliteTable("templates", {
	id: text("id").primaryKey(),
	title: text("title").notNull(),
	body: text("body").notNull(),
	tags: text("tags"),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
});

export const rosters = sqliteTable("rosters", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	created_at: text("created_at").notNull(),
});

export const students = sqliteTable("students", {
	id: text("id").primaryKey(),
	roster_id: text("roster_id")
		.notNull()
		.references(() => rosters.id, { onDelete: "cascade" }),
	name: text("name"),
	email: text("email").notNull(),
	created_at: text("created_at").notNull(),
});
