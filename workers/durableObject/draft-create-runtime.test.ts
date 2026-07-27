import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();

test(
	"MailboxDO preserves exact Draft create, save, and update retry truth across lifecycle changes",
	{ timeout: 30_000 },
	async () => {
		const outputDirectory = await mkdtemp(join(tmpdir(), "mail-draft-do-"));
		let runtime: Miniflare | undefined;
		try {
			await execFileAsync(
				join(ROOT, "node_modules/.bin/wrangler"),
				[
					"deploy",
					"workers/testing/draft-do-integration-entry.ts",
					"--dry-run",
					"--outdir",
					outputDirectory,
					"--compatibility-date",
					"2026-07-14",
					"--compatibility-flag",
					"nodejs_compat",
					"--config",
					"wrangler.jsonc",
					"--env=",
					"--upload-source-maps=false",
				],
				{
					cwd: ROOT,
					env: {
						...process.env,
						WRANGLER_LOG_PATH: join(outputDirectory, "wrangler.log"),
					},
				},
			);
			const bundle = await readFile(
				join(outputDirectory, "draft-do-integration-entry.js"),
				"utf8",
			);
			runtime = new Miniflare({
				log: new Log(LogLevel.ERROR),
				modules: true,
				script: bundle,
				compatibilityDate: "2026-07-14",
				compatibilityFlags: ["nodejs_compat"],
				durableObjects: {
					MAILBOX: { className: "DraftTestMailboxDO", useSQLite: true },
				},
				r2Buckets: ["BUCKET"],
				d1Databases: ["DB"],
				kvNamespaces: ["OAUTH_KV"],
				bindings: {
					BRAND: "wiser",
					FEATURES: [],
					DOMAINS: "wiserchat.ai",
					EMAIL_ADDRESSES: [],
					AWS_REGION: "eu-west-2",
					SES_CONFIGURATION_SET: "mail-portal-events",
					AI_MODEL: "test",
					AI_CHEAP_MODEL: "test",
					AI_STRONG_MODEL: "test",
					AI_COST_ALERT_USD: "25",
					AI_COST_REVIEW_USD: "50",
					VAPID_SUBJECT: "mailto:test@example.com",
				},
			});

				const requestForMailbox = async <T>(
					mailboxId: string,
					path: string,
					body?: unknown,
				): Promise<T> => {
					const response = await runtime!.dispatchFetch(
					`http://draft.test${path}?mailbox=${encodeURIComponent(mailboxId)}`,
					body === undefined
						? undefined
						: {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify(body),
							},
				);
				const text = await response.text();
					assert.equal(response.status, 200, text);
					return JSON.parse(text) as T;
				};
				const mailboxId = "team@example.com";
				const request = <T>(path: string, body?: unknown) =>
					requestForMailbox<T>(mailboxId, path, body);
			const input = (
				id: string,
				fingerprint = "fingerprint-1",
				createKey = "tool-create-key-1",
			) => ({
				id,
				createKey,
				createFingerprint: fingerprint,
				subject: "Hello",
				sender: mailboxId,
				recipient: "person@example.com",
				cc: null,
				bcc: null,
				body: "<p>Body</p>",
				in_reply_to: null,
				thread_id: id,
			});
			const actor = { kind: "agent", id: "user-1" };
			type UpsertResult = {
				status: string;
				draftId: string;
				draft?: { draft_version: number; thread_id: string };
			};
			const [left, right] = await Promise.all([
				request<UpsertResult>("/upsert", {
					input: input("candidate-left"), actor,
				}),
				request<UpsertResult>("/upsert", {
					input: input("candidate-right"), actor,
				}),
			]);
			assert.deepEqual(
				[left.status, right.status].sort(),
				["creation_replay", "saved"],
			);
			const saved = left.status === "saved" ? left : right;
			const replay = left.status === "creation_replay" ? left : right;
			assert.equal(replay.draftId, saved.draftId);
			assert.equal(replay.draft?.draft_version, 1);
			assert.equal(replay.draft?.thread_id, saved.draftId);

				type State = {
				emails: Array<{ id: string; draftVersion: number; createKey: string }>;
				activities: Array<{ action: string; entityId: string }>;
					operations: Array<{
					createKey: string;
					draftId: string;
					draftVersion: number;
					state: string;
					}>;
					deletionOutbox?: Array<{ r2Key: string; state: string }>;
				};
			let state = await request<State>("/state");
			assert.deepEqual(state.emails, [{
				id: saved.draftId,
				draftVersion: 1,
				createKey: "tool-create-key-1",
			}]);
			assert.deepEqual(state.activities, [{
				action: "draft_created",
				entityId: saved.draftId,
			}]);
			assert.deepEqual(state.operations, [{
				createKey: "tool-create-key-1",
				draftId: saved.draftId,
				draftVersion: 1,
				state: "active",
			}]);

			const conflict = await request<{ status: string; draftId: string }>(
				"/upsert",
				{ input: input("candidate-conflict", "fingerprint-2"), actor },
			);
			assert.equal(conflict.status, "creation_conflict");
			assert.equal(conflict.draftId, saved.draftId);
			state = await request<State>("/state");
			assert.equal(state.emails.length, 1);
			assert.equal(state.activities.length, 1);

			const update = await request<{ status: string; draftVersion: number }>(
				"/upsert",
				{
					input: {
						...input(saved.draftId),
						createKey: undefined,
						createFingerprint: undefined,
						expectedVersion: 1,
						subject: "Edited",
					},
					actor: { kind: "user", id: "user-1" },
				},
			);
			assert.equal(update.status, "saved");
			assert.equal(update.draftVersion, 2);

			const superseded = await request<{
				status: string;
				draftId: string;
				currentVersion: number;
			}>("/upsert", { input: input("candidate-delayed"), actor });
			assert.equal(superseded.status, "creation_superseded");
			assert.equal(superseded.draftId, saved.draftId);
			assert.equal(superseded.currentVersion, 2);
			state = await request<State>("/state");
			assert.equal(state.emails.length, 1);
			assert.deepEqual(state.activities.map((event) => event.action), [
				"draft_created",
				"draft_updated",
			]);

			for (const terminal of ["discard", "consume", "delete"] as const) {
				const createKey = `tool-create-key-${terminal}`;
				const created = await request<UpsertResult>("/upsert", {
					input: input(`candidate-${terminal}`, "terminal-fingerprint", createKey),
					actor,
				});
				assert.equal(created.status, "saved");
				const terminalResult = await request<{ status: string }>(`/${terminal}`, {
					draftId: created.draftId,
					...(terminal === "delete"
						? {}
						: {
								draftVersion: 1,
								actor: { kind: "user", id: "user-1" },
							}),
				});
				assert.equal(
					terminalResult.status,
					terminal === "discard"
						? "discarded"
						: terminal === "consume"
							? "consumed"
							: "deleted",
				);
				const delayed = await request<{
					status: string;
					draftId: string;
					reason: string;
				}>("/upsert", {
					input: input(`replacement-${terminal}`, "terminal-fingerprint", createKey),
					actor,
				});
				assert.equal(delayed.status, "creation_unavailable");
				assert.equal(delayed.draftId, created.draftId);
				assert.equal(
					delayed.reason,
					terminal === "discard"
						? "discarded"
						: terminal === "consume"
							? "consumed"
							: "deleted",
				);
			}
			state = await request<State>("/state");
			assert.equal(state.emails.length, 1);
				assert.deepEqual(
					state.operations.map((operation) => [operation.createKey, operation.state]),
				[
					["tool-create-key-1", "active"],
					["tool-create-key-consume", "consumed"],
					["tool-create-key-delete", "deleted"],
					["tool-create-key-discard", "discarded"],
					],
				);

				const claimDraft = await request<UpsertResult>("/upsert", {
					input: input("draft-save-claim", "claim-create", "claim-create-key"),
					actor,
				});
				assert.equal(claimDraft.status, "saved");
				const claimInput = (saveKey: string, claimToken = `token-${saveKey}`) => ({
					saveKey,
					fingerprint: `fingerprint-${saveKey}`,
					draftId: claimDraft.draftId,
					expectedVersion: 1,
					claimToken,
					claimExpiresAt: Date.now() + 300_000,
				});
				const [firstClaim, competingClaim] = await Promise.all([
					request<{ status: string }>("/claim-save", claimInput("save-1")),
					request<{ status: string }>("/claim-save", claimInput("save-2")),
				]);
				assert.deepEqual(
					[firstClaim.status, competingClaim.status].sort(),
					["claimed", "revision_in_progress"],
				);
				const winnerKey = firstClaim.status === "claimed" ? "save-1" : "save-2";
				const winner = claimInput(winnerKey);
				const recorded = await request<{ recorded: boolean }>(
					"/record-save-promotion",
					{
						saveKey: winner.saveKey,
						fingerprint: winner.fingerprint,
						claimToken: winner.claimToken,
						destinationKeys: ["attachments/draft-save-claim/attachment/file.pdf"],
					},
				);
				assert.equal(recorded.recorded, true);
				const claimCommit = await request<{ status: string; draftVersion: number }>(
					"/upsert",
					{
						input: {
							...input(claimDraft.draftId),
							createKey: undefined,
							createFingerprint: undefined,
							expectedVersion: 1,
							saveKey: winner.saveKey,
							saveFingerprint: winner.fingerprint,
							saveClaimToken: winner.claimToken,
							subject: "Claimed edit",
						},
						actor: { kind: "user", id: "user-1" },
					},
				);
				assert.equal(claimCommit.status, "saved");
				assert.equal(claimCommit.draftVersion, 2);
				assert.equal(
					(await request<{ status: string }>("/save-outcome", {
						saveKey: winner.saveKey,
						fingerprint: winner.fingerprint,
					})).status,
					"committed",
				);

				const cleanupDraftId = "draft-committed-cleanup";
				const replacedKey =
					`attachments/${cleanupDraftId}/old-attachment/old.txt`;
				const stagingKey =
					"uploads/team@example.com/11111111-1111-4111-8111-111111111111";
				await request("/put-owned-object", {
					key: replacedKey,
					promotionOwner: "old-owner",
				});
				await request("/put-owned-object", {
					key: stagingKey,
					promotionOwner: "save-cleanup-token",
				});
				const cleanupDraft = await request<UpsertResult>("/upsert", {
					input: input(
						cleanupDraftId,
						"cleanup-create-fingerprint",
						"cleanup-create-key",
					),
					attachments: [{
						id: "old-attachment",
						email_id: cleanupDraftId,
						filename: "old.txt",
						mimetype: "text/plain",
						size: 3,
						r2_key: replacedKey,
					}],
					actor,
				});
				assert.equal(cleanupDraft.status, "saved");
				const cleanupClaim = {
					saveKey: "save-committed-cleanup",
					fingerprint: "fingerprint-save-committed-cleanup",
					draftId: cleanupDraftId,
					expectedVersion: 1,
					claimToken: "save-cleanup-token",
					claimExpiresAt: Date.now() + 300_000,
				};
				assert.equal(
					(await request<{ status: string }>("/claim-save", cleanupClaim)).status,
					"claimed",
				);
				const committedCleanup = await request<{
					result: { status: string; draftVersion: number };
					deletionOutbox: Array<{ r2Key: string; state: string }>;
				}>("/upsert-cleanup-state", {
					input: {
						...input(cleanupDraftId),
						createKey: undefined,
						createFingerprint: undefined,
						expectedVersion: 1,
						saveKey: cleanupClaim.saveKey,
						saveFingerprint: cleanupClaim.fingerprint,
						saveClaimToken: cleanupClaim.claimToken,
						stagingCleanupKeys: [stagingKey],
					},
					attachments: [],
					actor: { kind: "user", id: "user-1" },
				});
				assert.equal(committedCleanup.result.status, "saved");
				assert.equal(committedCleanup.result.draftVersion, 2);
				assert.deepEqual(committedCleanup.deletionOutbox, [
					{ r2Key: replacedKey, state: "pending" },
					{ r2Key: stagingKey, state: "pending" },
				]);
				await request("/run-alarm");
					for (const key of [replacedKey, stagingKey]) {
						assert.equal(
							(await request<{ exists: boolean }>("/object-exists", { key })).exists,
							false,
						);
					}

					const discardDraftId = "draft-atomic-discard-cleanup";
					const discardAttachmentKey =
						`attachments/${discardDraftId}/discard-attachment/private.txt`;
					const discardAttachmentKeyTwo =
						`attachments/${discardDraftId}/discard-attachment-two/private-two.txt`;
					for (const key of [discardAttachmentKey, discardAttachmentKeyTwo]) {
						await request("/put-owned-object", {
							key,
							promotionOwner: "discard-owner",
						});
					}
					assert.equal(
						(await request<UpsertResult>("/upsert", {
							input: input(
								discardDraftId,
								"discard-cleanup-create-fingerprint",
								"discard-cleanup-create-key",
							),
							attachments: [{
								id: "discard-attachment",
								email_id: discardDraftId,
								filename: "private.txt",
								mimetype: "text/plain",
								size: 3,
								r2_key: discardAttachmentKey,
							}, {
								id: "discard-attachment-two",
								email_id: discardDraftId,
								filename: "private-two.txt",
								mimetype: "text/plain",
								size: 3,
								r2_key: discardAttachmentKeyTwo,
							}],
							actor,
						})).status,
						"saved",
					);
					const discardedWithCleanup = await request<{
						result: { status: string };
						deletionOutbox: Array<{
							r2Key: string;
							emailId: string;
							state: string;
						}>;
						emailCount: number;
						attachmentCount: number;
						activities: Array<{
							actorKind: string;
							actorId: string;
							metadataJson: string;
						}>;
					}>("/discard-cleanup-state", {
						draftId: discardDraftId,
						draftVersion: 1,
						actor: { kind: "user", id: "user-1" },
					});
					assert.equal(discardedWithCleanup.result.status, "discarded");
					assert.deepEqual(discardedWithCleanup.deletionOutbox, [
						{
							r2Key: discardAttachmentKeyTwo,
							emailId: discardDraftId,
							state: "pending",
						},
						{
							r2Key: discardAttachmentKey,
							emailId: discardDraftId,
							state: "pending",
						},
					]);
					assert.equal(discardedWithCleanup.emailCount, 0);
					assert.equal(discardedWithCleanup.attachmentCount, 0);
					assert.deepEqual(discardedWithCleanup.activities, [{
						actorKind: "user",
						actorId: "user-1",
						metadataJson: JSON.stringify({ attachmentCount: 2 }),
					}]);
					await request("/clear-alarm");
					await request("/read-list-projections");
					const discardAlarm =
						(await request<{ alarm: number | null }>("/alarm-state")).alarm;
					const discardObjectBeforeManualAlarm =
						(await request<{ exists: boolean }>("/object-exists", {
							key: discardAttachmentKey,
						})).exists;
					assert.equal(
						typeof discardAlarm === "number" || !discardObjectBeforeManualAlarm,
						true,
					);
					if (discardObjectBeforeManualAlarm) await request("/run-alarm");
					for (const key of [discardAttachmentKey, discardAttachmentKeyTwo]) {
						assert.equal(
							(await request<{ exists: boolean }>("/object-exists", { key })).exists,
							false,
						);
					}

					const legacyCleanupKey =
						"attachments/legacy-cleanup/attachment/private.txt";
					await request("/put-owned-object", {
						key: legacyCleanupKey,
						promotionOwner: "legacy-owner",
					});
					await request("/queue-attachment-cleanup", {
						emailId: "legacy-cleanup",
						keys: [legacyCleanupKey],
					});
					await request("/clear-alarm");
					await request("/read-list-projections");
					const legacyAlarm =
						(await request<{ alarm: number | null }>("/alarm-state")).alarm;
					const legacyObjectBeforeManualAlarm =
						(await request<{ exists: boolean }>("/object-exists", {
							key: legacyCleanupKey,
						})).exists;
					assert.equal(
						typeof legacyAlarm === "number" || !legacyObjectBeforeManualAlarm,
						true,
					);
					if (legacyObjectBeforeManualAlarm) await request("/run-alarm");
					assert.equal(
						(await request<{ exists: boolean }>("/object-exists", {
							key: legacyCleanupKey,
						})).exists,
						false,
					);

					const emptyClaimDraftId = "draft-empty-abandoned-claim";
					assert.equal(
						(await request<UpsertResult>("/upsert", {
							input: input(
								emptyClaimDraftId,
								"empty-claim-create-fingerprint",
								"empty-claim-create-key",
							),
							actor,
						})).status,
						"saved",
					);
					const emptyClaim = {
						saveKey: "save-empty-abandoned-claim",
						fingerprint: "fingerprint-empty-abandoned-claim",
						draftId: emptyClaimDraftId,
						expectedVersion: 1,
						claimToken: "claim-empty-abandoned-claim",
						claimExpiresAt: Date.now() + 300_000,
					};
					await request("/clear-alarm");
					assert.equal(
						(await request<{ status: string }>("/claim-save", emptyClaim)).status,
						"claimed",
					);
					const emptyClaimAlarm =
						(await request<{ alarm: number | null }>("/alarm-state")).alarm;
					assert.equal(typeof emptyClaimAlarm, "number");
					assert.equal(emptyClaimAlarm! <= emptyClaim.claimExpiresAt, true);
					await request("/expire-save-claim", { saveKey: emptyClaim.saveKey });
					await request("/run-alarm");
					assert.equal(
						(await request<State & {
							saveOperations: Array<{ saveKey: string; state: string }>;
						}>("/state")).saveOperations.find(
							(operation) => operation.saveKey === emptyClaim.saveKey,
						)?.state,
						"aborted",
					);

					const abandonedCleanupKey =
						"attachments/draft-save-claim/abandoned-generation/file.pdf";
					const abandonedClaim = {
						saveKey: "save-abandoned-generation",
						fingerprint: "fingerprint-save-abandoned-generation",
						draftId: claimDraft.draftId,
						expectedVersion: 2,
						claimToken: "claim-abandoned-generation",
						claimExpiresAt: Date.now() + 300_000,
					};
					assert.equal(
						(await request<{ status: string }>(
							"/claim-save",
							abandonedClaim,
						)).status,
						"claimed",
					);
					assert.equal(
						(await request<{ recorded: boolean }>("/record-save-promotion", {
							saveKey: abandonedClaim.saveKey,
							fingerprint: abandonedClaim.fingerprint,
							claimToken: abandonedClaim.claimToken,
							destinationKeys: [abandonedCleanupKey],
						})).recorded,
						true,
					);
					await request("/put-owned-object", {
						key: abandonedCleanupKey,
						promotionOwner: abandonedClaim.claimToken,
					});
					await request("/expire-save-claim", {
						saveKey: abandonedClaim.saveKey,
					});
					await request("/clear-alarm");
					await request("/read-list-projections");
					assert.equal(
						typeof (await request<{ alarm: number | null }>("/alarm-state")).alarm,
						"number",
					);
					await request("/run-alarm");
					assert.equal(
						(await request<{ exists: boolean }>("/object-exists", {
							key: abandonedCleanupKey,
						})).exists,
						false,
					);
					const abandonedState = await request<State & {
						saveOperations: Array<{ saveKey: string; state: string }>;
					}>("/state");
					assert.equal(
						abandonedState.saveOperations.find(
							(operation) => operation.saveKey === abandonedClaim.saveKey,
						)?.state,
						"aborted",
					);

					const abortedCleanupKey =
					"attachments/draft-save-claim/aborted-generation/file.pdf";
				const abortedClaim = {
					saveKey: "save-aborted-generation",
					fingerprint: "fingerprint-save-aborted-generation",
					draftId: claimDraft.draftId,
					expectedVersion: 2,
					claimToken: "claim-aborted-generation",
					claimExpiresAt: Date.now() + 300_000,
				};
				assert.equal(
					(await request<{ status: string }>("/claim-save", abortedClaim)).status,
					"claimed",
				);
				assert.equal(
					(await request<{ recorded: boolean }>("/record-save-promotion", {
						saveKey: abortedClaim.saveKey,
						fingerprint: abortedClaim.fingerprint,
						claimToken: abortedClaim.claimToken,
						destinationKeys: [abortedCleanupKey],
					})).recorded,
					true,
				);
				await request("/put-owned-object", {
					key: abortedCleanupKey,
					promotionOwner: abortedClaim.claimToken,
				});
				assert.equal(
					(await request<{ status: string }>("/abort-save", abortedClaim)).status,
					"aborted",
				);
					state = await request<State & {
						cleanupIntents: Array<{
							claimToken: string;
							destinationKeys: string;
							state: string;
							generation: number;
							verifyUntil: number;
						}>;
					}>("/state");
					assert.deepEqual(state.deletionOutbox, []);
					const abortedCleanupIntent = state.cleanupIntents.find(
						(intent) => intent.claimToken === abortedClaim.claimToken,
					);
					assert.equal(abortedCleanupIntent?.destinationKeys, JSON.stringify([abortedCleanupKey]));
					assert.equal(abortedCleanupIntent?.state, "pending");
					assert.equal(abortedCleanupIntent?.generation, 0);
					assert.ok(
						(abortedCleanupIntent?.verifyUntil ?? 0) >= Date.now() + 29 * 24 * 60 * 60_000,
					);
				await request("/clear-alarm");
				assert.equal(
					(await request<{ alarm: number | null }>("/alarm-state")).alarm,
					null,
				);
				const selfHealCleanupKey =
					"attachments/draft-save-claim/self-heal/file.pdf";
				await request("/seed-r2-deletion", {
					r2Key: selfHealCleanupKey,
					emailId: claimDraft.draftId,
					nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
				});
				await request("/read-list-projections");
				assert.equal(
					typeof (await request<{ alarm: number | null }>("/alarm-state")).alarm,
					"number",
				);
				await request("/run-alarm");
				assert.equal(
					(await request<{ exists: boolean }>("/object-exists", {
						key: abortedCleanupKey,
					})).exists,
					false,
				);

				for (const terminal of ["discard", "consume", "delete"] as const) {
					const terminalDraft = await request<UpsertResult>("/upsert", {
						input: input(
							`save-terminal-${terminal}`,
							`save-terminal-create-${terminal}`,
							`save-terminal-create-key-${terminal}`,
						),
						actor,
					});
					assert.equal(terminalDraft.status, "saved");
					const terminalSave = {
						saveKey: `save-terminal-key-${terminal}`,
						fingerprint: `save-terminal-fingerprint-${terminal}`,
						draftId: terminalDraft.draftId,
						expectedVersion: 1,
						claimToken: `save-terminal-token-${terminal}`,
						claimExpiresAt: Date.now() + 300_000,
					};
					assert.equal(
						(await request<{ status: string }>("/claim-save", terminalSave)).status,
						"claimed",
					);
					const committed = await request<{ status: string; draftVersion: number }>(
						"/upsert",
						{
							input: {
								...input(terminalDraft.draftId),
								createKey: undefined,
								createFingerprint: undefined,
								expectedVersion: 1,
								saveKey: terminalSave.saveKey,
								saveFingerprint: terminalSave.fingerprint,
								saveClaimToken: terminalSave.claimToken,
							},
							actor: { kind: "user", id: "user-1" },
						},
					);
					assert.equal(committed.status, "saved");
					assert.equal(committed.draftVersion, 2);
					assert.equal(
						(await request<{ status: string }>(`/${terminal}`, {
							draftId: terminalDraft.draftId,
							...(terminal === "delete"
								? {}
								: {
										draftVersion: 2,
										actor: { kind: "user", id: "user-1" },
									}),
						})).status,
						terminal === "discard"
							? "discarded"
							: terminal === "consume"
								? "consumed"
								: "deleted",
					);
					const terminalReplay = await request<{ status: string; claimToken?: string }>(
						"/claim-save",
						{ ...terminalSave, claimToken: `late-${terminal}` },
					);
					assert.equal(terminalReplay.status, "committed");
					assert.equal(terminalReplay.claimToken, terminalSave.claimToken);
				}

				const expiredSaveKey = "save-expired-generation";
				const expiredFingerprint = `fingerprint-${expiredSaveKey}`;
				const oldClaim = {
					saveKey: expiredSaveKey,
					fingerprint: expiredFingerprint,
					draftId: claimDraft.draftId,
						expectedVersion: 2,
						claimToken: "claim-old",
						claimExpiresAt: Date.now() + 300_000,
				};
				assert.equal(
					(await request<{ status: string }>("/claim-save", oldClaim)).status,
					"claimed",
				);
				const expiredDestinationKey =
					"attachments/draft-save-claim/expired-generation/file.pdf";
				assert.equal(
					(await request<{ recorded: boolean }>("/record-save-promotion", {
						saveKey: oldClaim.saveKey,
						fingerprint: oldClaim.fingerprint,
						claimToken: oldClaim.claimToken,
						destinationKeys: [expiredDestinationKey],
					})).recorded,
						true,
					);
					await request("/expire-save-claim", { saveKey: oldClaim.saveKey });
					const replacementClaim = {
					...oldClaim,
					claimToken: "claim-new",
					claimExpiresAt: Date.now() + 300_000,
				};
				assert.equal(
					(await request<{ status: string }>("/claim-save", replacementClaim)).status,
					"claimed",
				);
				let cleanupState = await request<State & {
					cleanupIntents: Array<{ claimToken: string; attempts: number }>;
				}>("/state");
				assert.equal(
					cleanupState.cleanupIntents.some((intent) =>
						intent.claimToken === oldClaim.claimToken,
					),
					true,
				);
				await request("/clear-alarm");
				await request("/expire-save-claim", {
					saveKey: replacementClaim.saveKey,
				});
				const emptySuccessorClaim = {
					...replacementClaim,
					claimToken: "claim-newer-empty",
					claimExpiresAt: Date.now() + 300_000,
				};
				assert.equal(
					(await request<{ status: string }>(
						"/claim-save",
						emptySuccessorClaim,
					)).status,
					"claimed",
				);
				assert.equal(
					typeof (await request<{ alarm: number | null }>("/alarm-state")).alarm,
					"number",
				);
				await request("/clear-alarm");
				await request("/read-list-projections");
				assert.equal(
					typeof (await request<{ alarm: number | null }>("/alarm-state")).alarm,
					"number",
				);
				await request("/make-cleanup-due", { claimToken: oldClaim.claimToken });
				await request("/run-alarm");
				await request("/put-owned-object", {
					key: expiredDestinationKey,
					promotionOwner: oldClaim.claimToken,
				});
				assert.equal(
					(await request<{ exists: boolean }>("/object-exists", {
						key: expiredDestinationKey,
					})).exists,
					true,
				);
				await request("/make-cleanup-due", { claimToken: oldClaim.claimToken });
				await request("/run-alarm");
				assert.equal(
					(await request<{ exists: boolean }>("/object-exists", {
						key: expiredDestinationKey,
					})).exists,
					false,
				);
				cleanupState = await request<State & {
					cleanupIntents: Array<{ claimToken: string; attempts: number }>;
				}>("/state");
				assert.equal(
					cleanupState.cleanupIntents.find((intent) =>
						intent.claimToken === oldClaim.claimToken,
					)?.attempts,
					2,
				);
				const staleCommit = await request<{ status: string }>("/upsert", {
					input: {
						...input(claimDraft.draftId),
						createKey: undefined,
						createFingerprint: undefined,
						expectedVersion: 2,
						saveKey: expiredSaveKey,
						saveFingerprint: expiredFingerprint,
						saveClaimToken: "claim-old",
					},
					actor: { kind: "user", id: "user-1" },
				});
				assert.equal(staleCommit.status, "save_claim_lost");

				const oldUpdatedAt = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
				const recentUpdatedAt = new Date(Date.now() - 29 * 24 * 60 * 60_000).toISOString();
				await request("/seed-save-operations", {
					count: 101,
					state: "committed",
					updatedAt: oldUpdatedAt,
					prefix: "expired-terminal",
				});
				await request("/seed-save-operations", {
					count: 1,
					state: "committed",
					updatedAt: recentUpdatedAt,
					prefix: "recent-terminal",
				});
				await request("/seed-save-operations", {
					count: 1,
					state: "claimed",
					updatedAt: oldUpdatedAt,
					prefix: "active-claim",
				});
				await request("/claim-save", {
					saveKey: "retention-trigger-1",
					fingerprint: "retention-trigger-1",
					draftId: "retention-trigger-draft-1",
					expectedVersion: 0,
					claimToken: "retention-token-1",
					claimExpiresAt: Date.now() + 300_000,
				});
				state = await request<State & { saveOperations: Array<{ saveKey: string }> }>("/state");
				assert.equal(
					state.saveOperations.filter((operation) =>
						operation.saveKey.startsWith("expired-terminal-"),
					).length,
					1,
				);
				assert.equal(
					state.saveOperations.some((operation) => operation.saveKey === "recent-terminal-0"),
					true,
				);
				assert.equal(
					state.saveOperations.some((operation) => operation.saveKey === "active-claim-0"),
					true,
				);

				const retentionReference = Date.now();
				const retentionWindow = 30 * 24 * 60 * 60_000;
				await request("/seed-save-operations", {
					count: 1,
					state: "committed",
					updatedAt: new Date(retentionReference - retentionWindow + 60_000).toISOString(),
					prefix: "inside-boundary",
				});
				await request("/seed-save-operations", {
					count: 1,
					state: "committed",
					updatedAt: new Date(retentionReference - retentionWindow).toISOString(),
					prefix: "exact-boundary",
				});
				await request("/seed-save-operations", {
					count: 1,
					state: "committed",
					updatedAt: new Date(retentionReference - retentionWindow - 60_000).toISOString(),
					prefix: "outside-boundary",
				});
				await request("/claim-save", {
					saveKey: "retention-trigger-2",
					fingerprint: "retention-trigger-2",
					draftId: "retention-trigger-draft-2",
					expectedVersion: 0,
					claimToken: "retention-token-2",
					claimExpiresAt: Date.now() + 300_000,
				});
				state = await request<State & { saveOperations: Array<{ saveKey: string }> }>("/state");
				assert.equal(
					state.saveOperations.some((operation) => operation.saveKey === "inside-boundary-0"),
					true,
				);
				assert.equal(
					state.saveOperations.some((operation) => operation.saveKey === "exact-boundary-0"),
					false,
				);
				assert.equal(
					state.saveOperations.some((operation) => operation.saveKey === "outside-boundary-0"),
					false,
				);

				const updateSource = await request<UpsertResult>("/upsert", {
					input: input(
						"draft-update-source",
						"draft-update-create-fingerprint",
						"draft-update-create-key",
					),
					actor,
				});
				assert.equal(updateSource.status, "saved");
				const updateOperation = {
					updateKey: "draft-update-operation-1",
					fingerprint: "draft-update-fingerprint-1",
					draftId: updateSource.draftId,
					expectedVersion: 1,
					changes: {
						recipient: "Updated@Example.com",
						subject: "Updated subject",
						body: "<p>Updated body</p>",
					},
					actor: { kind: "mcp" as const, id: "user-1" },
				};
				const [firstUpdate, secondUpdate] = await Promise.all([
					request<{ status: string; draftVersion: number }>(
						"/update-idempotent",
						updateOperation,
					),
					request<{ status: string; draftVersion: number }>(
						"/update-idempotent",
						updateOperation,
					),
				]);
				assert.deepEqual(
					[firstUpdate.status, secondUpdate.status].sort(),
					["replay", "updated"],
				);
				assert.equal(firstUpdate.draftVersion, 2);
				assert.equal(secondUpdate.draftVersion, 2);
				let updateState = await request<State & {
					updateOperations: Array<{
						updateKey: string;
						draftId: string;
						previousVersion: number;
						resultVersion: number;
					}>;
				}>("/state");
				assert.deepEqual(updateState.updateOperations, [{
					updateKey: updateOperation.updateKey,
					draftId: updateOperation.draftId,
					fingerprint: updateOperation.fingerprint,
					previousVersion: 1,
					resultVersion: 2,
				}]);
				assert.equal(
					updateState.activities.filter((activity) =>
						activity.entityId === updateOperation.draftId,
					).length,
					2,
				);
				assert.equal(
					(await request<{ status: string }>("/update-idempotent", {
						...updateOperation,
						fingerprint: "changed-fingerprint",
					})).status,
					"idempotency_conflict",
				);
				const staleNewInvocation = await request<{
					status: string;
					currentVersion: number;
				}>("/update-idempotent", {
					...updateOperation,
					updateKey: "draft-update-operation-2",
					fingerprint: "draft-update-fingerprint-2",
				});
				assert.equal(staleNewInvocation.status, "version_conflict");
				assert.equal(staleNewInvocation.currentVersion, 2);
				assert.equal(
					(await request<{ status: string }>("/delete", {
						draftId: updateOperation.draftId,
					})).status,
					"deleted",
				);
				const replayAfterDelete = await request<{
					status: string;
					draftVersion: number;
				}>("/update-idempotent", updateOperation);
				assert.equal(replayAfterDelete.status, "replay");
				assert.equal(replayAfterDelete.draftVersion, 2);
				updateState = await request<typeof updateState>("/state");
				assert.equal(updateState.updateOperations.length, 1);
					assert.equal(
						updateState.emails.some((email) =>
							email.id === updateOperation.draftId,
						),
						false,
					);

					const corruptionMailbox = "draft-corruption@example.com";
					const corruptUpdatedAt = new Date().toISOString();
					const validCorruptionKey =
						"attachments/draft-corruption/valid/file.pdf";
					await requestForMailbox(corruptionMailbox, "/seed-save-operations", {
						count: 1,
						state: "claimed",
						updatedAt: corruptUpdatedAt,
						prefix: "a-corrupt-expired",
						claimExpiresAt: Date.now() - 1,
						destinationKeys: "{malformed",
					});
					await requestForMailbox(corruptionMailbox, "/seed-save-operations", {
						count: 1,
						state: "claimed",
						updatedAt: corruptUpdatedAt,
						prefix: "z-valid-expired",
						claimExpiresAt: Date.now() - 1,
						destinationKeys: JSON.stringify([validCorruptionKey]),
					});
					await requestForMailbox(corruptionMailbox, "/put-owned-object", {
						key: validCorruptionKey,
						promotionOwner: "token-z-valid-expired-0",
					});
					await requestForMailbox(corruptionMailbox, "/run-alarm-and-clear");
					let corruptionState = await requestForMailbox<{
						saveOperations: Array<{ saveKey: string; state: string }>;
							cleanupIntents: Array<{
								claimToken: string;
								destinationKeys: string;
								attempts: number;
								state: string;
								generation: number;
								lastErrorCode: string | null;
							}>;
					}>(corruptionMailbox, "/state");
					assert.deepEqual(
						corruptionState.saveOperations.map(({ saveKey, state }) => ({
							saveKey,
							state,
						})),
						[
							{ saveKey: "a-corrupt-expired-0", state: "aborted" },
							{ saveKey: "z-valid-expired-0", state: "aborted" },
						],
					);
					const corruptIntent = corruptionState.cleanupIntents.find(
						(intent) => intent.claimToken === "token-a-corrupt-expired-0",
					);
						assert.equal(corruptIntent?.destinationKeys, "{malformed");
						assert.equal(corruptIntent?.attempts, 0);
						assert.equal(corruptIntent?.state, "parked");
						assert.equal(corruptIntent?.generation, 0);
						assert.equal(
							corruptIntent?.lastErrorCode,
							"draft_save_destination_plan_invalid",
						);
						const parked = await requestForMailbox<{
							items: Array<{ claimToken: string; generation: number }>;
						}>(corruptionMailbox, "/list-parked-save-cleanup");
						assert.deepEqual(
							parked.items.map(({ claimToken, generation }) => ({
								claimToken,
								generation,
							})),
							[{
								claimToken: "token-a-corrupt-expired-0",
								generation: 0,
							}],
						);
					await requestForMailbox(corruptionMailbox, "/run-alarm-and-clear");
						assert.equal(
						(await requestForMailbox<{ exists: boolean }>(
							corruptionMailbox,
							"/object-exists",
							{ key: validCorruptionKey },
						)).exists,
						false,
					);
					corruptionState = await requestForMailbox(
						corruptionMailbox,
						"/state",
					);
					assert.equal(
						corruptionState.cleanupIntents.some(
							(intent) => intent.claimToken === "token-a-corrupt-expired-0",
						),
							true,
						);
						const repairedKey =
							"attachments/draft-a-corrupt-expired-0/recovered/file.pdf";
						await requestForMailbox(corruptionMailbox, "/put-owned-object", {
							key: repairedKey,
							promotionOwner: "token-a-corrupt-expired-0",
						});
						assert.deepEqual(
							await requestForMailbox(corruptionMailbox, "/repair-parked-save-cleanup", {
								claimToken: "token-a-corrupt-expired-0",
								expectedGeneration: 0,
								destinationKeys: [repairedKey],
							}),
							{ status: "repaired", generation: 1 },
						);
						await requestForMailbox(corruptionMailbox, "/run-alarm-and-clear");
						assert.equal(
							(await requestForMailbox<{ exists: boolean }>(
								corruptionMailbox,
								"/object-exists",
								{ key: repairedKey },
							)).exists,
							false,
						);

					const batchMailbox = "draft-expiry-batch@example.com";
					const batchUpdatedAt = new Date().toISOString();
					await requestForMailbox(batchMailbox, "/seed-save-operations", {
						count: 101,
						state: "claimed",
						updatedAt: batchUpdatedAt,
						prefix: "expired-batch",
						claimExpiresAt: Date.now() - 1,
					});
					await requestForMailbox(batchMailbox, "/seed-save-operations", {
						count: 1,
						state: "claimed",
						updatedAt: batchUpdatedAt,
						prefix: "future-batch",
						claimExpiresAt: Date.now() + 300_000,
					});
					await requestForMailbox(batchMailbox, "/run-alarm-and-clear");
					let batchState = await requestForMailbox<{
						saveOperations: Array<{ saveKey: string; state: string }>;
					}>(batchMailbox, "/state");
					assert.equal(
						batchState.saveOperations.filter(({ state }) => state === "aborted").length,
						100,
					);
					assert.equal(
						batchState.saveOperations.filter(({ state }) => state === "claimed").length,
						2,
					);
					await requestForMailbox(batchMailbox, "/run-alarm-and-clear");
					batchState = await requestForMailbox(batchMailbox, "/state");
					assert.equal(
						batchState.saveOperations.filter(({ state }) => state === "aborted").length,
						101,
					);
					assert.equal(
						batchState.saveOperations.find(
							({ state }) => state === "claimed",
						)?.saveKey,
						"future-batch-0",
					);
				} finally {
			await runtime?.dispose();
			await rm(outputDirectory, { recursive: true, force: true });
		}
	},
);
