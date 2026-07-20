// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Dual-path memory search: SQL LIKE keyword search (always available) merged
 * with Cloudflare AI Search semantic search (optional, requires
 * `env.AI_SEARCH_INSTANCE_ID` to be configured). Uses the current
 * `env.AI.aiSearch` API, not the deprecated `env.AI.autorag(...)`.
 */
import { getMailboxStub } from "./email-helpers";
import type { Env } from "../types";

export interface MemoryHit {
	id: string;
	title: string | null;
	tags: string | null;
	snippet: string;
	source: "keyword" | "semantic";
	heading?: string | null;
	start_offset?: number;
	source_kind?: string;
	source_uri?: string | null;
	relevance?: number;
}

interface MemoryFileRow {
	id: string;
	title: string | null;
	tags: string | null;
	snippet: string;
	heading?: string | null;
	start_offset?: number;
	source_kind?: string;
	source_uri?: string | null;
}

type MemoryStub = {
	searchMemoryKeyword: (query: string, limit?: number) => Promise<MemoryFileRow[]>;
	getMemoryFileIds: (ids: string[]) => Promise<MemoryFileRow[]>;
};

/**
 * Extracts the memory file id from an R2 key of the form
 * `memory/{mailboxId}/{id}.md`. AI Search chunk results reference the
 * source object via `item.key`, which is this same R2 key.
 */
function memoryIdFromR2Key(key: string | undefined): string | undefined {
	return key?.match(/\/([^/]+)\.md$/)?.[1];
}

export async function searchMemory(
	env: Env,
	mailboxId: string,
	query: string,
	limit = 10,
): Promise<{ results: MemoryHit[]; semanticUsed: boolean; semanticError?: string }> {
	const stub = getMailboxStub(env, mailboxId) as unknown as MemoryStub;
	const keywordRows = await stub.searchMemoryKeyword(query, limit);
	const keywordHits: MemoryHit[] = keywordRows.map((r) => ({
		id: r.id,
		title: r.title,
		tags: r.tags,
		snippet: r.snippet,
		source: "keyword" as const,
		heading: r.heading,
		start_offset: r.start_offset,
		source_kind: r.source_kind,
		source_uri: r.source_uri,
		relevance: 1,
	}));

	let semanticHits: MemoryHit[] = [];
	let semanticUsed = false;
	let semanticError: string | undefined;

	const instanceId = env.AI_SEARCH_INSTANCE_ID;
	if (instanceId) {
		try {
			const res = await env.AI.aiSearch().get(instanceId).search({
				messages: [{ role: "user", content: query }],
				ai_search_options: { retrieval: { max_num_results: limit } },
			});
			const candidateIds = res.chunks
				.map((chunk) => memoryIdFromR2Key(chunk.item?.key))
				.filter((id): id is string => !!id);

			if (candidateIds.length > 0) {
				// AI Search may index content from other mailboxes sharing the
				// same instance/bucket. Cross-check against this mailbox's own
				// memory_files table to enforce isolation, since the retrieval
				// API has no confirmed mailbox-scoped filter option.
				const known = await stub.getMemoryFileIds(candidateIds);
				semanticHits = known.map((r) => ({
					id: r.id,
					title: r.title,
					tags: r.tags,
					snippet: r.snippet,
					source: "semantic" as const,
					relevance: 0.9,
				}));
			}
			semanticUsed = true;
		} catch (e) {
			semanticError = (e as Error).message;
			console.warn("AI Search failed, degrading to keyword-only:", semanticError);
		}
	}

	// Semantic hits are inserted first so a duplicate id keeps its semantic
	// (higher-ranked) copy; keyword-only hits fill the remainder up to limit.
	const seen = new Set<string>();
	const merged: MemoryHit[] = [];
	for (const hit of [...semanticHits, ...keywordHits]) {
		if (seen.has(hit.id)) continue;
		seen.add(hit.id);
		merged.push(hit);
	}

	return { results: merged.slice(0, limit), semanticUsed, semanticError };
}
