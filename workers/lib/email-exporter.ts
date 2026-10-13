// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * First-Class Email Data Export Engine (.mbox format RFC 4155).
 * Enables seamless email backup and migration for individual mailboxes
 * and entire custom domains, compatible with Apple Mail, Thunderbird, and Gmail.
 */

import type { Env } from "../types";
import { emailBodyKey, emailRawKey, buildSimpleMime } from "./email-content";
import { canonicalMailboxId } from "./mailbox-routing";
import { getFolderDisplayName } from "../../shared/folders";

export interface ExportJob {
	id: string;
	targetType: "mailbox" | "domain";
	targetId: string;
	status: "pending" | "processing" | "completed" | "failed";
	progress: number; // 0 - 100
	totalEmails: number;
	processedEmails: number;
	downloadKey?: string;
	downloadUrl?: string;
	filename?: string;
	fileSizeBytes?: number;
	createdAt: string;
	completedAt?: string;
	expiresAt: string; // 7 days from creation
	error?: string;
}

export const EXPORTS_JOB_PREFIX = "exports/jobs/";
export const EXPORTS_DATA_PREFIX = "exports/data/";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function exportJobKey(jobId: string): string {
	return `${EXPORTS_JOB_PREFIX}${jobId}.json`;
}

export function exportDataKey(jobId: string, ext = "mbox"): string {
	return `${EXPORTS_DATA_PREFIX}${jobId}.${ext}`;
}

/**
 * Format timestamp into RFC 4155 asctime format:
 * "Day Mon DD HH:MM:SS YYYY" (e.g. "Wed Jun 30 21:49:08 1993")
 */
export function formatAsctime(dateInput?: string | Date | null): string {
	const d = dateInput ? new Date(dateInput) : new Date();
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const months = [
		"Jan", "Feb", "Mar", "Apr", "May", "Jun",
		"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
	];
	const dayName = days[d.getUTCDay()];
	const monthName = months[d.getUTCMonth()];
	const dayNum = String(d.getUTCDate()).padStart(2, " ");
	const hours = String(d.getUTCHours()).padStart(2, "0");
	const mins = String(d.getUTCMinutes()).padStart(2, "0");
	const secs = String(d.getUTCSeconds()).padStart(2, "0");
	const year = d.getUTCFullYear();

	return `${dayName} ${monthName} ${dayNum} ${hours}:${mins}:${secs} ${year}`;
}

/**
 * RFC 4155 "From-quoting": Any line in the message body starting with "From "
 * must be prefixed with ">" to avoid ambiguous message boundaries.
 */
export function fromQuote(rawMessage: string): string {
	return rawMessage.replace(/^(>*From )/gm, ">$1");
}

/**
 * Format a single email message into standard RFC 4155 MBOX format.
 */
export function formatMboxEntry(
	sender: string | null | undefined,
	date: string | null | undefined,
	mimeContent: string,
	folderName?: string,
): string {
	const senderEmail = (sender || "MAILER-DAEMON@localhost").trim();
	const asctime = formatAsctime(date);
	const quoted = fromQuote(mimeContent);

	let entry = `From ${senderEmail} ${asctime}\r\n`;
	if (folderName) {
		entry += `X-Folder: ${folderName}\r\n`;
	}
	entry += quoted.trimEnd() + "\r\n\r\n";
	return entry;
}

/**
 * Retrieve export job metadata from R2.
 */
export async function getExportJob(
	bucket: R2Bucket,
	jobId: string,
): Promise<ExportJob | null> {
	const key = exportJobKey(jobId);
	const obj = await bucket.get(key);
	if (!obj) return null;
	try {
		return (await obj.json()) as ExportJob;
	} catch {
		return null;
	}
}

/**
 * Save export job metadata to R2.
 */
export async function saveExportJob(
	bucket: R2Bucket,
	job: ExportJob,
): Promise<void> {
	const key = exportJobKey(job.id);
	await bucket.put(key, JSON.stringify(job, null, 2), {
		httpMetadata: { contentType: "application/json" },
	});
}

/**
 * Check if a domain has an export generated in the last 7 days.
 */
