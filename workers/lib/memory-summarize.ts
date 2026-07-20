// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { generateText } from "ai";
import { getModelForMailbox } from "./ai-provider";
import type { Env } from "../types";

const MAX_CONTENT_CHARS = 20_000;

/** Generate a short AI summary of a memory file's content using the mailbox's configured AI model. */
export async function summarizeMemoryFile(
	env: Env,
	mailboxId: string,
	content: string,
): Promise<string> {
	const model = await getModelForMailbox(env, mailboxId);

	const result = await generateText({
		model,
		system:
			"Summarize the following document in 2-4 concise sentences. Return only the summary, no preamble or explanations.",
		messages: [{ role: "user", content: content.slice(0, MAX_CONTENT_CHARS) }],
	});

	return result.text.trim();
}
