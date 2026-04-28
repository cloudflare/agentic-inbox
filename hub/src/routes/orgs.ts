// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Org + invite endpoints. MVP shape:
 *   POST /orgs/invite — create a one-time invite token (requires an existing
 *     authenticated org; the invite can optionally bind to a sharing group).
 *   POST /orgs/accept — redeem an invite token to create a new org + API key.
 *   GET  /orgs/me    — return the authenticated org.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireOrg, type HubContext } from "../lib/auth";
import { generateSecret, sha256 } from "../lib/hash";
import type { Env } from "../types";

// --- Open endpoint (accept): separate app, not auth-gated ---

export const orgAcceptApp = new Hono<{ Bindings: Env }>();

const AcceptSchema = z.object({
	token: z.string().min(16).max(256),
	name: z.string().min(1).max(200),
	contact: z.string().max(500).optional(),
});

orgAcceptApp.post("/accept", async (c) => {
	const ip = c.req.header("cf-connecting-ip") ?? "unknown";
	const { success } = await c.env.RL_ACCEPT.limit({ key: ip });
	if (!success) return c.json({ error: "rate_limited" }, 429);

	const parsed = AcceptSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const { token, name, contact } = parsed.data;

	const tokenHash = await sha256(token);
	const invite = await c.env.DB
		.prepare(
			`SELECT token_hash, sharing_group_uuid, expires_at, consumed_at
			 FROM invites WHERE token_hash = ?1`,
		)
		.bind(tokenHash)
		.first<{ token_hash: string; sharing_group_uuid: string | null; expires_at: string; consumed_at: string | null }>();

	if (!invite) return c.json({ error: "invalid token" }, 404);
	if (invite.consumed_at) return c.json({ error: "token already used" }, 410);
	if (new Date(invite.expires_at).getTime() < Date.now()) return c.json({ error: "token expired" }, 410);

	const orgUuid = crypto.randomUUID();
	const apiKey = generateSecret();
	const keyHash = await sha256(apiKey);
	const now = new Date().toISOString();

	await c.env.DB.batch([
		c.env.DB
			.prepare(`INSERT INTO orgs (uuid, name, contact, created_at, trust) VALUES (?1, ?2, ?3, ?4, 1.0)`)
			.bind(orgUuid, name, contact ?? null, now),
		c.env.DB
			.prepare(`INSERT INTO api_keys (key_hash, org_uuid, label, created_at) VALUES (?1, ?2, 'initial', ?3)`)
			.bind(keyHash, orgUuid, now),
		c.env.DB
			.prepare(`UPDATE invites SET consumed_at = ?1 WHERE token_hash = ?2`)
			.bind(now, tokenHash),
		...(invite.sharing_group_uuid
			? [
				c.env.DB
					.prepare(
						`INSERT INTO sharing_group_orgs (sharing_group_uuid, org_uuid, role) VALUES (?1, ?2, 'member')`,
					)
					.bind(invite.sharing_group_uuid, orgUuid),
			]
			: []),
	]);

	return c.json({
		org: { uuid: orgUuid, name },
		api_key: apiKey, // returned ONCE — the caller must store it
		sharing_group_uuid: invite.sharing_group_uuid,
	}, 201);
});

// --- Authenticated endpoints ---

export const orgRoutes = new Hono<HubContext>();

orgRoutes.use("*", requireOrg);

orgRoutes.get("/me", async (c) => {
	return c.json({ org: c.var.org });
});

const InviteSchema = z.object({
	sharing_group_uuid: z.string().uuid().optional(),
	note: z.string().max(500).optional(),
	ttl_hours: z.number().int().min(1).max(24 * 30).optional(),
});

orgRoutes.post("/invite", async (c) => {
	const parsed = InviteSchema.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const { sharing_group_uuid, note, ttl_hours = 72 } = parsed.data;

	// Inviting into a sharing group requires the inviter is a member.
	if (sharing_group_uuid) {
		const mem = await c.env.DB
			.prepare(`SELECT 1 FROM sharing_group_orgs WHERE sharing_group_uuid = ?1 AND org_uuid = ?2`)
			.bind(sharing_group_uuid, c.var.org.uuid)
			.first();
		if (!mem) return c.json({ error: "not a member of that sharing group" }, 403);
	}

	const token = generateSecret();
	const tokenHash = await sha256(token);
	const expiresAt = new Date(Date.now() + ttl_hours * 3600 * 1000).toISOString();

	await c.env.DB
		.prepare(
			`INSERT INTO invites (token_hash, sharing_group_uuid, note, expires_at)
			 VALUES (?1, ?2, ?3, ?4)`,
		)
		.bind(tokenHash, sharing_group_uuid ?? null, note ?? null, expiresAt)
		.run();

	return c.json({ token, expires_at: expiresAt }, 201);
});
