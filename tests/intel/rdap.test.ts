import { describe, expect, it } from "vitest";
import {
	FRESH_DOMAIN_THRESHOLD_DAYS,
	lookupDomainAge,
	parseRdapAge,
	type RdapTransport,
} from "../../workers/intel/rdap";

const NOW = new Date("2026-04-18T12:00:00Z");

function rdapBody(events: Array<{ eventAction: string; eventDate: string }>) {
	return { events };
}

describe("parseRdapAge", () => {
	it("returns age_days from the earliest registration event", () => {
		const age = parseRdapAge(
			rdapBody([
				{ eventAction: "last changed", eventDate: "2026-04-01T00:00:00Z" },
				{ eventAction: "registration", eventDate: "2022-01-01T00:00:00Z" },
				{ eventAction: "registration", eventDate: "2020-06-15T00:00:00Z" }, // should win
			]),
			NOW,
		);
		expect(age?.registered_at).toBe("2020-06-15T00:00:00Z");
		expect(age?.age_days).toBeGreaterThan(2000);
		expect(age?.is_fresh).toBe(false);
	});

	it("flags domains registered within the fresh window", () => {
		const age = parseRdapAge(
			rdapBody([{ eventAction: "registration", eventDate: "2026-04-10T00:00:00Z" }]),
			NOW,
		);
		expect(age?.age_days).toBeLessThan(FRESH_DOMAIN_THRESHOLD_DAYS);
		expect(age?.is_fresh).toBe(true);
	});

	it("returns null when no registration event is present", () => {
		const age = parseRdapAge(
			rdapBody([{ eventAction: "last changed", eventDate: "2026-01-01T00:00:00Z" }]),
			NOW,
		);
		expect(age).toBeNull();
	});

	it("returns null when the body is malformed / missing", () => {
		expect(parseRdapAge(null)).toBeNull();
		expect(parseRdapAge(undefined)).toBeNull();
		expect(parseRdapAge({ events: "nope" as unknown as [] })).toBeNull();
		expect(parseRdapAge({ events: [{ eventAction: "registration", eventDate: "not-a-date" }] })).toBeNull();
	});
});

describe("lookupDomainAge", () => {
	it("returns parsed age on 200 OK", async () => {
		const transport: RdapTransport = async () => new Response(
			JSON.stringify(rdapBody([{ eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" }])),
			{ status: 200, headers: { "content-type": "application/rdap+json" } },
		);
		const age = await lookupDomainAge("example.com", NOW, transport);
		expect(age?.is_fresh).toBe(false);
		expect(age?.age_days).toBeGreaterThan(2000);
	});

	it("returns null on non-200 responses (does not fail closed)", async () => {
		const transport: RdapTransport = async () => new Response("not found", { status: 404 });
		const age = await lookupDomainAge("bad.example", NOW, transport);
		expect(age).toBeNull();
	});

	it("returns null when the transport throws (no network)", async () => {
		const transport: RdapTransport = async () => { throw new Error("enetunreach"); };
		const age = await lookupDomainAge("offline.example", NOW, transport);
		expect(age).toBeNull();
	});

	it("returns null for an empty or missing domain", async () => {
		expect(await lookupDomainAge("")).toBeNull();
	});
});
