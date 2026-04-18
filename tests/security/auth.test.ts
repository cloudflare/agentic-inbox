import { describe, expect, it } from "vitest";
import { emptyVerdict, parseAuthResults, scoreAuth } from "../../workers/security/auth";

function header(name: string, value: string) {
	return { key: name, value };
}

describe("parseAuthResults", () => {
	it("returns all-none when no Authentication-Results header present", () => {
		expect(parseAuthResults([header("from", "a@b.com")])).toEqual(emptyVerdict());
	});

	it("returns all-none when rawHeaders is not an array", () => {
		expect(parseAuthResults(null)).toEqual(emptyVerdict());
		expect(parseAuthResults(undefined)).toEqual(emptyVerdict());
		expect(parseAuthResults("not-an-array")).toEqual(emptyVerdict());
	});

	it("parses a standard gmail-style Authentication-Results header", () => {
		const verdict = parseAuthResults([
			header(
				"Authentication-Results",
				"mx.google.com; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
			),
		]);
		expect(verdict).toMatchObject({ spf: "pass", dkim: "pass", dmarc: "pass", authservId: "mx.google.com" });
	});

	it("captures softfail/fail/temperror/permerror", () => {
		const verdict = parseAuthResults([
			header(
				"Authentication-Results",
				"srv1; spf=softfail smtp.mailfrom=x; dkim=fail; dmarc=temperror",
			),
		]);
		expect(verdict).toMatchObject({ spf: "softfail", dkim: "fail", dmarc: "temperror" });
	});

	it("is case-insensitive on header key and result values", () => {
		const verdict = parseAuthResults([
			header("AUTHENTICATION-RESULTS", "authserv-x; SPF=Pass; DKIM=Fail; DMARC=None"),
		]);
		expect(verdict).toMatchObject({ spf: "pass", dkim: "fail", dmarc: "none", authservId: "authserv-x" });
	});

	it("first-verdict-wins across duplicate Authentication-Results headers", () => {
		// Multiple Authentication-Results headers can appear when mail traverses
		// several verifiers. We trust the first (outermost-recorded) result so a
		// downstream relay cannot override an upstream failure verdict.
		const verdict = parseAuthResults([
			header("Authentication-Results", "inner; spf=fail; dkim=fail; dmarc=fail"),
			header("Authentication-Results", "outer; spf=pass; dkim=pass; dmarc=pass"),
		]);
		expect(verdict).toMatchObject({ spf: "fail", dkim: "fail", dmarc: "fail", authservId: "inner" });
	});

	it("ignores irrelevant headers", () => {
		const verdict = parseAuthResults([
			header("DKIM-Signature", "v=1; a=rsa-sha256; dkim=pass"),
			header("Received-SPF", "pass"),
		]);
		expect(verdict).toEqual(emptyVerdict());
	});

	it("captures authserv-id when no method results are present", () => {
		const verdict = parseAuthResults([
			header("Authentication-Results", "auth.example.com; none"),
		]);
		expect(verdict.authservId).toBe("auth.example.com");
	});
});

describe("scoreAuth", () => {
	it("scores a clean pass as a net-negative (credit)", () => {
		const { score } = scoreAuth({ spf: "pass", dkim: "pass", dmarc: "pass" });
		expect(score).toBe(-10);
	});

	it("scores a DMARC fail as suspicious", () => {
		const { score, reasons } = scoreAuth({ spf: "pass", dkim: "pass", dmarc: "fail" });
		expect(score).toBeGreaterThanOrEqual(20);
		expect(reasons.join(" ")).toMatch(/DMARC/i);
	});

	it("caps multi-fail contribution at 30 (before DMARC-pass credit)", () => {
		const { score } = scoreAuth({ spf: "fail", dkim: "fail", dmarc: "fail" });
		expect(score).toBe(30);
	});

	it("scores SPF softfail identically to SPF fail (treats both as suspicious)", () => {
		const softfail = scoreAuth({ spf: "softfail", dkim: "none", dmarc: "none" });
		const fail = scoreAuth({ spf: "fail", dkim: "none", dmarc: "none" });
		expect(softfail.score).toBe(fail.score);
	});

	it("returns zero for all-none (no auth headers present)", () => {
		const { score } = scoreAuth(emptyVerdict());
		expect(score).toBe(0);
	});
});
