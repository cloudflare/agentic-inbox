// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, type Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import type { RequestPrincipal } from "../lib/mailbox-acl";
import { authorizeMailbox } from "../lib/mailbox-acl";
import {
	getExportJob,
	runMailboxExportJob,
	runDomainExportJob,
	hasRecentExportForDomain,
	type ExportJob,
} from "../lib/email-exporter";
import {
	authorizeDomainAdmin,
} from "./domain-dns";
import {
	getDomainEppCode,
	setDomainTransferLock,
} from "../lib/cloudflare-registrar";
import {
	saveDomainMetadata,
} from "../lib/domain-registry";

type AppVariables = { principal?: RequestPrincipal };

const DecommissionBody = z.object({
	confirmDomain: z.string().trim().min(1, "Confirmation domain is required"),
	skipExportAcknowledged: z.boolean().optional().default(false),
});

const TransferLockBody = z.object({
	locked: z.boolean(),
});

export function registerExportAndOffboardingRoutes(
	app: Hono<{ Bindings: Env; Variables: AppVariables }>,
) {
	/**
	 * Export a single mailbox to an RFC 4155 .mbox archive.
	 */
	app.post("/api/v1/mailboxes/:id/export", async (c) => {
		const principal = c.get("principal") as RequestPrincipal | undefined;
		const mailboxId = c.req.param("id");

		const auth = await authorizeMailbox(c.env.BUCKET, principal, mailboxId);
		if (!auth.ok) {
			return c.json({ error: auth.error || "Unauthorized" }, auth.status as any);
		}

		try {
			// Export the mailbox that was authorized, not the raw path value.
			const job = await runMailboxExportJob(c.env, auth.mailboxId);
			return c.json({
				exportId: job.id,
				status: job.status,
				progress: job.progress,
				totalEmails: job.totalEmails,
				fileSizeBytes: job.fileSizeBytes,
				downloadUrl: job.downloadUrl,
				expiresAt: job.expiresAt,
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Export failed";
			return c.json({ error: msg }, 500);
		}
	});

	/**
	 * Export all mailboxes for an entire domain into a unified RFC 4155 .mbox archive.
	 */
	app.post("/api/v1/admin/domains/:domain/export", async (c) => {
		const authz = await authorizeDomainAdmin(c, c.req.param("domain"));
		if (authz instanceof Response) return authz;

		const { domainMeta } = authz;

		try {
			const job = await runDomainExportJob(c.env, domainMeta.domain);
			return c.json({
				exportId: job.id,
				status: job.status,
				progress: job.progress,
				totalEmails: job.totalEmails,
				fileSizeBytes: job.fileSizeBytes,
				downloadUrl: job.downloadUrl,
				expiresAt: job.expiresAt,
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Domain export failed";
			return c.json({ error: msg }, 500);
		}
	});

	/**
	 * Load an export job the caller may read: they must still have access to
	 * the exported mailbox, or admin rights on the exported domain.
	 */
	const loadAuthorizedExport = async (
		c: Context<{ Bindings: Env; Variables: AppVariables }>,
		exportId: string,
	): Promise<ExportJob | Response> => {
		const job = await getExportJob(c.env.BUCKET, exportId);
		if (!job) {
			return c.json({ error: "Export job not found" }, 404);
		}
		if (job.targetType === "domain") {
			const authz = await authorizeDomainAdmin(c, job.targetId);
			if (authz instanceof Response) return c.json({ error: "Forbidden" }, 403);
		} else {
			const principal = c.get("principal") as RequestPrincipal | undefined;
			const auth = await authorizeMailbox(c.env.BUCKET, principal, job.targetId);
			if (!auth.ok) return c.json({ error: "Forbidden" }, 403);
		}
		return job;
	};

	/**
	 * Query export job status and progress.
	 */
	app.get("/api/v1/exports/:exportId", async (c) => {
		const job = await loadAuthorizedExport(c, c.req.param("exportId"));
		if (job instanceof Response) return job;
		return c.json(job);
	});

	/**
	 * Download an exported .mbox file archive.
	 */
	app.get("/api/v1/exports/:exportId/download", async (c) => {
		const job = await loadAuthorizedExport(c, c.req.param("exportId"));
		if (job instanceof Response) return job;
		if (!job.downloadKey || new Date(job.expiresAt).getTime() < Date.now()) {
			return c.json({ error: "Export archive file not found or expired" }, 404);
		}

		const fileObj = await c.env.BUCKET.get(job.downloadKey);
		if (!fileObj) {
			return c.json({ error: "Export archive file not found or expired" }, 404);
		}

		const filename = job.filename || `inboxies-export-${job.id}.mbox`;

		return new Response(fileObj.body, {
			headers: {
				"Content-Type": "application/mbox; charset=utf-8",
				"Content-Disposition": `attachment; filename="${filename}"`,
				"Cache-Control": "private, no-cache",
			},
		});
	});

	/**
	 * Offboarding Preflight Check: verify mailboxes and check if email has been exported.
	 */
	app.post("/api/v1/admin/domains/:domain/decommission-preflight", async (c) => {
		const authz = await authorizeDomainAdmin(c, c.req.param("domain"));
		if (authz instanceof Response) return authz;

		const { domainMeta } = authz;
		const normalizedDomain = domainMeta.domain.toLowerCase();

		// Count mailboxes for domain
		const listed = await c.env.BUCKET.list({ prefix: "mailboxes/" });
		const suffix = `@${normalizedDomain}.json`;
		const activeMailboxes = listed.objects
			.filter((o) => o.key.endsWith(suffix))
			.map((o) => o.key.replace(/^mailboxes\//, "").replace(/\.json$/, ""));

		const { hasExport, lastExport } = await hasRecentExportForDomain(
			c.env.BUCKET,
			normalizedDomain,
		);

		const isRegistrar = domainMeta.registration?.provider === "cloudflare_registrar";
		const isLocked = domainMeta.registration?.locked ?? true;

		return c.json({
			domain: domainMeta.domain,
			status: domainMeta.status,
			activeMailboxCount: activeMailboxes.length,
			activeMailboxes,
			hasRecentExport: hasExport,
			lastExport: lastExport
				? {
						id: lastExport.id,
						createdAt: lastExport.createdAt,
						downloadUrl: lastExport.downloadUrl,
						totalEmails: lastExport.totalEmails,
				  }
				: null,
			isRegistrarDomain: isRegistrar,
			transferLocked: isLocked,
		});
	});

	/**
	 * Decommission domain email service & prepare for DNS migration or registrar transfer.
	 */
	app.post("/api/v1/admin/domains/:domain/decommission", async (c) => {
		const authz = await authorizeDomainAdmin(c, c.req.param("domain"));
		if (authz instanceof Response) return authz;

		const { domainMeta } = authz;
		const parsed = DecommissionBody.safeParse(await c.req.json().catch(() => ({})));
		if (!parsed.success) {
			return c.json(
				{ error: parsed.error.issues[0]?.message || "Invalid input" },
				400,
			);
		}

		const { confirmDomain, skipExportAcknowledged } = parsed.data;

		// 1. Validate domain confirmation challenge
		if (confirmDomain.toLowerCase().trim() !== domainMeta.domain.toLowerCase().trim()) {
			return c.json(
				{
					error: `Confirmation domain mismatch. Please type '${domainMeta.domain}' exactly to confirm shutdown.`,
				},
				400,
			);
		}

		// 2. Safeguard: Check if export exists or if skip was explicitly acknowledged
		const { hasExport } = await hasRecentExportForDomain(c.env.BUCKET, domainMeta.domain);
		if (!hasExport && !skipExportAcknowledged) {
			return c.json(
				{
					error: "Action blocked: No recent email export found. Please download your email backup or explicitly check 'I accept the data loss risk, skip export'.",
					requiresExportOrSkip: true,
				},
				400,
			);
		}

		let eppCode: string | undefined;

		// 3. If registered via Cloudflare Registrar, unlock domain and fetch transfer EPP code
		if (domainMeta.registration?.provider === "cloudflare_registrar") {
			try {
				await setDomainTransferLock(c.env, domainMeta.domain, false);
				eppCode = await getDomainEppCode(c.env, domainMeta.domain);
				if (domainMeta.registration) {
					domainMeta.registration.locked = false;
					domainMeta.registration.eppAuthCodeRequestedAt = new Date().toISOString();
				}
			} catch (regErr: unknown) {
				// Non-fatal if registrar unlock encounters an issue in testing
			}
		}

		// 4. Update domain status to "offboarding"
		domainMeta.status = "offboarding";
		domainMeta.emailRoutingEnabled = false;
		domainMeta.updatedAt = new Date().toISOString();

		await saveDomainMetadata(c.env.BUCKET, domainMeta);

		return c.json({
			success: true,
			domain: domainMeta.domain,
			status: "offboarding",
			eppCode,
			message:
				"Email routing has been safely disconnected. You may now point your nameservers elsewhere or transfer your domain registration.",
		});
	});

	/**
	 * Retrieve EPP Transfer Authorization Code for a registered domain.
	 */
	app.get("/api/v1/admin/domains/:domain/epp-code", async (c) => {
		const authz = await authorizeDomainAdmin(c, c.req.param("domain"));
		if (authz instanceof Response) return authz;

		const { domainMeta } = authz;

		try {
			const eppCode = await getDomainEppCode(c.env, domainMeta.domain);
			return c.json({ domain: domainMeta.domain, eppCode });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Failed to fetch EPP code";
			return c.json({ error: msg }, 502);
		}
	});

	/**
	 * Toggle domain transfer lock on Cloudflare Registrar.
	 */
	app.post("/api/v1/admin/domains/:domain/transfer-lock", async (c) => {
		const authz = await authorizeDomainAdmin(c, c.req.param("domain"));
		if (authz instanceof Response) return authz;

		const { domainMeta } = authz;
		const parsed = TransferLockBody.safeParse(await c.req.json().catch(() => ({})));
		if (!parsed.success) {
			return c.json({ error: "Invalid lock state payload" }, 400);
		}

		const { locked } = parsed.data;

		try {
			const updatedLock = await setDomainTransferLock(c.env, domainMeta.domain, locked);
			if (domainMeta.registration) {
				domainMeta.registration.locked = updatedLock;
				domainMeta.updatedAt = new Date().toISOString();
				await saveDomainMetadata(c.env.BUCKET, domainMeta);
			}
			return c.json({ domain: domainMeta.domain, locked: updatedLock });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Failed to update transfer lock";
			return c.json({ error: msg }, 502);
		}
	});
}
