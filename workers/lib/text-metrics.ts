// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Count whitespace-separated words in a string. */
export function countWords(text: string): number {
	const trimmed = text.trim();
	return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Rough token estimate (~4 chars/token) for content without an exact count from toMarkdown. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
