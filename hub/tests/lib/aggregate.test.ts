import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyCorroboration,
	getPromotedForSharingGroup,
	PROMOTION_SCORE,
	PROMOTION_CONTRIBUTORS,
} from "../../src/lib/aggregate";
import { makeTestDb, type TestDb } from "../helpers/d1";

let db: TestDb;

beforeEach(() => {
	db = makeTestDb();
});

afterEach(() => {
	db.close();
});

async function seedOrg(uuid: string, trust = 1.0) {
	db.raw
		.prepare(`INSERT INTO orgs (uuid, name, trust) VALUES (?, ?, ?)`)
		.run(uuid, `org-${uuid}`, trust);
}

async function seedSharingGroup(uuid: string) {
	db.raw
		.prepare(`INSERT INTO sharing_groups (uuid, name) VALUES (?, ?)`)
		.run(uuid, `sg-${uuid}`);
}

async function corroborationFor(
	sg: string | null,
	type: string,
	value: string,
) {
	return db.raw
		.prepare(
			`SELECT score, contributor_count
			 FROM corroboration
			 WHERE (sharing_group_uuid IS ? OR (sharing_group_uuid IS NULL AND ? IS NULL))
			   AND attribute_type = ? AND value = ?`,
		)
		.get(sg, sg, type, value) as { score: number; contributor_count: number } | undefined;
}

describe("applyCorroboration", () => {
	it("inserts a fresh corroboration row and credits the contributor's trust", async () => {
		await seedOrg("org-A", 1.0);
		await seedSharingGroup("sg-1");

		await applyCorroboration(db.d1, {
			event_uuid: "e1",
			orgc_uuid: "org-A",
			sharing_group_uuid: "sg-1",
			attributes: [{ type: "url", value: "https://bad.example/phish" }],
		});

		const row = await corroborationFor("sg-1", "url", "https://bad.example/phish");
		expect(row).toMatchObject({ score: 1, contributor_count: 1 });
	});

	it("does NOT double-count the same org contributing the same attribute twice", async () => {
		// This is the core sybil/self-reinforcement defense: one org cannot
		// single-handedly promote their own intel by re-submitting it.
		await seedOrg("org-A", 1.0);
		await seedSharingGroup("sg-1");

		for (let i = 0; i < 5; i++) {
			await applyCorroboration(db.d1, {
				event_uuid: `e${i}`,
				orgc_uuid: "org-A",
				sharing_group_uuid: "sg-1",
				attributes: [{ type: "url", value: "https://bad.example/phish" }],
			});
		}

		const row = await corroborationFor("sg-1", "url", "https://bad.example/phish");
		expect(row).toMatchObject({ score: 1, contributor_count: 1 });
	});

	it("accumulates distinct orgs' trust values", async () => {
		await seedOrg("org-A", 1.0);
		await seedOrg("org-B", 1.5);
		await seedOrg("org-C", 0.5);
		await seedSharingGroup("sg-1");

		for (const org of ["org-A", "org-B", "org-C"]) {
			await applyCorroboration(db.d1, {
				event_uuid: `e-${org}`,
				orgc_uuid: org,
				sharing_group_uuid: "sg-1",
				attributes: [{ type: "url", value: "https://bad.example" }],
			});
		}

		const row = await corroborationFor("sg-1", "url", "https://bad.example");
		expect(row?.contributor_count).toBe(3);
		expect(row?.score).toBeCloseTo(3.0, 5);
	});

	it("ignores non-promotable attribute types (e.g. text, comment)", async () => {
		await seedOrg("org-A", 1.0);
		await seedSharingGroup("sg-1");

		await applyCorroboration(db.d1, {
			event_uuid: "e1",
			orgc_uuid: "org-A",
			sharing_group_uuid: "sg-1",
			attributes: [
				{ type: "comment", value: "looks phishy" },
				{ type: "text", value: "see subject" },
			],
		});

		// No row should have been created for the non-promotable types.
		const row = await corroborationFor("sg-1", "comment", "looks phishy");
		expect(row).toBeUndefined();
	});

	it("defaults unknown org to trust=1.0 (graceful-degradation for race conditions)", async () => {
		// No seedOrg call — the org doesn't exist in the table yet. The
		// aggregator should still fall back to trust=1.0 rather than skip.
		await seedSharingGroup("sg-1");
		await applyCorroboration(db.d1, {
			event_uuid: "e1",
			orgc_uuid: "org-ghost",
			sharing_group_uuid: "sg-1",
			attributes: [{ type: "url", value: "https://x.example" }],
		});
		const row = await corroborationFor("sg-1", "url", "https://x.example");
		expect(row).toMatchObject({ score: 1, contributor_count: 1 });
	});

	it("isolates corroboration state between sharing groups", async () => {
		await seedOrg("org-A", 1.0);
		await seedOrg("org-B", 1.0);
		await seedSharingGroup("sg-1");
		await seedSharingGroup("sg-2");

		// Both orgs submit the same value to sg-1; only org-A submits to sg-2.
		for (const sg of ["sg-1", "sg-1", "sg-2"]) {
			const org = sg === "sg-2" ? "org-A" : sg === "sg-1" ? "org-A" : "org-B";
		}
		await applyCorroboration(db.d1, {
			event_uuid: "e1", orgc_uuid: "org-A", sharing_group_uuid: "sg-1",
			attributes: [{ type: "url", value: "https://x.example" }],
		});
		await applyCorroboration(db.d1, {
			event_uuid: "e2", orgc_uuid: "org-B", sharing_group_uuid: "sg-1",
			attributes: [{ type: "url", value: "https://x.example" }],
		});
		await applyCorroboration(db.d1, {
			event_uuid: "e3", orgc_uuid: "org-A", sharing_group_uuid: "sg-2",
			attributes: [{ type: "url", value: "https://x.example" }],
		});

		const sg1 = await corroborationFor("sg-1", "url", "https://x.example");
		const sg2 = await corroborationFor("sg-2", "url", "https://x.example");
		expect(sg1?.contributor_count).toBe(2);
		expect(sg2?.contributor_count).toBe(1);
	});
});

