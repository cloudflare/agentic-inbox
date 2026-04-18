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

describe("evaluateTriage — hard block", () => {
	it("quarantines on confirmed intel hit regardless of sender trust", () => {
		const r = evaluateTriage({
			sender: "ceo@trusted.com",
			auth: dmarcPass,
			reputation: null,
			urls: [],
			intelMatch: { matched: true, feedId: "urlhaus", value: "bad.example", confirmed: true },
			settings: { ...baseSettings, allowlist_senders: ["ceo@trusted.com"] },
		});
		expect(r?.tier).toBe("hard_block");
		expect(r?.verdict.action).toBe("quarantine");
	});

	it("does NOT hard-block on unconfirmed (bloom-only) intel hit", () => {
		// Bloom FPR is ~1% — we never act on an unconfirmed hit alone.
		const r = evaluateTriage({
			sender: "x@y.com",
			auth: dmarcFail,
			reputation: null,
			urls: [],
			intelMatch: { matched: true, feedId: "f", value: "v", confirmed: false },
			settings: baseSettings,
		});
		expect(r).toBeNull();
	});

	it("hard-blocks a sender that's been flagged on this mailbox", () => {
		const r = evaluateTriage({
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
			urls: [],
			intelMatch: null,
			settings: baseSettings,
		});
		expect(r?.tier).toBe("hard_block");
	});

	it("is disabled when intel_auto_block is off", () => {
		const r = evaluateTriage({
			sender: "x@y.com",
			auth: dmarcFail,
			reputation: null,
			urls: [],
			intelMatch: { matched: true, feedId: "urlhaus", value: "v", confirmed: true },
			settings: { ...baseSettings, intel_auto_block: false },
		});
		expect(r).toBeNull();
	});
});

describe("evaluateTriage — hard allow", () => {
	it("requires DMARC pass even for an explicit allowlist match", () => {
		// Critical invariant: allowlist alone is insufficient.
		const r = evaluateTriage({
			sender: "ceo@trusted.com",
			auth: dmarcFail,
			reputation: null,
			urls: [],
			intelMatch: null,
			settings: { ...baseSettings, allowlist_senders: ["ceo@trusted.com"] },
		});
		expect(r).toBeNull();
	});

	it("allows on explicit sender allowlist + DMARC pass", () => {
		const r = evaluateTriage({
			sender: "ceo@trusted.com",
			auth: dmarcPass,
			reputation: null,
			urls: [],
			intelMatch: null,
			settings: { ...baseSettings, allowlist_senders: ["ceo@trusted.com"] },
		});
		expect(r?.tier).toBe("hard_allow");
		expect(r?.verdict.action).toBe("allow");
	});

	it("allows on explicit domain allowlist + DMARC pass (exact)", () => {
		const r = evaluateTriage({
			sender: "anyone@trusted.com",
			auth: dmarcPass,
			reputation: null,
			urls: [],
			intelMatch: null,
			settings: { ...baseSettings, allowlist_domains: ["trusted.com"] },
		});
		expect(r?.tier).toBe("hard_allow");
	});

	it("allows subdomains of allowlisted domains", () => {
		const r = evaluateTriage({
			sender: "bot@mail.trusted.com",
			auth: dmarcPass,
			reputation: null,
			urls: [],
			intelMatch: null,
			settings: { ...baseSettings, allowlist_domains: ["trusted.com"] },
		});
		expect(r?.tier).toBe("hard_allow");
	});

	it("allows on history-based trust when min_messages threshold met", () => {
		const r = evaluateTriage({
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
			urls: [],
			intelMatch: null,
			settings: { ...baseSettings, trusted_auto_allow_min_messages: 10 },
		});
		expect(r?.tier).toBe("hard_allow");
	});

	it("does not history-allow a flagged sender even if message_count is high", () => {
		const r = evaluateTriage({
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
			urls: [],
			intelMatch: null,
			settings: { ...baseSettings, trusted_auto_allow_min_messages: 10 },
		});
		// hard_block tier (because flagged) trumps hard_allow
		expect(r?.tier).toBe("hard_block");
	});

	it("returns null (falls through to full pipeline) when neither tier applies", () => {
		const r = evaluateTriage({
			sender: "stranger@nowhere.com",
			auth: dmarcPass,
			reputation: null,
			urls: [],
			intelMatch: null,
			settings: baseSettings,
		});
		expect(r).toBeNull();
	});
});
