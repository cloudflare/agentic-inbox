// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Operator-only admin routes (gated by HUB_ADMIN_KEY).
 *
 * /peers          POST   create an inbound peer (also creates peer + synthetic org)
 *                 GET    list inbound peers
 * /peers/:uuid    DELETE remove an inbound peer (cascade-removes peers row)
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireAdmin, type AdminContext } from "../lib/admin-auth";

export const adminRoutes = new Hono<AdminContext>();

adminRoutes.use("*", requireAdmin);

const CreatePeerSchema = z.object({
	name: z.string().min(1).max(200),
	contact: z.string().max(500).optional(),
	base_url: z.string().url().max(2000),
	api_key_secret_name: z.string().min(1).max(200),
	// Required non-NULL: pulled events default to this group's visibility.
	default_sharing_group_uuid: z.string().uuid(),
	default_trust: z.number().min(0).max(10).default(0.5),
	tag_include: z.string().max(4000).optional(),
	tag_exclude: z.string().max(4000).optional(),
});

adminRoutes.post("/peers", async (c) => {
	const parsed = CreatePeerSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const body = parsed.data;

	// Sharing group must exist.
	const sg = await c.env.DB
		.prepare(`SELECT 1 FROM sharing_groups WHERE uuid = ?1`)
		.bind(body.default_sharing_group_uuid)
		.first();
	if (!sg) return c.json({ error: "default_sharing_group_uuid not found" }, 400);

	const peerUuid = crypto.randomUUID();
	const inboundUuid = crypto.randomUUID();
	const syntheticOrgUuid = crypto.randomUUID();

	await c.env.DB.batch([
		c.env.DB
			.prepare(`INSERT INTO peers (uuid, name, contact) VALUES (?1, ?2, ?3)`)
			.bind(peerUuid, body.name, body.contact ?? null),
		c.env.DB
			.prepare(`INSERT INTO orgs (uuid, name, contact, trust) VALUES (?1, ?2, ?3, ?4)`)
			.bind(syntheticOrgUuid, `peer:${body.name}`, body.contact ?? null, body.default_trust),
		c.env.DB
			.prepare(
				`INSERT INTO inbound_peers
				   (uuid, peer_uuid, base_url, api_key_secret_name, synthetic_org_uuid,
				    default_sharing_group_uuid, tag_include, tag_exclude)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
			)
			.bind(
				inboundUuid, peerUuid, body.base_url, body.api_key_secret_name,
				syntheticOrgUuid, body.default_sharing_group_uuid,
				body.tag_include ?? null, body.tag_exclude ?? null,
			),
		c.env.DB
			.prepare(
				`INSERT INTO sharing_group_orgs (sharing_group_uuid, org_uuid, role) VALUES (?1, ?2, 'member')`,
			)
			.bind(body.default_sharing_group_uuid, syntheticOrgUuid),
	]);

	return c.json(
		{ inbound_peer_uuid: inboundUuid, peer_uuid: peerUuid, synthetic_org_uuid: syntheticOrgUuid },
		201,
	);
});

adminRoutes.get("/peers", async (c) => {
	const rows = await c.env.DB
		.prepare(
			`SELECT ib.uuid, p.name, p.contact, ib.base_url, ib.api_key_secret_name,
			        ib.enabled, ib.last_pulled_ts, ib.last_error, ib.next_retry_at,
			        ib.default_sharing_group_uuid, ib.tag_include, ib.tag_exclude,
			        ib.synthetic_org_uuid
			 FROM inbound_peers ib JOIN peers p ON p.uuid = ib.peer_uuid
			 ORDER BY p.name`,
		)
		.all();
	return c.json({ peers: rows.results ?? [] });
});

adminRoutes.delete("/peers/:uuid", async (c) => {
	const uuid = c.req.param("uuid");
	const ib = await c.env.DB
		.prepare(`SELECT peer_uuid, synthetic_org_uuid FROM inbound_peers WHERE uuid = ?1`)
		.bind(uuid)
		.first<{ peer_uuid: string; synthetic_org_uuid: string }>();
	if (!ib) return c.json({ error: "not found" }, 404);
	await c.env.DB.batch([
		c.env.DB.prepare(`DELETE FROM inbound_peers WHERE uuid = ?1`).bind(uuid),
		c.env.DB.prepare(`DELETE FROM peers WHERE uuid = ?1`).bind(ib.peer_uuid),
		// Synthetic org is preserved; the events table FK references it. We
		// soft-orphan rather than risk dangling refs. Operator can delete it
		// manually if no events remain.
	]);
	return new Response(null, { status: 204 });
});
