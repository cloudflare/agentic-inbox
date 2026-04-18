import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { Hono } from "hono";
import { requireOrg, type HubContext } from "../../src/lib/auth";
import { sha256 } from "../../src/lib/hash";
import { makeTestDb, type TestDb } from "../helpers/d1";

if (!(globalThis as any).crypto) (globalThis as any).crypto = webcrypto;

let db: TestDb;

beforeEach(() => {
	db = makeTestDb();
	// Seed org + api_key for tests.
});

afterEach(() => db.close());

async function seedKey(key: string, orgUuid = "org-A", revoked = false) {
	db.raw.prepare(`INSERT INTO orgs (uuid, name, trust) VALUES (?, ?, ?)`).run(orgUuid, `name-${orgUuid}`, 1.0);
	db.raw
		.prepare(`INSERT INTO api_keys (key_hash, org_uuid, label, revoked) VALUES (?, ?, ?, ?)`)
		.run(await sha256(key), orgUuid, "test", revoked ? 1 : 0);
}

function app() {
	const a = new Hono<HubContext>();
	a.use("*", requireOrg);
	a.get("/whoami", (c) => c.json(c.get("org")));
	return a;
}

const env = () => ({ DB: db.d1 } as unknown as Record<string, unknown>);

describe("requireOrg", () => {
	it("rejects requests with no Authorization header (401)", async () => {
		const res = await app().fetch(new Request("http://x/whoami"), env());
		expect(res.status).toBe(401);
	});

	it("rejects an unknown key (401)", async () => {
		const res = await app().fetch(
			new Request("http://x/whoami", { headers: { authorization: "Bearer unknown" } }),
			env(),
		);
		expect(res.status).toBe(401);
	});

	it("accepts a valid bare key (MISP-style)", async () => {
		await seedKey("good-key");
		const res = await app().fetch(
			new Request("http://x/whoami", { headers: { authorization: "good-key" } }),
			env(),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ uuid: "org-A", name: "name-org-A", trust: 1 });
	});

	it("accepts a valid Bearer-prefixed key", async () => {
		await seedKey("good-key");
		const res = await app().fetch(
			new Request("http://x/whoami", { headers: { authorization: "Bearer good-key" } }),
			env(),
		);
		expect(res.status).toBe(200);
	});

	it("rejects a revoked key", async () => {
		await seedKey("revoked-key", "org-A", true);
		const res = await app().fetch(
			new Request("http://x/whoami", { headers: { authorization: "Bearer revoked-key" } }),
			env(),
		);
		expect(res.status).toBe(401);
	});

	it("stores the sha256 of the key, not the key itself", async () => {
		await seedKey("secret-key");
		const stored = db.raw.prepare(`SELECT key_hash FROM api_keys`).all() as Array<{ key_hash: string }>;
		const hash = await sha256("secret-key");
		expect(stored[0].key_hash).toBe(hash);
		expect(stored[0].key_hash).not.toBe("secret-key");
	});
});
