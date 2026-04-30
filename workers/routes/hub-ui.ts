// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

/**
 * Read-only worker proxy for the threat-intel hub UI. The browser can't talk
 * to the hub directly because the hub API key lives as a worker secret —
 * these routes resolve the per-mailbox `intel.hub` config, read the secret
 * by name from `c.env`, and forward the call.
 *
 * Each endpoint follows the same shape: a 200 with `{ configured: false }`
 * when this mailbox has no hub config, otherwise the parsed payload.
 * Picking 200 (not 412) because a mailbox without hub credentials is the
 * normal idle state, not an error — the UI renders one empty-state panel
 * regardless of which call you made.
 *
 * Mounted under `/api/v1/mailboxes/:mailboxId/hub`. The shared `requireMailbox`
 * middleware applied at the parent path enforces the mailbox-id existence
 * check; visibility scoping is the same path-only check the rest of the
 * mailbox-scoped API uses today (see #27).
 */

import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox";
import { MispClient } from "../intel/misp-client";
import { loadHubCredentials } from "../lib/hub-config";

export const hubUiRoutes = new Hono<MailboxContext>();

interface ConfiguredResponse<T> {
	configured: true;
	data: T;
}
interface UnconfiguredResponse {
	configured: false;
}

/**
 * Returns `{ configured: false }` for any of: missing mailboxId, no
 * `intel.hub` block in the mailbox JSON, or the named secret unset on
 * `c.env`. The UI renders one empty state regardless of which side is
 * missing, so the helper collapses all three into the same shape.
 */
async function withHubClient<T>(
	c: import("hono").Context<MailboxContext>,
	mailboxId: string | undefined,
	fn: (client: MispClient, orgUuid: string) => Promise<T>,
): Promise<ConfiguredResponse<T> | UnconfiguredResponse> {
	if (!mailboxId) return { configured: false };
	const creds = await loadHubCredentials(
		c.env as unknown as Record<string, unknown>,
		c.env.BUCKET,
		mailboxId,
	);
	if (!creds) return { configured: false };
	const client = new MispClient({ baseUrl: creds.cfg.url, apiKey: creds.apiKey });
	const data = await fn(client, creds.cfg.org_uuid);
	return { configured: true, data };
}

hubUiRoutes.get("/contributions", async (c) => {
	const mailboxId = c.req.param("mailboxId");
	const result = await withHubClient(c, mailboxId, async (client) => {
		const events = await client.searchEvents({ limit: 25 });
		// Project to a flat shape the UI can render without knowing about MISP.
		return events.map((e) => ({
			uuid: e.Event.uuid,
			info: e.Event.info,
			date: e.Event.date,
			timestamp: e.Event.timestamp,
			sharing_group_uuid: e.Event.sharing_group_uuid,
			attribute_count: e.Event.Attribute?.length ?? 0,
		}));
	});
	return c.json(result);
});

hubUiRoutes.get("/destroylist", async (c) => {
	const mailboxId = c.req.param("mailboxId");
	const sharingGroup = c.req.query("sharing_group") ?? undefined;
	const result = await withHubClient(c, mailboxId, async (client) => {
		const values = await client.fetchDestroyList({ sharingGroup });
		return { values, count: values.length };
	});
	return c.json(result);
});

hubUiRoutes.get("/sharing-groups", async (c) => {
	const mailboxId = c.req.param("mailboxId");
	const result = await withHubClient(c, mailboxId, async (client) => {
		const groups = await client.listSharingGroups();
		return { groups };
	});
	return c.json(result);
});
