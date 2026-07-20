// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Background processing for uploaded memory files (PDF, DOCX, images,
 * plain text, markdown). Runs inside `c.executionCtx.waitUntil(...)` after
 * the upload route has already responded with a "processing" record, so
 * failures here must be written back to the DO's status column — there is
 * no client connection left to report to.
 */
import { getMailboxStub } from "./email-helpers";
import { countWords, estimateTokens } from "./text-metrics";
import { chunkMarkdown } from "./memory-chunks";
import type { Env } from "../types";

export type MemorySourceType = "text" | "markdown" | "pdf" | "docx" | "image";

type MemoryStatusStub = {
	updateMemoryFileStatus: (
		id: string,
		status: string,
		params?: {
			content?: string;
			error_message?: string;
			word_count?: number;
			token_count?: number;
		},
	) => Promise<unknown>;
	replaceMemoryChunks: (fileId: string, chunks: ReturnType<typeof chunkMarkdown>) => Promise<unknown>;
};

/** Determine the memory source type from a file's MIME type and name, or null if unsupported. */
export function resolveSourceType(mimeType: string, filename: string): MemorySourceType | null {
	const lower = filename.toLowerCase();
	if (mimeType === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
	if (
		mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
		lower.endsWith(".docx")
	) {
		return "docx";
	}
	if (mimeType.startsWith("image/")) return "image";
	if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
	if (mimeType === "text/plain" || lower.endsWith(".txt")) return "text";
	return null;
}

/**
 * Convert an uploaded file to markdown content and write it to R2 + the
 * DO's memory_files row. Text/markdown files are read directly; everything
 * else goes through `env.AI.toMarkdown()`.
 */
export async function processMemoryUpload(
	env: Env,
	mailboxId: string,
	id: string,
	r2_key: string,
	file: File,
	sourceType: MemorySourceType,
): Promise<void> {
	const stub = getMailboxStub(env, mailboxId) as unknown as MemoryStatusStub;
	try {
		let content: string;
		let tokenCount: number;
		if (sourceType === "text" || sourceType === "markdown") {
			content = await file.text();
			tokenCount = estimateTokens(content);
		} else {
			const [result] = await env.AI.toMarkdown([{ name: file.name, blob: file }], {
				conversionOptions: {
					pdf: { images: { convert: true, maxConvertedImages: 20 } },
					docx: { images: { convert: true, maxConvertedImages: 20 } },
					image: {},
				},
			});
			if (result.format === "error") {
				await stub.updateMemoryFileStatus(id, "error", { error_message: result.error });
				return;
			}
			content = result.data;
			// toMarkdown reports an exact token count for the conversion — prefer
			// it over the char-based estimate used for the text/markdown path.
			tokenCount = result.tokens;
		}

		await env.BUCKET.put(r2_key, content, { httpMetadata: { contentType: "text/markdown" } });
		await stub.updateMemoryFileStatus(id, "ready", {
			content,
			word_count: countWords(content),
			token_count: tokenCount,
		});
		await stub.replaceMemoryChunks(id, chunkMarkdown(content));
	} catch (e) {
		await stub.updateMemoryFileStatus(id, "error", { error_message: (e as Error).message });
	}
}
