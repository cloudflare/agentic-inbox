// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Minimal CSV parser for roster uploads. Parsed entirely in the browser so
 * the backend never has to deal with CSV parsing in the Workers runtime.
 * Supports comma-separated fields with double-quote escaping (RFC 4180-ish),
 * which is enough for typical roster exports (name, email columns).
 */

export interface ParsedStudent {
	name?: string;
	email: string;
}

/** Split a single CSV line into fields, honoring double-quoted values. */
function parseCsvLine(line: string): string[] {
	const fields: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (inQuotes) {
			if (char === '"') {
				if (line[i + 1] === '"') {
					current += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				current += char;
			}
		} else if (char === '"') {
			inQuotes = true;
		} else if (char === ",") {
			fields.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	fields.push(current);
	return fields.map((f) => f.trim());
}

/**
 * Parse roster CSV text into a list of students. Expects a header row with
 * "name" and "email" columns (case-insensitive, any order); "email" is
 * required, "name" is optional.
 */
export function parseRosterCsv(text: string): { students: ParsedStudent[]; errors: string[] } {
	const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (lines.length === 0) {
		return { students: [], errors: ["File is empty."] };
	}

	const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
	const emailIdx = header.indexOf("email");
	const nameIdx = header.indexOf("name");

	if (emailIdx === -1) {
		return { students: [], errors: ['CSV must have an "email" column.'] };
	}

	const students: ParsedStudent[] = [];
	const errors: string[] = [];
	const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	for (let i = 1; i < lines.length; i++) {
		const fields = parseCsvLine(lines[i]);
		const email = fields[emailIdx]?.trim();
		const name = nameIdx !== -1 ? fields[nameIdx]?.trim() : undefined;

		if (!email) {
			errors.push(`Row ${i + 1}: missing email, skipped.`);
			continue;
		}
		if (!emailPattern.test(email)) {
			errors.push(`Row ${i + 1}: "${email}" doesn't look like a valid email, skipped.`);
			continue;
		}
		students.push({ email, name: name || undefined });
	}

	return { students, errors };
}
