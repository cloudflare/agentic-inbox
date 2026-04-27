// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Inbound MISP sync. Pulls events from configured peers via
 * POST /events/restSearch, UPSERTs them into the local DB, and credits
 * corroboration to a synthetic per-peer org.
 *
 * Watermark semantics: query timestamp >= last_pulled_ts, advance to
 * max(timestamp seen) at end of run. This handles the multi-event-same-
 * timestamp case that '>' would lose. UPSERT makes the boundary overlap
 * a no-op for corroboration math.
 */

import type { Env } from "../types";
import { applyCorroboration } from "./aggregate";

export interface InboundPeerRow {
	uuid: string;
	peer_uuid: string;
	base_url: string;
	api_key_secret_name: string;
	synthetic_org_uuid: string;
	enabled: number;
	last_pulled_ts: string | null;
	last_error: string | null;
	next_retry_at: string | null;
	default_sharing_group_uuid: string;
	tag_include: string | null;
	tag_exclude: string | null;
}

interface UpstreamEvent {
	Event: {
		uuid: string;
		info: string;
		date: string;
		timestamp: string;
		analysis?: string;
		threat_level_id?: string;
		distribution?: string;
		orgc_uuid?: string;
		Tag?: Array<{ name: string }>;
		Attribute?: Array<{
			uuid?: string;
			type: string;
			category: string;
			value: string;
			to_ids?: boolean | 0 | 1;
			comment?: string;
		}>;
	};
}

const MAX_PAGES = 100;
const PAGE_SIZE = 200;
const SOFT_LOCK_MINUTES = 4;
const FAILURE_BACKOFF_MINUTES = 10;

export interface PullResult {
	events_pulled: number;
	events_skipped: number;
	events_filtered: number;
	error: string | null;
}

