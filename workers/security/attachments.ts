// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Cheap attachment-metadata gate. Runs BEFORE the LLM classifier.
 *
 * Catches the worst-case filetypes using just what PostalMime already parsed
 * (filename + mimetype). Deep scans (OCR, macro analysis, unzip) are a
 * separate, async concern — this module stays synchronous and allocation-free.
 *
 * Classification is purely extension-based. Mimetype on email attachments is
 * whatever the sending client set and is trivially spoofed — `invoice.exe`
 * sent as `application/pdf` is still an executable. We use the LAST
 * extension in the filename so `invoice.pdf.exe` resolves to `.exe`.
 */

/** High-risk executables. These have effectively zero legit use as email attachments. */
const EXECUTABLE_EXTENSIONS = new Set<string>([
	"exe", "scr", "com", "pif", "cpl", "cmd", "bat",
	"msi", "msix", "appx",
	"jar",
	"js", "jse", "vbs", "vbe", "wsf", "wsh", "ps1",
	"hta", "lnk", "inf",
]);

/**
 * High-risk container/disk-image formats. Legit uses exist (e.g. ISO of a
 * boot installer) but they are heavily used to smuggle executables past
 * gateways that block `.exe` directly — a user who double-clicks the .iso
 * in modern Windows gets it mounted as a drive without any warning.
 */
const CONTAINER_EXTENSIONS = new Set<string>([
	"iso", "img", "vhd", "vhdx",
]);

/** Macro-enabled Office documents. Macros are the classic malware delivery path. */
const MACRO_OFFICE_EXTENSIONS = new Set<string>([
	"docm", "xlsm", "pptm", "xlam", "xltm", "potm", "ppsm",
]);

export type AttachmentCategory = "executable" | "container" | "macro_office" | "safe";

export interface AttachmentClassification {
	category: AttachmentCategory;
	ext: string;
}

export type AttachmentAction = "block" | "score" | "ignore";

export interface AttachmentPolicy {
	executable_action: AttachmentAction;
	container_action: AttachmentAction;
	macro_office_action: AttachmentAction;
	/** Additional extensions (lowercased, no leading dot) that are treated as executables. */
	custom_blocklist_extensions: string[];
}

export interface AttachmentLike {
	filename?: string | null;
	mimetype?: string | null;
}

export interface AttachmentScoreResult {
	score: number;
	reasons: string[];
	hardBlock: boolean;
	/** Which attachment triggered the hard-block, if any — useful for UI/logging. */
	hardBlockReason?: string;
}

/**
 * Extract the last extension from a filename (lowercased, no dot). Returns
 * "" when there's no usable extension. Handles `invoice.pdf.exe` → `"exe"`.
 */
export function extractExtension(filename: string | null | undefined): string {
	if (!filename) return "";
	const stripped = filename.trim();
	if (stripped.length === 0) return "";
	const lastDot = stripped.lastIndexOf(".");
	if (lastDot <= 0 || lastDot === stripped.length - 1) return "";
	return stripped.slice(lastDot + 1).toLowerCase();
}

/** Classify a single attachment by its filename. Mimetype is accepted for API
 *  symmetry but intentionally ignored (see file header). */
export function classifyAttachment(
	filename: string | null | undefined,
	_mimetype: string | null | undefined,
): AttachmentClassification {
	const ext = extractExtension(filename);
	if (!ext) return { category: "safe", ext: "" };
	if (EXECUTABLE_EXTENSIONS.has(ext)) return { category: "executable", ext };
	if (CONTAINER_EXTENSIONS.has(ext)) return { category: "container", ext };
	if (MACRO_OFFICE_EXTENSIONS.has(ext)) return { category: "macro_office", ext };
	return { category: "safe", ext };
}

/** Score contributions per category when action === "score". Tuned so a
 *  single macro doc alone can't push a clean email into tag territory, but
 *  two signals (e.g. macro + bad auth) will. */
const CONTAINER_SCORE_BOOST = 25;
const MACRO_OFFICE_SCORE_BOOST = 15;

