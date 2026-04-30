// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

/**
 * Per-mailbox MISP-compatible hub configuration. Stored under `intel.hub` in
 * `mailboxes/<mailboxId>.json` (R2). The API key itself is NOT stored in R2 —
 * the JSON only carries the secret *name* via `api_key_secret_name`, and the
 * worker resolves it from `c.env` at call time. That way an org can rotate
 * its key without rewriting mailbox JSON.
 */

export interface HubConfig {
	url: string;
	org_uuid: string;
	api_key_secret_name: string;
	default_sharing_group_uuid?: string;
	auto_report?: boolean;
}

/** Returns the hub config for a mailbox, or null when none is set. */
export async function loadHubConfig(
	bucket: R2Bucket,
	mailboxId: string,
): Promise<HubConfig | null> {
	const obj = await bucket.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return null;
	const json = (await obj.json().catch(() => null)) as
		| { intel?: { hub?: unknown } }
		| null;
	const raw = json?.intel?.hub;
	if (!raw || typeof raw !== "object") return null;
	const cfg = raw as Partial<HubConfig>;
	if (!cfg.url || !cfg.org_uuid || !cfg.api_key_secret_name) return null;
	return {
		url: cfg.url,
		org_uuid: cfg.org_uuid,
		api_key_secret_name: cfg.api_key_secret_name,
		default_sharing_group_uuid: cfg.default_sharing_group_uuid,
		auto_report: cfg.auto_report ?? false,
	};
}

/**
 * Resolve a hub config + the live API key. Returns null if either the config
 * is missing or the named secret is unset on `env`. Callers that need the
 * "configured but unhealthy" distinction should branch on which side returned
 * null — for the read-only hub UI we treat both as "not configured" so the
 * empty state has one shape.
 */
export async function loadHubCredentials(
	env: Record<string, unknown>,
	bucket: R2Bucket,
	mailboxId: string,
): Promise<{ cfg: HubConfig; apiKey: string } | null> {
	const cfg = await loadHubConfig(bucket, mailboxId);
	if (!cfg) return null;
	const apiKey = env[cfg.api_key_secret_name];
	if (typeof apiKey !== "string" || !apiKey) return null;
	return { cfg, apiKey };
}
