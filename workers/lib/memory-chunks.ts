// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { estimateTokens } from "./text-metrics";

export interface MemoryChunk {
	id: string;
	heading: string | null;
	content: string;
	start_offset: number;
	end_offset: number;
	token_count: number;
}

/** Split Markdown into bounded, heading-aware chunks without losing offsets. */
export function chunkMarkdown(content: string, maxCharacters = 1800): MemoryChunk[] {
	const lines = content.split("\n");
	const chunks: MemoryChunk[] = [];
	let heading: string | null = null;
	let buffer = "";
	let start = 0;
	let offset = 0;

	const flush = (end: number) => {
		const text = buffer.trim();
		if (!text) return;
		const leading = buffer.indexOf(text);
		const startOffset = start + Math.max(0, leading);
		chunks.push({
			id: crypto.randomUUID(),
			heading,
			content: text,
			start_offset: startOffset,
			end_offset: Math.max(startOffset + text.length, end),
			token_count: estimateTokens(text),
		});
	};

	for (const line of lines) {
		const lineStart = offset;
		const next = `${line}\n`;
		const isHeading = /^#{1,6}\s+/.test(line);
		if (isHeading) heading = line.replace(/^#{1,6}\s+/, "").trim();
		if (buffer && buffer.length + next.length > maxCharacters) {
			flush(lineStart);
			buffer = "";
			start = lineStart;
		}
		buffer += next;
		offset += next.length;
	}
	flush(content.length);
	return chunks;
}
