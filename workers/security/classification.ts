// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * LLM-based content classification. One structured-output call per email.
 *
 * Tool-using agent triage (fetchUrlPreview, getSenderHistory, etc.) is layered
 * on later — see `workers/security/tools.ts` (added in a follow-up milestone).
 * The synchronous pipeline keeps latency bounded by avoiding tool loops here.
 */

import { stripHtmlToText } from "../lib/email-helpers";
import type { AuthVerdict } from "./auth";

export type ClassificationLabel =
	| "safe"
	| "spam"
	| "phishing"
	| "bec"
	| "suspicious";

export interface ClassificationResult {
	label: ClassificationLabel;
	confidence: number;
	reasoning: string;
}

const SYSTEM_PROMPT = `You are an email security classifier. Classify the email into exactly ONE label and return a confidence and short reasoning.

Labels:
- safe: a normal email (newsletter, personal, business correspondence, automated transactional)
- spam: unsolicited bulk/marketing content with no malicious intent
- phishing: credential theft, fake login, malicious link, impersonates a known brand or service
- bec: business email compromise — impersonates an executive, vendor, colleague to request wire transfer / gift cards / changes to banking details
- suspicious: worrying signals but not clearly malicious; err here instead of safe when in doubt

Return STRICT JSON in this exact shape:
{"label": "safe"|"spam"|"phishing"|"bec"|"suspicious", "confidence": 0.0-1.0, "reasoning": "one short sentence"}

No prose, no code fences, no preamble — just the JSON object.`;

export interface ClassifyInput {
	subject: string;
	sender: string;
	bodyHtml: string;
	auth: AuthVerdict;
}

/**
 * Test-only seam: implementations can be injected via `__setClassifier` to
 * bypass the Workers AI call. This is NOT part of the runtime contract and
 * must not be used from production code paths. Tests reset the override to
 * `null` on teardown.
 */
export type ClassifierImpl = (ai: Ai, input: ClassifyInput) => Promise<ClassificationResult>;
let overrideClassifier: ClassifierImpl | null = null;
export function __setClassifier(impl: ClassifierImpl | null) {
	overrideClassifier = impl;
}

export async function classifyEmail(
	ai: Ai,
	input: ClassifyInput,
): Promise<ClassificationResult> {
	if (overrideClassifier) return overrideClassifier(ai, input);
	const plain = stripHtmlToText(input.bodyHtml || "").slice(0, 4000);
	const userMessage = `SENDER: ${input.sender}
AUTH: spf=${input.auth.spf} dkim=${input.auth.dkim} dmarc=${input.auth.dmarc}
SUBJECT: ${input.subject || "(no subject)"}

BODY:
${plain}`;

	try {
		const response = (await Promise.race([
			ai.run(
				"@cf/meta/llama-3.1-8b-instruct-fast",
				{
					messages: [
						{ role: "system", content: SYSTEM_PROMPT },
						{ role: "user", content: userMessage },
					],
					max_tokens: 200,
					temperature: 0,
				},
			),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error("classify-timeout")), 5000),
			),
		])) as { response?: string };

		return parseClassifierOutput(response?.response ?? "");
	} catch (e) {
		// Fail closed: unparsable / unavailable classifier → suspicious.
		// We do NOT quarantine solely on classifier failure; the verdict
		// aggregator combines with auth / URL / reputation signals.
		console.error("classifyEmail failed:", (e as Error).message);
		return { label: "suspicious", confidence: 0.3, reasoning: "classifier unavailable" };
	}
}

function parseClassifierOutput(raw: string): ClassificationResult {
	const trimmed = raw.trim();
	// Try to locate the first { ... } block if the model wrapped it.
	const match = trimmed.match(/\{[\s\S]*\}/);
	if (!match) {
		return { label: "suspicious", confidence: 0.3, reasoning: "classifier output not JSON" };
	}
	try {
		const obj = JSON.parse(match[0]);
		const label = normalizeLabel(obj.label);
		const confidence = typeof obj.confidence === "number"
			? Math.max(0, Math.min(1, obj.confidence))
			: 0.5;
		const reasoning = typeof obj.reasoning === "string" ? obj.reasoning.slice(0, 500) : "";
		return { label, confidence, reasoning };
	} catch {
		return { label: "suspicious", confidence: 0.3, reasoning: "classifier output malformed" };
	}
}

function normalizeLabel(raw: unknown): ClassificationLabel {
	if (typeof raw !== "string") return "suspicious";
	const s = raw.toLowerCase().trim();
	if (s === "safe" || s === "spam" || s === "phishing" || s === "bec" || s === "suspicious") {
		return s;
	}
	return "suspicious";
}

export function scoreClassification(result: ClassificationResult): { score: number; reasons: string[] } {
	const map: Record<ClassificationLabel, number> = {
		safe: 0, spam: 20, suspicious: 30, bec: 45, phishing: 50,
	};
	const base = map[result.label];
	// Scale slightly by confidence so low-confidence high-severity labels
	// don't slam the score; high-confidence safe stays at zero.
	const scaled = Math.round(base * (0.5 + 0.5 * result.confidence));
	const reasons = result.label === "safe"
		? []
		: [`classifier: ${result.label} (${Math.round(result.confidence * 100)}%)`];
	return { score: scaled, reasons };
}
