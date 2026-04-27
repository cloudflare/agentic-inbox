// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { createMiddleware } from "hono/factory";
import type { Env } from "../types";

export type AdminContext = { Bindings: Env };

/**
 * Single-secret admin gate. Compares the request token against `HUB_ADMIN_KEY`
 * (a Worker secret). Used for inbound-peer CRUD and other operator-only
 * surfaces. We do not log the supplied token; on mismatch we return 401
 * without revealing whether the resource exists.
 */
export const requireAdmin = createMiddleware<AdminContext>(async (c, next) => {
	const expected = c.env.HUB_ADMIN_KEY;
	if (!expected) return c.json({ error: "admin not configured" }, 401);

	const header = c.req.header("authorization") ?? c.req.header("Authorization");
	if (!header) return c.json({ error: "missing authorization" }, 401);
	const token = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();

	if (!constantTimeEqual(token, expected)) {
		return c.json({ error: "invalid admin token" }, 401);
	}
	await next();
});

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}
