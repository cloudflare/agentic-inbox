// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

import { describe, expect, it } from "vitest";
import { verdictActionToPill } from "~/components/phishsoc/verdict";

describe("verdictActionToPill", () => {
	it("maps block to danger/Blocked", () => {
		expect(verdictActionToPill("block")).toEqual({ tone: "danger", label: "Blocked" });
	});

	it("maps quarantine to suspect/Quarantined", () => {
		expect(verdictActionToPill("quarantine")).toEqual({
			tone: "suspect",
			label: "Quarantined",
		});
	});

	it("maps tag to suspect/Suspicious", () => {
		expect(verdictActionToPill("tag")).toEqual({ tone: "suspect", label: "Suspicious" });
	});

	it("returns null for allow (no pill on clean rows)", () => {
		expect(verdictActionToPill("allow")).toBeNull();
	});

	it("returns null for unknown / null / undefined", () => {
		expect(verdictActionToPill("unknown-action")).toBeNull();
		expect(verdictActionToPill(null)).toBeNull();
		expect(verdictActionToPill(undefined)).toBeNull();
	});
});
