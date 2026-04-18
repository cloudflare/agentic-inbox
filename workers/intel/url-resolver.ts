// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Follow a URL's redirect chain and surface the final URL + page title.
 *
 * The synchronous pipeline only sees the URL as it appears in the email.
 * Many phishing links use short-URLs or tracking redirectors that hop
 * through several hosts before landing on the credential-theft page. By
 * resolving the final hostname we let downstream heuristics (homograph,
 * intel-feed match) operate on the actual destination.
 *
 * The `fetchImpl` parameter is there so tests can avoid touching the
 * network; production callers use the global `fetch`.
 */

export const MAX_REDIRECT_HOPS = 5;
export const RESOLVE_TIMEOUT_MS = 8000;

export interface ResolvedUrl {
	original: string;
	resolved: string;
	hops: number;
	/** Trimmed `<title>` from the final GET, if any. Capped at 200 chars. */
	title: string | null;
	/** Set when the chain exits the starting hostname — a strong anti-phishing tell. */
	host_changed: boolean;
	/** HTTP status of the final response; 0 when the fetch failed. */
	final_status: number;
	/** True when the chain stopped because of MAX_REDIRECT_HOPS. */
	truncated: boolean;
}

export async function resolveUrl(
	rawUrl: string,
	fetchImpl: typeof fetch = fetch,
): Promise<ResolvedUrl | null> {
	const startHost = safeHost(rawUrl);
	if (!startHost) return null;

	const result: ResolvedUrl = {
		original: rawUrl,
		resolved: rawUrl,
		hops: 0,
		title: null,
		host_changed: false,
		final_status: 0,
		truncated: false,
	};

	// First, do a HEAD-follow chain with manual redirect handling so we can
	// count hops and surface the hostname change. We'd use `redirect: "follow"`
	// on fetch but that hides the intermediate Location headers we want to
	// count.
	let current = rawUrl;
	for (let i = 0; i <= MAX_REDIRECT_HOPS; i++) {
		if (i === MAX_REDIRECT_HOPS) {
			result.truncated = true;
			break;
		}
		let res: Response;
		try {
			res = await fetchImpl(current, {
				method: "GET",
				redirect: "manual",
				signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
				headers: {
					// Many phishing redirectors refuse to emit Location without a
					// recognisable browser UA. Use a generic one.
					"user-agent": "Mozilla/5.0 (compatible; AgenticInboxSecurity/1.0)",
				},
			});
		} catch {
			result.final_status = 0;
			result.resolved = current;
			break;
		}
		result.hops = i + 1;
		result.final_status = res.status;
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get("location");
			if (!loc) break;
			const next = absolutize(current, loc);
			if (!next) break;
			current = next;
			continue;
		}
		result.resolved = current;
		// Only bother extracting a title on HTML-ish responses.
		const ct = res.headers.get("content-type") || "";
		if (ct.toLowerCase().includes("html")) {
			try {
				const text = (await res.text()).slice(0, 200_000);
				result.title = extractTitle(text);
			} catch {
				// ignore body read failures — we have the URL already
			}
		}
		break;
	}

	const endHost = safeHost(result.resolved);
	result.host_changed = !!endHost && endHost !== startHost;
	return result;
}

function absolutize(base: string, loc: string): string | null {
	try {
		return new URL(loc, base).toString();
	} catch {
		return null;
	}
}

function safeHost(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i;

export function extractTitle(html: string): string | null {
	const match = html.match(TITLE_RE);
	if (!match) return null;
	return match[1]
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200) || null;
}
