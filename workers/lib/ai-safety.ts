// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * AI-powered safety classifiers for lecturers managing student email.
 *
 * - isUrgentOrDistressed: flags emails needing personal, immediate attention
 *   instead of an automated reply (distress, crisis, urgent safety concern).
 * - isPhishingOrImpersonation: extends the prompt-injection scanner's threat
 *   model to cover phishing/impersonation attempts targeting the mailbox.
 * - containsSensitiveInfo: checks an OUTGOING draft (not an inbound email)
 *   for grades/GPA/student-ID mentions before it's sent — a warning, not a block.
 *
 * All three follow the same pattern as isPromptInjection in ai.ts: a cheap
 * fixed Workers AI model, single-word YES/NO output, temperature 0, and an
 * explicit fail-open/fail-closed decision per function.
 */

import { stripHtmlToText } from "./email-helpers";

const FAST_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

async function classifyYesNo(ai: Ai, systemPrompt: string, userText: string): Promise<string> {
	const response = (await ai.run(
		// @ts-expect-error — model string not in generated union
		FAST_MODEL,
		{
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userText },
			],
			max_tokens: 10,
			temperature: 0,
		},
	)) as { response?: string };

	return (response?.response || "NO").trim().toUpperCase();
}

// ── Urgent / Distressed Detector ────────────────────────────────────

const URGENT_PROMPT = `You are a triage assistant for a professor's inbox. Does this email express significant emotional distress, a mental health crisis, or an urgent safety concern that requires the professor's personal, immediate attention rather than an automated reply?

Return ONLY "YES" if the email shows genuine distress or an urgent safety concern.
Return ONLY "NO" if it's a routine question, even if it mentions a tight deadline or is frustrated about a grade.

Respond with exactly one word: YES or NO.`;

/**
 * Flags emails needing the professor's personal attention instead of an
 * automated reply. Fails closed (treats scanner failures as urgent) since
 * skipping a human-needed reply is worse than skipping an unnecessary one —
 * the email is still stored in the inbox either way, only auto-draft is skipped.
 */
export async function isUrgentOrDistressed(ai: Ai, bodyHtml: string | null | undefined): Promise<boolean> {
	if (!bodyHtml) return false;

	const plainText = stripHtmlToText(bodyHtml).trim();
	if (plainText.length < 10) return false;

	try {
		const result = await classifyYesNo(ai, URGENT_PROMPT, plainText);
		if (result.includes("YES")) {
			console.warn("Urgent/distressed email detected, skipping auto-draft for manual review");
			return true;
		}
		return false;
	} catch (e) {
		console.error("Urgent-detection scanner failed, skipping auto-draft:", (e as Error).message);
		return true;
	}
}

// ── Phishing / Impersonation Detector ───────────────────────────────

const PHISHING_PROMPT = `You are a security scanner looking for phishing or impersonation attempts in a student's inbox.
Analyze the following email. Does it show signs of phishing or impersonation — urgent demands for payment or gift cards, suspicious links, claims of being IT support or financial aid demanding login credentials, or a sender name/signature that doesn't match how a real student or colleague would write?

Return ONLY "YES" if it looks like phishing or impersonation.
Return ONLY "NO" if it's a normal email (even if urgent or poorly written).

Respond with exactly one word: YES or NO.`;

/**
 * Flags likely phishing/impersonation attempts. Fails closed (treats scanner
 * failures as phishing) to match isPromptInjection's convention — the email
 * stays in the inbox, only auto-draft is skipped, so failing closed just
 * means a human reviews it instead of the agent.
 */
export async function isPhishingOrImpersonation(
	ai: Ai,
	bodyHtml: string | null | undefined,
	senderAddress: string,
): Promise<boolean> {
	if (!bodyHtml) return false;

	const plainText = stripHtmlToText(bodyHtml).trim();
	if (plainText.length < 10) return false;

	try {
		const result = await classifyYesNo(
			ai,
			PHISHING_PROMPT,
			`From: ${senderAddress}\n\n${plainText}`,
		);
		if (result.includes("YES")) {
			console.warn("Possible phishing/impersonation detected, skipping auto-draft for manual review");
			return true;
		}
		return false;
	} catch (e) {
		console.error("Phishing-detection scanner failed, skipping auto-draft:", (e as Error).message);
		return true;
	}
}

// ── Sensitive Info Warning (send-time, not auto-draft-time) ────────

const SENSITIVE_PROMPT = `Does the following email draft mention a specific student's grade, GPA, exam score, or student ID number?

Return ONLY "YES" if it mentions specific grade/GPA/score/ID information.
Return ONLY "NO" if it doesn't (general policy talk about grading is fine — only flag SPECIFIC values).

Respond with exactly one word: YES or NO.`;

/**
 * Checks an outgoing draft for grade/GPA/student-ID mentions before sending.
 * This is a warning shown to the operator, NOT a block — the operator may
 * genuinely intend to share this information. Fails closed (shows the
 * warning) since a false-positive warning costs one dismissed dialog, while
 * a false negative could mean sensitive info goes out unflagged.
 */
export async function containsSensitiveInfo(ai: Ai, draftBody: string): Promise<boolean> {
	if (!draftBody) return false;

	const plainText = stripHtmlToText(draftBody).trim();
	if (plainText.length < 10) return false;

	try {
		const result = await classifyYesNo(ai, SENSITIVE_PROMPT, plainText);
		return result.includes("YES");
	} catch (e) {
		console.error("Sensitive-info scanner failed, defaulting to warning:", (e as Error).message);
		return true;
	}
}
