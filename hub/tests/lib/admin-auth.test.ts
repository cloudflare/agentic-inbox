import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { requireAdmin, type AdminContext } from "../../src/lib/admin-auth";

function makeApp(adminKey: string) {
	const app = new Hono<AdminContext>();
	app.use("*", requireAdmin);
	app.get("/", (c) => c.json({ ok: true }));
	return (init?: RequestInit) =>
		app.request("/", init, { HUB_ADMIN_KEY: adminKey } as never);
}

describe("requireAdmin", () => {
	it("rejects requests with no Authorization header", async () => {
		const res = await makeApp("secret-key")();
		expect(res.status).toBe(401);
	});

	it("rejects requests with the wrong key", async () => {
		const res = await makeApp("secret-key")({
			headers: { Authorization: "wrong-key" },
		});
		expect(res.status).toBe(401);
	});

	it("rejects when HUB_ADMIN_KEY is empty (operator misconfiguration)", async () => {
		const res = await makeApp("")({ headers: { Authorization: "anything" } });
		expect(res.status).toBe(401);
	});

	it("accepts the bare key form", async () => {
		const res = await makeApp("secret-key")({
			headers: { Authorization: "secret-key" },
		});
		expect(res.status).toBe(200);
	});

	it("accepts the Bearer form", async () => {
		const res = await makeApp("secret-key")({
			headers: { Authorization: "Bearer secret-key" },
		});
		expect(res.status).toBe(200);
	});
});
