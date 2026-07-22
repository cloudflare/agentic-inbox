// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface SignatureSettings {
	enabled: boolean;
	text: string;
	html?: string;
}

export interface AiProviderSetting {
	type: "workers-ai" | "openrouter";
	model: string;
}

export interface SafetySettings {
	urgentDetection?: boolean;
	phishingDetection?: boolean;
	sensitiveInfoWarning?: boolean;
}

export interface MailboxSettings {
	fromName?: string;
	forwarding?: { enabled: boolean; email: string };
	signature?: SignatureSettings;
	autoReply?: { enabled: boolean; subject: string; message: string };
	agentSystemPrompt?: string;
	aiProvider?: AiProviderSetting;
	memory?: { useAutoRag?: boolean };
	safety?: SafetySettings;
}

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	settings?: MailboxSettings;
}

export interface Email {
	id: string;
	thread_id?: string | null;
	folder_id?: string | null;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string;
	bcc?: string;
	date: string;
	read: boolean;
	starred: boolean;
	body?: string | null;
	in_reply_to?: string | null;
	email_references?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: Attachment[];
	snippet?: string | null;
	// Thread aggregate fields (only present in threaded list view)
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	needs_reply?: boolean;
	has_draft?: boolean;
}

export interface Attachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string;
	disposition?: string;
}

export interface Folder {
	id: string;
	name: string;
	unreadCount: number;
}

export interface MemoryEntry {
	id: string;
	title: string | null;
	tags: string | null;
	status: "processing" | "ready" | "error";
	source_type: "text" | "markdown" | "pdf" | "docx" | "image";
	error_message: string | null;
	word_count: number | null;
	token_count: number | null;
	summary: string | null;
	source_kind: "manual" | "upload" | "google_drive" | "onedrive" | "email";
	source_uri: string | null;
	external_id: string | null;
	parent_id: string | null;
	draft_eligible: number;
	last_indexed_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface MemoryFileDetail extends MemoryEntry {
	content: string;
}

export interface MemoryHit {
	id: string;
	title: string | null;
	tags: string | null;
	snippet: string;
	source: "keyword" | "semantic";
	heading?: string | null;
	start_offset?: number;
	source_kind?: string;
	source_uri?: string | null;
	relevance?: number;
}

export interface MemorySearchResponse {
	results: MemoryHit[];
	semanticUsed: boolean;
	semanticError?: string;
}

export interface DraftContextSource {
	id: string;
	title: string;
	excerpt: string;
	heading: string | null;
	source: "keyword" | "semantic" | "pinned";
	citation: string;
	reason: string;
	relevance: number;
}

export interface DraftContextPack {
	sources: DraftContextSource[];
	facts: Array<{ id: string; kind: string; value: string; confidence: number | null; sourceChunkId: string | null }>;
	warnings: string[];
	query: string;
	semanticUsed: boolean;
}

export interface MemoryFact {
	id: string;
	kind: string;
	value: string;
	status: "suggested" | "confirmed" | "rejected" | "superseded";
	confidence: number | null;
	source_chunk_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface Template {
	id: string;
	title: string;
	body: string;
	tags: string | null;
	created_at: string;
	updated_at: string;
}

export interface Roster {
	id: string;
	name: string;
	studentCount: number;
	created_at: string;
}

export interface Student {
	id: string;
	roster_id: string;
	name: string | null;
	email: string;
	created_at: string;
}

export interface ConnectedAccount {
	id: string;
	provider: "microsoft" | "google";
	providerAccountId: string;
	email: string | null;
	displayName: string | null;
	status: "connected" | "reauth_required" | "disconnected";
	createdAt: string;
	updatedAt: string;
}

export interface BriefingItem {
	id: string;
	type: "email" | "event" | "task" | "follow-up";
	title: string;
	reason: string;
	priority: "high" | "medium" | "low";
	sourceId: string;
	sourceUrl: string;
	createdAt: string;
}

export interface Extraction {
	id: string;
	kind: "event" | "task" | "follow-up";
	title: string;
	dueAt: string | null;
	confidence: number;
	sourceEmailId: string;
	sourceThreadId: string | null;
	status: "suggested" | "committed" | "dismissed";
}

export interface ProductivitySnapshot {
	events: Array<{ id: string; subject?: string; start?: { dateTime?: string }; end?: { dateTime?: string } }>;
	contacts: Array<{ id: string; displayName?: string; emailAddresses?: Array<{ address?: string }>; companyName?: string }>;
	tasks: Array<{ id: string; title?: string; dueDateTime?: { dateTime?: string }; status?: string }>;
	taskListId: string;
}

export interface Topic {
	id: string;
	title: string;
	content: string;
	selectedEmailIds: string[];
	status: string;
	jobId: string | null;
	mode: string | null;
	createdAt: string;
	updatedAt: string;
}
