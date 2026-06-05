// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface SignatureSettings {
	enabled: boolean;
	text: string;
	html?: string;
}

export interface MailboxSettings {
	fromName?: string;
	forwarding?: { enabled: boolean; email: string };
	signature?: SignatureSettings;
	autoReply?: { enabled: boolean; subject: string; message: string };
}

export type UserStatus = "pending" | "active" | "disabled";
export type GlobalRole = "admin" | "none";
export type MailboxRole = "admin" | "manager" | "responder" | "viewer";

export interface MailboxCapabilities {
	readMail: boolean;
	mutateMail: boolean;
	sendMail: boolean;
	manageMailbox: boolean;
	manageMembers: boolean;
	manageTemplates: boolean;
	useTemplates: boolean;
	manageAi: boolean;
	useAi: boolean;
}

export interface AppUser {
	id: string;
	email: string;
	accessSub: string | null;
	status: UserStatus;
	globalRole: GlobalRole;
	displayName: string | null;
	createdAt: string;
	updatedAt: string;
	lastLoginAt: string | null;
}

export interface CurrentUser {
	identity: { sub: string; email: string };
	user: AppUser | null;
	registrationStatus: UserStatus | "unregistered";
}

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	settings?: MailboxSettings;
	role?: MailboxRole;
	capabilities?: MailboxCapabilities;
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

export interface MailboxMembership {
	mailboxId: string;
	userId: string;
	email: string;
	displayName: string | null;
	status: UserStatus;
	role: Exclude<MailboxRole, "admin">;
	capabilities: MailboxCapabilities;
	createdAt: string;
	updatedAt: string;
}

export interface ResponseTemplate {
	id: string;
	mailboxId: string;
	name: string;
	subject: string;
	bodyHtml: string;
	bodyText: string | null;
	createdBy: string;
	updatedBy: string;
	createdAt: string;
	updatedAt: string;
}

export interface AiDraftSettings {
	mailboxId: string;
	enabled: boolean;
	model: string | null;
	systemPrompt: string | null;
	updatedBy: string | null;
	updatedAt: string | null;
}

export interface AiDraftResponse {
	model: string;
	bodyHtml: string;
	bodyText: string;
}
