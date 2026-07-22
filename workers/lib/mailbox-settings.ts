// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared helpers for reading per-mailbox settings from their R2 JSON blob
 * (`mailboxes/{mailboxId}.json`). Extracted so both the agent's auto-draft
 * flow and the manual reply/forward/send routes can read the same settings
 * without duplicating the read-and-parse logic.
 */

import type { Env } from "../types";

export interface SafetySettings {
	urgentDetection?: boolean;
	phishingDetection?: boolean;
	sensitiveInfoWarning?: boolean;
}

/**
 * Fetch the per-mailbox safety classifier toggles. All default to off —
 * false positives cost a skipped auto-draft or an extra warning, so these
 * are opt-in.
 */
export async function getSafetySettings(env: Env, mailboxId: string): Promise<SafetySettings> {
	try {
		const key = `mailboxes/${mailboxId}.json`;
		const obj = await env.BUCKET.get(key);
		if (obj) {
			const settings = await obj.json<Record<string, unknown>>();
			if (settings.safety && typeof settings.safety === "object") {
				return settings.safety as SafetySettings;
			}
		}
	} catch {
		// Fall through to all-off
	}
	return {};
}