export async function hasRecentExportForDomain(
	bucket: R2Bucket,
	domain: string,
): Promise<{ hasExport: boolean; lastExport?: ExportJob }> {
	const listed = await bucket.list({ prefix: EXPORTS_JOB_PREFIX });
	const normalizedDomain = domain.toLowerCase().trim();
	let latestJob: ExportJob | undefined;

	for (const obj of listed.objects) {
		const res = await bucket.get(obj.key);
		if (!res) continue;
		try {
			const job = (await res.json()) as ExportJob;
			// Only a whole-domain export of exactly this domain counts: a single
			// mailbox export doesn't cover the domain, and a suffix match would
			// let `acme.com` exports satisfy `cme.com`.
			if (
				job.targetType === "domain" &&
				job.targetId.toLowerCase() === normalizedDomain &&
				job.status === "completed"
			) {
				const isExpired = new Date(job.expiresAt).getTime() < Date.now();
				if (!isExpired) {
					if (!latestJob || new Date(job.createdAt) > new Date(latestJob.createdAt)) {
						latestJob = job;
					}
				}
			}
		} catch {
			// ignore malformed jobs
		}
	}

	return {
		hasExport: Boolean(latestJob),
		lastExport: latestJob,
	};
}

/**
 * Export all emails for a single mailbox to an .mbox stream.
 */
export async function exportMailboxToMbox(
	env: Env,
	mailboxId: string,
): Promise<{ mboxContent: string; totalEmails: number }> {
	const canonical = canonicalMailboxId(mailboxId);
	if (!canonical) throw new Error(`Invalid mailbox ID: ${mailboxId}`);

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(canonical));
	let offset = 0;
	const batchSize = 200;
	let mboxContent = "";
	let processed = 0;

	while (true) {
		// In test/mock environments or live Durable Objects:
		let batch: any[] = [];
		if (typeof (stub as any).getBatchForExport === "function") {
			batch = await (stub as any).getBatchForExport(offset, batchSize);
		} else if (typeof stub.getEmails === "function") {
			batch = await stub.getEmails({ page: Math.floor(offset / batchSize) + 1, limit: batchSize });
		}

		if (!batch || batch.length === 0) break;

		for (const email of batch) {
			let mimeBody: string | null = null;

			// 1. Try to load raw RFC822 MIME from R2
			const rawObj = await env.BUCKET.get(emailRawKey(email.id));
			if (rawObj) {
				mimeBody = await rawObj.text();
			}

			// 2. Fallback: reconstruct RFC822 MIME from HTML body & headers
			if (!mimeBody) {
				const bodyObj = await env.BUCKET.get(emailBodyKey(email.id));
				const bodyText = bodyObj ? await bodyObj.text() : email.snippet || "";
				mimeBody = buildSimpleMime(
					{
						from: email.sender_name ? `"${email.sender_name}" <${email.sender}>` : email.sender,
						to: email.recipient,
						cc: email.cc,
						bcc: email.bcc,
						subject: email.subject,
						date: email.date,
						messageId: email.provider_message_id,
						inReplyTo: email.in_reply_to,
					},
					bodyText,
				);
			}

			const folderName = email.folder_id ? getFolderDisplayName(email.folder_id) : "Inbox";
			mboxContent += formatMboxEntry(email.sender, email.date, mimeBody, folderName);
			processed++;
		}

		offset += batch.length;
		if (batch.length < batchSize) break;
	}

	return { mboxContent, totalEmails: processed };
}

/**
 * Execute a complete Mailbox export job, packaging into R2.
 */
