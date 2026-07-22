// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/MIT

import { searchMemory, type MemoryHit } from "./memory-search";
import { getMailboxStub } from "./email-helpers";
import type { Env } from "../types";

export interface DraftContextSource {
	id: string;
	title: string;
	excerpt: string;
	heading: string | null;
	source: "keyword" | "semantic" | "pinned";
	citation: string;
	reason: string;
	relevance: number;
}

export interface DraftContextFact {
	id: string;
	kind: string;
	value: string;
	confidence: number | null;
	sourceChunkId: string | null;
}

export interface DraftContextPack {
	sources: DraftContextSource[];
	facts: DraftContextFact[];
	warnings: string[];
	query: string;
	semanticUsed: boolean;
}

type ContextStub = {
	listMemoryFacts: (status?: string) => Promise<Array<{
		id: string;
		kind: string;
		value: string;
		confidence: number | null;
		source_chunk_id: string | null;
	}>>;
};

function toSource(hit: MemoryHit, reason: string): DraftContextSource {
	const title = hit.title || "Untitled memory";
	return {
		id: hit.id,
		title,
		excerpt: hit.snippet,
		heading: hit.heading ?? null,
		source: hit.source,
		citation: `${title}${hit.heading ? ` > ${hit.heading}` : ""}${hit.start_offset != null ? ` (offset ${hit.start_offset})` : ""}`,
		reason,
		relevance: hit.relevance ?? 0.5,
	};
}

/** Build bounded, operator-visible context for drafting without leaking metadata into the email. */
export async function buildDraftContext(
	env: Env,
	mailboxId: string,
	query: string,
	limit = 6,
): Promise<DraftContextPack> {
	const result = await searchMemory(env, mailboxId, query, limit);
	const stub = getMailboxStub(env, mailboxId) as unknown as ContextStub;
	const facts = await stub.listMemoryFacts("confirmed");
	const sources = result.results.map((hit) => toSource(hit, "Matched the email subject, recipient, or body."));
	const warnings: string[] = [];
	if (!result.semanticUsed) warnings.push("Semantic search is unavailable; using exact and keyword matching.");
	if (result.semanticError) warnings.push("Semantic search failed and the result was recovered with keyword search.");
	return {
		sources,
		facts: facts.slice(0, 12).map((fact) => ({
			id: fact.id,
			kind: fact.kind,
			value: fact.value,
			confidence: fact.confidence,
			sourceChunkId: fact.source_chunk_id,
		})),
		warnings,
		query,
		semanticUsed: result.semanticUsed,
	};
}
