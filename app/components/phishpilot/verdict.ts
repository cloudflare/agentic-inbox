export type Verdict = "safe" | "tag" | "quarantine" | "block" | "pending";

export type VerdictTone = "safe" | "suspect" | "danger" | "info" | "muted" | "accent";

export const VERDICT_TONE: Record<Verdict, VerdictTone> = {
	safe: "safe",
	tag: "suspect",
	quarantine: "suspect",
	block: "danger",
	pending: "muted",
};

export const VERDICT_LABEL: Record<Verdict, string> = {
	safe: "Safe",
	tag: "Tagged",
	quarantine: "Quarantined",
	block: "Blocked",
	pending: "Pending",
};

// Cases use status strings (open, closed-tp, closed-fp, closed-dup) rather
// than verdict per email. Map them here so we keep the visual language
// consistent across both surfaces.
export function statusTone(status: string): VerdictTone {
	switch (status) {
		case "open": return "danger";
		case "closed-tp": return "danger";
		case "closed-fp": return "muted";
		case "closed-dup": return "muted";
		default: return "muted";
	}
}

export function statusLabel(status: string): string {
	switch (status) {
		case "open": return "Open";
		case "closed-tp": return "True positive";
		case "closed-fp": return "False positive";
		case "closed-dup": return "Duplicate";
		default: return status;
	}
}

// Returns the Tailwind text-color utility for a numeric score on a 0–100
// scale (≥80 danger, ≥70 suspect, ≥60 muted suspect, else neutral). Mirrors
// the threshold table in the design handoff.
export function scoreToneClass(score: number): string {
	if (score >= 80) return "text-danger";
	if (score >= 70) return "text-suspect";
	if (score >= 60) return "text-suspect/70";
	return "text-ink-3";
}
