// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * URL extraction and synchronous heuristic scoring.
 *
 * Fetch-based enrichment (URL preview, redirect chain, RDAP) happens in the
 * async deep-scan stage — see `workers/intel/deep-scan.ts`. Feed-based
 * lookups (bloom filter against PhishDestroy/URLhaus lists) are applied by
 * `workers/intel/feeds.ts` at the pipeline integration point.
 */

/** Domains whose typos are extremely high-value for phishers. */
const HIGH_VALUE_DOMAINS = [
	"google.com", "gmail.com", "googledrive.com", "googleusercontent.com",
	"microsoft.com", "outlook.com", "office.com", "live.com", "microsoftonline.com",
	"apple.com", "icloud.com",
	"amazon.com", "amazon.co.uk", "amazonaws.com",
	"paypal.com", "venmo.com", "zelle.com", "cashapp.com",
	"facebook.com", "instagram.com", "meta.com", "whatsapp.com",
	"dropbox.com", "box.com", "onedrive.com",
	"adobe.com", "docusign.com", "docusign.net",
	"github.com", "gitlab.com",
	"linkedin.com", "twitter.com", "x.com",
	"netflix.com", "spotify.com",
	"bankofamerica.com", "chase.com", "wellsfargo.com", "citibank.com",
	"hsbc.com", "barclays.com",
	"cloudflare.com", "cloudflareaccess.com",
];

const SHORTENER_DOMAINS = new Set([
	"bit.ly", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "is.gd", "buff.ly",
	"rebrand.ly", "cutt.ly", "shorturl.at", "rb.gy", "tiny.cc", "bl.ink",
	"lnkd.in", "t.ly", "s.id", "v.gd", "qr.ae", "x.gd", "short.io",
	"linktr.ee", "mcaf.ee", "trib.al", "dlvr.it",
]);

export interface ExtractedUrl {
	url: string;
	display_text?: string;
	hostname: string;
	is_homograph: boolean;
	is_shortener: boolean;
}

const HREF_RE = /href\s*=\s*["']([^"']+)["']/gi;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;
const ANCHOR_RE = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

function stripTags(html: string): string {
	return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function safeHostname(url: string): string | null {
	try {
		const u = new URL(url);
		return u.hostname.toLowerCase();
	} catch {
		return null;
	}
}

/** Levenshtein distance — used for typo/homograph detection. */
function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	const n = a.length, m = b.length;
	if (n === 0) return m;
	if (m === 0) return n;
	let prev = new Array(m + 1);
	let curr = new Array(m + 1);
	for (let j = 0; j <= m; j++) prev[j] = j;
	for (let i = 1; i <= n; i++) {
		curr[0] = i;
		for (let j = 1; j <= m; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[m];
}

/**
 * Small allow-list of second-level country-code TLDs. The Public Suffix List
 * is the "correct" answer but pulling it in costs ~200KB of compiled data
 * per Worker; this 20-entry list covers the domains that matter for the
 * high-value-domain homograph check (so `amazom.co.uk` is compared against
 * `amazon.co.uk` rather than the nonsensical `co.uk`).
 */
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
	"co.uk", "co.jp", "co.kr", "co.nz", "co.za", "co.in",
	"com.au", "com.br", "com.cn", "com.mx", "com.sg", "com.tr", "com.ar",
	"ac.uk", "gov.uk", "org.uk", "net.au", "org.au",
]);

/**
 * Extract the registrable (eTLD+1) portion of a hostname, handling common
 * multi-label suffixes so we compare like-for-like against HIGH_VALUE_DOMAINS.
 */
function registrableDomain(hostname: string): string {
	const parts = hostname.split(".");
	if (parts.length < 2) return hostname;
	const last2 = parts.slice(-2).join(".");
	if (parts.length >= 3 && MULTI_LABEL_PUBLIC_SUFFIXES.has(last2)) {
		return parts.slice(-3).join(".");
	}
	return last2;
}

/**
 * Non-ASCII hostnames, bare punycode, or close Levenshtein matches to
 * high-value domains are flagged as homographs. Legitimate mail practically
 * never uses IDN hostnames; attackers use Cyrillic/Greek lookalikes.
 */
export function isHomographic(hostname: string): boolean {
	for (let i = 0; i < hostname.length; i++) {
		if (hostname.charCodeAt(i) > 127) return true;
	}
	if (hostname.includes("xn--")) return true;
	for (const d of HIGH_VALUE_DOMAINS) {
		if (hostname === d || hostname.endsWith("." + d)) return false;
	}
	const registrable = registrableDomain(hostname);
	for (const d of HIGH_VALUE_DOMAINS) {
		const dist = levenshtein(registrable, d);
		if (dist > 0 && dist <= 2) return true;
	}
	return false;
}

export function extractUrls(body: string | null | undefined, cap = 20): ExtractedUrl[] {
	if (!body) return [];
	const seen = new Set<string>();
	const out: ExtractedUrl[] = [];

	for (const match of body.matchAll(ANCHOR_RE)) {
		if (out.length >= cap) break;
		pushUrl(out, seen, match[1], stripTags(match[2]).slice(0, 200));
	}
	for (const match of body.matchAll(HREF_RE)) {
		if (out.length >= cap) break;
		pushUrl(out, seen, match[1]);
	}
	for (const match of body.matchAll(BARE_URL_RE)) {
		if (out.length >= cap) break;
		pushUrl(out, seen, match[0]);
	}
	return out;
}

function pushUrl(out: ExtractedUrl[], seen: Set<string>, rawUrl: string, display?: string) {
	const hostname = safeHostname(rawUrl);
	if (!hostname) return;
	if (seen.has(rawUrl)) return;
	seen.add(rawUrl);
	const registrable = registrableDomain(hostname);
	out.push({
		url: rawUrl,
		display_text: display,
		hostname,
		is_homograph: isHomographic(hostname),
		is_shortener: SHORTENER_DOMAINS.has(hostname) || SHORTENER_DOMAINS.has(registrable),
	});
}

export function scoreUrls(urls: ExtractedUrl[]): { score: number; reasons: string[] } {
	const reasons: string[] = [];
	let score = 0;
	const homograph = urls.find((u) => u.is_homograph);
	if (homograph) { score += 20; reasons.push(`homograph URL (${homograph.hostname})`); }
	const shortener = urls.find((u) => u.is_shortener);
	if (shortener) { score += 5; reasons.push(`link shortener (${shortener.hostname})`); }
	return { score, reasons };
}
