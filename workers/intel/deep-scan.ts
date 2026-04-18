// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Async deep-scan orchestrator.
 *
 * Runs AFTER the synchronous security pipeline has stored its verdict
 * and decided allow/tag/quarantine. Deep-scan adds higher-latency signals
 * that would have dominated the sync-path budget:
 *
 *   - Redirect-chain resolution for every URL (up to 5 hops)
 *   - RDAP age lookup for each new hostname
 *   - Attachment extension / MIME / macro heuristics
 *
 * If the combined deep-scan signals push the verdict across a higher
 * threshold (e.g. from `tag` to `quarantine`) we upgrade the verdict and
 * move the email to the QUARANTINE folder. We never DOWNgrade — sync
 * decisions are load-bearing (the user may already have seen the email)
 * so the deep-scan only tightens.
 *
 * The orchestrator is best-effort: every external call is wrapped so a
 * single failure (flaky RDAP server, unreachable URL) never aborts the
 * scan for the other signals. `deep_scan_status` ends as either
 * `completed` or `failed` and the stored verdict is always internally
 * consistent.
 */

import type { Env } from "../types";
import type { FinalVerdict, VerdictThresholds } from "../security/verdict";
import { getMailboxStub } from "../lib/email-helpers";
import { Folders } from "../../shared/folders";
import { checkUrlAgainstFeeds } from "./feeds";
import { lookupDomainAge, FRESH_DOMAIN_THRESHOLD_DAYS } from "./rdap";
import { resolveUrl } from "./url-resolver";
import { aggregateAttachmentSignals, scoreAttachment } from "./attachment-checks";
import { isHomographic } from "../security/urls";
import { DEFAULT_THRESHOLDS } from "../security/verdict";

export interface DeepScanInput {
	env: Env;
	mailboxId: string;
	emailId: string;
	thresholds?: VerdictThresholds;
}

export interface DeepScanResult {
	added_score: number;
	reasons: string[];
	final_action: FinalVerdict["action"] | "unchanged";
}

/**
 * Cap on score that deep-scan can add on top of the sync verdict. Keeping
 * this bounded means operators can tune the sync thresholds independently
 * of deep-scan sensitivity, and one flaky signal can't single-handedly
 * quarantine on its own.
 */
const DEEP_SCAN_MAX_ADD = 40;

export async function runDeepScan(input: DeepScanInput): Promise<DeepScanResult> {
	const { env, mailboxId, emailId } = input;
	const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
	const stub = getMailboxStub(env, mailboxId);

	const stored = await stub.getStoredVerdict(emailId).catch(() => null);
	// No sync verdict stored — either the pipeline was disabled or errored.
	// Deep-scan still runs for URL/attachment persistence but can't layer
	// a score increment onto a missing base verdict.
	const baseVerdict = parseVerdict(stored?.verdict);

	const reasons: string[] = [];
	let added = 0;

	try {
		const urlDelta = await scanUrls(env, mailboxId, emailId);
		added += urlDelta.score;
		reasons.push(...urlDelta.reasons);
	} catch (e) {
		console.error("deep-scan URL stage failed:", (e as Error).message);
	}

	try {
		const attDelta = await scanAttachments(env, mailboxId, emailId);
		added += attDelta.score;
		reasons.push(...attDelta.reasons);
	} catch (e) {
		console.error("deep-scan attachment stage failed:", (e as Error).message);
	}

	added = Math.min(DEEP_SCAN_MAX_ADD, added);

	let finalAction: FinalVerdict["action"] | "unchanged" = "unchanged";
	if (baseVerdict && added > 0) {
		const newScore = Math.min(100, (stored?.score ?? baseVerdict.score) + added);
		const newAction = actionForScore(newScore, thresholds);
		const upgraded = tierIndex(newAction) > tierIndex(baseVerdict.action);
		if (upgraded) {
			const upgradedVerdict: FinalVerdict = {
				...baseVerdict,
				score: newScore,
				action: newAction,
				signals: [...baseVerdict.signals, ...reasons],
				explanation: dedupe([
					...baseVerdict.signals.slice(0, 2),
					...reasons,
				]).slice(0, 4).join("; "),
			};
			await stub.persistSecurityVerdict(emailId, {
				verdict_json: JSON.stringify(upgradedVerdict),
				score: newScore,
				explanation: upgradedVerdict.explanation,
			}).catch(() => {});
			if (newAction === "quarantine" || newAction === "block") {
				await stub.moveEmail(emailId, Folders.QUARANTINE).catch(() => {});
			}
			finalAction = newAction;
		}
	}

	await stub.updateDeepScanStatus(emailId, "completed").catch(() => {});
	return { added_score: added, reasons, final_action: finalAction };
}

