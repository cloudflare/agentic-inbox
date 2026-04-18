// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface SignatureSettings {
	enabled: boolean;
	text: string;
	html?: string;
}

export interface BusinessHoursSettings {
	timezone: string;
	start_hour: number;
	end_hour: number;
	weekdays_only: boolean;
	boost_on_off_hours: boolean;
}

export interface VerdictThresholdSettings {
	tag: number;
	quarantine: number;
	block: number;
}

export interface SecuritySettings {
	enabled?: boolean;
	learning_mode?: boolean;
	thresholds?: VerdictThresholdSettings;
	allowlist_senders?: string[];
	allowlist_domains?: string[];
	trusted_authserv_ids?: string[];
	trusted_auto_allow?: boolean;
	trusted_auto_allow_min_messages?: number;
	intel_auto_block?: boolean;
	business_hours?: BusinessHoursSettings;
}

export interface MailboxSettings {
	fromName?: string;
	forwarding?: { enabled: boolean; email: string };
	signature?: SignatureSettings;
	autoReply?: { enabled: boolean; subject: string; message: string };
	agentSystemPrompt?: string;
	security?: SecuritySettings;
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
	// Security pipeline verdict (null when the pipeline didn't run)
	security_verdict?: string | null;
	security_score?: number | null;
	security_explanation?: string | null;
}

/** Shape of the JSON stored in Email.security_verdict. */
export interface SecurityVerdict {
	action: "allow" | "tag" | "quarantine" | "block";
	score: number;
	explanation: string;
	auth: {
		spf: string;
		dkim: string;
		dmarc: string;
		authservId?: string;
	};
	classification: {
		label: "safe" | "spam" | "phishing" | "bec" | "suspicious";
		confidence: number;
		reasoning: string;
	};
	signals: string[];
	/** Present when a triage tier short-circuited the pipeline. */
	triage?: "hard_allow" | "hard_block" | "attachment_block" | "folder_bypass";
}

export function parseVerdict(raw: string | null | undefined): SecurityVerdict | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as SecurityVerdict;
	} catch {
		return null;
	}
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
