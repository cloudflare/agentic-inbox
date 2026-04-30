// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

import { MailboxSettings } from "../../shared/mailbox-settings";

/**
 * Read the per-mailbox settings blob from R2 and parse through the Zod
 * schema (which fills in defaults for missing fields). Returns the
 * defaults if the blob is missing or unreadable — never throws.
 *
 * The `env` shape is intentionally narrowed to `{ BUCKET: R2Bucket }` so
 * this helper works in both Worker and Durable Object contexts.
 */
export async function getMailboxSettings(
	env: { BUCKET: R2Bucket },
	mailboxId: string,
): Promise<MailboxSettings> {
	try {
		const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
		if (obj) {
			const raw = await obj.json<Record<string, unknown>>();
			return MailboxSettings.parse(raw);
		}
	} catch {
		// Fall through to defaults — missing/malformed blob shouldn't break
		// the auto-draft pipeline. Surfaces as default behavior.
	}
	return MailboxSettings.parse({});
}
