// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Synchronous security pipeline. Runs inline during `receiveEmail()` between
 * the email being stored to INBOX and the agent auto-draft trigger. Returns
 * a verdict; the caller decides whether to move to QUARANTINE.
 *
 * Staged so latency stays bounded:
 *   1. Parse SPF/DKIM/DMARC from raw headers               (µs)
 *   2. Sender reputation lookup (per-mailbox SQLite)        (ms)
 *   3. URL extraction + homograph/shortener heuristics      (ms)
 *   4. LLM classification (Workers AI, 5s timeout)          (seconds)
 *   5. Aggregate verdict (pure scoring function)            (µs)
 *   6. Persist verdict + URLs + sender reputation           (ms)
 *
 * Async deep-scan (attachment OCR, URL fetch, RDAP) is enqueued by the caller
 * once `workers/intel/deep-scan.ts` is wired up — out of scope for this
 * module so the sync path has no dependency on Queue bindings.
 */

import type { Env } from "../types";
import { getMailboxStub } from "../lib/email-helpers";
import { parseAuthResults } from "./auth";
import { classifyEmail } from "./classification";
import { extractUrls } from "./urls";
import { aggregateVerdict, type FinalVerdict } from "./verdict";
import { getSecuritySettings } from "./settings";
import { checkUrlAgainstFeeds, type FeedMatch } from "../intel/feeds";
import { evaluateTriage, type IntelMatchInfo } from "./triage";
import type { AttachmentLike } from "./attachments";
import { scoreOffHours } from "./time-rules";
import type { VerdictThresholds } from "./verdict";

/**
 * Apply a post-aggregation score bump and recompute the action tier and
 * explanation. Used for signals that only fire after the main verdict has
 * been computed (intel feed hits, off-hours delivery).
 */
function applyBoost(
	verdict: FinalVerdict,
	boost: number,
	reason: string,
	thresholds: VerdictThresholds,
): FinalVerdict {
	const newScore = Math.min(100, verdict.score + boost);
	const action: FinalVerdict["action"] = newScore >= thresholds.block ? "block"
		: newScore >= thresholds.quarantine ? "quarantine"
		: newScore >= thresholds.tag ? "tag"
		: "allow";
	const signals = [...verdict.signals, reason];
	return {
		...verdict,
		score: newScore,
		action,
		signals,
		explanation: signals.slice(0, 4).join("; "),
	};
}

export interface RunPipelineInput {
	env: Env;
	mailboxId: string;
	messageId: string;
	/** Folder the message was delivered into. Drives the folder-bypass triage tier. */
	targetFolder: string;
	parsedEmail: {
		subject?: string;
		from?: { address?: string };
		html?: string;
		text?: string;
		headers?: unknown;
		attachments?: AttachmentLike[];
	};
}

export interface PipelineResult {
	/** Null means the pipeline was skipped (security disabled for this mailbox). */
	verdict: FinalVerdict | null;
	skipped: boolean;
}

