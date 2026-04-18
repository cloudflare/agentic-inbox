// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * RDAP domain registration-age lookup.
 *
 * Phishing domains are overwhelmingly fresh — registered days before the
 * campaign and burned within weeks. Domain age is therefore one of the
 * highest-signal-per-dollar checks available. We use https://rdap.org/ as
 * the top-level router; it handles TLD-specific RDAP server discovery.
 *
 * The HTTP call is isolated behind `rdapFetch` so tests can inject a fake
 * transport without touching the network.
 */

/**
 * Minimum domain age (in days) to consider "aged"; below this we flag the
 * domain as fresh-registration suspicious. Chosen at 30 because typical
 * phishing infrastructure turnover is 1–14 days and legitimate corporate
 * domains are virtually always much older.
 */
export const FRESH_DOMAIN_THRESHOLD_DAYS = 30;

export interface DomainAge {
	registered_at: string; // ISO-8601
	age_days: number;
	is_fresh: boolean;
}

export type RdapTransport = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Returns domain age info, or `null` when lookup fails for any reason
 * (network, non-200, missing registration event, unparseable date).
 * Never throws — callers treat missing age info as "no signal", not
 * "fail closed", because RDAP providers are rate-limited and flaky and
 * we don't want false positives on their bad days.
 */
export async function lookupDomainAge(
	domain: string,
	now: Date = new Date(),
	fetchImpl: RdapTransport = fetch,
): Promise<DomainAge | null> {
	if (!domain) return null;
	// Strip any leading subdomains and trailing dot; RDAP is keyed by
	// the registrable (eTLD+1) plus any registrar-accepted subdomain.
	const canonical = domain.toLowerCase().replace(/\.$/, "");

	let res: Response;
	try {
		res = await fetchImpl(`https://rdap.org/domain/${encodeURIComponent(canonical)}`, {
			// 10s upper bound — the deep-scan budget per email can't be dominated
			// by a slow RDAP server.
			signal: AbortSignal.timeout(10_000),
			headers: { accept: "application/rdap+json, application/json" },
		});
	} catch {
		return null;
	}
	if (!res.ok) return null;

	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return null;
	}
	return parseRdapAge(body, now);
}

/**
 * Extract the earliest "registration" event date from an RDAP payload.
 * Exposed for tests; callers should prefer `lookupDomainAge`.
 */
export function parseRdapAge(body: unknown, now: Date = new Date()): DomainAge | null {
	if (!body || typeof body !== "object") return null;
	const events = (body as { events?: Array<{ eventAction?: unknown; eventDate?: unknown }> }).events;
	if (!Array.isArray(events)) return null;
	let earliest: number | null = null;
	let earliestIso: string | null = null;
	for (const ev of events) {
		if (!ev || typeof ev !== "object") continue;
		if (ev.eventAction !== "registration") continue;
		if (typeof ev.eventDate !== "string") continue;
		const ts = Date.parse(ev.eventDate);
		if (!Number.isFinite(ts)) continue;
		if (earliest === null || ts < earliest) {
			earliest = ts;
			earliestIso = ev.eventDate;
		}
	}
	if (earliest === null || earliestIso === null) return null;
	const ageMs = now.getTime() - earliest;
	const age_days = Math.floor(ageMs / 86_400_000);
	return {
		registered_at: earliestIso,
		age_days,
		is_fresh: age_days >= 0 && age_days < FRESH_DOMAIN_THRESHOLD_DAYS,
	};
}
