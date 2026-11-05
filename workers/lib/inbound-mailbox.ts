// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export type InboundMailboxDecision =
	| { action: "deliver"; mailboxId: string }
	| { action: "ignore"; mailboxId?: string }
	| { action: "reject" };

/**
 * Email Routing invokes the worker once per SMTP RCPT TO. That envelope
 * address is the mailbox for this delivery. The first To: header is not:
 * mailing lists, BCC, and messages that also address someone without a
 * mailbox would otherwise be stored in the wrong place or dropped.
 *
 * When the runtime does not supply an envelope, fall back to the header
 * the previous code used.
 */
export function decideInboundMailbox(input: {
	envelopeTo?: string | null;
	headerTo?: Array<string | null | undefined>;
	allowedAddresses?: Array<string | null | undefined>;
}): InboundMailboxDecision {
	const envelope = normalizeMailboxAddress(input.envelopeTo);
	const headers = (input.headerTo ?? [])
		.map((address) => normalizeMailboxAddress(address))
		.filter((address): address is string => Boolean(address));
	const allowed = (input.allowedAddresses ?? [])
		.map((address) => normalizeMailboxAddress(address))
		.filter((address): address is string => Boolean(address));

	if (envelope) {
		if (allowed.length > 0 && !allowed.includes(envelope)) {
			return { action: "ignore", mailboxId: envelope };
		}
		return { action: "deliver", mailboxId: envelope };
	}

	if (allowed.length > 0) {
		const match = headers.find((address) => allowed.includes(address));
		return match ? { action: "deliver", mailboxId: match } : { action: "ignore" };
	}

	return headers[0] ? { action: "deliver", mailboxId: headers[0] } : { action: "reject" };
}

export function normalizeMailboxAddress(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim().toLowerCase();
	const angle = trimmed.match(/<([^>]+)>/);
	const address = (angle ? angle[1] : trimmed).trim();
	if (!address.includes("@") || /[\s,<>]/.test(address)) return undefined;
	return address;
}
