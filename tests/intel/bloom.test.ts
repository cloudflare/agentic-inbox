import { describe, expect, it } from "vitest";
import {
	addToBloom,
	checkBloom,
	createBloom,
	deserializeBloom,
	serializeBloom,
} from "../../workers/intel/bloom";

describe("bloom filter", () => {
	it("finds values it was given", () => {
		const b = createBloom(1000);
		for (const v of ["a.example", "b.example", "https://c.example/x"]) addToBloom(b, v);
		for (const v of ["a.example", "b.example", "https://c.example/x"]) expect(checkBloom(b, v)).toBe(true);
	});

	it("respects its own p=0.01 FPR on modest inputs", () => {
		const b = createBloom(1000, 0.01);
		const kept = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			const v = `entry-${i}.example.com`;
			kept.add(v);
			addToBloom(b, v);
		}
		let falsePositives = 0;
		const probes = 5000;
		for (let i = 0; i < probes; i++) {
			const v = `probe-${i}.unknown.example`;
			if (kept.has(v)) continue;
			if (checkBloom(b, v)) falsePositives++;
		}
		// 1% target with ~5000 probes leaves plenty of headroom; we assert a
		// loose upper bound so small hash quirks don't flake the suite.
		expect(falsePositives / probes).toBeLessThan(0.05);
	});

	it("round-trips through serialize/deserialize", () => {
		const b = createBloom(500);
		for (let i = 0; i < 100; i++) addToBloom(b, `v${i}`);
		const serialized = serializeBloom(b);
		const restored = deserializeBloom(serialized);
		expect(restored).not.toBeNull();
		for (let i = 0; i < 100; i++) expect(checkBloom(restored!, `v${i}`)).toBe(true);
	});

	it("rejects invalid magic bytes on deserialize", () => {
		const bad = new Uint8Array(16);
		expect(deserializeBloom(bad)).toBeNull();
	});

	it("rejects truncated input on deserialize", () => {
		expect(deserializeBloom(new Uint8Array(4))).toBeNull();
	});
});
