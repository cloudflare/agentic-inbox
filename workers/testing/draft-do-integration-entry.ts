import type { ActivityActor } from "../lib/activity.ts";
import type { Env } from "../types.ts";
import { MailboxDO } from "../durableObject/index.ts";

export class DraftTestMailboxDO extends MailboxDO {
	async discardWithCleanupStateForTest(
		draftId: string,
		draftVersion: number,
		actor: ActivityActor,
	) {
		const result = await this.discardDraft(draftId, draftVersion, actor);
		const deletionOutbox = [...this.ctx.storage.sql.exec(
			`SELECT r2_key AS r2Key, email_id AS emailId, state
			 FROM r2_deletion_outbox
			 ORDER BY r2_key`,
		)];
		const emailCount = [...this.ctx.storage.sql.exec(
			"SELECT COUNT(*) AS count FROM emails WHERE id = ?",
			draftId,
		)][0]?.count;
		const attachmentCount = [...this.ctx.storage.sql.exec(
			"SELECT COUNT(*) AS count FROM attachments WHERE email_id = ?",
			draftId,
		)][0]?.count;
		const activities = [...this.ctx.storage.sql.exec(
			`SELECT actor_kind AS actorKind, actor_id AS actorId, metadata_json AS metadataJson
			 FROM activity_events
			 WHERE action = 'draft_discarded' AND entity_id = ?`,
			draftId,
		)];
		return { result, deletionOutbox, emailCount, attachmentCount, activities };
	}

	async upsertWithCleanupStateForTest(
		input: Parameters<MailboxDO["upsertDraft"]>[0],
		attachments: Parameters<MailboxDO["upsertDraft"]>[1],
		actor: ActivityActor,
	) {
		const result = await this.upsertDraft(input, attachments, actor);
		const deletionOutbox = [...this.ctx.storage.sql.exec(
			`SELECT r2_key AS r2Key, state
			 FROM r2_deletion_outbox
			 ORDER BY r2_key`,
		)];
		return { result, deletionOutbox };
	}

	draftStateForTest() {
		const emails = [...this.ctx.storage.sql.exec(
			`SELECT id, draft_version AS draftVersion, draft_create_key AS createKey
			 FROM emails
			 WHERE draft_create_key IS NOT NULL
			 ORDER BY id`,
		)];
		const activities = [...this.ctx.storage.sql.exec(
			`SELECT action, entity_id AS entityId
			 FROM activity_events
			 WHERE action IN ('draft_created', 'draft_updated')
			 ORDER BY occurred_at, id`,
		)];
		const operations = [...this.ctx.storage.sql.exec(
			`SELECT create_key AS createKey, draft_id AS draftId,
			        draft_version AS draftVersion, state
			 FROM draft_create_operations
			 ORDER BY create_key`,
		)];
		const saveOperations = [...this.ctx.storage.sql.exec(
				`SELECT save_key AS saveKey, fingerprint, draft_id AS draftId,
				        expected_version AS expectedVersion, state, claim_token AS claimToken,
				        committed_version AS committedVersion,
				        claim_expires_at AS claimExpiresAt,
				        destination_keys AS destinationKeys
			 FROM draft_save_operations
			 ORDER BY save_key`,
		)];
		const cleanupIntents = [...this.ctx.storage.sql.exec(
			`SELECT claim_token AS claimToken, draft_id AS draftId,
			        destination_keys AS destinationKeys,
			        next_attempt_at AS nextAttemptAt, verify_until AS verifyUntil,
			        attempts, state, generation,
			        last_error_code AS lastErrorCode, parked_at AS parkedAt
			 FROM draft_save_cleanup_intents
			 ORDER BY claim_token`,
		)];
		const updateOperations = [...this.ctx.storage.sql.exec(
			`SELECT update_key AS updateKey, fingerprint, draft_id AS draftId,
			        previous_version AS previousVersion,
			        result_version AS resultVersion
			 FROM draft_update_operations
			 ORDER BY update_key`,
		)];
		const deletionOutbox = [...this.ctx.storage.sql.exec(
			`SELECT r2_key AS r2Key, state
			 FROM r2_deletion_outbox
			 ORDER BY r2_key`,
		)];
		return {
			emails,
			activities,
			operations,
			saveOperations,
			cleanupIntents,
			updateOperations,
			deletionOutbox,
		};
	}

