// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox-level security settings, stored inline in `mailboxes/{id}.json`.
 *
 * Read-only helper — writes go through the existing mailbox settings route.
 * New fields are optional so older mailbox JSON files load cleanly.
 */

import type { Env } from "../types";
import { DEFAULT_THRESHOLDS, type VerdictThresholds } from "./verdict";
import { DEFAULT_ATTACHMENT_POLICY, type AttachmentPolicy } from "./attachments";

/**
 * Business-hours definition for the off-hours scrutiny tier.
 *
 * This is a *scoring* input — it tilts marginal verdicts, never decides them
 * alone. See `workers/security/time-rules.ts` for the rationale (BEC / wire
 * fraud is correlated with off-hours delivery). The short-circuit triage
 * layer is intentionally NOT wired to this signal: a trusted allowlisted
 * sender emailing at 3 AM is still a legitimate email.
 */
export interface BusinessHours {
	/** IANA timezone, e.g. `America/New_York`. Invalid values fall back to no contribution. */
	timezone: string;
	/** Inclusive start hour in 24h local time. 7 means 07:00 counts as in-hours. */
	start_hour: number;
	/** Exclusive end hour in 24h local time. 19 means 19:00 counts as out-of-hours. */
	end_hour: number;
	/** When true, Saturday and Sunday count as outside business hours regardless of the hour. */
	weekdays_only: boolean;
	/** Master switch so existing mailboxes opt-in explicitly. Defaults to false. */
	boost_on_off_hours: boolean;
}

export interface MailboxSecuritySettings {
	enabled: boolean;
	thresholds: VerdictThresholds;
	/** Learning mode: tag only, never auto-quarantine. */
	learning_mode: boolean;
	/** Exact sender addresses (lowercased) that short-circuit to allow when DMARC passes. */
	allowlist_senders: string[];
	/** Registrable domains (lowercased) that short-circuit to allow when DMARC passes. */
	allowlist_domains: string[];
	/**
	 * Lowercased list of trusted `authserv-id` values (e.g. `mx.cloudflare.net`,
	 * `mx.google.com`). When set, only `Authentication-Results` headers from
	 * these authserv-ids contribute to the DMARC/SPF/DKIM verdict — all others
	 * are ignored. Prevents an attacker-controlled upstream from forging a
	 * pass verdict by injecting their own `Authentication-Results` header.
	 *
	 * Empty list falls back to first-header-wins behaviour (insecure against
	 * forgery). Operators should populate this list to match their mail path.
	 */
	trusted_authserv_ids: string[];
	/** Enable the hard-allow triage tier. Requires DMARC pass — never allowlist alone. */
	trusted_auto_allow: boolean;
	/**
	 * History-based hard-allow: if a sender has ≥ this many prior messages
	 * with avg_score < 20 (and DMARC passes), auto-allow without running the
	 * classifier. Set to 0 to disable history-based hard-allow.
	 */
	trusted_auto_allow_min_messages: number;
	/** Enable the hard-block triage tier on confirmed intel-feed hits or flagged senders. */
	intel_auto_block: boolean;
	/**
	 * Optional per-mailbox business-hours policy. When present and
	 * `boost_on_off_hours` is true, mail received outside the configured window
	 * gets a small verdict-score boost. See `time-rules.ts`.
	 */
	business_hours?: BusinessHours;
	/**
	 * Per-folder bypass policies keyed by folder id (e.g. "INBOX", "Newsletters").
	 * See `triage.ts` for the folder-bypass tier semantics and
	 * `workers/index.ts` for the `treat_as_verified` reputation-bump hook.
	 */
	folder_policies?: Record<string, FolderPolicy>;
	/**
	 * Attachment-type gate. When present, runs before hard-allow in triage
	 * so a DMARC-passing allowlisted sender carrying an .exe still gets
	 * quarantined. See `attachments.ts`.
	 */
	attachment_policy?: AttachmentPolicy;
}

/**
 * Per-folder policy: either bypasses part of the pipeline (`mode`) or marks
 * the folder as a trust signal (`treat_as_verified` — moving mail in bumps
 * the sender's reputation). Both fields are independent.
 */
export interface FolderPolicy {
	mode?: "skip_all" | "skip_classifier";
	treat_as_verified?: boolean;
}

export const DEFAULT_SECURITY_SETTINGS: MailboxSecuritySettings = {
	enabled: false, // opt-in — existing mailboxes are unaffected until the user flips this
	thresholds: DEFAULT_THRESHOLDS,
	learning_mode: false,
	allowlist_senders: [],
	allowlist_domains: [],
	trusted_authserv_ids: [],
	trusted_auto_allow: true,
	trusted_auto_allow_min_messages: 10,
	intel_auto_block: true,
};

export async function getSecuritySettings(
	env: Env,
	mailboxId: string,
): Promise<MailboxSecuritySettings> {
	try {
		const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
		if (!obj) return DEFAULT_SECURITY_SETTINGS;
		const json = (await obj.json()) as { security?: Partial<MailboxSecuritySettings> } | null;
		const raw = json?.security ?? {};
		const merged: MailboxSecuritySettings = {
			...DEFAULT_SECURITY_SETTINGS,
			...raw,
			thresholds: { ...DEFAULT_THRESHOLDS, ...(raw.thresholds ?? {}) },
			// Defensive normalisation: everything in allowlists is lowercased so
			// comparisons at runtime don't need to repeat the case fold.
			allowlist_senders: (raw.allowlist_senders ?? DEFAULT_SECURITY_SETTINGS.allowlist_senders).map((s) => s.toLowerCase()),
			allowlist_domains: (raw.allowlist_domains ?? DEFAULT_SECURITY_SETTINGS.allowlist_domains).map((s) => s.toLowerCase()),
			trusted_authserv_ids: (raw.trusted_authserv_ids ?? DEFAULT_SECURITY_SETTINGS.trusted_authserv_ids).map((s) => s.toLowerCase()),
			// business_hours: only materialise if the user supplied at least a timezone.
			// `boost_on_off_hours` defaults to false so a partially specified block is inert.
			business_hours: raw.business_hours && raw.business_hours.timezone
				? {
					timezone: raw.business_hours.timezone,
					start_hour: raw.business_hours.start_hour ?? 7,
					end_hour: raw.business_hours.end_hour ?? 19,
					weekdays_only: raw.business_hours.weekdays_only ?? true,
					boost_on_off_hours: raw.business_hours.boost_on_off_hours ?? false,
				}
				: undefined,
		};
		return merged;
	} catch (e) {
		console.error("getSecuritySettings failed:", (e as Error).message);
		return DEFAULT_SECURITY_SETTINGS;
	}
}