export async function runMailboxExportJob(
	env: Env,
	mailboxId: string,
	jobId?: string,
): Promise<ExportJob> {
	const canonical = canonicalMailboxId(mailboxId) || mailboxId;
	const id = jobId || `exp_mbx_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
	const now = new Date();
	const expiresAt = new Date(now.getTime() + SEVEN_DAYS_MS).toISOString();

	const job: ExportJob = {
		id,
		targetType: "mailbox",
		targetId: canonical,
		status: "processing",
		progress: 10,
		totalEmails: 0,
		processedEmails: 0,
		createdAt: now.toISOString(),
		expiresAt,
	};
	await saveExportJob(env.BUCKET, job);

	try {
		const { mboxContent, totalEmails } = await exportMailboxToMbox(env, canonical);
		const dataKey = exportDataKey(id, "mbox");
		const filename = `${canonical.replace(/[^a-z0-9]/gi, "_")}-archive.mbox`;

		await env.BUCKET.put(dataKey, mboxContent, {
			httpMetadata: {
				contentType: "application/mbox; charset=utf-8",
				contentDisposition: `attachment; filename="${filename}"`,
			},
		});

		job.status = "completed";
		job.progress = 100;
		job.totalEmails = totalEmails;
		job.processedEmails = totalEmails;
		job.downloadKey = dataKey;
		job.downloadUrl = `/api/v1/exports/${id}/download`;
		job.filename = filename;
		job.fileSizeBytes = new TextEncoder().encode(mboxContent).length;
		job.completedAt = new Date().toISOString();

		await saveExportJob(env.BUCKET, job);
		return job;
	} catch (err: unknown) {
		job.status = "failed";
		job.error = err instanceof Error ? err.message : "Export failed";
		await saveExportJob(env.BUCKET, job);
		throw err;
	}
}

/**
 * Execute a complete Domain-wide export job (all mailboxes for domain).
 */
export async function runDomainExportJob(
	env: Env,
	domain: string,
	jobId?: string,
): Promise<ExportJob> {
	const normalizedDomain = domain.toLowerCase().trim();
	const id = jobId || `exp_dom_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
	const now = new Date();
	const expiresAt = new Date(now.getTime() + SEVEN_DAYS_MS).toISOString();

	const job: ExportJob = {
		id,
		targetType: "domain",
		targetId: normalizedDomain,
		status: "processing",
		progress: 10,
		totalEmails: 0,
		processedEmails: 0,
		createdAt: now.toISOString(),
		expiresAt,
	};
	await saveExportJob(env.BUCKET, job);

	try {
		// Find all mailboxes for domain in R2
		const listed = await env.BUCKET.list({ prefix: "mailboxes/" });
		const domainSuffix = `@${normalizedDomain}.json`;
		const mailboxes: string[] = [];

		for (const obj of listed.objects) {
			if (obj.key.endsWith(domainSuffix)) {
				const id = obj.key.replace(/^mailboxes\//, "").replace(/\.json$/, "");
				mailboxes.push(id);
			}
		}

		let unifiedMbox = "";
		let totalCount = 0;

		for (let i = 0; i < mailboxes.length; i++) {
			const mboxId = mailboxes[i];
			const { mboxContent, totalEmails } = await exportMailboxToMbox(env, mboxId);
			unifiedMbox += mboxContent;
			totalCount += totalEmails;

			job.progress = Math.min(10 + Math.floor(((i + 1) / Math.max(mailboxes.length, 1)) * 80), 90);
			job.processedEmails = totalCount;
			await saveExportJob(env.BUCKET, job);
		}

		const dataKey = exportDataKey(id, "mbox");
		const filename = `${normalizedDomain.replace(/[^a-z0-9]/gi, "_")}-all-mailboxes.mbox`;

		await env.BUCKET.put(dataKey, unifiedMbox, {
			httpMetadata: {
				contentType: "application/mbox; charset=utf-8",
				contentDisposition: `attachment; filename="${filename}"`,
			},
		});

		job.status = "completed";
		job.progress = 100;
		job.totalEmails = totalCount;
		job.processedEmails = totalCount;
		job.downloadKey = dataKey;
		job.downloadUrl = `/api/v1/exports/${id}/download`;
		job.filename = filename;
		job.fileSizeBytes = new TextEncoder().encode(unifiedMbox).length;
		job.completedAt = new Date().toISOString();

		await saveExportJob(env.BUCKET, job);
		return job;
	} catch (err: unknown) {
		job.status = "failed";
		job.error = err instanceof Error ? err.message : "Domain export failed";
		await saveExportJob(env.BUCKET, job);
		throw err;
	}
}