export async function runSecurityPipeline(input: RunPipelineInput): Promise<PipelineResult> {
	const { env, mailboxId, messageId, parsedEmail, targetFolder } = input;
	const settings = await getSecuritySettings(env, mailboxId);
	if (!settings.enabled) return { verdict: null, skipped: true };

	const sender = (parsedEmail.from?.address || "").toLowerCase();
	const bodyHtml = parsedEmail.html || parsedEmail.text || "";
	const subject = parsedEmail.subject || "";
	const attachments = parsedEmail.attachments ?? [];

	// Cheap signals first — all below run in parallel-friendly order and
	// complete in milliseconds. The classifier LLM call is the expensive
	// stage (seconds); the triage tier checks below let us skip it entirely
	// for clear-cut cases.
	const auth = parseAuthResults(parsedEmail.headers, {
		trustedAuthservIds: settings.trusted_authserv_ids,
	});
	const urls = extractUrls(bodyHtml);

	// Intel feed lookup — first confirmed hit wins. Kept early (pre-triage)
	// so the hard-block tier can short-circuit on it.
	let intelMatch: FeedMatch | null = null;
	for (const u of urls) {
		const m = await checkUrlAgainstFeeds(env, mailboxId, u.url).catch(() => null);
		if (!m) continue;
		// Prefer confirmed over bloom-only; stop as soon as we have a confirmed hit.
		if (m.confirmed) { intelMatch = m; break; }
		if (!intelMatch) intelMatch = m;
	}
	const intelForTriage: IntelMatchInfo | null = intelMatch?.confirmed
		? { matched: true, feedId: intelMatch.feedId, value: intelMatch.value, confirmed: true }
		: null;

	const stub = getMailboxStub(env, mailboxId);
	const reputation = sender ? await stub.getSenderReputation(sender) : null;

	// Triage tiers — may short-circuit the pipeline before we ever touch the LLM.
	// See workers/security/triage.ts for the rules and invariants.
	const triaged = evaluateTriage({
		sender,
		auth,
		reputation,
		urls,
		intelMatch: intelForTriage,
		settings,
		targetFolder,
		attachments,
	});
	if (triaged.shortcircuit) {
		const sc = triaged.shortcircuit;
		let verdict: FinalVerdict = { ...sc.verdict, triage: sc.tier };
		// Learning mode still applies — even a hard-block is downgraded to tag.
		if (settings.learning_mode && (verdict.action === "quarantine" || verdict.action === "block")) {
			verdict = { ...verdict, action: "tag" };
		}
		await persistAll(env, mailboxId, messageId, sender, verdict, urls);
		return { verdict, skipped: false };
	}

	// Full path: LLM classification (possibly skipped by folder-bypass tier) + aggregation.
	const classification = triaged.skipClassifier
		? { label: "safe" as const, confidence: 1.0, reasoning: "classifier skipped by folder policy" }
		: await classifyEmail(env.AI, { subject, sender, bodyHtml, auth });

	let verdict = aggregateVerdict(
		{ auth, classification, urls, reputation },
		settings.thresholds,
	);

	// Intel-feed boost. Confirmed hit bumps score by 20; unconfirmed bloom-only
	// hit bumps by 5 (low-signal — bloom FPR is configured at ~1%).
	const intelBoost = intelMatch?.confirmed ? 20 : intelMatch ? 5 : 0;
	if (intelBoost > 0 && intelMatch) {
		const label = intelMatch.confirmed ? "threat-intel match" : "threat-intel match (unconfirmed)";
		const reason = `${label} (${intelMatch.feedId}: ${intelMatch.value})`;
		verdict = applyBoost(verdict, intelBoost, reason, settings.thresholds);
	}

	// Off-hours boost. Small nudge (+10) so it can only tilt borderline verdicts.
	const offHours = scoreOffHours(settings.business_hours);
	if (offHours.score > 0) {
		verdict = applyBoost(verdict, offHours.score, offHours.reasons[0], settings.thresholds);
	}

	// Learning mode never quarantines/blocks — cap at "tag".
	if (settings.learning_mode && (verdict.action === "quarantine" || verdict.action === "block")) {
		verdict = { ...verdict, action: "tag" };
	}

	await persistAll(env, mailboxId, messageId, sender, verdict, urls);
	return { verdict, skipped: false };
}

/**
 * Persist verdict + URL rows + sender reputation update. Best-effort: each
 * step catches its own errors so a single failure doesn't lose the verdict
 * for the caller.
 */
async function persistAll(
	env: Env,
	mailboxId: string,
	messageId: string,
	sender: string,
	verdict: FinalVerdict,
	urls: ReturnType<typeof extractUrls>,
) {
	const stub = getMailboxStub(env, mailboxId);
	try {
		await stub.persistSecurityVerdict(messageId, {
			verdict_json: JSON.stringify(verdict),
			score: verdict.score,
			explanation: verdict.explanation,
		});
	} catch (e) {
		console.error("persistSecurityVerdict failed:", (e as Error).message);
	}

	if (urls.length > 0) {
		try {
			await stub.insertUrls(
				messageId,
				urls.map((u) => ({
					url: u.url,
					display_text: u.display_text ?? null,
					is_homograph: u.is_homograph ? 1 : 0,
					is_shortener: u.is_shortener ? 1 : 0,
				})),
			);
		} catch (e) {
			console.error("insertUrls failed:", (e as Error).message);
		}
	}

	if (sender) {
		try {
			await stub.upsertSenderReputation(sender, verdict.score);
		} catch (e) {
			console.error("upsertSenderReputation failed:", (e as Error).message);
		}
	}
}

export type { FinalVerdict } from "./verdict";
export type { AuthVerdict } from "./auth";
export type { ClassificationResult } from "./classification";
