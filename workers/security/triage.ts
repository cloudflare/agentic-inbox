// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Layered short-circuit triage. Evaluated BEFORE the LLM classifier so we
 * can skip the expensive stage for obvious-safe or obvious-malicious mail.
 *
 * Four tiers, in order:
 *   0. Folder bypass — per-folder policy (see MailboxSecuritySettings).
 *      If the target folder is configured `skip_all`, short-circuit with a
 *      synthetic allow verdict. If `skip_classifier`, tell the caller to
 *      skip the LLM stage but keep the rest of the pipeline. This tier is
 *      a latency/cost optimisation plus manual trust signal — only the
 *      mailbox owner can configure it, and the pipeline's default target
 *      folder is INBOX, so an attacker cannot direct mail into a bypass
 *      folder without first compromising the owner's filter rules.
 *   1. Hard block — confirmed intel-feed match OR explicitly flagged sender.
 *      Quarantines immediately; classifier never runs.
 *   2. Attachment block — attachment-type gate (see attachments.ts). Blocks
 *      on executable extensions and a user-configured custom blocklist.
 *      Runs BEFORE hard-allow on purpose: a DMARC-passing allowlisted sender
 *      who suddenly attaches a .exe is, by definition, not sending
 *      legitimate mail anymore (account takeover, auto-forwarded malware,
 *      etc.). We'd rather quarantine than let the allowlist paper over it.
 *   3. Hard allow — DMARC pass AND (explicit allowlist OR trusted history).
 *      Returns allow immediately; classifier never runs.
 *
 * Hard-block wins over hard-allow: if someone compromises a trusted sender
 * and sends a URL we already know is malicious, we'd rather quarantine.
 *
 * IMPORTANT INVARIANT: hard-allow REQUIRES DMARC pass. Allowlist alone is
 * never sufficient — that would let anyone spoof the From address of a
 * trusted domain. DMARC pass is the bind between the From header and the
 * actual sending infrastructure. The folder-bypass tier is deliberately
 * independent of this invariant; it reflects an explicit owner decision
 * ("don't scan this folder") rather than a trust claim about the sender.
 */

import type { AuthVerdict } from "./auth";
import type { SenderReputation } from "./reputation";
import type { ClassificationResult } from "./classification";
import type { ExtractedUrl } from "./urls";
import type { FinalVerdict, VerdictThresholds } from "./verdict";
import type { MailboxSecuritySettings } from "./settings";
import type { AttachmentLike } from "./attachments";
import { scoreAttachments } from "./attachments";

export interface IntelMatchInfo {
	matched: true;
	feedId: string;
	value: string;
	confirmed: boolean;
}

export interface TriageInputs {
	sender: string;
	auth: AuthVerdict;
	reputation: SenderReputation | null;
	urls: ExtractedUrl[];
	intelMatch: IntelMatchInfo | null;
	settings: MailboxSecuritySettings;
	/** Folder the message was delivered into. Used by the folder-bypass tier. */
	targetFolder: string;
	/** PostalMime-parsed attachments (filename/mimetype). Empty array is fine. */
	attachments: AttachmentLike[];
}

export interface TriageShortCircuit {
	verdict: FinalVerdict;
	tier: "hard_block" | "hard_allow" | "folder_bypass" | "attachment_block";
	reason: string;
}

/**
 * Return value of `evaluateTriage`. Either tier fires (`shortcircuit`), or
 * the pipeline continues — possibly with the LLM classifier skipped
 * (`skipClassifier` from the folder-bypass `skip_classifier` mode).
 */
export interface TriageResult {
	shortcircuit?: TriageShortCircuit;
	skipClassifier?: boolean;
}

const SKIP_CLASSIFICATION: ClassificationResult = {
	label: "safe",
	confidence: 1.0,
	reasoning: "classifier skipped by triage",
};

