// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { stripHtmlToText } from "./email-helpers";

type HeaderInput = string | Array<{ key?: string; name?: string; value?: string }>;

export interface SpamClassification {
	version: 1;
	classifiedAt: string;
	verdict: "clean" | "suspicious" | "spam";
	score: number;
	reasons: string[];
	checks: {
		senderDomain: string | null;
		dns: {
			hasMx: boolean | null;
			hasSpfRecord: boolean | null;
			hasDmarcRecord: boolean | null;
			dkimRecordFound: boolean | null;
		};
		authentication: {
			spf: string | null;
			dkim: string | null;
			dmarc: string | null;
			dkimSignature: { domain: string; selector: string } | null;
		};
		content: {
			spamTerms: string[];
			linkCount: number;
		};
	};
}

interface ClassifyInput {
	sender: string;
	subject: string;
	bodyHtml?: string | null;
	rawHeaders?: HeaderInput | null;
}

interface DnsAnswer {
	data?: string;
}

interface DnsJsonResponse {
	Answer?: DnsAnswer[];
}

function parseHeaders(rawHeaders?: HeaderInput | null): Map<string, string[]> {
	const headers = new Map<string, string[]>();
	if (!rawHeaders) return headers;

	let parsed: HeaderInput = rawHeaders;
	if (typeof rawHeaders === "string") {
		try {
			parsed = JSON.parse(rawHeaders) as HeaderInput;
		} catch {
			return headers;
		}
	}

	if (!Array.isArray(parsed)) return headers;
	for (const header of parsed) {
		const key = (header.key || header.name || "").toLowerCase();
		if (!key) continue;
		const value = header.value || "";
		const values = headers.get(key) || [];
		values.push(value);
		headers.set(key, values);
	}
	return headers;
}

function getHeader(headers: Map<string, string[]>, name: string) {
	return (headers.get(name.toLowerCase()) || []).join("\n");
}

function extractEmailDomain(sender: string): string | null {
	const match = sender.match(/@([A-Z0-9.-]+\.[A-Z]{2,})/i);
	return match ? match[1].toLowerCase().replace(/[>\s]+$/, "") : null;
}

function parseAuthResult(authHeaders: string, mechanism: "spf" | "dkim" | "dmarc") {
	const match = authHeaders.match(new RegExp(`\\b${mechanism}=([a-z0-9_-]+)`, "i"));
	return match ? match[1].toLowerCase() : null;
}

function parseDkimSignature(headers: Map<string, string[]>) {
	const signature = getHeader(headers, "dkim-signature");
	if (!signature) return null;
	const domain = signature.match(/\bd=([^;\s]+)/i)?.[1]?.toLowerCase();
	const selector = signature.match(/\bs=([^;\s]+)/i)?.[1]?.toLowerCase();
	if (!domain || !selector) return null;
	return { domain, selector };
}

async function dnsQuery(name: string, type: "MX" | "TXT") {
	const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
	const response = await fetch(url, { headers: { Accept: "application/dns-json" } });
	if (!response.ok) return [];
	const json = await response.json<DnsJsonResponse>();
	return (json.Answer || []).map((answer) => answer.data || "").filter(Boolean);
}

async function hasTxtContaining(name: string, needle: RegExp) {
	const answers = await dnsQuery(name, "TXT");
	return answers.some((answer) => needle.test(answer.replace(/^"|"$/g, "")));
}

function addReason(reasons: string[], reason: string) {
	if (!reasons.includes(reason)) reasons.push(reason);
}

function scoreAuthResult(
	mechanism: "spf" | "dkim" | "dmarc",
	value: string | null,
	reasons: string[],
) {
	if (!value) return 0;
	if (value === "pass") return -15;
	if (["fail", "permerror"].includes(value)) {
		addReason(reasons, `${mechanism.toUpperCase()} authentication failed`);
		return 45;
	}
	if (["softfail", "temperror", "neutral", "none"].includes(value)) {
		addReason(reasons, `${mechanism.toUpperCase()} authentication was ${value}`);
		return 20;
	}
	return 0;
}

