import type { MailboxSettings } from "../app/types/index";
export interface SenderIdentity {
	id: string;
	email: string;
	mailbox_id: string | null;
	name: string;
	active: boolean;
	settings?: MailboxSettings;
}
export interface SenderConfiguration {
	senders: SenderIdentity[];
	default_sender_identity_id: string | null;
}
export interface SenderContext {
	explicit?: string;
	draft?: string | null;
	reply?: {
		recipient: string;
		cc?: string;
		sender_identity_id?: string | null;
	};
	mailboxId: string;
}
// What an API key may send from. Without mailboxIds the caller is unrestricted.
export interface SenderAccess {
	mailboxIds?: string[];
	senderIds?: string[];
	defaultSenderId?: string | null;
}
export const canUseSender = (
	sender: Pick<SenderIdentity, "id" | "mailbox_id">,
	access: SenderAccess,
) =>
	!access.mailboxIds ||
	(!!sender.mailbox_id && access.mailboxIds.includes(sender.mailbox_id)) ||
	!!access.senderIds?.includes(sender.id);
// The senders and default a restricted caller sees. An unavailable key default
// is reported as no default rather than replaced by the workspace default.
export function scopeSenders(
	config: SenderConfiguration,
	access: SenderAccess,
): SenderConfiguration {
	if (!access.mailboxIds) return config;
	const senders = config.senders.filter((s) => canUseSender(s, access));
	const preferred = access.defaultSenderId ?? config.default_sender_identity_id;
	return {
		senders,
		default_sender_identity_id: senders.some((s) => s.id === preferred)
			? preferred
			: null,
	};
}
// Do not skip inactive matches: the caller must report an unavailable sender.
export function resolveSenderId(
	config: SenderConfiguration,
	context: SenderContext,
): string | null {
	if (context.explicit) return context.explicit;
	if (context.draft) return context.draft;
	if (context.reply) {
		if (context.reply.sender_identity_id)
			return context.reply.sender_identity_id;
		const recipients: string[] =
			`${context.reply.recipient},${context.reply.cc ?? ""}`
				.toLowerCase()
				.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/g) ?? [];
		const directMatches = config.senders.filter((s) =>
			recipients.includes(s.email.toLowerCase()),
		);
		const matches = directMatches.length
			? directMatches
			: config.senders.filter(
					(s) =>
						s.mailbox_id && recipients.includes(s.mailbox_id.toLowerCase()),
				);
		if (matches.length === 1) return matches[0].id;
		if (matches.length > 1) return null;
	}
	return (
		config.default_sender_identity_id ??
		config.senders.find((s) => s.mailbox_id === context.mailboxId)?.id ??
		null
	);
}