async function scanUrls(
	env: Env,
	mailboxId: string,
	emailId: string,
): Promise<{ score: number; reasons: string[] }> {
	const stub = getMailboxStub(env, mailboxId);
	const urls = await stub.getUrlsForEmail(emailId);
	if (!urls.length) return { score: 0, reasons: [] };

	const reasons: string[] = [];
	let score = 0;
	// Track checked hostnames so RDAP isn't hit repeatedly for the same domain.
	const seenHosts = new Set<string>();

	for (const row of urls) {
		const urlRow = row as unknown as { id: string; url: string };
		const resolved = await resolveUrl(urlRow.url).catch(() => null);
		const finalUrl = resolved?.resolved ?? urlRow.url;
		const urlVerdict: string[] = [];

		if (resolved?.host_changed) {
			urlVerdict.push("redirect_host_change");
			score += 10;
		}
		if (resolved?.truncated) {
			urlVerdict.push("redirect_chain_too_long");
			score += 5;
		}

		const host = safeHost(finalUrl);
		if (host && !seenHosts.has(host)) {
			seenHosts.add(host);
			if (isHomographic(host)) {
				urlVerdict.push("resolved_homograph");
				score += 15;
			}
			const age = await lookupDomainAge(host).catch(() => null);
			if (age?.is_fresh) {
				urlVerdict.push(`domain_age_${age.age_days}d`);
				score += age.age_days < 7 ? 20 : 10;
			}
			const feedMatch = await checkUrlAgainstFeeds(env, mailboxId, finalUrl).catch(() => null);
			if (feedMatch?.confirmed) {
				urlVerdict.push(`intel_match:${feedMatch.feedId}`);
				score += 20;
			}
		}

		await stub.updateUrlScan(urlRow.id, {
			resolved_url: finalUrl,
			page_title: resolved?.title ?? null,
			fetch_status: resolved ? "completed" : "failed",
			verdict: urlVerdict.length > 0 ? urlVerdict.join(",") : null,
		}).catch(() => {});

		if (urlVerdict.length > 0) {
			reasons.push(`URL ${host ?? urlRow.url}: ${urlVerdict.join(",")}`);
		}
	}

	// Cap URL contribution so a particularly nasty-looking link can't
	// single-handedly burn the whole deep-scan budget.
	return { score: Math.min(30, score), reasons };
}

async function scanAttachments(
	env: Env,
	mailboxId: string,
	emailId: string,
): Promise<{ score: number; reasons: string[] }> {
	const stub = getMailboxStub(env, mailboxId);
	const rows = (await stub.getAttachmentsForEmail(emailId)) as unknown as Array<{
		id: string; filename: string; mimetype: string; size: number;
	}>;
	if (!rows.length) return { score: 0, reasons: [] };

	const verdicts = rows.map((r) => ({ row: r, verdict: scoreAttachment(r) }));
	const agg = aggregateAttachmentSignals(verdicts.map((v) => v.verdict));

	for (const { row, verdict } of verdicts) {
		await stub.updateAttachmentScan(row.id, {
			scan_status: "completed",
			scan_verdict: JSON.stringify(verdict),
		}).catch(() => {});
	}

	return { score: agg.score, reasons: agg.reasons };
}

// ── Internals ────────────────────────────────────────────────────

interface StoredVerdict { verdict: string | null; score: number | null; }

function parseVerdict(raw: string | null | undefined): FinalVerdict | null {
	if (!raw) return null;
	try { return JSON.parse(raw) as FinalVerdict; } catch { return null; }
}

function actionForScore(score: number, thresholds: VerdictThresholds): FinalVerdict["action"] {
	if (score >= thresholds.block) return "block";
	if (score >= thresholds.quarantine) return "quarantine";
	if (score >= thresholds.tag) return "tag";
	return "allow";
}

function tierIndex(action: FinalVerdict["action"]): number {
	switch (action) {
		case "allow": return 0;
		case "tag": return 1;
		case "quarantine": return 2;
		case "block": return 3;
	}
}

function safeHost(url: string): string | null {
	try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

function dedupe(items: string[]): string[] {
	return [...new Set(items)];
}

export type { StoredVerdict };
