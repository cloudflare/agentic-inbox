import type { ComposeOptions } from "../hooks/useUIStore.ts";
import { replyAllRecipientFields } from "./recipient-input.ts";
import {
	FORWARDED_MESSAGE_MARKER,
	insertComposeSignature,
} from "./compose-signature.ts";
import {
	escapeHtml,
	stripHtml,
} from "./html-text.ts";
import { formatQuotedDate } from "../../shared/dates.ts";
import type { MailboxSignature } from "../../shared/mailbox-signature-settings";

export interface InitialComposeFields {
	to: string;
	cc: string;
	bcc: string;
	showCcBcc: boolean;
	subject: string;
	body: string;
}

const EMPTY_FIELDS: InitialComposeFields = {
	to: "",
	cc: "",
	bcc: "",
	showCcBcc: false,
	subject: "",
	body: "",
};

const SUBJECT_PREFIX_PATTERNS = {
	Re: /^re\s*:\s*/i,
	Fwd: /^(?:fwd|fw)\s*:\s*/i,
} as const;

/**
 * The one place a reply or forward prefix is applied. Existing prefixes are
 * absorbed whatever their spacing or case, so subjects never stack up as
 * "Re: Re: Fwd: ...".
 */
export function prefixedSubject(
	subject: string,
	prefix: "Re" | "Fwd",
): string {
	const pattern = SUBJECT_PREFIX_PATTERNS[prefix];
	let base = subject.trim();
	while (pattern.test(base)) base = base.replace(pattern, "").trim();
	return `${prefix}: ${base}`;
}

function forwardBody(original: NonNullable<ComposeOptions["originalEmail"]>) {
	const safeSender = escapeHtml(original.sender);
	const safeSubject = escapeHtml(original.subject);
	const safeBody = escapeHtml(stripHtml(original.body || "")).replace(
		/\n/g,
		"<br>",
	);

	return `<p><br></p><div ${FORWARDED_MESSAGE_MARKER} style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><strong>Forwarded message:</strong><br><strong>From:</strong> ${safeSender}<br><strong>Date:</strong> ${formatQuotedDate(original.date)}<br><strong>Subject:</strong> ${safeSubject}<br><br>${safeBody}</div>`;
}

function withSignature(
	bodyHtml: string,
	mode: "new" | "reply" | "reply-all" | "forward",
	signature: MailboxSignature | undefined,
) {
	return signature?.enabled
		? insertComposeSignature(bodyHtml, signature.text, mode).bodyHtml
		: bodyHtml;
}

/**
 * A clean writing space and nothing else. Replies deliberately quote nothing:
 * the message being answered is already in the thread above the composer, so
 * repeating it only pushes the reply out of view.
 */
function blankBody(
	mode: "new" | "reply" | "reply-all",
	signature: MailboxSignature | undefined,
) {
	return withSignature(signature?.enabled ? "<p><br></p>" : "", mode, signature);
}

export function buildInitialComposeFields(input: {
	composeOptions: ComposeOptions;
	mailboxEmail?: string;
	signature?: MailboxSignature;
}): InitialComposeFields {
	const { composeOptions, mailboxEmail, signature } = input;
	const { draftEmail: draft, originalEmail: original, mode } = composeOptions;

	if (draft) {
		return {
			to: draft.recipient || "",
			cc: draft.cc || "",
			bcc: draft.bcc || "",
			showCcBcc: Boolean(draft.cc || draft.bcc),
			subject: draft.subject || "",
			body: draft.body || "",
		};
	}

	if (!original) {
		return {
			...EMPTY_FIELDS,
			to: mode === "new" ? composeOptions.initialTo ?? "" : "",
			body: blankBody("new", signature),
		};
	}

	if (mode === "reply") {
		return {
			...EMPTY_FIELDS,
			to: original.sender,
			subject: prefixedSubject(original.subject, "Re"),
			body: blankBody("reply", signature),
		};
	}

	if (mode === "reply-all") {
		return {
			...EMPTY_FIELDS,
			...replyAllRecipientFields({
				sender: original.sender,
				to: original.recipient,
				cc: original.cc,
				mailboxAddress: mailboxEmail ?? "",
			}),
			subject: prefixedSubject(original.subject, "Re"),
			body: blankBody("reply-all", signature),
		};
	}

	if (mode === "forward") {
		return {
			...EMPTY_FIELDS,
			subject: prefixedSubject(original.subject, "Fwd"),
			body: withSignature(forwardBody(original), "forward", signature),
		};
	}

	return {
		...EMPTY_FIELDS,
		body: blankBody("new", signature),
	};
}
