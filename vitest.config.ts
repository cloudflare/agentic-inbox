import { defineConfig } from "vitest/config";

/**
 * Vitest config for the security pipeline modules.
 *
 * These modules are pure functions — parsing, scoring, and aggregation —
 * and don't need the Workers runtime to run. We deliberately scope tests
 * to `tests/` so `vitest` doesn't try to pick up build output or vendored
 * fixtures. Workers-runtime-specific modules (DO, R2, KV) stay un-unit-
 * tested here; they're exercised via integration against `wrangler dev`.
 */
export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		globals: false,
		reporters: ["default"],
	},
});
