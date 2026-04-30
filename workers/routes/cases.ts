// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Case REST endpoints. Mounted under
 * `/api/v1/mailboxes/:mailboxId/cases`.
 *
 * The report-as-phish flow also triggers an optional hub push — see
 * `workers/intel/report.ts` + `workers/intel/misp-client.ts`. That's wired up
 * in M7 once the hub project exists; for now cases are local-only and
 * `shared_to_hub = 0`.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { EmailFull } from "../lib/schemas";
import { requireMailbox, type MailboxContext } from "../lib/mailbox";
import { extractUrls } from "../security/urls";
import { stripHtmlToText } from "../lib/email-helpers";
import { buildMispEvent } from "../intel/report";
import { MispClient } from "../intel/misp-client";
import { loadHubConfig } from "../lib/hub-config";

export const caseRoutes = new Hono<MailboxContext>();

caseRoutes.use("*", requireMailbox);

const CreateCaseBody = z.object({
	title: z.string().min(1).max(500),
	notes: z.string().optional(),
	emailId: z.string().optional(),
	observables: z.array(z.object({
		kind: z.string().min(1).max(32),
		value: z.string().min(1).max(500),
	})).optional(),
});

const UpdateCaseBody = z.object({
	status: z.enum(["open", "closed-tp", "closed-fp", "closed-dup"]).optional(),
	notes: z.string().optional(),
});

const ReportPhishBody = z.object({ emailId: z.string().min(1) });

caseRoutes.get("/", async (c) => {
	const status = c.req.query("status") ?? undefined;
	const limit = Number(c.req.query("limit") ?? 50);
	const cases = await c.var.mailboxStub.listCases({ status, limit });
	return c.json({ cases });
});

caseRoutes.post("/", async (c) => {
	const parsed = CreateCaseBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const result = await c.var.mailboxStub.createCase(parsed.data);
	return c.json(result, 201);
});

caseRoutes.get("/:caseId", async (c) => {
	const caseData = await c.var.mailboxStub.getCase(c.req.param("caseId"));
	if (!caseData) return c.json({ error: "Not found" }, 404);
	return c.json({ case: caseData });
});

caseRoutes.patch("/:caseId", async (c) => {
	const parsed = UpdateCaseBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	await c.var.mailboxStub.updateCase(c.req.param("caseId"), parsed.data);
	return c.json({ ok: true });
});

caseRoutes.delete("/:caseId", async (c) => {
	await c.var.mailboxStub.deleteCase(c.req.param("caseId"));
	return c.json({ ok: true });
});

/**
 * Shortcut: take an email id, auto-extract observables, create a case.
 * The UI's "Report phish" button hits this endpoint.
 */
caseRoutes.post("/report-phish", async (c) => {
	const parsed = ReportPhishBody.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const { emailId } = parsed.data;

	const email = (await c.var.mailboxStub.getEmail(emailId)) as EmailFull | null;
	if (!email) return c.json({ error: "Email not found" }, 404);

	const urls = extractUrls(email.body || "");
	const observables: Array<{ kind: string; value: string }> = [];
	if (email.sender) observables.push({ kind: "email", value: email.sender });
	for (const u of urls) {
		observables.push({ kind: "url", value: u.url });
		observables.push({ kind: "domain", value: u.hostname });
	}

	const { id } = await c.var.mailboxStub.createCase({
		title: `Reported phish: ${email.subject || "(no subject)"}`,
		notes: `Reported from email ${emailId}. Sender: ${email.sender}.`,
		emailId,
		observables,
	});

	// Reputation penalty on the sender so the pipeline flags future mail.
	if (email.sender) {
		await c.var.mailboxStub.flagSender(email.sender, true).catch(() => {});
	}

	// Optional push to the community hub. Mailbox must opt in via
	// `intel.hub.auto_report = true` and configure hub credentials.
	let hubUuid: string | null = null;
	try {
		const mailboxId = c.req.param("mailboxId");
		if (mailboxId) {
			const hub = await loadHubConfig(c.env.BUCKET, mailboxId);
			if (hub?.auto_report) {
				const apiKey = (c.env as unknown as Record<string, string | undefined>)[hub.api_key_secret_name];
				if (apiKey) {
					const event = await buildMispEvent({
						orgUuid: hub.org_uuid,
						sharingGroupUuid: hub.default_sharing_group_uuid,
						info: email.subject || "Reported phish",
						observedAt: email.date,
						sender: email.sender,
						subject: email.subject || "",
						bodyText: stripHtmlToText(email.body || "").slice(0, 10_000),
						urls: urls.map((u) => ({ url: u.url, hostname: u.hostname })),
					});
					const client = new MispClient({ baseUrl: hub.url, apiKey });
					const posted = await client.postEvent(event);
					if (posted?.uuid) {
						hubUuid = posted.uuid;
						await c.var.mailboxStub.updateCase(id, {
							shared_to_hub: true,
							hub_event_uuid: posted.uuid,
						});
					}
				}
			}
		}
	} catch (e) {
		console.error("hub report failed:", (e as Error).message);
	}

	return c.json({ caseId: id, hubEventUuid: hubUuid }, 201);
});
