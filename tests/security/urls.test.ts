import { describe, expect, it } from "vitest";
import {
	extractUrls,
	isHomographic,
	scoreUrls,
	type ExtractedUrl,
} from "../../workers/security/urls";

describe("extractUrls", () => {
	it("returns [] for empty/null input", () => {
		expect(extractUrls(null)).toEqual([]);
		expect(extractUrls(undefined)).toEqual([]);
		expect(extractUrls("")).toEqual([]);
	});

	it("extracts an anchor href and its visible display text", () => {
		const urls = extractUrls('<a href="https://example.com/login">Click here</a>');
		expect(urls).toHaveLength(1);
		expect(urls[0]).toMatchObject({
			url: "https://example.com/login",
			display_text: "Click here",
			hostname: "example.com",
		});
	});

	it("extracts bare URLs from plain text", () => {
		const urls = extractUrls("Visit https://example.com/path now.");
		expect(urls.map((u) => u.url)).toContain("https://example.com/path");
	});

	it("de-duplicates URLs by exact match", () => {
		const urls = extractUrls(
			'<a href="https://a.com/x">a</a> and <a href="https://a.com/x">b</a>',
		);
		expect(urls).toHaveLength(1);
	});

	it("caps output at the configured limit", () => {
		const body = Array.from({ length: 30 }, (_, i) => `https://example${i}.com`).join(" ");
		expect(extractUrls(body, 10)).toHaveLength(10);
	});

	it("ignores garbage that does not parse as a URL", () => {
		expect(extractUrls('<a href="javascript:void(0)">x</a>')).toEqual([]);
		expect(extractUrls("not a url")).toEqual([]);
	});

	it("flags shorteners on extracted URLs", () => {
		const urls = extractUrls("https://bit.ly/abc and https://tinyurl.com/xyz");
		expect(urls.every((u) => u.is_shortener)).toBe(true);
	});

	it("strips HTML from display_text", () => {
		const urls = extractUrls('<a href="https://example.com"><b>Click <i>here</i></b></a>');
		expect(urls[0].display_text).toBe("Click here");
	});
});

describe("isHomographic", () => {
	it("flags non-ASCII hostnames", () => {
		expect(isHomographic("раypal.com")).toBe(true); // Cyrillic 'р'
		expect(isHomographic("münchen.example")).toBe(true);
	});

	it("flags bare punycode hostnames", () => {
		expect(isHomographic("xn--paypa-7ve.com")).toBe(true);
	});

	it("does NOT flag exact matches or subdomains of high-value domains", () => {
		expect(isHomographic("paypal.com")).toBe(false);
		expect(isHomographic("mail.google.com")).toBe(false);
		expect(isHomographic("accounts.google.com")).toBe(false);
	});

	it("flags typo-squats of high-value .com domains (Lev dist 1–2)", () => {
		expect(isHomographic("paypa1.com")).toBe(true);
		expect(isHomographic("g00gle.com")).toBe(true);
		expect(isHomographic("anazon.com")).toBe(true);
	});

	it("does not flag unrelated third-party domains", () => {
		expect(isHomographic("openai.com")).toBe(false);
		expect(isHomographic("rust-lang.org")).toBe(false);
	});

	it("handles multi-label public suffixes (amazon.co.uk and lookalikes)", () => {
		// Regression: earlier versions used last-2-labels as the registrable
		// domain, so `amazom.co.uk` was compared against `co.uk` (and slipped
		// through), and the real `amazon.co.uk` was fine only because of the
		// exact/suffix early return. Lookalikes of brands that are NOT in the
		// high-value list still go undetected — that's by design; we'd need a
		// broader brand database to catch those.
		expect(isHomographic("amazon.co.uk")).toBe(false);
		expect(isHomographic("amazom.co.uk")).toBe(true);
	});
});

describe("scoreUrls", () => {
	it("returns zero when all URLs are clean", () => {
		const urls: ExtractedUrl[] = [
			{ url: "https://a.com", hostname: "a.com", is_homograph: false, is_shortener: false },
		];
		expect(scoreUrls(urls)).toEqual({ score: 0, reasons: [] });
	});

	it("scores a homograph URL at +20", () => {
		const urls: ExtractedUrl[] = [
			{ url: "https://paypa1.com", hostname: "paypa1.com", is_homograph: true, is_shortener: false },
		];
		expect(scoreUrls(urls).score).toBe(20);
	});

	it("scores a shortener at +5", () => {
		const urls: ExtractedUrl[] = [
			{ url: "https://bit.ly/x", hostname: "bit.ly", is_homograph: false, is_shortener: true },
		];
		expect(scoreUrls(urls).score).toBe(5);
	});

	it("stacks homograph + shortener", () => {
		const urls: ExtractedUrl[] = [
			{ url: "https://bit.ly/x", hostname: "bit.ly", is_homograph: false, is_shortener: true },
			{ url: "https://paypa1.com", hostname: "paypa1.com", is_homograph: true, is_shortener: false },
		];
		expect(scoreUrls(urls).score).toBe(25);
	});
});
