// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * AIS community hub — MISP-compatible reporting & feed distribution.
 *
 * This is an open-source reference implementation, not a full MISP server.
 * Supported surface:
 *   POST   /events
 *   GET    /events/{uuid}
 *   POST   /events/restSearch
 *   GET    /feeds/destroylist.txt
 *   GET    /sharing_groups
 *   POST   /sharing_groups
 *   POST   /orgs/invite    (authenticated — existing org invites another)
 *   POST   /orgs/accept    (public — consumes an invite token, creates org + key)
 *   GET    /orgs/me
 *   *      /admin/*        (operator-only — gated by HUB_ADMIN_KEY)
 */

import { Hono } from "hono";
import { eventRoutes } from "./routes/events";
import { feedRoutes } from "./routes/feeds";
import { orgRoutes, orgAcceptApp } from "./routes/orgs";
import { sharingGroupRoutes } from "./routes/sharing-groups";
import { adminRoutes } from "./routes/admin";
import { consumeTriageBatch } from "./agent/triage";
import { runInboundSync } from "./lib/sync";
import type { Env, TriageMessage } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("AIS Hub — MISP-compatible threat-intel sharing. See /events, /feeds/destroylist.txt, /orgs."));

app.route("/events", eventRoutes);
app.route("/feeds", feedRoutes);
app.route("/orgs", orgAcceptApp); // public /orgs/accept
app.route("/orgs", orgRoutes);    // authed /orgs/me, /orgs/invite
app.route("/sharing_groups", sharingGroupRoutes);
app.route("/admin", adminRoutes);

export default {
	fetch: app.fetch,
	async queue(batch: MessageBatch<TriageMessage>, env: Env) {
		await consumeTriageBatch(batch, env);
	},
	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(runInboundSync(env));
	},
};
