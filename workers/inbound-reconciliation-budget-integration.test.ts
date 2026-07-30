import assert from "node:assert/strict";
import test from "node:test";
import { reconcileInboundArchives } from "./inbound-reconciliation.ts";
import {
	emergencyForwardMarkerKey,
	reconcileEmergencyForwardMarkers,
} from "./lib/emergency-forward.ts";
import {
	createInboundCleanupIntent,
	inboundCleanupIntentKey,
} from "./lib/inbound-derived-content-cleanup-intent.ts";
import {
	type InboundDerivedContentRepairAttempt,
	INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION,
	pendingRepairAttemptKey,
} from "./lib/inbound-derived-content-repair-attempt.ts";
import {
	INBOUND_RECONCILIATION_SERVICE_SUBREQUEST_BUDGET,
	INBOUND_RECONCILIATION_WORST_CASE_SERVICE_SUBREQUESTS,
} from "./lib/inbound-reconciliation-budget.ts";

const mailboxId = "hello@wiserchat.ai";
const now = new Date("2026-07-15T10:00:00.000Z");

function attemptId(index: number) {
	return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

test("a maximum scheduled reconciliation shape stays within the Worker service-subrequest budget", async () => {
	let serviceSubrequests = 0;
	let emergencyServiceSubrequests = 0;
	let etagRevision = 0;
	let recentListCount = 0;
	const stored = new Map<string, {
		value: string;
		etag: string;
		customMetadata?: Record<string, string>;
	}>();
	const repairKeys: string[] = [];
	const cleanupKeys: string[] = [];
	const recentKeys = Array.from(
		{ length: 64 },
		(_, index) => {
			const minute = new Date(Date.UTC(2026, 6, 14, 10, Math.floor(index / 2)));
			const year = minute.getUTCFullYear();
			const month = String(minute.getUTCMonth() + 1).padStart(2, "0");
			const day = String(minute.getUTCDate()).padStart(2, "0");
			const hour = String(minute.getUTCHours()).padStart(2, "0");
			const minutePart = String(minute.getUTCMinutes()).padStart(2, "0");
			return `raw/${year}/${month}/${day}/${hour}/${minutePart}/archive-${index}.eml`;
		},
	);
	const archiveKeys = [...recentKeys.slice(0, 8), "raw/2026/07/15/archive-8.eml"];
	const emergencyRawKeys = Array.from(
		{ length: 8 },
		(_, index) => `raw/2026/07/15/emergency-${index}.eml`,
	);
	const emergencyMarkerKeys = emergencyRawKeys.map(emergencyForwardMarkerKey);
	const emergencyQueue: unknown[] = [];
	const emergencyRawSha256 = "a".repeat(64);
	const archiveRawSha256 = "b".repeat(64);
	const activeMarkerKeys = archiveKeys.slice(0, 8).map(
		(rawKey) => `system/inbound-active/${encodeURIComponent(rawKey)}.json`,
	);
	stored.set("system/inbound-recent-cursor.json", {
		value: JSON.stringify({
			minute: "2026-07-14T10:00:00.000Z",
			cursor: null,
			updatedAt: "2026-07-14T09:59:00.000Z",
		}),
		etag: "recent-cursor-etag",
	});
	stored.set("system/emergency-forward/reconciliation-cursor.json", {
		value: "not-json",
		etag: "corrupt-emergency-cursor-etag",
	});
	for (const [index, rawKey] of emergencyRawKeys.entries()) {
		const ingressId = `emergency-${index}`;
		stored.set(emergencyMarkerKeys[index], {
			value: "not-json",
			etag: `corrupt-emergency-marker-${index}`,
			customMetadata: { ingressId, status: "forward_pending" },
		});
		stored.set(`receipts/${ingressId}.json`, {
			value: JSON.stringify({
				schemaVersion: 1,
				ingressId,
				rawKey,
				mailboxId,
				rawSize: 1,
				rawSha256: emergencyRawSha256,
				archivedAt: "2026-07-15T09:00:00.000Z",
				etag: `emergency-raw-etag-${index}`,
				version: `emergency-raw-version-${index}`,
				state: "quarantined",
				updatedAt: "2026-07-15T09:01:00.000Z",
				errorCode: "MIME_PARSE_FAILED",
			}),
			etag: `emergency-receipt-${index}`,
			customMetadata: { state: "quarantined" },
		});
	}

	for (let index = 0; index < 20; index += 1) {
		const id = attemptId(index);
		const attempt: InboundDerivedContentRepairAttempt = {
			schemaVersion: INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION,
			kind: "inbound_derived_content_repair_attempt",
			status: "pending",
			attemptId: id,
			ingressId: `repair-${index}`,
			mailboxId,
			expectedGeneration: 2,
			markerId: `marker_${String(index).padStart(8, "0")}`,
			commandFingerprint: String(index % 10).repeat(64),
			createdAt: "2026-07-15T09:00:00.000Z",
			proof: {
				attachments: [{
					r2Key: `attachments/repair-${index}/${id}/repair-${index}-0/file.bin`,
					byteLength: 1,
				}],
				bodyObjects: [],
			},
		};
		const key = pendingRepairAttemptKey(attempt.ingressId, id);
		repairKeys.push(key);
		stored.set(key, { value: JSON.stringify(attempt), etag: `seed-repair-${index}` });
	}

	for (let index = 0; index < 7; index += 1) {
		const id = attemptId(100 + index);
		const value = {
			...createInboundCleanupIntent({
				emailId: `cleanup-${index}`,
				mailboxId,
				projectionAttemptId: id,
				createdAt: "2026-07-14T00:00:00.000Z",
				fenceToken: attemptId(200 + index),
			}),
			status: "abandoned" as const,
			revision: 1,
			leaseUntil: "2026-07-14T00:20:00.000Z",
			abandonedAt: "2026-07-14T00:20:00.000Z",
			emptyObservedAt: "2026-07-15T09:00:00.000Z",
			emptyObservations: 1,
		};
		const key = inboundCleanupIntentKey(value.emailId, id);
		cleanupKeys.push(key);
		stored.set(key, { value: JSON.stringify(value), etag: `seed-cleanup-${index}` });
	}

	for (let index = 0; index < 9; index += 1) {
		stored.set(`receipts/archive-${index}.json`, {
			value: JSON.stringify({
				schemaVersion: 1,
				ingressId: `archive-${index}`,
				rawKey: archiveKeys[index],
				mailboxId,
				rawSize: 1,
				rawSha256: archiveRawSha256,
				archivedAt: "2026-07-15T09:00:00.000Z",
				etag: `raw-archive-${index}`,
				version: "raw-version",
				state: "stored",
				updatedAt: "2026-07-15T09:00:00.000Z",
			}),
			etag: `receipt-${index}`,
		});
		stored.set(
			`system/reconciliation-anomalies/${encodeURIComponent(archiveKeys[index])}.json`,
			{
				value: JSON.stringify({
					detectedAt: "2026-07-15T09:00:00.000Z",
					errorCode: "STORED_PROJECTION_MISSING",
					ingressId: `archive-${index}`,
					mailboxId,
					rawKey: archiveKeys[index],
					status: "pending_operator_review",
				}),
				etag: `anomaly-${index}`,
			},
		);
	}

	const rawBucket = {
		async list(options: { prefix: string; limit: number; cursor?: string }) {
			serviceSubrequests += 1;
			if (options.prefix === "system/emergency-forward/active/") {
				emergencyServiceSubrequests += 1;
				assert.equal(options.limit, 8);
				return {
					objects: emergencyMarkerKeys.map((key) => ({ key })),
					truncated: false,
				};
			}
			if (options.prefix === "system/derived-content-repair-attempts/pending/") {
				assert.equal(options.limit, 20);
				return { objects: repairKeys.map((key) => ({ key })), truncated: false };
			}
			if (options.prefix === "system/derived-content-cleanup-intents/pending/") {
				assert.equal(options.limit, 7);
				return { objects: cleanupKeys.map((key) => ({ key })), truncated: false };
			}
			if (options.prefix === "system/inbound-active/") {
				assert.equal(options.limit, 8);
				return {
					objects: activeMarkerKeys.map((key) => ({ key })),
					truncated: false,
				};
			}
			if (/^raw\/2026\/07\/14\/\d{2}\/\d{2}\/$/.test(options.prefix)) {
				assert.equal(options.limit, 64 - 2 * recentListCount);
				const objects = recentKeys
					.filter((key) => key.startsWith(options.prefix))
					.map((key) => ({ key }));
				assert.equal(objects.length, 2);
				recentListCount += 1;
				return { objects, truncated: false };
			}
			assert.equal(options.prefix, "raw/");
			assert.equal(options.limit, 1);
			return { objects: [{ key: archiveKeys[8] }], truncated: false };
		},
		async head(key: string) {
			serviceSubrequests += 1;
			if (key.startsWith("receipts/")) {
				const current = stored.get(`system/head-count/${key}`);
				const count = current ? Number(current.value) + 1 : 1;
				stored.set(`system/head-count/${key}`, {
					value: String(count),
					etag: `head-count-${count}`,
				});
				return {
					key,
					size: 1,
					etag: `receipt-head-${count}`,
					version: "receipt-version",
					customMetadata: { state: count === 1 ? "enqueued" : "stored" },
				};
			}
			const ingressId = key.slice(key.lastIndexOf("/") + 1, -4);
			return {
				key,
				size: 1,
				etag: `raw-${ingressId}`,
				version: "raw-version",
				customMetadata: {
					archivedAt: "2026-07-15T09:00:00.000Z",
					ingressId,
					mailboxId,
					rawSize: "1",
					rawSha256: archiveRawSha256,
					schemaVersion: "1",
				},
				checksums: {
					sha256: Uint8Array.from(
						Buffer.from(archiveRawSha256, "hex"),
					).buffer,
				},
			};
		},
		async get(key: string) {
			serviceSubrequests += 1;
			if (
				key === "system/emergency-forward/reconciliation-cursor.json" ||
				key === "system/emergency-forward/anomalies/reconciliation-cursor.json" ||
				key.startsWith("system/emergency-forward/active/") ||
				key.startsWith("system/emergency-forward/anomalies/raw%2F2026%2F07%2F15%2Femergency-") ||
				emergencyRawKeys.includes(key) ||
				/^receipts\/emergency-\d+\.json$/.test(key)
			) {
				emergencyServiceSubrequests += 1;
			}
			const emergencyRawIndex = emergencyRawKeys.indexOf(key);
			if (emergencyRawIndex >= 0) {
				return {
					key,
					version: `emergency-raw-version-${emergencyRawIndex}`,
					size: 1,
					etag: `emergency-raw-etag-${emergencyRawIndex}`,
					body: new ReadableStream(),
					customMetadata: {
						schemaVersion: "1",
						ingressId: `emergency-${emergencyRawIndex}`,
						mailboxId,
						rawSize: "1",
						rawSha256: emergencyRawSha256,
						archivedAt: "2026-07-15T09:00:00.000Z",
					},
					checksums: {
						sha256: Uint8Array.from(
							Buffer.from(emergencyRawSha256, "hex"),
						).buffer,
					},
					async text() { return "x"; },
				};
			}
			const object = stored.get(key);
			return object
				? {
						key,
						etag: object.etag,
						customMetadata: object.customMetadata,
						async text() { return object.value; },
					}
				: null;
		},
		async put(
			key: string,
			value: string,
			options?: {
				customMetadata?: Record<string, string>;
				onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
			},
		) {
			serviceSubrequests += 1;
			if (
				key === "system/emergency-forward/reconciliation-cursor.json" ||
				key === "system/emergency-forward/anomalies/reconciliation-cursor.json" ||
				key.startsWith("system/emergency-forward/active/") ||
				key.startsWith("system/emergency-forward/anomalies/") ||
				/^receipts\/emergency-\d+\.json$/.test(key)
			) {
				emergencyServiceSubrequests += 1;
			}
			const current = stored.get(key);
			if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return null;
			if (options?.onlyIf?.etagMatches &&
				current?.etag !== options.onlyIf.etagMatches) return null;
			etagRevision += 1;
			stored.set(key, {
				value,
				etag: `etag-${etagRevision}`,
				customMetadata: options?.customMetadata,
			});
			return key.startsWith("system/derived-content-repair-attempts/resolved/")
				? null
				: {};
		},
		async delete(key: string) {
			serviceSubrequests += 1;
			if (
				key.startsWith("system/emergency-forward/") ||
				/^receipts\/emergency-\d+\.json$/.test(key)
			) {
				emergencyServiceSubrequests += 1;
			}
			stored.delete(key);
		},
	};

	const env = {
		DOMAINS: "wiserchat.ai",
		DB: {
			prepare() {
				throw new Error("stored archives must not query mailbox admission");
			},
		},
		BUCKET: {
			async list(options: { prefix: string; cursor?: string }) {
				serviceSubrequests += 1;
				const offset = Number(options.cursor ?? 0);
				if (offset >= 256) return { objects: [], truncated: false };
				const emailId = options.prefix.split("/")[1];
				return {
					objects: [{
						key: options.prefix.startsWith("attachments/")
							? `${options.prefix}${emailId}-${offset}/file-${offset}.bin`
							: `${options.prefix}${offset}.body`,
						size: 1,
					}],
					truncated: true,
					cursor: String(offset + 1),
				};
			},
			async head() {
				serviceSubrequests += 1;
				return null;
			},
		},
		RAW_MAIL_BUCKET: rawBucket,
		INBOUND_QUEUE: {
			async send() {
				serviceSubrequests += 1;
				throw new Error("stored archives must not enqueue");
			},
		},
		EMERGENCY_FORWARD_QUEUE: {
			async send(value: unknown) {
				serviceSubrequests += 1;
				emergencyServiceSubrequests += 1;
				emergencyQueue.push(value);
			},
		},
		MAILBOX: {
			idFromName(value: string) {
				return value;
			},
			get() {
				return {
					async finalizeInboundDerivedContentRepairAttempt() {
						serviceSubrequests += 1;
						return { outcome: "rejected" as const };
					},
					async enqueueUnownedInboundDerivedContentCleanup(input: {
						objects: Array<unknown>;
					}) {
						serviceSubrequests += 1;
						return { queued: input.objects.length, retained: 0, absent: 0 };
					},
					async getInboundDerivedContentManifest(ingressId: string) {
						serviceSubrequests += 1;
						if (ingressId.startsWith("cleanup-")) return { status: "missing" as const };
						return {
							status: "live_inbound" as const,
							generation: 1,
							lastRepairMarkerId: null,
							attachments: Array.from({ length: 512 }, (_, index) => ({
								id: `attachment-${index}`,
								r2Key: `attachments/${ingressId}/owned-${index}.bin`,
								byteLength: 1,
							})),
							bodyObjects: [],
						};
					},
					async isEmailDeleted() {
						serviceSubrequests += 1;
						return false;
					},
					// The emergency ingress ids are the undelivered worst case: a live
					// row would settle their markers instead of re-enqueuing them.
					async hasEmail(ingressId: string) {
						serviceSubrequests += 1;
						return !ingressId.startsWith("emergency-");
					},
					async getEmail(ingressId: string) {
						serviceSubrequests += 1;
						return ingressId.startsWith("emergency-") ? null : {};
					},
				};
			},
		},
	};

	const originalLog = console.log;
	const originalError = console.error;
	console.log = () => {};
	console.error = () => {};
	try {
		const [result] = await Promise.all([
			reconcileInboundArchives(env, { now: () => now }),
			reconcileEmergencyForwardMarkers(env, {
				now: () => now,
				bestEffortTimeoutMs: 1,
			}),
		]);
		assert.equal(result.scanned, 9);
		assert.equal(result.pendingReview, 9);
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}

	assert.equal(INBOUND_RECONCILIATION_WORST_CASE_SERVICE_SUBREQUESTS, 8_881);
	assert.equal(emergencyQueue.length, 8);
	assert.equal(emergencyServiceSubrequests, 4 + 8 * 13);
	assert.equal(serviceSubrequests, 8_752);
	assert.ok(
		serviceSubrequests <= INBOUND_RECONCILIATION_WORST_CASE_SERVICE_SUBREQUESTS,
	);
	assert.ok(serviceSubrequests <= INBOUND_RECONCILIATION_SERVICE_SUBREQUEST_BUDGET);
});
