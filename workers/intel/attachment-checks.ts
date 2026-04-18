// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Filename / MIME-type heuristics for email attachments.
 *
 * These checks are PURE — no I/O, no Workers bindings — so they can be
 * exercised from vitest without mocks and called from both the sync
 * pipeline (for the extension/MIME mismatch, which is cheap) and the
 * async deep-scan (for the full multi-signal verdict).
 *
 * They do NOT replace antivirus. They catch the low-hanging-fruit delivery
 * patterns that malware authors have used for decades: risky extensions,
 * extension/MIME mismatches, and double-extensions designed to hide the
 * dangerous part behind a friendlier-looking suffix.
 */

export interface AttachmentInfo {
	filename: string;
	mimetype: string;
	size: number;
}

export interface AttachmentVerdict {
	/** 0..100 — higher is more suspicious. */
	score: number;
	flags: AttachmentFlag[];
	/** Short human-readable explanation, at most 3 flags joined. */
	explanation: string;
}

export type AttachmentFlag =
	| "dangerous_extension"
	| "macro_enabled_office"
	| "double_extension"
	| "extension_mime_mismatch"
	| "suspicious_archive_name"
	| "executable_in_archive_name"
	| "zero_byte";

/** Always-block extensions. Executable on the user's OS or a script host. */
const DANGEROUS_EXTENSIONS = new Set([
	// Windows executables
	"exe", "scr", "com", "pif", "cpl", "msi", "msp", "mst", "bat", "cmd",
	"vbs", "vbe", "js", "jse", "wsf", "wsh", "ps1", "psm1", "hta", "lnk",
	"reg", "scf", "jar", "application", "gadget",
	// macOS-y
	"dmg", "pkg", "command", "app",
	// Linux-y that are sometimes sent as attachments
	"deb", "rpm",
	// Installer scripts
	"appx", "appxbundle",
]);

/** Office formats that support macros — not blocked, but high scrutiny. */
const MACRO_OFFICE_EXTENSIONS = new Set([
	"docm", "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppam", "ppsm", "sldm",
]);

/** Archive formats — flagged when their filename advertises an executable inside. */
const ARCHIVE_EXTENSIONS = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "iso", "img"]);

/**
 * Canonical mime-type → set of acceptable extensions.
 * Used for mismatch detection, not allow-listing. Missing entries mean
 * "don't assert a match" rather than "reject unseen types".
 */
const MIME_EXT_MAP: Record<string, string[]> = {
	"application/pdf": ["pdf"],
	"image/png": ["png"],
	"image/jpeg": ["jpg", "jpeg"],
	"image/gif": ["gif"],
	"image/webp": ["webp"],
	"image/svg+xml": ["svg"],
	"text/plain": ["txt", "log", "md"],
	"text/html": ["html", "htm"],
	"text/csv": ["csv"],
	"application/zip": ["zip"],
	"application/x-rar-compressed": ["rar"],
	"application/x-7z-compressed": ["7z"],
	"application/msword": ["doc"],
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
	"application/vnd.ms-excel": ["xls"],
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
	"application/vnd.ms-powerpoint": ["ppt"],
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
};

/** Final extension (lowercased), or empty string if none. */
export function finalExtension(filename: string): string {
	const clean = filename.toLowerCase().trim();
	const idx = clean.lastIndexOf(".");
	if (idx < 0 || idx === clean.length - 1) return "";
	return clean.slice(idx + 1);
}

/** Second-to-last extension, used to detect `.pdf.exe` disguises. */
function penultimateExtension(filename: string): string {
	const clean = filename.toLowerCase().trim();
	const last = clean.lastIndexOf(".");
	if (last <= 0) return "";
	const stem = clean.slice(0, last);
	const prev = stem.lastIndexOf(".");
	if (prev < 0) return "";
	return stem.slice(prev + 1);
}

/**
 * Score + flag a single attachment. Does NOT look at file contents.
 *
 * The score is a *contribution* to the email's overall suspicion score —
 * call sites decide how to weight it (the async deep-scan aggregates per
 * email, cap at 30 so attachments can't single-handedly quarantine).
 */
