// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/MIT

import { generateText } from "ai";
import { getModelForMailbox } from "./ai-provider";
import { getMailboxStub } from "./email-helpers";
import type { Env } from "../types";

const MAX_CONTENT_CHARS = 16_000;

interface ExtractedFact {
	kind: string;
	value: string;
	confidence?: number;
}

type FactStub = {
	getMemoryFile: (id: string) => Promise<{ content?: string } | null>;
	getFirstMemoryChunkId: (fileId: string) => Promise<string | null>;
	createMemoryFact: (params: { id: string; kind: string; value: string; confidence?: number; source_chunk_id?: string }) => Promise<unknown>;
};

function parseFacts(text: string): ExtractedFact[] {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
	try {
		const parsed = JSON.parse(fenced);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((fact): fact is ExtractedFact =>
			fact && typeof fact === "object" && typeof fact.kind === "string" && typeof fact.value === "string",
		).slice(0, 20);
	} catch {
		return [];
	}
}

/** Extracts reviewable facts; all results remain suggested until confirmed by the operator. */
export async function extractMemoryFacts(env: Env, mailboxId: string, fileId: string): Promise<void> {
	const stub = getMailboxStub(env, mailboxId) as unknown as FactStub;
	const file = await stub.getMemoryFile(fileId);
	if (!file?.content?.trim()) return;
	const model = await getModelForMailbox(env, mailboxId);
	const result = await generateText({
		model,
		system: "Extract only explicit, useful facts from the document. Return a JSON array of objects with kind, value, and confidence from 0 to 100. Do not infer or invent. If none, return [].",
		messages: [{ role: "user", content: file.content.slice(0, MAX_CONTENT_CHARS) }],
	});
	const sourceChunkId = await stub.getFirstMemoryChunkId(fileId);
	for (const fact of parseFacts(result.text)) {
		await stub.createMemoryFact({
			id: crypto.randomUUID(),
			kind: fact.kind.slice(0, 80),
			value: fact.value.slice(0, 1000),
			confidence: Math.max(0, Math.min(100, Math.round(fact.confidence ?? 50))),
			source_chunk_id: sourceChunkId ?? undefined,
		});
	}
}
