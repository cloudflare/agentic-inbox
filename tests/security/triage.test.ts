import { describe, expect, it } from "vitest";
import { evaluateTriage } from "../../workers/security/triage";
import { DEFAULT_SECURITY_SETTINGS } from "../../workers/security/settings";
import type { AuthVerdict } from "../../workers/security/auth";

const dmarcPass: AuthVerdict = { spf: "pass", dkim: "pass", dmarc: "pass" };
const dmarcFail: AuthVerdict = { spf: "fail", dkim: "fail", dmarc: "fail" };

const baseSettings = {
	...DEFAULT_SECURITY_SETTINGS,
	enabled: true,
	trusted_auto_allow: true,
	intel_auto_block: true,
};

const baseInputs = {
	urls: [],
	targetFolder: "INBOX",
	attachments: [],
};

describe("evaluateTriage — hard block", () => {
	it("quarantines on confirmed intel hit regardless of sender trust", () => {
		const r = evaluateTriage({
			...baseInputs,
			sender: "ceo@trusted.com",
			auth: dmarcPass,
			reputation: null,
			intelMatch: { matched: true, feedId: "urlhaus", value: "bad.example", confirmed: true },
			settings: { ...baseSettings, allowlist_senders: ["ceo@trusted.com"] },
		});
		expect(r.shortcircuit?.tier).toBe("hard_block");
		expect(r.shortcircuit?.verdict.action).toBe("quarantine");
	});

	it("does NOT hard-block on unconfirmed (bloom-only) intel hit", () => {
		// Bloom FPR is ~1% — we never act on an unconfirmed hit alone.
		const r = evaluateTriage({
			...baseInputs,
			sender: "x@y.com",
			auth: dmarcFail,
			reputation: null,
			intelMatch: { matched: true, feedId: "f", value: "v", confirmed: false },
			settings: baseSettings,
		});
		expect(r.shortcircuit).toBeUndefined();
	});

	it("hard-blocks a sender that's been flagged on this mailbox", () => {
		const r = evaluateTriage({
			...baseInputs,
			sender: "x@y.com",
			auth: dmarcPass,
			reputation: {
				sender: "x@y.com",
				first_seen: "",
				last_seen: "",
				message_count: 2,
				avg_score: 40,
				flagged: true,
			},
			intelMatch: null,
			settings: baseSettings,
		});
		expect(r.shortcircuit?.tier).toBe("hard_block");
	});

	it("is disabled when intel_auto_block is off", () => {
		const r = evaluateTriage({
			...baseInputs,
			sender: "x@y.com",
			auth: dmarcFail,
			reputation: null,
			intelMatch: { matched: true, feedId: "urlhaus", value: "v", confirmed: true },
			settings: { ...baseSettings, intel_auto_block: false },
		});
		expect(r.shortcircuit).toBeUndefined();
	});
});

describe("evaluateTriage — hard allow", () => {
	it("requires DMARC pass even for an explicit allowlist match", () => {
		// Critical invariant: allowlist alone is insufficient.
		const r = evaluateTriage({
			...baseInputs,
			sender: "ceo@trusted.com",
			auth: dmarcFail,
			reputation: null,
			intelMatch: null,
			settings: { ...baseSettings, allowlist_senders: ["ceo@trusted.com"] },
		});
		expect(r.shortcircuit).toBeUndefined();
	});

	it("allows on explicit sender allowlist + DMARC pass", () => {
		const r = evaluateTriage({
			...baseInputs,
			sender: "ceo@trusted.com",
			auth: dmarcPass,
			reputation: null,
			intelMatch: null,
			settings: { ...baseSettings, allowlist_senders: ["ceo@trusted.com"] },
		});
		expect(r.shortcircuit?.tier).toBe("hard_allow");
		expect(r.shortcircuit?.verdict.action).toBe("allow");
	});

	it("allows on explicit domain allowlist + DMARC pass (exact)", () => {
		const r = evaluateTriage({
			...baseInputs,
			sender: "anyone@trusted.com",
			auth: dmarcPass,
			reputation: null,
			intelMatch: null,
			settings: { ...baseSettings, allowlist_domains: ["trusted.com"] },
		});
		expect(r.shortcircuit?.tier).toBe("hard_allow");
	});

	it("allows subdomains of allowlisted domains", () => {
		const r = evaluateTriage({
			...baseInputs,
			sender: "bot@mail.trusted.com",
			auth: dmarcPass,
			reputation: null,
			intelMatch: null,
			settings: { ...baseSettings, allowlist_domains: ["trusted.com"] },
		});
		expect(r.shortcircuit?.tier).toBe("hard_allow");
	});

	it("allows on history-based trust when min_messages threshold met", () => {
		const r = evaluateTriage({
			...baseInputs,
			sender: "colleague@work.com",
			auth: dmarcPass,
			reputation: {
				sender: "colleague@work.com",
				first_seen: "",
				last_seen: "",
				message_count: 50,
				avg_score: 5,
				flagged: false,
			},
			intelMatch: null,
			settings: { ...baseSettings, trusted_auto_allow_min_messages: 10 },
		});
		expect(r.shortcircuit?.tier).toBe("hard_allow");
	});

	it("does not history-allow a flagged sender even if message_count is high", () => {
		const r = evaluateTriage({
			...baseInputs,
			sender: "colleague@work.com",
			auth: dmarcPass,
			reputation: {
				sender: "colleague@work.com",
				first_seen: "",
				last_seen: "",
				message_count: 100,
				avg_score: 80,
				flagged: true,
			},
			intelMatch: null,
			settings: { ...baseSettings, trusted_auto_allow_min_messages: 10 },
		});
		// hard_block tier (because flagged) trumps hard_allow
		expect(r.shortcircuit?.tier).toBe("hard_block");
	});

	it("returns no short-circuit when neither tier applies", () => {
		const r = evaluateTriage({
			...baseInputs,
			sender: "stranger@nowhere.com",
			auth: dmarcPass,
			reputation: null,
			intelMatch: null,
			settings: baseSettings,
		});
		expect(r.shortcircuit).toBeUndefined();
	});
});