describe("getPromotedForSharingGroup", () => {
	it("returns only entries meeting both promotion thresholds", async () => {
		await seedOrg("org-A", 1.0);
		await seedOrg("org-B", 1.0);
		await seedSharingGroup("sg-1");

		// Below threshold: only one contributor.
		await applyCorroboration(db.d1, {
			event_uuid: "e1", orgc_uuid: "org-A", sharing_group_uuid: "sg-1",
			attributes: [{ type: "url", value: "https://only-one.example" }],
		});
		// Meets both thresholds.
		for (const org of ["org-A", "org-B"]) {
			await applyCorroboration(db.d1, {
				event_uuid: `e-${org}`, orgc_uuid: org, sharing_group_uuid: "sg-1",
				attributes: [{ type: "url", value: "https://corroborated.example" }],
			});
		}

		const promoted = await getPromotedForSharingGroup(db.d1, "sg-1");
		expect(promoted).toHaveLength(1);
		expect(promoted[0]).toMatchObject({
			attribute_type: "url",
			value: "https://corroborated.example",
		});
		expect(promoted[0].score).toBeGreaterThanOrEqual(PROMOTION_SCORE);
		expect(promoted[0].contributor_count).toBeGreaterThanOrEqual(PROMOTION_CONTRIBUTORS);
	});

	it("does not promote a high-trust single contributor above the threshold score alone", async () => {
		// Invariant: a single trusted org (e.g. trust=5) can NOT single-handedly
		// promote an attribute to the destroylist even though their score alone
		// crosses PROMOTION_SCORE — the contributor_count guard prevents it.
		await seedOrg("org-whale", 5.0);
		await seedSharingGroup("sg-1");
		await applyCorroboration(db.d1, {
			event_uuid: "e1", orgc_uuid: "org-whale", sharing_group_uuid: "sg-1",
			attributes: [{ type: "url", value: "https://solo.example" }],
		});
		const promoted = await getPromotedForSharingGroup(db.d1, "sg-1");
		expect(promoted).toEqual([]);
	});

	it("scopes promotion to the given sharing group", async () => {
		await seedOrg("org-A", 1.0);
		await seedOrg("org-B", 1.0);
		await seedSharingGroup("sg-1");
		await seedSharingGroup("sg-2");

		for (const org of ["org-A", "org-B"]) {
			await applyCorroboration(db.d1, {
				event_uuid: `e-${org}`, orgc_uuid: org, sharing_group_uuid: "sg-1",
				attributes: [{ type: "url", value: "https://sg1.example" }],
			});
		}

		const sg1 = await getPromotedForSharingGroup(db.d1, "sg-1");
		const sg2 = await getPromotedForSharingGroup(db.d1, "sg-2");
		expect(sg1).toHaveLength(1);
		expect(sg2).toHaveLength(0);
	});
});
