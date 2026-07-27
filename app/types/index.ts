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
	agentSystemPrompt?: string;
}

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	type?: "PERSONAL" | "SHARED";
	settings?: MailboxSettings;
}

export interface Email {
	id: string;
	/** Stable grouping key returned by threaded folder lists. */
	conversation_id?: string | null;
	thread_id?: string | null;
	folder_id?: string | null;
	snooze_source_folder_id?: string | null;
	snoozed_until?: string | null;
	subject: string;
	sender: string;
	sender_name?: string | null;
	recipient: string;
	cc?: string;
	bcc?: string;
	date: string;
	read: boolean;
	starred: boolean;
	body?: string | null;
	body_external?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	draft_version?: number;
	attachments?: Attachment[];
	snippet?: string | null;
	has_attachments?: boolean;
	// Thread aggregate fields (only present in threaded list view)
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	participant_names?: string;
	needs_reply?: boolean;
	has_draft?: boolean;
	labels?: Label[];
}

export type LabelColor =
	| "gray" | "red" | "orange" | "yellow" | "green"
	| "teal" | "blue" | "purple" | "pink";

export interface Label {
	id: string;
	name: string;
	color: LabelColor;
	createdAt?: string;
	updatedAt?: string;
}

export interface LabelMutationTarget {
	emailId: string;
	folderId: string;
	conversationId?: string;
}

export interface LabelMutationResult {
	status: "completed";
	results: Array<{
		emailId: string;
		status: "updated" | "not_found" | "outbound_delivery_active";
		affectedCount: number;
	}>;
}

export interface Attachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string;
	disposition?: string;
}

export type {
	AttachmentKind,
	MailboxAttachmentItem,
	MailboxAttachmentPage,
} from "../../shared/mailbox-attachments.ts";

/**
 * A reference to a file to attach, sent to the server instead of the bytes
 * (upload-first model): a freshly uploaded staging file, or a file already
 * stored against another email (e.g. a draft being sent).
 */
export type AttachmentRef =
	| {
			kind: "upload";
			uploadId: string;
			disposition?: "attachment" | "inline";
			contentId?: string;
	  }
	| {
			kind: "existing";
			emailId: string;
			attachmentId: string;
			disposition?: "attachment" | "inline";
	  };

export interface Folder {
	id: string;
	name: string;
	unreadCount: number;
}

export type OutboundDeliveryStatus =
	| "queued"
	| "sending"
	| "retrying"
	| "sent"
	| "bounced"
	| "failed"
	| "unknown"
	| "cancelled";

export interface OutboundDelivery {
	id: string;
	emailId: string;
	/** Present on conversation-highlight lookups, including older thread messages. */
	threadId?: string;
	draftId?: string;
	mailboxId: string;
	status: OutboundDeliveryStatus;
	kind: "compose" | "reply" | "forward" | "bulk";
	createdAt: string;
	updatedAt: string;
	availableAt: string;
	undoUntil: string;
	scheduledFor?: string;
	nextAttemptAt?: string;
	attemptCount: number;
	maxAttempts: number;
	lastErrorCode?: string;
	lastErrorMessage?: string;
	sentAt?: string;
	failedAt?: string;
	unknownAt?: string;
	cancelledAt?: string;
	cancelRecoveryPending?: boolean;
	storageIntegrityCode?: "outbound_delivery_record_invalid";
}

export interface OutboundEnqueueResponse {
	deliveryId: string;
	id: string;
	status: OutboundDeliveryStatus;
	undoUntil: string;
	scheduledFor: string | null;
	replayed: boolean;
	outcome: "enqueued" | "active_replay" | "terminal_replay";
}