export function evaluateTriage(inputs: TriageInputs): TriageResult {
	const { settings } = inputs;

	// Tier 0: folder bypass. Runs first because it reflects an explicit
	// owner decision about a folder; we don't want to spend cycles on
	// hard-block/hard-allow evaluation when the whole folder is opted out.
	const folderPolicy = settings.folder_policies?.[inputs.targetFolder];
	if (folderPolicy?.mode === "skip_all") {
		const reason = `folder policy: skip_all (${inputs.targetFolder})`;
		const verdict: FinalVerdict = {
			action: "allow",
			score: 0,
			explanation: reason,
			auth: inputs.auth,
			classification: { ...SKIP_CLASSIFICATION, reasoning: "pipeline skipped by folder policy" },
			signals: [reason],
		};
		return { shortcircuit: { verdict, tier: "folder_bypass", reason } };
	}
	const skipClassifier = folderPolicy?.mode === "skip_classifier";

	// Tier 1: hard block — runs first (among sender/content tiers) so a
	// compromised-but-allowlisted sender who's sending a known-bad URL still
	// gets stopped.
	if (settings.intel_auto_block) {
		const block = evaluateHardBlock(inputs);
		if (block) return { shortcircuit: block };
	}

	// Tier 2: attachment block — cheap metadata-only check. Runs before
	// hard-allow so a compromised/allowlisted sender carrying an .exe still
	// gets stopped. Hard-allow DMARC invariant is preserved separately.
	const attBlock = evaluateAttachmentGate(inputs);
	if (attBlock) return { shortcircuit: attBlock };

	// Tier 3: hard allow — requires DMARC pass in ALL paths. See invariant above.
	if (settings.trusted_auto_allow) {
		const allow = evaluateHardAllow(inputs);
		if (allow) return { shortcircuit: allow };
	}

	return { skipClassifier };
}

function evaluateAttachmentGate(inputs: TriageInputs): TriageShortCircuit | null {
	if (!inputs.attachments || inputs.attachments.length === 0) return null;
	const policy = inputs.settings.attachment_policy;
	if (!policy) return null;

	const result = scoreAttachments(inputs.attachments, policy);
	if (!result.hardBlock) return null;

	// Note: this tier fires BEFORE hard-allow, so a DMARC-passing allowlisted
	// sender with an executable attachment is still quarantined. That's the
	// intended behaviour — see the module-level docstring for the rationale.
	const reason = result.hardBlockReason ?? result.reasons[0] ?? "attachment blocked";
	const verdict: FinalVerdict = {
		action: "quarantine",
		score: 100,
		explanation: reason,
		auth: inputs.auth,
		classification: { ...SKIP_CLASSIFICATION, label: "suspicious", reasoning: "classifier skipped by attachment-gate triage" },
		signals: result.reasons.length > 0 ? result.reasons : [reason],
	};
	return { verdict, tier: "attachment_block", reason };
}

function evaluateHardBlock(inputs: TriageInputs): TriageShortCircuit | null {
	const reasons: string[] = [];

	if (inputs.reputation?.flagged) {
		reasons.push(`sender flagged (${inputs.sender})`);
	}
	if (inputs.intelMatch?.confirmed) {
		reasons.push(`confirmed intel hit (${inputs.intelMatch.feedId}: ${inputs.intelMatch.value})`);
	}

	if (reasons.length === 0) return null;

	const verdict: FinalVerdict = {
		action: "quarantine",
		score: 100,
		explanation: reasons.join("; "),
		auth: inputs.auth,
		classification: { ...SKIP_CLASSIFICATION, label: "phishing", reasoning: "classifier skipped by hard-block triage" },
		signals: reasons,
	};
	return { verdict, tier: "hard_block", reason: reasons.join("; ") };
}

function evaluateHardAllow(inputs: TriageInputs): TriageShortCircuit | null {
	// CRITICAL INVARIANT: require DMARC pass. Without it, anyone can spoof
	// the From: address of a trusted domain.
	if (inputs.auth.dmarc !== "pass") return null;

	const senderMatch = inputs.settings.allowlist_senders.includes(inputs.sender);
	const domain = inputs.sender.split("@")[1] ?? "";
	const domainMatch = domain.length > 0 &&
		(inputs.settings.allowlist_domains.includes(domain) ||
			inputs.settings.allowlist_domains.some((d) => domain.endsWith("." + d)));

	const reasons: string[] = [];
	if (senderMatch) reasons.push(`sender on allowlist (${inputs.sender})`);
	else if (domainMatch) reasons.push(`domain on allowlist (${domain})`);
	else {
		// History-based hard-allow: long-standing trusted sender.
		const minMsgs = inputs.settings.trusted_auto_allow_min_messages;
		const rep = inputs.reputation;
		if (
			minMsgs > 0 &&
			rep &&
			!rep.flagged &&
			rep.message_count >= minMsgs &&
			rep.avg_score < 20
		) {
			reasons.push(`trusted history (${rep.message_count} msgs, avg ${rep.avg_score.toFixed(0)})`);
		} else {
			return null;
		}
	}
	reasons.push("DMARC pass");

	const verdict: FinalVerdict = {
		action: "allow",
		score: 0,
		explanation: reasons.join("; "),
		auth: inputs.auth,
		classification: SKIP_CLASSIFICATION,
		signals: reasons,
	};
	return { verdict, tier: "hard_allow", reason: reasons.join("; ") };
}
