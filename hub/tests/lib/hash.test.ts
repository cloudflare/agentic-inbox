import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { generateSecret, sha256 } from "../../src/lib/hash";

// Polyfill `crypto` (Web Crypto API) for Node test runtimes that don't expose
// it on `globalThis`. Node ≥ 20 has it built in; older versions need the shim.
if (!(globalThis as any).crypto) {
	(globalThis as any).crypto = webcrypto;
}

describe("sha256", () => {
	it("produces the known digest of the empty string", async () => {
		// Well-known: sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
		expect(await sha256("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});

	it("produces the known digest of 'abc'", async () => {
		expect(await sha256("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("is stable across calls (deterministic)", async () => {
		const a = await sha256("claude");
		const b = await sha256("claude");
		expect(a).toBe(b);
	});

	it("produces distinct digests for distinct inputs", async () => {
		const a = await sha256("claude");
		const b = await sha256("Claude");
		expect(a).not.toBe(b);
	});

	it("handles multi-byte UTF-8 correctly", async () => {
		// Different strings must hash differently even if their lengths match
		// when encoded as UTF-8.
		const a = await sha256("café");
		const b = await sha256("cafe");
		expect(a).not.toBe(b);
	});
});

describe("generateSecret", () => {
	it("returns a 43-character base64url string (≈256 bits)", () => {
		const s = generateSecret();
		expect(s).toHaveLength(43);
		expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("returns a fresh value each call", () => {
		// Birthday collision on 32 random bytes is astronomically unlikely;
		// this is really just checking we're not accidentally returning a
		// cached/constant value.
		const secrets = new Set<string>();
		for (let i = 0; i < 50; i++) secrets.add(generateSecret());
		expect(secrets.size).toBe(50);
	});
});
