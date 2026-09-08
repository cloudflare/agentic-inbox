// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";
import { attachFooter, detachFooter, signatureTextFromHtml, type FooterChoice } from "../../shared/signature";

type SignatureSettings = {
	enabled?: boolean;
	text?: string;
	html?: string;
};

type MailboxSettingsWithSignature = {
	signature?: SignatureSettings;
};

type SignatureBody = {
	html?: string;
	text?: string;
};

async function loadSignature(env: Env, mailboxId: string): Promise<SignatureSettings | null> {
	const obj = await env.BUCKET.get(`mailboxes/${mailboxId.toLowerCase()}.json`);
	if (!obj) return null;
	const settings = (await obj.json()) as MailboxSettingsWithSignature;
	const signature = settings.signature;
	return signature || null;
}

export async function applyMailboxSignature(
	env: Env,
	mailboxId: string,
	body: SignatureBody,
	choice?: FooterChoice,
	draft = false,
): Promise<Required<SignatureBody>> {
	const signature = await loadSignature(env, mailboxId);
	const defaultText = signature?.text || (signature?.html ? signatureTextFromHtml(signature.html) : "");
	const detached = detachFooter(body.html || "", defaultText);
	const selected = choice ?? detached.choice ?? { enabled: Boolean(signature?.enabled), text: defaultText };
	if (body.html !== undefined && (body.html.length > 0 || !body.text)) {
		const html = attachFooter(detached.body, selected, draft);
		return { html, text: body.text !== undefined ? signatureTextFromHtml(html) : "" };
	}
	let text = body.text || "";
	// Plain-text callers may already have appended the saved footer.
	for (const candidate of new Set([defaultText, selected.text])) {
		if (!candidate.trim()) continue;
		while (text.trimEnd().endsWith(candidate.trim())) text = text.trimEnd().slice(0, -candidate.trim().length).trimEnd();
	}
	return { html: "", text: selected.enabled && selected.text.trim() ? `${text}${text ? "\n\n" : ""}${selected.text.trim()}` : text };
}

export async function applyMailboxSignatureToHtml(
	env: Env,
	mailboxId: string,
	html: string,
): Promise<string> {
	const signed = await applyMailboxSignature(env, mailboxId, { html });
	return signed.html;
}