	clearAlarmForTest() {
		return this.ctx.storage.deleteAlarm();
	}

	getAlarmForTest() {
		return this.ctx.storage.getAlarm();
	}

	// Exercises all three list projections. The draft branch and the flat list
	// have no other runtime caller in the suite, so a malformed column or
	// subquery in either only surfaces here.
	async readListProjectionsForTest(): Promise<void> {
		await this.getThreadedEmails({ folder: "inbox", page: 1, limit: 25 });
		await this.getThreadedEmails({ folder: "draft", page: 1, limit: 25 });
		await this.getEmails({ folder: "inbox", page: 1, limit: 25 });
	}

	expireDraftSaveClaimForTest(saveKey: string) {
		this.ctx.storage.sql.exec(
			`UPDATE draft_save_operations
			 SET claim_expires_at = ?
			 WHERE save_key = ? AND state = 'claimed'`,
			Date.now() - 1,
			saveKey,
		);
	}

	seedR2DeletionForTest(input: {
		r2Key: string;
		emailId: string;
		nextAttemptAt: string;
	}) {
		this.ctx.storage.sql.exec(
			`INSERT INTO r2_deletion_outbox(
				r2_key, email_id, projection_attempt_id, state,
				claim_generation, lease_token, lease_expires_at, attempts,
				next_attempt_at, last_error, created_at
			) VALUES (?, ?, NULL, 'pending', 0, NULL, NULL, 0, ?, NULL, ?)`,
			input.r2Key,
			input.emailId,
			input.nextAttemptAt,
			new Date().toISOString(),
		);
	}

