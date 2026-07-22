// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { generateText } from "ai";
import { getModelForMailbox } from "./ai-provider";
import { stripHtmlToText, textToHtml } from "./email-helpers";
import type { Env } from "../types";

type RewriteAction = "polish" | "formalize" | "friendly" | "shorten" | "custom";

const ACTION_PROMPTS: Record<Exclude<RewriteAction, "custom">, string> = {
	polish: "Improve the writing quality of this email. Fix grammar, improve clarity, and make it more professional while keeping the same meaning and tone.",
	formalize: "Rewrite this email in a more formal, professional tone. Keep the same meaning but use more formal language.",
	friendly: "Rewrite this email in a warmer, more friendly and conversational tone. Keep the same meaning but sound more approachable.",
	shorten: "Make this email shorter and more concise. Remove unnecessary words and keep only the essential information.",
};

/** Rewrite email body using the mailbox's configured AI model. */
export async function rewriteEmailBody(
	env: Env,
	mailboxId: string,
	body: string,
	action: RewriteAction,
	customInstruction?: string,
): Promise<string> {
	const model = await getModelForMailbox(env, mailboxId);
	const plainText = stripHtmlToText(body);

	const systemPrompt = `You are an email writing assistant. You rewrite email drafts according to instructions. Return ONLY the rewritten email body — no greetings like "Here's the rewrite", no explanations, no markdown formatting. Output plain text only.`;

	const userPrompt = action === "custom" && customInstruction
		? `${customInstruction}\n\nEmail to rewrite:\n${plainText}`
		: `${ACTION_PROMPTS[action as Exclude<RewriteAction, "custom">]}\n\nEmail to rewrite:\n${plainText}`;

	const result = await generateText({
		model,
		system: systemPrompt,
		messages: [{ role: "user", content: userPrompt }],
	});

	return textToHtml(result.text.trim());
}