export function scoreAttachment(info: AttachmentInfo): AttachmentVerdict {
	const flags: AttachmentFlag[] = [];
	let score = 0;

	const last = finalExtension(info.filename);
	const prev = penultimateExtension(info.filename);
	const mime = info.mimetype.toLowerCase();

	if (info.size === 0) {
		flags.push("zero_byte");
		score += 5; // weak signal, but zero-byte attachments are rarely legitimate
	}

	if (DANGEROUS_EXTENSIONS.has(last)) {
		flags.push("dangerous_extension");
		score += 40;
	}

	if (MACRO_OFFICE_EXTENSIONS.has(last)) {
		flags.push("macro_enabled_office");
		score += 20;
	}

	// Classic "invoice.pdf.exe" / "report.docx.js" — penultimate extension
	// is a common "safe" one while the final is dangerous. Flag both on
	// dangerous final and on mismatched penultimate.
	if (prev && isLikelyPenultimateCover(prev) && last !== prev) {
		flags.push("double_extension");
		score += 15;
	}

	// MIME/extension mismatch: declared MIME says one thing, filename
	// extension says another. We only flag when the MIME is one we have
	// a canonical mapping for — missing map entries pass silently so we
	// don't flood on exotic-but-valid types.
	const expected = MIME_EXT_MAP[mime];
	if (expected && last && !expected.includes(last)) {
		flags.push("extension_mime_mismatch");
		score += 15;
	}

	// Archive whose filename mentions an executable payload. Cheap check
	// that catches the common `invoice_exe.zip` or `report(exe).zip`
	// spam/phish patterns without unpacking.
	if (ARCHIVE_EXTENSIONS.has(last)) {
		const lower = info.filename.toLowerCase();
		// Allow underscore/dot/dash/parens as segment separators, not just
		// \b (which treats `_exe` as a single word).
		if (/(?:^|[^a-z0-9])(exe|scr|bat|cmd|vbs|js|ps1|hta|lnk)(?:[^a-z0-9]|$)/.test(lower)) {
			flags.push("executable_in_archive_name");
			score += 10;
		} else if (/(?:^|[^a-z0-9])(invoice|receipt|payment|shipment|tracking)(?:[^a-z0-9]|$)/.test(lower)) {
			// Commercial-bait archive — not blocked, just nudged upward.
			flags.push("suspicious_archive_name");
			score += 5;
		}
	}

	score = Math.max(0, Math.min(100, score));
	const explanation = flags.slice(0, 3).join(", ") || "no notable signals";
	return { score, flags, explanation };
}

/**
 * Per-email aggregation: roll up individual attachment verdicts into a
 * single score capped at 30 so attachments can contribute meaningfully
 * to quarantine but never dominate the aggregate on their own.
 */
export function aggregateAttachmentSignals(
	verdicts: AttachmentVerdict[],
): { score: number; flags: AttachmentFlag[]; reasons: string[] } {
	const flags = new Set<AttachmentFlag>();
	const reasons: string[] = [];
	let highest = 0;
	for (const v of verdicts) {
		for (const f of v.flags) flags.add(f);
		if (v.score > highest) highest = v.score;
		if (v.flags.length > 0) reasons.push(`attachment: ${v.explanation}`);
	}
	return {
		score: Math.min(30, highest),
		flags: [...flags],
		// De-duplicated explanation lines, capped at a couple entries for brevity.
		reasons: dedupe(reasons).slice(0, 2),
	};
}

function dedupe(items: string[]): string[] {
	return [...new Set(items)];
}

/**
 * Penultimate extensions that get abused as "cover" in double-extension
 * tricks. Constrained to common document / media types — we don't want
 * legitimate files like `archive.tar.gz` to flag.
 */
function isLikelyPenultimateCover(ext: string): boolean {
	return ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "jpg", "jpeg", "png"].includes(ext);
}
