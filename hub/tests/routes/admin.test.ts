import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { adminRoutes } from "../../src/routes/admin";
import { makeTestDb, type TestDb } from "../helpers/d1";
import type { Env } from "../../src/types";

let db: TestDb;
let env: Env;

beforeEach(() => {
	db = makeTestDb();
	env = {
		DB: db.d1,
		AI: {} as Ai,
		TRIAGE_QUEUE: { send: async () => {} } as never,
		HUB_ADMIN_KEY: "admin-secret",
	};
	// Seed a sharing group that admin routes can reference.
	db.raw.prepare(`INSERT INTO sharing_groups (uuid, name) VALUES (?, ?)`)
		.run("sg-1", "default-sg");
});

afterEach(() => db.close());

function appReq(path: string, init?: RequestInit) {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/admin", adminRoutes);
	return app.request(`/admin${path}`, init, env as never);
}

const adminAuth = { Authorization: "admin-secret" };

describe("POST /admin/peers", () => {
	it("rejects unauthenticated requests", async () => {
		const res = await appReq("/peers", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "x", base_url: "https://x", default_sharing_group_uuid: "sg-1", api_key_secret_name: "K" }),
		});
		expect(res.status).toBe(401);
	});

	it("rejects when default_sharing_group_uuid is missing", async () => {
		const res = await appReq("/peers", {
			method: "POST",
			headers: { ...adminAuth, "Content-Type": "application/json" },
			body: JSON.stringify({ name: "x", base_url: "https://x.example", api_key_secret_name: "K" }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects when the referenced sharing group does not exist", async () => {
		const res = await appReq("/peers", {
			method: "POST",
			headers: { ...adminAuth, "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "x", base_url: "https://x.example", api_key_secret_name: "K",
				default_sharing_group_uuid: "00000000-0000-0000-0000-000000000099",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("creates peer + inbound_peer + synthetic org atomically", async () => {
		// Replace the seeded sg-1 with a uuid-shaped value to satisfy zod.
		db.raw.prepare(`DELETE FROM sharing_groups`).run();
		db.raw.prepare(`INSERT INTO sharing_groups (uuid, name) VALUES (?, ?)`)
			.run("00000000-0000-0000-0000-000000000001", "default-sg");

		const res = await appReq("/peers", {
			method: "POST",
			headers: { ...adminAuth, "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "CIRCL", contact: "noc@circl.lu",
				base_url: "https://misp.circl.lu",
				api_key_secret_name: "PEER_CIRCL_KEY",
				default_sharing_group_uuid: "00000000-0000-0000-0000-000000000001",
				default_trust: 0.5,
				tag_include: "tlp:white\ntlp:green",
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json() as { inbound_peer_uuid: string; synthetic_org_uuid: string };
		expect(body.inbound_peer_uuid).toMatch(/^[0-9a-f-]{36}$/);
		expect(body.synthetic_org_uuid).toMatch(/^[0-9a-f-]{36}$/);

		const peer = db.raw.prepare(`SELECT * FROM peers WHERE name = ?`).get("CIRCL");
		expect(peer).toBeDefined();
		const ib = db.raw.prepare(`SELECT * FROM inbound_peers WHERE uuid = ?`).get(body.inbound_peer_uuid) as { tag_include: string; default_sharing_group_uuid: string };
		expect(ib.tag_include).toBe("tlp:white\ntlp:green");
		expect(ib.default_sharing_group_uuid).toBe("00000000-0000-0000-0000-000000000001");
		const org = db.raw.prepare(`SELECT * FROM orgs WHERE uuid = ?`).get(body.synthetic_org_uuid) as { trust: number };
		expect(org.trust).toBe(0.5);
		// Synthetic org has no api_key — never authenticates.
		const keyCount = db.raw.prepare(`SELECT count(*) as n FROM api_keys WHERE org_uuid = ?`).get(body.synthetic_org_uuid) as { n: number };
		expect(keyCount.n).toBe(0);
	});
});

describe("GET /admin/peers", () => {
	it("lists configured inbound peers", async () => {
		db.raw.prepare(`DELETE FROM sharing_groups`).run();
		db.raw.prepare(`INSERT INTO sharing_groups (uuid, name) VALUES (?, ?)`)
			.run("00000000-0000-0000-0000-000000000001", "default-sg");

		await appReq("/peers", {
			method: "POST",
			headers: { ...adminAuth, "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "p1", base_url: "https://p1.example", api_key_secret_name: "K1",
				default_sharing_group_uuid: "00000000-0000-0000-0000-000000000001",
			}),
		});
		const res = await appReq("/peers", { headers: adminAuth });
		expect(res.status).toBe(200);
		const body = await res.json() as { peers: Array<{ name: string; base_url: string }> };
		expect(body.peers).toHaveLength(1);
		expect(body.peers[0].name).toBe("p1");
		expect(body.peers[0].base_url).toBe("https://p1.example");
	});
});

describe("DELETE /admin/peers/:uuid", () => {
	it("removes the inbound_peers row and cascades the peers row", async () => {
		db.raw.prepare(`DELETE FROM sharing_groups`).run();
		db.raw.prepare(`INSERT INTO sharing_groups (uuid, name) VALUES (?, ?)`)
			.run("00000000-0000-0000-0000-000000000001", "default-sg");

		const create = await appReq("/peers", {
			method: "POST",
			headers: { ...adminAuth, "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "p1", base_url: "https://p1.example", api_key_secret_name: "K1",
				default_sharing_group_uuid: "00000000-0000-0000-0000-000000000001",
			}),
		});
		const { inbound_peer_uuid } = await create.json() as { inbound_peer_uuid: string };

		const res = await appReq(`/peers/${inbound_peer_uuid}`, {
			method: "DELETE", headers: adminAuth,
		});
		expect(res.status).toBe(204);
		const ib = db.raw.prepare(`SELECT count(*) as n FROM inbound_peers`).get() as { n: number };
		expect(ib.n).toBe(0);
	});
});
