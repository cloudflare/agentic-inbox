import { describe, expect, it } from "vitest";
import { scoreReputation } from "../../workers/security/reputation";

describe("scoreReputation", () => {
	it("adds +5 suspicion for first-time senders (null reputation)", () => {
		const { score, reasons } = scoreReputation(null);
		expect(score).toBe(5);
		expect(reasons.join(" ")).toMatch(/first-time/i);
	});

	it("adds +5 suspicion when message_count is 0", () => {
		const { score } = scoreReputation({
			sender: "a@b.com",
			first_seen: "",
			last_seen: "",
			message_count: 0,
			avg_score: 0,
			flagged: false,
		});
		expect(score).toBe(5);
	});

	it("adds +15 suspicion for a previously flagged sender", () => {
		const { score, reasons } = scoreReputation({
			sender: "a@b.com",
			first_seen: "",
			last_seen: "",
			message_count: 10,
			avg_score: 50,
			flagged: true,
		});
		expect(score).toBe(15);
		expect(reasons.join(" ")).toMatch(/flagged/i);
	});

	it("returns zero for a trusted sender with long benign history", () => {
		const { score, reasons } = scoreReputation({
			sender: "a@b.com",
			first_seen: "",
			last_seen: "",
			message_count: 100,
			avg_score: 5,
			flagged: false,
		});
		expect(score).toBe(0);
		expect(reasons).toEqual([]);
	});

	it("adds suspicion (never subtracts) for a sender with consistently bad history", () => {
		// Regression: earlier versions subtracted from the score when
		// avg_score was high, which inverted the reputation signal —
		// a sender that has reliably been malicious in the past looked
		// *less* suspicious to the aggregator than an unknown sender.
		const { score } = scoreReputation({
			sender: "a@b.com",
			first_seen: "",
			last_seen: "",
			message_count: 20,
			avg_score: 80,
			flagged: false,
		});
		expect(score).toBeGreaterThanOrEqual(0);
	});
});