export async function classifyEmailForSpam(input: ClassifyInput): Promise<SpamClassification> {
	const headers = parseHeaders(input.rawHeaders);
	const authHeaders = `${getHeader(headers, "authentication-results")}\n${getHeader(headers, "arc-authentication-results")}\n${getHeader(headers, "received-spf")}`;
	const senderDomain = extractEmailDomain(input.sender);
	const dkimSignature = parseDkimSignature(headers);
	const reasons: string[] = [];
	let score = 0;

	const spf = parseAuthResult(authHeaders, "spf");
	const dkim = parseAuthResult(authHeaders, "dkim");
	const dmarc = parseAuthResult(authHeaders, "dmarc");
	score += scoreAuthResult("spf", spf, reasons);
	score += scoreAuthResult("dkim", dkim, reasons);
	score += scoreAuthResult("dmarc", dmarc, reasons);

	let hasMx: boolean | null = null;
	let hasSpfRecord: boolean | null = null;
	let hasDmarcRecord: boolean | null = null;
	let dkimRecordFound: boolean | null = null;

	if (senderDomain) {
		const [mxAnswers, spfRecord, dmarcRecord] = await Promise.all([
			dnsQuery(senderDomain, "MX").catch(() => []),
			hasTxtContaining(senderDomain, /\bv=spf1\b/i).catch(() => null),
			hasTxtContaining(`_dmarc.${senderDomain}`, /\bv=DMARC1\b/i).catch(() => null),
		]);
		hasMx = mxAnswers.length > 0;
		hasSpfRecord = spfRecord;
		hasDmarcRecord = dmarcRecord;

		if (!hasMx) {
			score += 35;
			addReason(reasons, "Sender domain has no MX record");
		}
		if (hasSpfRecord === false) {
			score += 25;
			addReason(reasons, "Sender domain has no SPF record");
		}
		if (hasDmarcRecord === false) {
			score += 25;
			addReason(reasons, "Sender domain has no DMARC record");
		}
		if (/\.(buzz|life|live|services|click|top|xyz|site|website)$/i.test(senderDomain)) {
			score += 25;
			addReason(reasons, "Sender domain uses a high-spam-rate marketing TLD");
		}
	} else {
		score += 40;
		addReason(reasons, "Sender address does not contain a valid domain");
	}

	if (dkimSignature) {
		dkimRecordFound = await hasTxtContaining(
			`${dkimSignature.selector}._domainkey.${dkimSignature.domain}`,
			/\bv=DKIM1\b|\bp=/i,
		).catch(() => null);
		if (dkimRecordFound === false) {
			score += 35;
			addReason(reasons, "DKIM signature references a missing selector record");
		}
	} else {
		score += 15;
		addReason(reasons, "Message has no DKIM signature");
	}

	const plainText = stripHtmlToText(input.bodyHtml || "");
	const combinedText = `${input.subject}\n${plainText}`.toLowerCase();
	const spamPatterns: Array<[string, RegExp, number]> = [
		["credential or password lure", /\b(password|login|verify|validate|confirm|account suspended|mailbox quota|webmail)\b/i, 18],
		["financial lure", /\b(invoice|payment|remittance|refund|crypto|bitcoin|investment|loan)\b/i, 15],
		["urgency language", /\b(urgent|immediately|final warning|action required|limited time)\b/i, 12],
		["adult or pharmaceutical terms", /\b(casino|viagra|cialis|porn|sex|dating)\b/i, 20],
		["suspicious attachment language", /\b(open attachment|see attached|download document|view file)\b/i, 10],
		["SEO or web-design solicitation", /\b(seo|search engine|organic search|google ranking|rank(?:ing)?|targeted ads|website (?:traffic|design|development|redesign|revamp)|generate (?:consistent )?leads|find your website|right people find your website|recovery specialist)\b/i, 40],
		["cold outreach language", /\b(quick introduction|more info|helping the right people|over \d+ years experience|revamp or redesign)\b/i, 25],
	];
	const spamTerms: string[] = [];
	for (const [label, pattern, points] of spamPatterns) {
		if (pattern.test(combinedText)) {
			spamTerms.push(label);
			score += points;
			addReason(reasons, `Content contains ${label}`);
		}
	}

	const linkCount = (combinedText.match(/https?:\/\//g) || []).length;
	if (linkCount >= 3) {
		score += 12;
		addReason(reasons, "Message contains several links");
	}

	if (spf === "pass" && dkim === "pass" && dmarc === "pass") {
		score -= 25;
	}

	score = Math.max(0, Math.min(100, score));
	const verdict = score >= 60 ? "spam" : score >= 35 ? "suspicious" : "clean";

	if (reasons.length === 0) {
		reasons.push("No spam indicators found");
	}

	return {
		version: 1,
		classifiedAt: new Date().toISOString(),
		verdict,
		score,
		reasons,
		checks: {
			senderDomain,
			dns: { hasMx, hasSpfRecord, hasDmarcRecord, dkimRecordFound },
			authentication: { spf, dkim, dmarc, dkimSignature },
			content: { spamTerms, linkCount },
		},
	};
}
