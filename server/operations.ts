import { Hono } from "hono";
import type { Database } from "./db";
import { ingest, type ObjectStore } from "./inbound";

export const requiredMigrations = [
	1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
	23, 24, 25, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42,
	43, 44, 45, 46, 47,
];

export async function readiness(
	db: Database,
	dependencyCheck?: () => Promise<boolean>,
) {
	try {
		const versions = await db`SELECT version FROM inbox_migrations`;
		const applied = new Set(versions.map((row) => row.version));

		if (!requiredMigrations.every((version) => applied.has(version)))
			return false;
		await db`SELECT id FROM inbound_recovery LIMIT 0`;
		return dependencyCheck ? await dependencyCheck() : true;
	} catch {
		return false;
	}
}

export function operationsApi(
	db: Database,
	options: { admin: boolean; actor: string; objects?: ObjectStore },
) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		if (!options.admin)
			return c.json({ error: "Administrator access required" }, 403);
		await next();
	});
	app.get("/", async (c) => {
		const recoveries =
			await db`SELECT id,mailbox_id,status,failure_stage,size,created_at,updated_at,replayed_at FROM inbound_recovery WHERE status<>'complete' ORDER BY created_at LIMIT 100`;
		const sends =
			await db`SELECT e.id,e.mailbox_id,e.delivery_status,r.created_at FROM outbound_requests r JOIN emails e ON e.id=r.email_id WHERE e.delivery_status IN ('sending','unknown') AND r.created_at<now()-interval '15 minutes' ORDER BY r.created_at LIMIT 100`;
		const jobs =
			await db`SELECT o.job_token,o.created_at,c.mailbox_id,c.thread_id FROM classifier_outbox o LEFT JOIN conversation_classifications c ON c.token=o.job_token WHERE o.published_at IS NULL AND o.created_at<now()-interval '30 minutes' ORDER BY o.created_at LIMIT 100`;
		return c.json({ recoveries, sends, jobs });
	});
	app.post("/:id/replay", async (c) => {
		if (
			!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
				c.req.param("id"),
			)
		)
			return c.json({ error: "Invalid recovery id" }, 400);
		if (!options.objects)
			return c.json({ error: "Recovery storage unavailable" }, 503);
		const [record] =
			await db`SELECT * FROM inbound_recovery WHERE id=${c.req.param("id")}`;
		if (!record) return c.json({ error: "Recovery not found" }, 404);
		if (record.status === "complete") return c.json({ status: "complete" });
		const object = await options.objects
			.get(record.raw_storage_key)
			.catch(() => undefined);
		if (object === undefined)
			return c.json({ error: "Recovery storage unavailable" }, 503);
		if (!object) return c.json({ error: "Recovery object unavailable" }, 409);
		const raw = await object.arrayBuffer();
		const hash = Array.from(
			new Uint8Array(await crypto.subtle.digest("SHA-256", raw)),
			(x) => x.toString(16).padStart(2, "0"),
		).join("");
		if (raw.byteLength !== record.size || hash !== record.raw_hash)
			return c.json({ error: "Recovery object integrity check failed" }, 409);
		await db`UPDATE inbound_recovery SET replayed_by=${options.actor},replayed_at=now() WHERE id=${record.id}`;
		try {
			await ingest(
				{
					to: record.mailbox_id,
					from: record.envelope_from,
					raw: new Blob([raw]).stream(),
					rawSize: raw.byteLength,
					setReject() {
						throw new Error("Recovery rejected");
					},
				},
				db,
				options.objects,
			);
		} catch {
			return c.json({ error: "Replay failed; record retained for retry" }, 503);
		}
		return c.json({ status: "complete" });
	});
	return app;
}

export async function pruneInboundRecovery(db: Database) {
	// No object deletion: unresolved rows and raw MIME are never aged out here.
	await db`DELETE FROM inbound_recovery WHERE status='complete' AND updated_at<now()-interval '30 days'`;
}