export async function pullFromPeer(env: Env, peer: InboundPeerRow): Promise<PullResult> {
	// Take the soft lock so an overlapping cron skips this peer.
	const softLockUntil = new Date(Date.now() + SOFT_LOCK_MINUTES * 60_000).toISOString();
	await env.DB
		.prepare(`UPDATE inbound_peers SET next_retry_at = ?1 WHERE uuid = ?2`)
		.bind(softLockUntil, peer.uuid)
		.run();

	const apiKey = (env as unknown as Record<string, string>)[peer.api_key_secret_name];
	if (!apiKey) {
		return finishWithError(env, peer, `secret ${peer.api_key_secret_name} not bound`);
	}

	// Fetch local org UUIDs once for loop prevention.
	const localOrgs = await env.DB.prepare(`SELECT uuid FROM orgs`).all<{ uuid: string }>();
	const localOrgSet = new Set((localOrgs.results ?? []).map((r) => r.uuid));
	// The synthetic org represents the peer; allow it through.
	localOrgSet.delete(peer.synthetic_org_uuid);

	const tagInclude = (peer.tag_include ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
	const tagExclude = (peer.tag_exclude ?? "").split("\n").map((s) => s.trim()).filter(Boolean);

	let pulled = 0, skipped = 0, filtered = 0;
	let maxTs = peer.last_pulled_ts ?? "0";

	for (let page = 1; page <= MAX_PAGES; page++) {
		const events = await fetchPage(peer, apiKey, peer.last_pulled_ts, page);
		if (events === null) {
			return finishWithError(env, peer, `upstream returned non-OK on page ${page}`);
		}
		if (events.length === 0) break;

		for (const e of events) {
			const ev = e.Event;
			if (!ev?.uuid || !ev.timestamp) { skipped++; continue; }
			if (ev.orgc_uuid && localOrgSet.has(ev.orgc_uuid)) { skipped++; continue; }
			if (!passesTagFilter(ev.Tag, tagInclude, tagExclude)) { filtered++; continue; }

			await upsertEvent(env, peer, e);
			await applyCorroboration(env.DB, {
				event_uuid: ev.uuid,
				orgc_uuid: peer.synthetic_org_uuid,
				sharing_group_uuid: peer.default_sharing_group_uuid,
				attributes: (ev.Attribute ?? []).map((a) => ({ type: a.type, value: a.value })),
			});
			if (ev.timestamp > maxTs) maxTs = ev.timestamp;
			pulled++;
		}

	}

	await env.DB
		.prepare(
			`UPDATE inbound_peers
			 SET last_pulled_ts = ?1, last_error = NULL, next_retry_at = NULL
			 WHERE uuid = ?2`,
		)
		.bind(maxTs, peer.uuid)
		.run();

	return { events_pulled: pulled, events_skipped: skipped, events_filtered: filtered, error: null };
}

async function fetchPage(
	peer: InboundPeerRow,
	apiKey: string,
	since: string | null,
	page: number,
): Promise<UpstreamEvent[] | null> {
	const body: Record<string, unknown> = {
		returnFormat: "json",
		limit: PAGE_SIZE,
		page,
		// Explicit ASC ordering. MISP restSearch order is undefined without
		// this; with DESC default a deep first-backfill (>MAX_PAGES * PAGE_SIZE
		// events) would advance the watermark past unprocessed older events
		// and never come back for them.
		order: "Event.timestamp ASC",
	};
	if (since) body.timestamp = since; // >= semantics on the upstream side

	const res = await fetch(`${peer.base_url.replace(/\/$/, "")}/events/restSearch`, {
		method: "POST",
		headers: {
			"Authorization": apiKey,
			"Accept": "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
	}).catch(() => null);

	if (!res || !res.ok) return null;
	const json = (await res.json().catch(() => null)) as { response?: UpstreamEvent[] } | UpstreamEvent[] | null;
	if (Array.isArray(json)) return json;
	return json?.response ?? [];
}

function passesTagFilter(
	tags: Array<{ name: string }> | undefined,
	include: string[],
	exclude: string[],
): boolean {
	const names = new Set((tags ?? []).map((t) => t.name));
	if (exclude.length > 0 && exclude.some((t) => names.has(t))) return false;
	if (include.length > 0 && !include.some((t) => names.has(t))) return false;
	return true;
}

/**
 * UPSERT one event. INSERT OR REPLACE for the events row; for attributes we
 * delete then re-insert because attribute UUIDs may shift on upstream edits.
 *
 * NOTE: this intentionally does NOT reuse the POST /events route's plain
 * INSERT — sync needs idempotency on re-pull, the public route needs strict
 * UUID conflict rejection.
 */
async function upsertEvent(env: Env, peer: InboundPeerRow, e: UpstreamEvent) {
	const ev = e.Event;
	await env.DB.batch([
		env.DB
			.prepare(
				`INSERT OR REPLACE INTO events
				   (uuid, orgc_uuid, sharing_group_uuid, info, date, timestamp,
				    distribution, analysis, threat_level_id, event_json, source_peer_uuid)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
			)
			.bind(
				ev.uuid,
				peer.synthetic_org_uuid,             // attribution → synthetic peer org
				peer.default_sharing_group_uuid,
				ev.info,
				ev.date,
				ev.timestamp,
				ev.distribution ?? "1",
				ev.analysis ?? "0",
				ev.threat_level_id ?? "2",
				JSON.stringify(e),
				peer.uuid,
			),
		env.DB.prepare(`DELETE FROM attributes WHERE event_uuid = ?1`).bind(ev.uuid),
	]);

	if (ev.Attribute && ev.Attribute.length > 0) {
		await env.DB.batch(
			ev.Attribute.map((a) =>
				env.DB
					.prepare(
						`INSERT INTO attributes (uuid, event_uuid, type, category, value, to_ids, comment)
						 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
					)
					.bind(
						a.uuid ?? crypto.randomUUID(),
						ev.uuid,
						a.type,
						a.category,
						a.value,
						a.to_ids === true || a.to_ids === 1 ? 1 : 0,
						a.comment ?? null,
					),
			),
		);
	}
}

async function finishWithError(env: Env, peer: InboundPeerRow, message: string): Promise<PullResult> {
	const backoff = new Date(Date.now() + FAILURE_BACKOFF_MINUTES * 60_000).toISOString();
	await env.DB
		.prepare(`UPDATE inbound_peers SET last_error = ?1, next_retry_at = ?2 WHERE uuid = ?3`)
		.bind(message.slice(0, 500), backoff, peer.uuid)
		.run();
	return { events_pulled: 0, events_skipped: 0, events_filtered: 0, error: message };
}

/** Cron entry — iterate eligible peers, pull each. */
export async function runInboundSync(env: Env): Promise<void> {
	const now = new Date().toISOString();
	const rows = await env.DB
		.prepare(
			`SELECT * FROM inbound_peers
			 WHERE enabled = 1
			   AND (next_retry_at IS NULL OR next_retry_at < ?1)`,
		)
		.bind(now)
		.all<InboundPeerRow>();
	for (const peer of rows.results ?? []) {
		try {
			await pullFromPeer(env, peer);
		} catch (err) {
			console.error(`pullFromPeer ${peer.uuid} threw:`, (err as Error).message);
		}
	}
}