export const DEFAULT_ATTACHMENT_POLICY: AttachmentPolicy = {
	executable_action: "block",
	container_action: "score",
	macro_office_action: "score",
	custom_blocklist_extensions: [],
};

/**
 * Evaluate an attachment list against the policy.
 *
 * A `hardBlock: true` result means the caller should short-circuit the
 * pipeline to quarantine — we don't want to pay for an LLM call on an email
 * that carries a .exe.
 *
 * Custom blocklist is ADDITIVE — it can only expand what gets blocked, never
 * weaken the defaults. (An org can't accidentally allowlist executables via
 * configuration, only add further extensions on top.)
 */
export function scoreAttachments(
	attachments: AttachmentLike[] | null | undefined,
	policy: AttachmentPolicy,
): AttachmentScoreResult {
	if (!attachments || attachments.length === 0) {
		return { score: 0, reasons: [], hardBlock: false };
	}

	// Normalise once — callers may pass user-supplied config, and duplicates
	// or empty entries would just waste work in the hot loop below.
	const customBlocklist = new Set(
		(policy.custom_blocklist_extensions ?? [])
			.map((e) => e.trim().toLowerCase().replace(/^\./, ""))
			.filter((e) => e.length > 0),
	);

	let score = 0;
	const reasons: string[] = [];
	let hardBlock = false;
	let hardBlockReason: string | undefined;

	for (const att of attachments) {
		const { category, ext } = classifyAttachment(att.filename, att.mimetype);
		const name = att.filename || "(unnamed attachment)";

		// Custom blocklist is checked first and always acts as a hard-block.
		// This runs even for files that would otherwise classify as "safe".
		if (ext && customBlocklist.has(ext)) {
			const reason = `attachment on custom blocklist .${ext} (${name})`;
			reasons.push(reason);
			if (!hardBlock) { hardBlock = true; hardBlockReason = reason; }
			continue;
		}

		if (category === "safe") continue;

		const action = category === "executable" ? policy.executable_action
			: category === "container" ? policy.container_action
			: policy.macro_office_action;

		if (action === "ignore") continue;

		if (action === "block") {
			const reason = `attachment ${category} .${ext} (${name})`;
			reasons.push(reason);
			if (!hardBlock) { hardBlock = true; hardBlockReason = reason; }
			continue;
		}

		// action === "score"
		const boost = category === "container" ? CONTAINER_SCORE_BOOST
			: category === "macro_office" ? MACRO_OFFICE_SCORE_BOOST
			: /* executable under "score" policy */ 40;
		score += boost;
		reasons.push(`attachment ${category} .${ext} (${name}) +${boost}`);
	}

	return { score, reasons, hardBlock, hardBlockReason };
}

// Hand-traced examples (kept in code so the intent is grep-able):
//   classifyAttachment("invoice.exe", "application/pdf") → { category: "executable", ext: "exe" }
//   classifyAttachment("invoice.pdf.exe", ...)           → { category: "executable", ext: "exe" }
//   classifyAttachment("report.iso", ...)                → { category: "container",  ext: "iso" }
//   classifyAttachment("report.docm", ...)               → { category: "macro_office", ext: "docm" }
//   classifyAttachment("invoice.pdf", ...)               → { category: "safe",       ext: "pdf" }
//
// With DEFAULT_ATTACHMENT_POLICY:
//   [invoice.exe]  → hardBlock=true, reason "attachment executable .exe (invoice.exe)"
//   [report.iso]   → hardBlock=false, score 25
//   [report.docm]  → hardBlock=false, score 15
//   [invoice.pdf]  → hardBlock=false, score 0
//   [malware.ace] with custom_blocklist_extensions=["ace"] → hardBlock=true
//
// TODO(attachments): password-protected archive heuristic. zip/rar with a
// very high ratio of unparseable content relative to size is a classic
// malware-smuggling pattern, but we can't cleanly detect it without an
// unzip implementation in the Worker — deferred alongside full deep-scan.
