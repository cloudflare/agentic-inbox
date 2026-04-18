import { describe, expect, it } from "vitest";
import { aggregateVerdict, DEFAULT_THRESHOLDS } from "../../workers/security/verdict";
import type { AuthVerdict } from "../../workers/security/auth";
import type { ClassificationResult } from "../../workers/security/classification";

const cleanAuth: AuthVerdict = { spf: "pass", dkim: "pass", dmarc: "pass" };
const safeClass: ClassificationResult = { label: "safe", confidence: 0.9, reasoning: "ok" };

describe("aggregateVerdict", () => {
	it("produces allow for a clean, trusted email", () => {
		const v = aggregateVerdict({
			auth: cleanAuth,
			classification: safeClass,
			urls: [],
			reputation: {
				sender: "a@b.com",
				first_seen: "2026-01-01T00:00:00Z",
				last_seen: "2026-01-01T00:00:00Z",
				message_count: 5,
				avg_score: 5,
				flagged: false,
			},
		});
		expect(v.action).toBe("allow");
		expect(v.score).toBeLessThan(DEFAULT_THRESHOLDS.tag);
	});

	it("quarantines on high-confidence phishing + DMARC fail", () => {
		const v = aggregateVerdict({
			auth: { spf: "fail", dkim: "fail", dmarc: "fail" },
			classification: { label: "phishing", confidence: 0.95, reasoning: "fake login" },
			urls: [
				{ url: "https://paypa1.com", hostname: "paypa1.com", is_homograph: true, is_shortener: false },
			],
			reputation: null,
		});
		expect(["quarantine", "block"]).toContain(v.action);
		expect(v.score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.quarantine);
		expect(v.signals.length).toBeGreaterThan(0);
	});

	it("clamps score to [0, 100]", () => {
		const v = aggregateVerdict({
			auth: { spf: "fail", dkim: "fail", dmarc: "fail" },
			classification: { label: "phishing", confidence: 1 , reasoning: "" },
			urls: [
				{ url: "https://paypa1.com", hostname: "paypa1.com", is_homograph: true, is_shortener: true },
			],
			reputation: { sender: "x", first_seen: "", last_seen: "", message_count: 1, avg_score: 99, flagged: true },
		}, DEFAULT_THRESHOLDS);
		expect(v.score).toBeLessThanOrEqual(100);
		expect(v.score).toBeGreaterThanOrEqual(0);
	});

	it("never returns negative scores even when all signals are benign", () => {
		// A clean-auth email with no other signals gets -10 from scoreAuth;
		// the aggregate must floor that at 0.
		const v = aggregateVerdict({
			auth: cleanAuth,
			classification: safeClass,
			urls: [],
			reputation: null, // first-time sender adds +5, so this caps negative
		});
		expect(v.score).toBeGreaterThanOrEqual(0);
	});

	it("explanation surfaces the first few signals", () => {
		const v = aggregateVerdict({
			auth: { spf: "fail", dkim: "fail", dmarc: "fail" },
			classification: { label: "phishing", confidence: 0.9, reasoning: "" },
			urls: [],
			reputation: null,
		});
		expect(v.explanation.length).toBeGreaterThan(0);
		expect(v.explanation).not.toBe("no notable signals");
	});

	it("respects custom thresholds", () => {
		const base = {
			auth: cleanAuth,
			classification: { label: "spam" as const, confidence: 0.9, reasoning: "" },
			urls: [],
			reputation: null,
		};
		const strict = aggregateVerdict(base, { tag: 5, quarantine: 10, block: 20 });
		const lenient = aggregateVerdict(base, { tag: 90, quarantine: 95, block: 99 });
		expect(strict.action).not.toBe("allow");
		expect(lenient.action).toBe("allow");
	});
});
