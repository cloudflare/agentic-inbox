// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Deep-scan integration coverage for the RDAP fresh-domain path. Live
 * end-to-end testing was unable to drive the RDAP-only signal in isolation
 * (every recently-registered domain we could find was also on a threat
 * intel feed), so this test pins the contract: when `lookupDomainAge`
 * returns `is_fresh`, `runDeepScan` produces a `domain_age_Nd` reason and
 * the score increment lands on the stored verdict.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDeepScan } from "../../workers/intel/deep-scan";
import type { Env } from "../../workers/types";

interface UrlRow {
	id: string;
	url: string;
	resolved_url: string | null;
	verdict: string | null;
	fetch_status: string | null;
	page_title: string | null;
}

function makeStub(initialUrls: UrlRow[]) {
	const urls = new Map(initialUrls.map((u) => [u.id, u]));
	const verdicts = new Map<string, { verdict_json: string; score: number; explanation: string }>();
	const moves: Array<{ id: string; folderId: string }> = [];
	const deepScanStatus = new Map<string, string>();

	verdicts.set("email-1", {
		verdict_json: JSON.stringify({
			action: "tag",
			score: 25,
			explanation: "classifier: suspicious",
			auth: { spf: "none", dkim: "none", dmarc: "none" },
			classification: { label: "suspicious", confidence: 0.7, reasoning: "stub" },
			signals: ["classifier: suspicious"],
		}),
		score: 25,
		explanation: "classifier: suspicious",
	});

	const stub = {
		async getStoredVerdict(emailId: string) {
			const row = verdicts.get(emailId);
			return row ? { verdict: row.verdict_json, score: row.score, explanation: row.explanation } : null;
		},
		async getUrlsForEmail(_emailId: string) {
			return Array.from(urls.values());
		},
		async getAttachmentsForEmail(_emailId: string) {
			return [];
		},
		async updateUrlScan(urlId: string, data: Partial<UrlRow>) {
			const existing = urls.get(urlId);
			if (existing) urls.set(urlId, { ...existing, ...data });
		},
		async persistSecurityVerdict(emailId: string, data: { verdict_json: string; score: number; explanation: string }) {
			verdicts.set(emailId, data);
		},
		async moveEmail(id: string, folderId: string) {
			moves.push({ id, folderId });
		},
		async updateDeepScanStatus(emailId: string, status: string) {
			deepScanStatus.set(emailId, status);
		},
	};

	return { stub, urls, verdicts, moves, deepScanStatus };
}

function makeFakeEnv(stub: unknown): Env {
	const ns = {
		idFromName: () => ({ toString: () => "email-1" } as unknown as DurableObjectId),
		get: () => stub as unknown as DurableObjectStub,
	} as unknown as DurableObjectNamespace;
	return { MAILBOX: ns } as unknown as Env;
}

/**
 * Build a fake `fetch` that returns canned bodies depending on the URL.
 * `resolveUrl` is forced to bail out (404 on HEAD) so the test isolates the
 * RDAP-age path; the URL handler also has to be tolerant of the GET that
 * `resolveUrl` issues for the page title.
 */
function buildFakeFetch(rdapBody: object) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith("https://rdap.org/")) {
			return new Response(JSON.stringify(rdapBody), {
				status: 200,
				headers: { "content-type": "application/rdap+json" },
			});
		}
		// resolveUrl HEAD/GET on the original URL: respond 404 so it returns null.
		return new Response("not found", { status: 404 });
	});
}

describe("runDeepScan — RDAP fresh-domain integration", () => {
	const realFetch = globalThis.fetch;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-26T12:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.fetch = realFetch;
	});

	it("adds +20 and a domain_age_Nd reason for a domain registered <7 days ago", async () => {
		const { stub, verdicts, moves } = makeStub([
			{
				id: "url-1",
				url: "https://just-registered-2026.example/login",
				resolved_url: null,
				verdict: null,
				fetch_status: null,
				page_title: null,
			},
		]);
		globalThis.fetch = buildFakeFetch({
			events: [{ eventAction: "registration", eventDate: "2026-04-22T00:00:00Z" }],
		});

		const result = await runDeepScan({
			env: makeFakeEnv(stub),
			mailboxId: "test@example.com",
			emailId: "email-1",
		});

		expect(result.added_score).toBeGreaterThanOrEqual(20);
		expect(result.reasons.join(" ")).toMatch(/domain_age_4d/);
		// Sync verdict was tag(25); +20 → 45. Default thresholds are
		// tag=30, quarantine=60, block=80, so action should still be `tag`
		// (unchanged) — the score landed but didn't tip the action.
		const stored = verdicts.get("email-1")!;
		expect(stored.score).toBe(25);
		expect(result.final_action).toBe("unchanged");
		expect(moves).toEqual([]);
	});

	it("uses the lower +10 weight for a domain in the 7-29 day window", async () => {
		const { stub } = makeStub([
			{
				id: "url-1",
				url: "https://aged-but-fresh.example/x",
				resolved_url: null,
				verdict: null,
				fetch_status: null,
				page_title: null,
			},
		]);
		globalThis.fetch = buildFakeFetch({
			// 14 days before the fake "now" (2026-04-26).
			events: [{ eventAction: "registration", eventDate: "2026-04-12T00:00:00Z" }],
		});

		const result = await runDeepScan({
			env: makeFakeEnv(stub),
			mailboxId: "test@example.com",
			emailId: "email-1",
		});

		expect(result.added_score).toBe(10);
		expect(result.reasons.join(" ")).toMatch(/domain_age_14d/);
	});

	it("upgrades the action and quarantines when the boost crosses a threshold", async () => {
		const { stub, verdicts, moves } = makeStub([
			{
				id: "url-1",
				url: "https://fresh.example/x",
				resolved_url: null,
				verdict: null,
				fetch_status: null,
				page_title: null,
			},
		]);
		// Override the seeded sync verdict to be just below quarantine (45);
		// +20 from a fresh domain pushes to 65 which crosses quarantine=60.
		verdicts.set("email-1", {
			verdict_json: JSON.stringify({
				action: "tag",
				score: 45,
				explanation: "classifier: suspicious",
				auth: { spf: "none", dkim: "none", dmarc: "none" },
				classification: { label: "suspicious", confidence: 0.7, reasoning: "stub" },
				signals: ["classifier: suspicious"],
			}),
			score: 45,
			explanation: "classifier: suspicious",
		});
		globalThis.fetch = buildFakeFetch({
			events: [{ eventAction: "registration", eventDate: "2026-04-25T00:00:00Z" }],
		});

		const result = await runDeepScan({
			env: makeFakeEnv(stub),
			mailboxId: "test@example.com",
			emailId: "email-1",
		});

		expect(result.final_action).toBe("quarantine");
		expect(moves).toEqual([{ id: "email-1", folderId: "quarantine" }]);
		expect(verdicts.get("email-1")!.score).toBe(65);
	});

	it("ignores aged domains (>30 days) — no boost, no signal", async () => {
		const { stub } = makeStub([
			{
				id: "url-1",
				url: "https://established.example/x",
				resolved_url: null,
				verdict: null,
				fetch_status: null,
				page_title: null,
			},
		]);
		globalThis.fetch = buildFakeFetch({
			events: [{ eventAction: "registration", eventDate: "2018-01-01T00:00:00Z" }],
		});

		const result = await runDeepScan({
			env: makeFakeEnv(stub),
			mailboxId: "test@example.com",
			emailId: "email-1",
		});

		expect(result.added_score).toBe(0);
		expect(result.reasons.join(" ")).not.toMatch(/domain_age/);
	});
});