	seedDraftSaveOperationsForTest(input: {
		count: number;
		state: "claimed" | "committed" | "aborted";
		updatedAt: string;
		prefix: string;
		claimExpiresAt?: number;
		destinationKeys?: string;
	}) {
		for (let index = 0; index < input.count; index += 1) {
			this.ctx.storage.sql.exec(
				`INSERT INTO draft_save_operations(
					save_key, fingerprint, draft_id, expected_version, state,
					destination_keys, committed_version, claim_expires_at,
					updated_at, claim_token
					) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
				`${input.prefix}-${index}`,
				`fingerprint-${input.prefix}-${index}`,
				`draft-${input.prefix}-${index}`,
					input.state,
					input.destinationKeys ?? "[]",
					input.state === "committed" ? 2 : null,
					input.claimExpiresAt ?? Date.now() + 300_000,
				input.updatedAt,
				`token-${input.prefix}-${index}`,
			);
		}
	}

	makeDraftSaveCleanupDueForTest(claimToken: string) {
		this.ctx.storage.sql.exec(
			`UPDATE draft_save_cleanup_intents
			 SET next_attempt_at = ?
			 WHERE claim_token = ?`,
			Date.now() - 1,
			claimToken,
		);
	}

	listParkedDraftSaveCleanupIntentsForTest() {
		return this.listParkedDraftSaveCleanupIntents(undefined, 100);
	}

	repairParkedDraftSaveCleanupIntentForTest(
		claimToken: string,
		expectedGeneration: number,
		destinationKeys: string[],
	) {
		return this.repairParkedDraftSaveCleanupIntent(
			claimToken,
			{ expectedGeneration, destinationKeys },
			{ kind: "user", id: "admin-1" },
		);
	}

	runAlarmForTest() {
		return this.alarm();
	}

	async runAlarmAndClearForTest() {
		await this.alarm();
		await this.ctx.storage.deleteAlarm();
	}
}

type DraftTestStub = DurableObjectStub<DraftTestMailboxDO> & {
	discardWithCleanupStateForTest(
		draftId: string,
		draftVersion: number,
		actor: ActivityActor,
	): Promise<Awaited<ReturnType<DraftTestMailboxDO["discardWithCleanupStateForTest"]>>>;
	draftStateForTest(): Promise<{
		emails: Array<Record<string, unknown>>;
		activities: Array<Record<string, unknown>>;
		operations: Array<Record<string, unknown>>;
		saveOperations?: Array<Record<string, unknown>>;
		cleanupIntents?: Array<Record<string, unknown>>;
		updateOperations?: Array<Record<string, unknown>>;
		deletionOutbox?: Array<Record<string, unknown>>;
	}>;
	seedDraftSaveOperationsForTest(input: Parameters<
		DraftTestMailboxDO["seedDraftSaveOperationsForTest"]
	>[0]): Promise<void>;
	makeDraftSaveCleanupDueForTest(claimToken: string): Promise<void>;
	listParkedDraftSaveCleanupIntentsForTest(): Promise<{
		items: Array<Record<string, unknown>>;
	}>;
	repairParkedDraftSaveCleanupIntentForTest(
		claimToken: string,
		expectedGeneration: number,
		destinationKeys: string[],
	): Promise<Record<string, unknown>>;
	runAlarmForTest(): Promise<void>;
	runAlarmAndClearForTest(): Promise<void>;
	clearAlarmForTest(): Promise<void>;
	getAlarmForTest(): Promise<number | null>;
	readListProjectionsForTest(): Promise<void>;
	expireDraftSaveClaimForTest(saveKey: string): Promise<void>;
	seedR2DeletionForTest(input: Parameters<
		DraftTestMailboxDO["seedR2DeletionForTest"]
	>[0]): Promise<void>;
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const mailboxId = url.searchParams.get("mailbox") ?? "team@example.com";
		const stub = env.MAILBOX.get(
			env.MAILBOX.idFromName(mailboxId),
		) as DraftTestStub;
		if (url.pathname === "/state") {
			return Response.json(await stub.draftStateForTest());
		}
		if (url.pathname === "/seed-save-operations") {
			const body = await request.json() as Parameters<
				DraftTestMailboxDO["seedDraftSaveOperationsForTest"]
			>[0];
			await stub.seedDraftSaveOperationsForTest(body);
			return Response.json({ seeded: body.count });
		}
			if (url.pathname === "/make-cleanup-due") {
			const body = await request.json() as { claimToken: string };
			await stub.makeDraftSaveCleanupDueForTest(body.claimToken);
			return Response.json({ scheduled: true });
		}
			if (url.pathname === "/run-alarm") {
			await stub.runAlarmForTest();
			return Response.json({ completed: true });
		}
		if (url.pathname === "/clear-alarm") {
			await stub.clearAlarmForTest();
			return Response.json({ cleared: true });
		}
		if (url.pathname === "/alarm-state") {
			return Response.json({ alarm: await stub.getAlarmForTest() });
		}
		if (url.pathname === "/seed-r2-deletion") {
			const body = await request.json() as Parameters<
				DraftTestMailboxDO["seedR2DeletionForTest"]
			>[0];
			await stub.seedR2DeletionForTest(body);
			return Response.json({ seeded: true });
		}
		if (url.pathname === "/read-list-projections") {
			await stub.readListProjectionsForTest();
			return Response.json({ read: true });
		}
		if (url.pathname === "/expire-save-claim") {
			const body = await request.json() as { saveKey: string };
			await stub.expireDraftSaveClaimForTest(body.saveKey);
			return Response.json({ expired: true });
		}
		if (url.pathname === "/put-owned-object") {
			const body = await request.json() as {
				key: string;
				promotionOwner: string;
			};
			await env.BUCKET.put(body.key, new Uint8Array([1, 2, 3]), {
				customMetadata: { promotionOwner: body.promotionOwner },
			});
			return Response.json({ stored: true });
		}
		if (url.pathname === "/object-exists") {
			const body = await request.json() as { key: string };
			return Response.json({ exists: (await env.BUCKET.head(body.key)) !== null });
		}
		if (url.pathname === "/upsert") {
			const body = await request.json() as {
				input: Parameters<MailboxDO["upsertDraft"]>[0];
				attachments?: Parameters<MailboxDO["upsertDraft"]>[1];
				actor: ActivityActor;
			};
			return Response.json(
				await stub.upsertDraft(body.input, body.attachments ?? [], body.actor),
			);
		}
		if (url.pathname === "/upsert-cleanup-state") {
			const body = await request.json() as {
				input: Parameters<MailboxDO["upsertDraft"]>[0];
				attachments?: Parameters<MailboxDO["upsertDraft"]>[1];
				actor: ActivityActor;
			};
			return Response.json(
				await stub.upsertWithCleanupStateForTest(
					body.input,
					body.attachments ?? [],
					body.actor,
				),
			);
		}
		if (url.pathname === "/claim-save") {
			const body = await request.json() as Parameters<MailboxDO["claimDraftSave"]>[0];
			return Response.json(await stub.claimDraftSave(body));
		}
		if (url.pathname === "/update-idempotent") {
			const body = await request.json() as Parameters<
				MailboxDO["updateDraftIdempotently"]
			>[0];
			return Response.json(await stub.updateDraftIdempotently(body));
		}
		if (url.pathname === "/record-save-promotion") {
			const body = await request.json() as {
				saveKey: string;
				fingerprint: string;
				claimToken: string;
				destinationKeys: string[];
			};
			return Response.json({
				recorded: await stub.recordDraftSavePromotion(
					body.saveKey,
					body.fingerprint,
					body.claimToken,
					body.destinationKeys,
				),
			});
		}
		if (url.pathname === "/abort-save") {
			const body = await request.json() as {
				saveKey: string;
				fingerprint: string;
				claimToken: string;
			};
			return Response.json(
				await stub.abortDraftSave(
					body.saveKey,
					body.fingerprint,
					body.claimToken,
				),
			);
		}
		if (url.pathname === "/save-outcome") {
			const body = await request.json() as { saveKey: string; fingerprint: string };
			return Response.json(
				await stub.getDraftSaveOutcome(body.saveKey, body.fingerprint),
			);
		}
			if (url.pathname === "/discard") {
			const body = await request.json() as {
				draftId: string;
				draftVersion: number;
				actor: ActivityActor;
			};
			return Response.json(
				await stub.discardDraft(body.draftId, body.draftVersion, body.actor),
				);
			}
			if (url.pathname === "/list-parked-save-cleanup") {
				return Response.json(
					await stub.listParkedDraftSaveCleanupIntentsForTest(),
				);
			}
			if (url.pathname === "/repair-parked-save-cleanup") {
				const body = await request.json() as {
					claimToken: string;
					expectedGeneration: number;
					destinationKeys: string[];
				};
				return Response.json(
					await stub.repairParkedDraftSaveCleanupIntentForTest(
						body.claimToken,
						body.expectedGeneration,
						body.destinationKeys,
					),
				);
			}
			if (url.pathname === "/run-alarm-and-clear") {
				await stub.runAlarmAndClearForTest();
				return Response.json({ completed: true, cleared: true });
			}
			if (url.pathname === "/discard-cleanup-state") {
				const body = await request.json() as {
					draftId: string;
					draftVersion: number;
					actor: ActivityActor;
				};
				return Response.json(
					await stub.discardWithCleanupStateForTest(
						body.draftId,
						body.draftVersion,
						body.actor,
					),
				);
			}
			if (url.pathname === "/queue-attachment-cleanup") {
				const body = await request.json() as {
					emailId: string;
					keys: string[];
				};
				await stub.queueAttachmentCleanup(body.emailId, body.keys);
				return Response.json({ queued: true });
			}
		if (url.pathname === "/consume") {
			const body = await request.json() as {
				draftId: string;
				draftVersion: number;
				actor: ActivityActor;
			};
			return Response.json(
				await stub.consumeDraftVersion(body.draftId, body.draftVersion, body.actor),
			);
		}
		if (url.pathname === "/delete") {
			const body = await request.json() as { draftId: string };
			const deleted = await stub.deleteEmail(body.draftId);
			return Response.json({ status: deleted ? "deleted" : "missing" });
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	},
};
