// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Sender display-name helpers shared by ingest, backfill, and UI.
 *
 * `emails.sender` is always the address. The human name lives in
 * `sender_name` (and, for older rows, can be recovered from raw From headers).
 */

/** Unit separator used when concatenating thread participant labels. */
export const PARTICIPANT_SEPARATOR = "\u001f";

export function normalizeDisplayName(
	name?: string | null,
): string | null {
	if (!name) return null;
	const trimmed = decodeRfc2047(name).trim();
	if (!trimmed) return null;
	// PostalMime (and some clients) repeat the address as the "name".
	if (looksLikeEmail(trimmed)) return null;
	return trimmed;
}

export function localPart(address: string): string {
	const trimmed = address.trim();
	if (!trimmed) return address;
	const at = trimmed.indexOf("@");
	return at > 0 ? trimmed.slice(0, at) : trimmed;
}

/**
 * Pull a display name from a From header value such as
 * `Jordan Hale <jordan@acme.com>` or `"Hale, Jordan" <jordan@acme.com>`.
 */
export function parseFromDisplayName(value: string): string | null {
	const decoded = decodeRfc2047(value).trim();
	if (!decoded) return null;

	const lt = decoded.lastIndexOf("<");
	const gt = decoded.lastIndexOf(">");
	if (lt !== -1 && gt > lt) {
		let name = decoded.slice(0, lt).trim();
		if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
			name = name.slice(1, -1).replace(/\\"/g, '"');
		}
		return normalizeDisplayName(name);
	}

	return normalizeDisplayName(decoded);
}

export function displayNameFromAddressField(
	from: string | { email: string; name: string },
): string | null {
	if (typeof from === "string") return parseFromDisplayName(from);
	return normalizeDisplayName(from.name);
}

export function senderNameFromRawHeaders(
	rawHeaders?: string | null,
): string | null {
	if (!rawHeaders) return null;
	try {
		const parsed = JSON.parse(rawHeaders) as unknown;
		const fromValue = fromHeaderValue(parsed);
		if (!fromValue) return null;
		return parseFromDisplayName(fromValue);
	} catch {
		return null;
	}
}

export function displaySenderName(email: {
	sender: string;
	sender_name?: string | null;
	raw_headers?: string | null;
}): string {
	const stored = normalizeDisplayName(email.sender_name);
	if (stored) return stored;
	const recovered = senderNameFromRawHeaders(email.raw_headers);
	if (recovered) return recovered;
	return localPart(email.sender);
}

export function formatParticipants(email: {
	sender: string;
	sender_name?: string | null;
	participants?: string | null;
	raw_headers?: string | null;
}): string {
	if (email.participants) {
		const names = splitParticipants(email.participants)
			.map((part) => (looksLikeEmail(part) ? localPart(part) : part))
			.filter(Boolean)
			.filter((name, idx, arr) => arr.indexOf(name) === idx);
		if (names.length === 0) return displaySenderName(email);
		if (names.length <= 3) return names.join(", ");
		return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
	}
	return displaySenderName(email);
}

function splitParticipants(participants: string): string[] {
	const separator = participants.includes(PARTICIPANT_SEPARATOR)
		? PARTICIPANT_SEPARATOR
		: ",";
	return participants
		.split(separator)
		.map((part) => part.trim())
		.filter(Boolean);
}

function looksLikeEmail(value: string): boolean {
	return !value.includes(" ") && value.includes("@");
}

function fromHeaderValue(parsed: unknown): string | null {
	if (Array.isArray(parsed)) {
		for (const entry of parsed) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			const key = String(record.key ?? record.name ?? "");
			if (key.toLowerCase() === "from") {
				return String(record.value ?? "");
			}
		}
		return null;
	}
	if (parsed && typeof parsed === "object") {
		const record = parsed as Record<string, unknown>;
		for (const [key, value] of Object.entries(record)) {
			if (key.toLowerCase() === "from") return String(value ?? "");
		}
	}
	return null;
}

/** Decode RFC 2047 encoded-words (`=?UTF-8?Q?...?=`) when present. */
function decodeRfc2047(input: string): string {
	if (!input.includes("=?")) return input;
	return input.replace(
		/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
		(_match, charset: string, encoding: string, text: string) => {
			try {
				if (encoding.toUpperCase() === "B") {
					const binary = atob(text.replace(/\s/g, ""));
					const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
					return new TextDecoder(normalizeCharset(charset)).decode(bytes);
				}
				const unpacked = text
					.replace(/_/g, " ")
					.replace(/=([0-9A-Fa-f]{2})/g, (_hex, pair: string) =>
						String.fromCharCode(Number.parseInt(pair, 16)),
					);
				const bytes = Uint8Array.from(unpacked, (ch) => ch.charCodeAt(0));
				return new TextDecoder(normalizeCharset(charset)).decode(bytes);
			} catch {
				return _match;
			}
		},
	);
}

function normalizeCharset(charset: string): string {
	const lower = charset.trim().toLowerCase();
	if (lower === "utf-8" || lower === "utf8" || lower === "us-ascii") return "utf-8";
	return "utf-8";
}
