// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import {
  eq,
  and,
  or,
  asc,
  desc,
	gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  Folders,
  InternalFolders,
  isInternalFolderId,
} from "../../shared/folders";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";
import { dispatchPreparedSesSend, prepareSesSend } from "../email-sender";
import {
  generateMessageId,
  buildThreadToken,
  buildThreadingHeaders,
} from "../lib/email-helpers";
import {
  arrayBufferToBase64,
  attachmentSha256,
  attachmentKey,
  attachmentKeyPrefix,
  storedAttachmentKey,
  outboundAttachmentByteIdentities,
  outboundAttachmentBytesMatch,
  uploadKey,
} from "../lib/attachments";
import type {
  InboundDerivedContentManifest,
  InboundDerivedContentRepairAttemptIdentity,
  InboundDerivedContentRepairAttemptTerminal,
  InboundDerivedContentRepairCommand,
  InboundDerivedContentRepairResult,
  DirectInboundAuthority,
  DirectInboundProjectionCommand,
  InboundArchiveAuthority,
  InboundProjectionCommand,
  InboundProjectionResult,
  StoredEmailBodyObject,
} from "../lib/inbound-projection-contract.ts";
import { isInboundRawKeyForIngress } from "../lib/inbound-raw-key.ts";
import { inboundDerivedContentRepairCommandFingerprint } from "../lib/inbound-derived-content-repair-attempt.ts";
import {
  classifyInboundDerivedContentCleanup,
  classifyInboundProjectionDerivedContent,
  projectionAttemptIdFromDerivedContentKey,
  validateInboundDerivedContentCleanupProof,
  validateInboundDerivedContentProjectionProof,
  validateInboundDerivedContentCleanupRequest,
  type InboundDerivedContentCleanupCandidate,
  type InboundDerivedContentCleanupInput,
} from "../lib/inbound-derived-content-cleanup.ts";
import { safeAttachmentStorageFilename } from "../../shared/attachment-filename.ts";
import { isCanonicalAttachmentUploadId } from "../lib/attachment-upload-id.ts";
import {
  ATTACHMENT_LIMITS,
  validateAttachmentSet,
} from "../../shared/attachments";
// Shared with push notifications: both surfaces reduce the same raw-HTML body
// to one line of human text, so they must agree on what counts as prose.
import { htmlToSnippet } from "../lib/push/payload";
import {
  hasAttachmentsSql,
  SENDER_DISPLAY_SQL,
  SNIPPET_LENGTH,
  snippetSourceSql,
} from "../lib/list-projection";
import { vapidConfig } from "../lib/push/transport";
import { sendWebPush } from "../lib/push/send";
import type { PushPayload } from "../lib/push/types";
import {
  enqueuePushNotification,
  processPushOutbox,
  readPushHealth,
} from "../lib/push/outbox.ts";
import type { ActivityActor } from "../lib/activity";
import {
  buildMailSearchPlan,
  type MailSearchOptions,
} from "../lib/mail-search";
import {
  outboundDeliveryBlocksGenericLifecycle,
  planMove,
  planTrash,
  resolveRestoreFolder,
} from "../lib/email-lifecycle";
import { mailboxAccess } from "../lib/mailbox-access";
import {
  prepareRecoveredDraftAttachments,
  recoveredDraftId,
  sourceDraftMatchesSnapshot,
} from "../lib/cancelled-outbound-recovery";
import {
  nextBulkEnqueueAt,
  cancellationRecoveryPending,
  planCancelledOutboundRecovery,
  planDispatchQuota,
} from "../lib/outbound-dispatch-policy";
import {
  classifySesOutcome,
  type EnqueueOutboundCommand,
  type OutboundAttachmentByteIdentity,
  type OutboundDeliveryActor,
  type OutboundDeliveryStatus,
} from "../lib/outbound-delivery-contract";
import { CONVERSATION_ID_SQL } from "../lib/conversation-identity";
import {
	aggregateAcceptedAttemptProviderTruth,
	canReconcileConcurrentProviderTerminal,
  assertOutboundCommandFingerprint,
  classifyOutboundReplay,
  OutboundIdempotencyConflictError,
  OutboundRetryCapacityError,
  TruthfulOutboxService,
  type EnqueuedDelivery,
  type StoredOutboundDelivery,
} from "../lib/outbound-delivery-service";
import {
  DurableObjectOutboundDeliveryStorage,
  deserializeOutboundSnapshot,
	isCanonicalUtcTimestamp,
  type PendingOutboundAttachment,
} from "./outbound-storage";
import {
  executeBatchTriage,
  type BatchTriageRepository,
} from "./batch-triage.ts";
import {
  isBatchTriageActionAllowed,
  type BatchTriageCommand,
} from "../../shared/batch-triage.ts";
import { planBulkEnqueueReconciliation } from "../lib/outbound-enqueue-recovery.ts";
import { withOutboundCommandFingerprint } from "../lib/outbound-command-fingerprint.ts";
import {
  bulkCleanupBacklogCount,
  bulkCleanupNextAt,
  completeBulkCleanupClaim,
  planBulkCleanupClaim,
  retryBulkCleanupClaim,
  type BulkCleanupIntent,
} from "../lib/bulk-cleanup-intent.ts";
import {
  bulkAdmissionFingerprint,
  bulkAttachmentPreparationKey,
  bulkPersonalizedHtmlValidationError,
  BulkRecipientAttachmentUnavailableError,
  bulkNextUtcDayAt,
  BULK_JOB_ID_PATTERN,
  BULK_OPERATION_ID_PATTERN,
  BULK_LIMITS,
  BULK_PREPARATION_MAX_AGE_MS,
  BULK_STALE_WRITER_VERIFY_MS,
  completeBulkAdmission,
  ensureBulkQueueMembership,
  failBulkAdmission,
  planBulkDailyAdmission,
  planBulkDailyReservation,
  planBulkAdmissionReservation,
  planBulkAdmissionClaim,
  planBulkRecipientEnqueueDisposition,
  renderBulkTemplate,
  removeBulkQueueMembership,
  type BulkAdmissionRecord,
  type BulkAdmissionReservation,
  type BulkDailyAdmissionRecord,
  type BulkDailyReservationRecord,
  type BulkEnqueueResult,
  type BulkReservationResult,
} from "../lib/bulk-job-admission.ts";
import { mailboxSendCutoffs } from "../lib/send-rate-limit.ts";
import {
  finalizeCommittedOutboundMutation,
  runOutboundAlarmLane,
} from "../lib/outbound-liveness.ts";
import {
  validateLabelDefinition,
  validateLabelMutationTargets,
  type LabelMutationTarget,
} from "../lib/labels.ts";
import { resourceCreateReplayCutoff } from "../lib/resource-create-idempotency.ts";
import {
  earliestMailboxAlarm,
  normalizeSnoozeRequest,
  normalizeSnoozeScope,
  planDueSnoozeWake,
  snoozeBlocksGenericMove,
} from "../lib/snooze.ts";
import {
  executeSnooze,
  executeUnsnooze,
  type SnoozeRepository,
} from "./snooze-state.ts";
import { finalizeCommittedSnooze } from "../lib/snooze-liveness.ts";
import { resolveUnambiguousThreadReference } from "../lib/thread-reference.ts";
import { readConversationIntelligenceEvidenceProjection } from "../lib/conversation-intelligence-evidence.ts";
import { projectInboxTriageCandidates } from "../lib/inbox-triage-candidates.ts";
import { readConversationActivityProjection } from "../lib/conversation-activity.ts";
import { readAiSearchInterpreterCatalog } from "../lib/ai-search-interpreter-catalog.ts";
import {
  validateNormalizedInboxTriageSuggestionRequest,
  type NormalizedInboxTriageSuggestionRequest,
} from "../../shared/inbox-triage-suggestions.ts";
import { readStoredReminderAnchor } from "../lib/follow-up-reminder-anchor.ts";
import { readFollowUpReminderPreviews } from "../lib/follow-up-reminder-previews.ts";
import { followUpReminderD1Store } from "../lib/follow-up-reminders-d1.ts";
import {
  InlineImageMappingError,
  validateResolvedInlineImages,
} from "../lib/inline-image-authority.ts";
import {
  processOneFollowUpReplyCompletion,
  type FollowUpReplyQueueRepository,
} from "../lib/follow-up-reminder-queue.ts";
import {
  readRecipientSuggestions,
  recipientMemoryFolderEligible,
  recordRecipientInteractions,
  seedRecipientInteractions,
  storedEmailInteraction,
} from "../lib/recipient-memory.ts";
import {
  RecipientMemoryOrigins,
  type RecipientMemoryOrigin,
} from "../../shared/recipient-suggestions.ts";
import { classifyDraftCreateReplay } from "../lib/draft-create-replay.ts";
import {
  readGlobalTodayBriefEvidence,
  readGlobalTodayBriefMetadata,
  readTodayBriefCandidates,
  type GlobalTodayBriefEvidenceRequest,
} from "../lib/today-brief-candidates.ts";
import { readGlobalTodayMailboxSnapshot } from "../lib/global-today-mailbox-snapshot.ts";
import type { FollowUpReminder } from "../../shared/follow-up-reminders.ts";
import {
  validateNormalizedMailboxAttachmentListOptions,
  type NormalizedMailboxAttachmentListOptions,
} from "../../shared/mailbox-attachments.ts";
import {
  claimImportedEmail as claimImportedEmailRecord,
  releaseImportedEmailClaim as releaseImportedEmailClaimRecord,
  renewImportedEmailClaim as renewImportedEmailClaimRecord,
} from "../lib/import-email-claims.ts";
import {
  advanceImportPromotionFingerprint,
  appendImportPromotionIntent,
  beginImportPromotionIntent,
  importPromotionInitialFingerprint,
  readImportPromotionAppendSnapshot,
  sealImportPromotionIntent,
  type ImportPromotionObject,
} from "../lib/import-promotion-intent.ts";
import {
  readMailboxAttachmentDetail,
  readMailboxAttachmentForEmail,
  readMailboxAttachmentPage,
} from "../lib/mailbox-attachments.ts";
import {
  readMailboxChanges,
  readMailboxCurrentSequence,
} from "../lib/mailbox-change-feed.ts";
import {
  validateNormalizedMailboxChangeQuery,
  type NormalizedMailboxChangeQuery,
} from "../../shared/mailbox-change-feed.ts";
import { createMailPeopleProjector } from "../lib/people/index.ts";
import type {
  NormalizedMailPeopleListQuery,
  NormalizedMailPersonTimelineQuery,
} from "../../shared/mail-people.ts";
import {
  validateMailPersonId,
  validateNormalizedMailPeopleListQuery,
  validateNormalizedMailPersonTimelineQuery,
} from "../../shared/mail-people.ts";
import { normalizeMailAddress } from "../lib/mail-address.ts";
import { readRelationshipBriefEvidence } from "../lib/relationship-brief-evidence.ts";
import { AUTOMATION_RUN_STATES } from "../../shared/automation-rules.ts";
import {
  AutomationRuleError,
  createAutomationRulesModule,
  type AutomationRuleVersionRecord,
  type AutomationRuleRecord,
  type AutomationDryRunRecord,
  type AutomationRunRecord,
} from "../lib/automation-rules/index.ts";
import {
  applyAutomationActionPlan,
  readAutomationDryRunContexts,
  readAutomationPlanningContext,
} from "../lib/automation-rules/mailbox-runtime.ts";
import {
  createSemanticIndex,
  type SemanticIndexReadiness,
} from "../lib/semantic-index.ts";
import { advanceSemanticMailboxIndex } from "../lib/semantic-index-runtime.ts";
import { createSemanticIndexProvider } from "../lib/semantic-provider.ts";
import { createWorkersAiSemanticRichDocumentConverter } from "../lib/semantic-attachment-converter.ts";
import { semanticMailboxNamespace } from "../lib/semantic-search.ts";
import { isSemanticSearchEnabled } from "../lib/features.ts";
import { resolveBrand } from "../routes/brand.ts";

class OutboundAttachmentIntegrityError extends Error {
  constructor(
    readonly code:
      | "snapshot_missing"
      | "attachment_missing"
      | "attachment_metadata_mismatch"
      | "attachment_size_mismatch"
      | "attachment_integrity_unverifiable"
      | "attachment_content_mismatch",
  ) {
    super(code);
    this.name = "OutboundAttachmentIntegrityError";
  }
}

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

const ALLOWED_SORT_COLUMNS = [
  "id",
  "subject",
  "sender",
  "recipient",
  "date",
  "read",
  "starred",
] as const;

const SEMANTIC_SCHEDULER_MAILBOX_KEY = "semantic:index:mailbox";
const SEMANTIC_SCHEDULER_FAILURES_KEY = "semantic:index:failures";
const SEMANTIC_SCHEDULER_MAX_FAILURES = 5;

function semanticSchedulerErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "unknown";
  return `scheduler_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`.slice(
    0,
    64,
  );
}

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
  id: schema.emails.id,
  subject: schema.emails.subject,
  sender: schema.emails.sender,
  recipient: schema.emails.recipient,
  date: schema.emails.date,
  read: schema.emails.read,
  starred: schema.emails.starred,
} satisfies Record<
  SortColumn,
  (typeof schema.emails)[keyof typeof schema.emails]
>;

interface GetEmailsOptions {
  folder?: string;
  label_id?: string;
  thread_id?: string;
  page?: number;
  limit?: number;
  sortColumn?: SortColumn;
  sortDirection?: "ASC" | "DESC";
}

interface EmailData {
  id: string;
  subject: string;
  sender: string;
  sender_name?: string | null;
  recipient: string;
  cc?: string | null;
  bcc?: string | null;
  date: string;
  body: string;
  read?: boolean;
  starred?: boolean;
  in_reply_to?: string | null;
  email_references?: string | null;
  thread_id?: string | null;
  message_id?: string | null;
  raw_headers?: string | null;
  recipient_memory_origin?: RecipientMemoryOrigin | null;
  snooze_wake_thread_id?: string | null;
  follow_up_reply_mailbox_address?: string | null;
  automation_trigger?: "live_inbound";
  push_notification?: PushPayload;
}

interface AttachmentData {
  id: string;
  email_id: string;
  filename: string;
  mimetype: string;
  size: number;
  content_id?: string | null;
  disposition?: string | null;
  r2_key?: string | null;
}

type EmailDeletionArtifacts = {
  attachments: Array<{
    id: string;
    email_id: string;
    filename: string;
    r2_key: string | null;
  }>;
  bodyObjects: StoredEmailBodyObject[];
};

// ── Bulk send (mail merge, F-06) ───────────────────────────────────

const ATTACHMENT_CLEANUP_QUEUE_KEY = "attachment-cleanup:queue";
const DRAFT_SAVE_REPLAY_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DRAFT_SAVE_PRUNE_BATCH = 100;
const DRAFT_SAVE_EXPIRY_SWEEP_BATCH = 100;
const DRAFT_SAVE_CLEANUP_INITIAL_DELAY_MS = 5 * 60_000;
const DRAFT_SAVE_CLEANUP_MAX_DELAY_MS = 24 * 60 * 60_000;

type DraftSaveDestinationPlan =
  | { ok: true; keys: string[] }
  | { ok: false; code: "draft_save_destination_plan_invalid" };

function decodeDraftSaveDestinationPlan(
  value: string,
): DraftSaveDestinationPlan {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length > ATTACHMENT_LIMITS.maxFiles ||
      parsed.some((key) => typeof key !== "string" || key.length === 0)
    ) {
      return { ok: false, code: "draft_save_destination_plan_invalid" };
    }
    const keys = parsed as string[];
    if (new Set(keys).size !== keys.length) {
      return { ok: false, code: "draft_save_destination_plan_invalid" };
    }
    return { ok: true, keys };
  } catch {
    return { ok: false, code: "draft_save_destination_plan_invalid" };
  }
}

async function privacySafeRecipientHash(address: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(address.trim().toLowerCase()),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type AttachmentCleanupJob = {
  id: string;
  emailId: string;
  keys: string[];
  promotionOwner?: string;
  attempts: number;
  createdAt: number;
  state?: "pending" | "parked";
  generation?: number;
  nextAttemptAt?: number;
  lastErrorCode?: string;
  parkedAt?: number;
};
const BULK_QUEUE_KEY = "bulk:queue";
const BULK_ACTIVE_KEY = "bulk:active";
const BULK_TERMINAL_HISTORY_KEY = "bulk:terminal-history";
const BULK_DAILY_ADMISSION_KEY = "bulk:daily-admission";
const BULK_DAILY_RESERVATION_KEY = "bulk:daily-reservation";
const BULK_DAILY_RESERVATION_ACTOR_PREFIX = "bulk:daily-reservation:actor:";
const BULK_RESERVATION_PREFIX = "bulk:reservation:";
const BULK_ATTACHMENT_CLEANUP_PREFIX = "bulk:attachment-cleanup:";
const BULK_RECIPIENT_PREPARATION_PREFIX = "bulk:recipient-preparation:";
const SAFE_BULK_ERRORS = new Set([
  "An attachment upload was not found or has expired. Re-attach and try again.",
  "Bulk attachments could not be prepared. Re-attach them and try again.",
  "Bulk job preparation expired. Start a new submission.",
  "Job cancelled because the initiating user's mailbox access ended.",
  "Recipient could not be queued.",
]);

type BulkRecipient = Record<string, string>; // must include `email`

/** One shared attachment for a bulk job: its immutable raw bytes live in R2. */
interface BulkAttachment {
  key: string; // R2 key holding immutable raw bytes
  filename: string;
  type: string;
  size: number;
  contentSha256: string;
}

interface BulkJob {
  id: string;
  operationId: string;
  status: "preparing" | "queued" | "running" | "done" | "failed" | "cancelled";
  actorUserId: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  html?: string;
  text?: string;
  total: number;
  /** Recipient rows durably accepted into the truthful outbox. */
  enqueued: number;
  /** Legacy pre-Outbox counter, read only while an in-flight job upgrades. */
  sent?: number;
  failed: number;
  cursor: number;
  errors: { email: string; error: string }[];
  createdAt: number;
  updatedAt: number;
  /** Earliest time another recipient may be accepted into the outbox. */
  nextEnqueueAt?: number;
  /** Shared attachments delivered to every recipient (manifest only; bytes in R2). */
  attachments?: BulkAttachment[];
  /** Original upload objects retained until the fenced admission commit. */
  preparationAttachmentKeys?: string[];
  /** Cleanup authority for the alarm-owned generation copy. */
  preparationCleanupIntentId?: string;
  preparationGeneration?: number;
}

type BulkActiveEntry = {
  jobId: string;
  admissionKey: string;
  total: number;
  createdAt: number;
};

type BulkTerminalEntry = {
  jobId: string;
  admissionKey: string;
  completedAt: number;
};

type BulkRecipientPreparation = {
  jobId: string;
  cursor: number;
  idempotencyKey: string;
  messageId: string;
  attachments: PendingOutboundAttachment[];
  keys: string[];
  cleanupIntentId: string;
  createdAt: number;
};

type BulkJobProgress = Pick<
  BulkJob,
  | "id"
  | "status"
  | "total"
  | "enqueued"
  | "failed"
  | "cursor"
  | "createdAt"
  | "updatedAt"
> & {
  errors: Array<{ email: string; error: string }>;
  errorCount: number;
  errorsTruncated: boolean;
};

const MAX_DO_SQL_BOUND_PARAMETERS = 100;
const R2_DELETION_BATCH_SIZE = 100;
const R2_DELETION_LEASE_MS = 5 * 60 * 1_000;
const RETIRED_PROJECTION_ATTEMPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const R2_CLAIM_KEY_CHUNK_SIZE = 48;
const R2_ATTEMPT_FENCE_INSERT_CHUNK_SIZE = 18;
const R2_LEGACY_FENCE_INSERT_CHUNK_SIZE = 24;
const IMPORT_PROMOTION_RECONCILE_BATCH_SIZE = 20;
const IMPORT_PROMOTION_LEASE_MS = 5 * 60_000;
const IMPORT_PROMOTION_ABANDONED_WATCH_MS = 24 * 60 * 60_000;

function sqlParameterChunks<T>(
  values: readonly T[],
  maximum = MAX_DO_SQL_BOUND_PARAMETERS,
): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += maximum) {
    chunks.push(values.slice(offset, offset + maximum));
  }
  return chunks;
}

function insertSqliteRowsBounded<T>(
  rows: readonly T[],
  maximumBindingsPerRow: number,
  insert: (chunk: T[]) => void,
): void {
  const rowsPerStatement = Math.max(
    1,
    Math.floor(MAX_DO_SQL_BOUND_PARAMETERS / maximumBindingsPerRow),
  );
  for (const chunk of sqlParameterChunks(rows, rowsPerStatement)) insert(chunk);
}

function assertInboundProjectionDeadlineIsActive(
  projectionExpiresAt: number | undefined,
): void {
  if (projectionExpiresAt === undefined) return;
  if (
    !Number.isSafeInteger(projectionExpiresAt) ||
    projectionExpiresAt <= Date.now()
  ) {
    throw Object.assign(new Error("Inbound projection command expired"), {
      code: "INBOUND_PROJECTION_EXPIRED",
    });
  }
}

export class MailboxDO extends DurableObject<Env> {
  declare __DURABLE_OBJECT_BRAND: never;
  db: ReturnType<typeof drizzle>;
  #semanticPreparation: Promise<SemanticIndexReadiness> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.db = drizzle(this.ctx.storage, { schema });
    applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
  }

  protected headR2Object(r2Key: string): Promise<R2Object | null> {
    return this.env.BUCKET.head(r2Key);
  }

  #automationRules() {
    return createAutomationRulesModule({
      storage: {
        sql: this.ctx.storage.sql,
        transactionSync: (run) => this.ctx.storage.transactionSync(run),
      },
    });
  }

  // ── Email CRUD (Drizzle) ───────────────────────────────────────
  #labelsForEmailIds(emailIds: string[]) {
    const result = new Map<
      string,
      Array<{
        id: string;
        name: string;
        color: string;
      }>
    >();
    if (emailIds.length === 0) return result;
    const rows = this.db
      .select({
        emailId: schema.emailLabels.email_id,
        id: schema.labels.id,
        name: schema.labels.name,
        color: schema.labels.color,
      })
      .from(schema.emailLabels)
      .innerJoin(
        schema.labels,
        eq(schema.labels.id, schema.emailLabels.label_id),
      )
      .where(inArray(schema.emailLabels.email_id, emailIds))
      .orderBy(asc(schema.labels.name))
      .all();
    for (const row of rows) {
      const labels = result.get(row.emailId) ?? [];
      labels.push({ id: row.id, name: row.name, color: row.color });
      result.set(row.emailId, labels);
    }
    return result;
  }

  async getEmails(options: GetEmailsOptions = {}) {
    await this.#selfHealSnoozes();
    await this.#selfHealCleanupAlarm();
    const {
      folder,
      label_id,
      thread_id,
      page = 1,
      limit: rawLimit = 25,
      sortColumn: rawSortColumn = "date",
      sortDirection = "DESC",
    } = options;

    // Cap pagination limit to prevent unbounded queries
    const limit = Math.min(Math.max(rawLimit, 1), 100);

    const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
      rawSortColumn as SortColumn,
    )
      ? rawSortColumn
      : "date";

    const offset = (page - 1) * limit;

    const conditions: SQL[] = [
      sql`${schema.emails.folder_id} <> ${InternalFolders.RETIRED_OUTBOUND}`,
    ];
    if (folder) {
      conditions.push(
        sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
      );
    }
    if (thread_id) {
      conditions.push(eq(schema.emails.thread_id, thread_id));
    }
    if (label_id) {
      conditions.push(sql`EXISTS (
				SELECT 1 FROM ${schema.emailLabels}
				WHERE ${schema.emailLabels.email_id} = ${schema.emails.id}
					AND ${schema.emailLabels.label_id} = ${label_id}
			)`);
    }

    const orderCol = SORT_COLUMN_MAP[sortColumn];
    const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

    const result = this.db
      .select({
        id: schema.emails.id,
        subject: schema.emails.subject,
        sender: schema.emails.sender,
        sender_name: schema.emails.sender_name,
        recipient: schema.emails.recipient,
        cc: schema.emails.cc,
        bcc: schema.emails.bcc,
        date: schema.emails.date,
        read: schema.emails.read,
        starred: schema.emails.starred,
        in_reply_to: schema.emails.in_reply_to,
        email_references: schema.emails.email_references,
        thread_id: schema.emails.thread_id,
        folder_id: schema.emails.folder_id,
        snooze_source_folder_id: schema.emails.snooze_source_folder_id,
        snoozed_until: schema.emails.snoozed_until,
        snippet: sql<string>`${sql.raw(snippetSourceSql("emails"))}`,
        has_attachments: sql<number>`${sql.raw(hasAttachmentsSql("emails"))}`,
      })
      .from(schema.emails)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(orderDir)
      .limit(limit)
      .offset(offset)
      .all();

    const labelsByEmail = this.#labelsForEmailIds(
      result.map((email) => email.id),
    );
    return result.map((email) => ({
      ...email,
      read: !!email.read,
      starred: !!email.starred,
      has_attachments: !!email.has_attachments,
      snippet: htmlToSnippet(email.snippet, SNIPPET_LENGTH),
      labels: labelsByEmail.get(email.id) ?? [],
    }));
  }

  /**
   * Count total emails matching the given filters (for pagination).
   */
  async countEmails(
    options: { folder?: string; thread_id?: string; label_id?: string } = {},
  ) {
    await this.#selfHealSnoozes();
    const { folder, thread_id, label_id } = options;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (folder) {
      conditions.push(
        "folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
      );
      params.push(folder);
    }

    if (thread_id) {
      conditions.push(`thread_id = ?${params.length + 1}`);
      params.push(thread_id);
    }
    if (label_id) {
      conditions.push(
        `EXISTS (SELECT 1 FROM email_labels el WHERE el.email_id = emails.id AND el.label_id = ?${params.length + 1})`,
      );
      params.push(label_id);
    }

    conditions.unshift(`folder_id <> '${InternalFolders.RETIRED_OUTBOUND}'`);
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = [
      ...this.ctx.storage.sql.exec(
        `SELECT COUNT(*) as total FROM emails ${where}`,
        ...params,
      ),
    ][0] as { total: number } | undefined;

    return row?.total ?? 0;
  }

  // ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──
  #visibleFolderId(folderReference: string): string | null {
    const folder = this.db
      .select({ id: schema.folders.id })
      .from(schema.folders)
      .where(
        or(
          eq(schema.folders.id, folderReference),
          eq(schema.folders.name, folderReference),
        ),
      )
      .limit(1)
      .get();
    return folder && !isInternalFolderId(folder.id) ? folder.id : null;
  }

  async getThreadedEmails(options: GetEmailsOptions = {}) {
    await this.#selfHealSnoozes();
    const { folder, label_id, page = 1, limit: rawLimit = 25 } = options;
    const limit = Math.min(Math.max(rawLimit, 1), 100);

    if (!folder) {
      // Fallback to regular getEmails if no folder specified
      return this.getEmails(options);
    }
    await this.#selfHealCleanupAlarm();
    const visibleFolderId = this.#visibleFolderId(folder);
    if (!visibleFolderId) return [];

    const offset = (page - 1) * limit;

    // Thread grouping strategy:
    // For DRAFT folder: group by in_reply_to (the email being replied to).
    //   This ensures reply-drafts to different emails stay separate, even if
    //   they share a thread_id or subject. New drafts (no in_reply_to) each
    //   get their own group via their unique id.
    // For other folders:
    //   1. Primary: group by thread_id (from email threading headers)
    //   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
    //      for legacy emails that lack threading headers (thread_id IS NULL).
    const isDraftFolder = visibleFolderId === Folders.DRAFT;

    if (isDraftFolder) {
      const result = this.ctx.storage.sql.exec(
        `WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
						AND (?4 IS NULL OR EXISTS (
							SELECT 1 FROM email_labels el
							WHERE el.email_id = emails.id AND el.label_id = ?4
						))
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT sender) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.sender_name, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.draft_group_key as conversation_id,
					lp.in_reply_to, lp.email_references,
					${snippetSourceSql("lp")} as snippet,
					${hasAttachmentsSql("lp")} as has_attachments,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
        visibleFolderId,
        limit,
        offset,
        label_id ?? null,
      );

      const rows = [...result];
      const labelsByEmail = this.#labelsForEmailIds(
        rows.map((row: any) => String(row.id)),
      );
      return rows.map((row: any) => ({
        ...row,
        read: !!row.read,
        starred: !!row.starred,
        thread_count: row.thread_count || 1,
        thread_unread_count: row.thread_unread_count || 0,
        participants: row.participants || row.sender,
        has_attachments: !!row.has_attachments,
        snippet: htmlToSnippet(row.snippet, SNIPPET_LENGTH),
        labels: labelsByEmail.get(String(row.id)) ?? [],
      }));
    }

    // Non-draft folders: full threading logic
    const result = this.ctx.storage.sql.exec(
      `WITH
			folder_emails AS (
				SELECT *,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
					AND (?4 IS NULL OR EXISTS (
						SELECT 1 FROM email_labels el
						WHERE el.email_id = emails.id AND el.label_id = ?4
					))
			),
			thread_to_conversation AS (
				SELECT
					raw_thread_id,
					normalized_subject,
					${CONVERSATION_ID_SQL} as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			),
			all_emails_with_conversation AS (
				SELECT
					e.*,
					COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
				FROM emails e
				LEFT JOIN thread_to_conversation tc
					ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
				WHERE e.folder_id <> '${InternalFolders.RETIRED_OUTBOUND}'
			),
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					GROUP_CONCAT(DISTINCT ${SENDER_DISPLAY_SQL}) as participant_names,
					SUM(CASE WHEN EXISTS(
						SELECT 1 FROM attachments a
						WHERE a.email_id = all_emails_with_conversation.id
					) THEN 1 ELSE 0 END) as attachment_count,
					SUM(CASE WHEN folder_id = (SELECT id FROM folders WHERE name = 'draft' LIMIT 1) THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conversation
				WHERE conversation_id IN (
					SELECT DISTINCT conversation_id FROM all_emails_with_conversation
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				)
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC, id DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC, fe.id DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.sender_name, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.snooze_source_folder_id, lif.snoozed_until,
				lif.conversation_id,
				lif.in_reply_to, lif.email_references,
				${snippetSourceSql("lif")} as snippet,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				cs.participant_names,
				CASE WHEN cs.attachment_count > 0 THEN 1 ELSE 0 END as has_attachments,
				CASE WHEN lmc.folder_id != (SELECT id FROM folders WHERE name = 'sent' LIMIT 1)
					AND lmc.folder_id != (SELECT id FROM folders WHERE name = 'draft' LIMIT 1)
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1
			ORDER BY lif.date DESC, lif.conversation_id ASC, lif.id ASC
			LIMIT ?2 OFFSET ?3`,
      visibleFolderId,
      limit,
      offset,
      label_id ?? null,
    );

    const rows = [...result];
    const labelsByEmail = this.#labelsForEmailIds(
      rows.map((row: any) => String(row.id)),
    );
    return rows.map((row: any) => ({
      ...row,
      read: !!row.read,
      starred: !!row.starred,
      thread_count: row.thread_count || 1,
      thread_unread_count: row.thread_unread_count || 0,
      participants: row.participants || row.sender,
      participant_names: row.participant_names || row.sender,
      has_attachments: !!row.has_attachments,
      snippet: htmlToSnippet(row.snippet, SNIPPET_LENGTH),
      needs_reply: !!row.needs_reply,
      has_draft: !!row.has_draft,
      labels: labelsByEmail.get(String(row.id)) ?? [],
    }));
  }

  /**
   * Count threaded conversations in a folder (for pagination).
   * Returns the number of conversation groups, not individual emails.
   */
  async countThreadedEmails(folder: string, labelId?: string) {
    await this.#selfHealSnoozes();
    const visibleFolderId = this.#visibleFolderId(folder);
    if (!visibleFolderId) return 0;
    const isDraftFolder = visibleFolderId === Folders.DRAFT;

    if (isDraftFolder) {
      const row = [
        ...this.ctx.storage.sql.exec(
          `SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
						AND (?2 IS NULL OR EXISTS (
							SELECT 1 FROM email_labels el
							WHERE el.email_id = emails.id AND el.label_id = ?2
						))`,
          visibleFolderId,
          labelId ?? null,
        ),
      ][0] as { total: number } | undefined;
      return row?.total ?? 0;
    }

    const row = [
      ...this.ctx.storage.sql.exec(
        `WITH
				folder_emails AS (
					SELECT
						COALESCE(thread_id, id) as raw_thread_id,
						thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
						AND (?2 IS NULL OR EXISTS (
							SELECT 1 FROM email_labels el
							WHERE el.email_id = emails.id AND el.label_id = ?2
						))
				),
				thread_to_conversation AS (
					SELECT
						raw_thread_id,
						${CONVERSATION_ID_SQL} as conversation_id
					FROM folder_emails
					GROUP BY raw_thread_id, normalized_subject, thread_id
				)
				SELECT COUNT(DISTINCT conversation_id) as total
				FROM thread_to_conversation`,
        visibleFolderId,
        labelId ?? null,
      ),
    ][0] as { total: number } | undefined;
    return row?.total ?? 0;
  }

  // ── Single email operations (Drizzle) ──────────────────────────
  async hasEmail(id: string): Promise<boolean> {
    return Boolean(
      this.db
        .select({ id: schema.emails.id })
        .from(schema.emails)
        .where(eq(schema.emails.id, id))
        .get(),
    );
  }

  #externalBodyParts(emailId: string) {
    return this.db
      .select({
        id: schema.emailBodyObjects.id,
        partIndex: schema.emailBodyObjects.part_index,
        contentType: schema.emailBodyObjects.content_type,
        charset: schema.emailBodyObjects.charset,
        byteLength: schema.emailBodyObjects.byte_length,
      })
      .from(schema.emailBodyObjects)
      .where(eq(schema.emailBodyObjects.email_id, emailId))
      .orderBy(asc(schema.emailBodyObjects.part_index))
      .all();
  }

  async getEmail(id: string) {
    await this.#selfHealSnoozes();
    await this.#selfHealCleanupAlarm();
    const email = this.db
      .select()
      .from(schema.emails)
      .where(
        and(
          eq(schema.emails.id, id),
          sql`${schema.emails.folder_id} <> ${InternalFolders.RETIRED_OUTBOUND}`,
        ),
      )
      .get();

    if (!email) return null;

    const emailAttachments = this.db
      .select({
        id: schema.attachments.id,
        email_id: schema.attachments.email_id,
        filename: schema.attachments.filename,
        mimetype: schema.attachments.mimetype,
        size: schema.attachments.size,
        content_id: schema.attachments.content_id,
        disposition: schema.attachments.disposition,
      })
      .from(schema.attachments)
      .where(eq(schema.attachments.email_id, id))
      .all();

    const externalBodyParts = this.#externalBodyParts(id);
    return {
      ...email,
      read: !!email.read,
      starred: !!email.starred,
      attachments: emailAttachments,
      external_body_parts: externalBodyParts,
      body_external: externalBodyParts.length > 0,
      labels: this.#labelsForEmailIds([id]).get(id) ?? [],
    };
  }

  async getEmailLocation(id: string) {
    if (!id || id.length > 300) return null;
    const row = this.db
      .select({
        emailId: schema.emails.id,
        folderId: schema.emails.folder_id,
      })
      .from(schema.emails)
      .where(
        and(
          eq(schema.emails.id, id),
          sql`${schema.emails.folder_id} <> ${InternalFolders.RETIRED_OUTBOUND}`,
        ),
      )
      .get();
    return row ?? null;
  }

  /**
   * Fetch a thread's email rows, bounded body previews, external-body metadata,
   * and attachments in batched queries instead of N+1 getEmail calls.
   */
  async getThreadEmails(threadId: string) {
    await this.#selfHealSnoozes();
    const emailRows = [
      ...this.ctx.storage.sql.exec(
        `SELECT * FROM emails
				 WHERE thread_id = ?1 AND folder_id <> ?2
				 ORDER BY date ASC`,
        threadId,
        InternalFolders.RETIRED_OUTBOUND,
      ),
    ] as any[];

    if (emailRows.length === 0) return [];

    const emailIds = emailRows.map((e) => e.id as string);

    // Batch-fetch all attachments for the thread in a single query
    const placeholders = emailIds.map((_, i) => `?${i + 1}`).join(",");
    const attachmentRows = [
      ...this.ctx.storage.sql.exec(
        `SELECT id, email_id, filename, mimetype, size, content_id, disposition
				 FROM attachments WHERE email_id IN (${placeholders})`,
        ...emailIds,
      ),
    ] as any[];
    const bodyPartRows = [
      ...this.ctx.storage.sql.exec(
        `SELECT id, email_id, part_index, content_type, charset, byte_length
				 FROM email_body_objects WHERE email_id IN (${placeholders})
				 ORDER BY email_id ASC, part_index ASC`,
        ...emailIds,
      ),
    ] as Array<{
      id: string;
      email_id: string;
      part_index: number;
      content_type: "text/html" | "text/plain";
      charset: string;
      byte_length: number;
    }>;

    // Group attachments by email_id
    const attachmentsByEmail = new Map<string, any[]>();
    for (const att of attachmentRows) {
      const list = attachmentsByEmail.get(att.email_id) || [];
      list.push(att);
      attachmentsByEmail.set(att.email_id, list);
    }
    const bodyPartsByEmail = new Map<string, typeof bodyPartRows>();
    for (const part of bodyPartRows) {
      const list = bodyPartsByEmail.get(part.email_id) ?? [];
      list.push(part);
      bodyPartsByEmail.set(part.email_id, list);
    }

    const labelsByEmail = this.#labelsForEmailIds(emailIds);
    return emailRows.map((email) => ({
      ...email,
      read: !!email.read,
      starred: !!email.starred,
      attachments: attachmentsByEmail.get(email.id) || [],
      external_body_parts: (bodyPartsByEmail.get(email.id) ?? []).map(
        (part) => ({
          id: part.id,
          partIndex: part.part_index,
          contentType: part.content_type,
          charset: part.charset,
          byteLength: part.byte_length,
        }),
      ),
      body_external: (bodyPartsByEmail.get(email.id) ?? []).length > 0,
      labels: labelsByEmail.get(email.id) ?? [],
    }));
  }

  async getEmailBodyObject(emailId: string, bodyObjectId: string) {
    if (
      !emailId ||
      !bodyObjectId ||
      emailId.length > 300 ||
      bodyObjectId.length > 300
    )
      return null;
    return (
      this.db
        .select({
          id: schema.emailBodyObjects.id,
          email_id: schema.emailBodyObjects.email_id,
          part_index: schema.emailBodyObjects.part_index,
          content_type: schema.emailBodyObjects.content_type,
          charset: schema.emailBodyObjects.charset,
          r2_key: schema.emailBodyObjects.r2_key,
          byte_length: schema.emailBodyObjects.byte_length,
        })
        .from(schema.emailBodyObjects)
        .innerJoin(
          schema.emails,
          eq(schema.emails.id, schema.emailBodyObjects.email_id),
        )
        .where(
          and(
            eq(schema.emailBodyObjects.id, bodyObjectId),
            eq(schema.emailBodyObjects.email_id, emailId),
            sql`${schema.emails.folder_id} <> ${InternalFolders.RETIRED_OUTBOUND}`,
          ),
        )
        .get() ?? null
    );
  }

  async getEmailBodySource(emailId: string) {
    if (!emailId || emailId.length > 300) return null;
    const email = this.db
      .select({ id: schema.emails.id, body: schema.emails.body })
      .from(schema.emails)
      .where(
        and(
          eq(schema.emails.id, emailId),
          sql`${schema.emails.folder_id} <> ${InternalFolders.RETIRED_OUTBOUND}`,
        ),
      )
      .get();
    if (!email) return null;
    const parts = this.db
      .select({
        contentType: schema.emailBodyObjects.content_type,
        partIndex: schema.emailBodyObjects.part_index,
        r2Key: schema.emailBodyObjects.r2_key,
        byteLength: schema.emailBodyObjects.byte_length,
      })
      .from(schema.emailBodyObjects)
      .where(eq(schema.emailBodyObjects.email_id, emailId))
      .orderBy(asc(schema.emailBodyObjects.part_index))
      .all();
    return parts.length > 0
      ? { storage: "external" as const, parts }
      : { storage: "inline" as const, body: email.body };
  }

  async isEmailDeleted(id: string): Promise<boolean> {
    return Boolean(
      this.db
        .select({ id: schema.emailDeletionTombstones.id })
        .from(schema.emailDeletionTombstones)
        .where(eq(schema.emailDeletionTombstones.id, id))
        .get(),
    );
  }

  #directInboundAuthorityInputIsValid(
    input: DirectInboundAuthority,
  ): boolean {
    return (
      input.schemaVersion === 1 &&
      /^[A-Za-z0-9_-]{1,300}$/.test(input.ingressId) &&
      input.mailboxId.length > 2 &&
      input.mailboxId.length <= 320 &&
      Number.isSafeInteger(input.rawSize) &&
      input.rawSize > 0 &&
      input.rawSize <= 25 * 1024 * 1024 &&
      /^[a-f0-9]{64}$/.test(input.rawSha256) &&
      Number.isFinite(Date.parse(input.receivedAt)) &&
      new Date(input.receivedAt).toISOString() === input.receivedAt
    );
  }

  #directInboundAuthorityMatches(
    existing: typeof schema.directInboundDeliveryAuthorities.$inferSelect,
    input: DirectInboundAuthority,
    state: "deleted" | "projected",
  ): boolean {
    return (
      existing.state === state &&
      existing.schema_version === input.schemaVersion &&
      existing.id === input.ingressId &&
      existing.mailbox_id === input.mailboxId &&
      existing.raw_size === input.rawSize &&
      existing.raw_sha256 === input.rawSha256 &&
      existing.received_at === input.receivedAt &&
      (state === "projected"
        ? existing.generation === 1 && existing.deleted_at === null
        : existing.generation >= 2 && existing.deleted_at !== null)
    );
  }

  #archiveInboundAuthorityMatches(
    existing: typeof schema.inboundDeliveryAuthorities.$inferSelect,
    input: InboundArchiveAuthority,
    state: "deleted" | "projected",
  ): boolean {
    return (
      existing.state === state &&
      existing.schema_version === input.schemaVersion &&
      existing.id === input.ingressId &&
      existing.raw_key === input.rawKey &&
      existing.mailbox_id === input.mailboxId &&
      existing.raw_size === input.rawSize &&
      existing.raw_sha256 === input.rawSha256 &&
      existing.archived_at === input.archivedAt &&
      existing.archive_etag === input.etag &&
      existing.archive_version === input.version &&
      (state === "projected"
        ? existing.generation === 1 && existing.deleted_at === null
        : existing.generation >= 2 && existing.deleted_at !== null)
    );
  }

  #directAuthorityMatchesArchiveIdentity(
    existing: typeof schema.directInboundDeliveryAuthorities.$inferSelect,
    input: InboundArchiveAuthority,
    state: "deleted" | "projected",
  ): boolean {
    return (
      existing.state === state &&
      existing.schema_version === input.schemaVersion &&
      existing.id === input.ingressId &&
      existing.mailbox_id === input.mailboxId &&
      existing.raw_size === input.rawSize &&
      existing.raw_sha256 === input.rawSha256 &&
      existing.received_at === input.archivedAt &&
      (state === "projected"
        ? existing.generation === 1 && existing.deleted_at === null
        : existing.generation >= 2 && existing.deleted_at !== null)
    );
  }

  #archiveAuthorityMatchesDirectIdentity(
    existing: typeof schema.inboundDeliveryAuthorities.$inferSelect,
    input: DirectInboundAuthority,
    state: "deleted" | "projected",
  ): boolean {
    return (
      existing.state === state &&
      existing.schema_version === input.schemaVersion &&
      existing.id === input.ingressId &&
      existing.mailbox_id === input.mailboxId &&
      existing.raw_size === input.rawSize &&
      existing.raw_sha256 === input.rawSha256 &&
      existing.archived_at === input.receivedAt &&
      (state === "projected"
        ? existing.generation === 1 && existing.deleted_at === null
        : existing.generation >= 2 && existing.deleted_at !== null)
    );
  }

  async getInboundDeletionAuthority(
    input: InboundArchiveAuthority,
  ): Promise<{ generation: number; deletedAt: string } | null> {
    if (
      input.schemaVersion !== 1 ||
      !input.ingressId ||
      !isInboundRawKeyForIngress(input.rawKey, input.ingressId) ||
      !input.mailboxId ||
      !Number.isSafeInteger(input.rawSize) ||
      input.rawSize <= 0 ||
      input.rawSize > 25 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(input.rawSha256) ||
      !Number.isFinite(Date.parse(input.archivedAt)) ||
      new Date(input.archivedAt).toISOString() !== input.archivedAt ||
      !input.etag ||
      !input.version
    ) {
      return null;
    }
    const authority = this.db
      .select()
      .from(schema.inboundDeliveryAuthorities)
      .where(eq(schema.inboundDeliveryAuthorities.id, input.ingressId))
      .get();
    const directAuthority = this.db
      .select()
      .from(schema.directInboundDeliveryAuthorities)
      .where(eq(schema.directInboundDeliveryAuthorities.id, input.ingressId))
      .get();
    const tombstone = this.db
      .select({ deletedAt: schema.emailDeletionTombstones.deleted_at })
      .from(schema.emailDeletionTombstones)
      .where(eq(schema.emailDeletionTombstones.id, input.ingressId))
      .get();
    const liveEmail = this.db
      .select({ id: schema.emails.id })
      .from(schema.emails)
      .where(eq(schema.emails.id, input.ingressId))
      .get();
    if (authority && directAuthority) return null;
    const exactArchive = Boolean(
      authority &&
        authority.state === "deleted" &&
        authority.schema_version === input.schemaVersion &&
        authority.raw_key === input.rawKey &&
        authority.mailbox_id === input.mailboxId &&
        authority.raw_size === input.rawSize &&
        authority.raw_sha256 === input.rawSha256 &&
        authority.archived_at === input.archivedAt &&
        authority.archive_etag === input.etag &&
        authority.archive_version === input.version &&
        Number.isSafeInteger(authority.generation) &&
        authority.generation >= 2 &&
        authority.deleted_at,
    );
    const exactDirect = Boolean(
      directAuthority &&
        this.#directAuthorityMatchesArchiveIdentity(
          directAuthority,
          input,
          "deleted",
        ),
    );
    const terminalAuthority = exactArchive ? authority : exactDirect ? directAuthority : null;
    if (
      !terminalAuthority ||
      !terminalAuthority.deleted_at ||
      tombstone?.deletedAt !== terminalAuthority.deleted_at ||
      Boolean(liveEmail)
    ) {
      return null;
    }
    return {
      generation: terminalAuthority.generation,
      deletedAt: terminalAuthority.deleted_at,
    };
  }

  async getInboundProjectionAuthority(
    input: InboundArchiveAuthority,
  ): Promise<{ generation: number } | null> {
    if (
      input.schemaVersion !== 1 ||
      !input.ingressId ||
      !isInboundRawKeyForIngress(input.rawKey, input.ingressId) ||
      !input.mailboxId ||
      !Number.isSafeInteger(input.rawSize) ||
      input.rawSize <= 0 ||
      input.rawSize > 25 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(input.rawSha256) ||
      !Number.isFinite(Date.parse(input.archivedAt)) ||
      new Date(input.archivedAt).toISOString() !== input.archivedAt ||
      !input.etag ||
      !input.version
    ) {
      return null;
    }
    const authority = this.db
      .select()
      .from(schema.inboundDeliveryAuthorities)
      .where(eq(schema.inboundDeliveryAuthorities.id, input.ingressId))
      .get();
    const directAuthority = this.db
      .select()
      .from(schema.directInboundDeliveryAuthorities)
      .where(eq(schema.directInboundDeliveryAuthorities.id, input.ingressId))
      .get();
    const liveEmail = this.db
      .select({
        origin: schema.emails.recipient_memory_origin,
      })
      .from(schema.emails)
      .where(eq(schema.emails.id, input.ingressId))
      .get();
    const tombstone = this.db
      .select({ id: schema.emailDeletionTombstones.id })
      .from(schema.emailDeletionTombstones)
      .where(eq(schema.emailDeletionTombstones.id, input.ingressId))
      .get();
    if (authority && directAuthority) return null;
    const exactArchive = Boolean(
      authority &&
        authority.state === "projected" &&
        authority.schema_version === input.schemaVersion &&
        authority.raw_key === input.rawKey &&
        authority.mailbox_id === input.mailboxId &&
        authority.raw_size === input.rawSize &&
        authority.raw_sha256 === input.rawSha256 &&
        authority.archived_at === input.archivedAt &&
        authority.archive_etag === input.etag &&
        authority.archive_version === input.version &&
        authority.generation === 1 &&
        authority.deleted_at === null,
    );
    const exactDirect = Boolean(
      directAuthority &&
        this.#directAuthorityMatchesArchiveIdentity(
          directAuthority,
          input,
          "projected",
        ),
    );
    const terminalAuthority = exactArchive ? authority : exactDirect ? directAuthority : null;
    if (
      !terminalAuthority ||
      liveEmail?.origin !== RecipientMemoryOrigins.LIVE_INBOUND ||
      tombstone
    ) {
      return null;
    }
    return { generation: terminalAuthority.generation };
  }

  async getDirectInboundDeletionAuthority(
    input: DirectInboundAuthority,
  ): Promise<{ generation: number; deletedAt: string } | null> {
    if (!this.#directInboundAuthorityInputIsValid(input)) return null;
    const authority = this.db
      .select()
      .from(schema.directInboundDeliveryAuthorities)
      .where(eq(schema.directInboundDeliveryAuthorities.id, input.ingressId))
      .get();
    const archiveAuthority = this.db
      .select()
      .from(schema.inboundDeliveryAuthorities)
      .where(eq(schema.inboundDeliveryAuthorities.id, input.ingressId))
      .get();
    const tombstone = this.db
      .select({ deletedAt: schema.emailDeletionTombstones.deleted_at })
      .from(schema.emailDeletionTombstones)
      .where(eq(schema.emailDeletionTombstones.id, input.ingressId))
      .get();
    const liveEmail = this.db
      .select({ id: schema.emails.id })
      .from(schema.emails)
      .where(eq(schema.emails.id, input.ingressId))
      .get();
    if (authority && archiveAuthority) return null;
    const exactDirect = Boolean(
      authority &&
        this.#directInboundAuthorityMatches(authority, input, "deleted"),
    );
    const exactArchive = Boolean(
      archiveAuthority &&
        this.#archiveAuthorityMatchesDirectIdentity(
          archiveAuthority,
          input,
          "deleted",
        ),
    );
    const terminalAuthority = exactDirect ? authority : exactArchive ? archiveAuthority : null;
    if (
      !terminalAuthority ||
      !terminalAuthority.deleted_at ||
      tombstone?.deletedAt !== terminalAuthority.deleted_at ||
      liveEmail
    ) {
      return null;
    }
    return {
      generation: terminalAuthority.generation,
      deletedAt: terminalAuthority.deleted_at,
    };
  }

  async getDirectInboundProjectionAuthority(
    input: DirectInboundAuthority,
  ): Promise<{ generation: number } | null> {
    if (!this.#directInboundAuthorityInputIsValid(input)) return null;
    const authority = this.db
      .select()
      .from(schema.directInboundDeliveryAuthorities)
      .where(eq(schema.directInboundDeliveryAuthorities.id, input.ingressId))
      .get();
    const archiveAuthority = this.db
      .select()
      .from(schema.inboundDeliveryAuthorities)
      .where(eq(schema.inboundDeliveryAuthorities.id, input.ingressId))
      .get();
    const liveEmail = this.db
      .select({ origin: schema.emails.recipient_memory_origin })
      .from(schema.emails)
      .where(eq(schema.emails.id, input.ingressId))
      .get();
    const tombstone = this.db
      .select({ id: schema.emailDeletionTombstones.id })
      .from(schema.emailDeletionTombstones)
      .where(eq(schema.emailDeletionTombstones.id, input.ingressId))
      .get();
    if (authority && archiveAuthority) return null;
    const exactDirect = Boolean(
      authority &&
        this.#directInboundAuthorityMatches(authority, input, "projected"),
    );
    const exactArchive = Boolean(
      archiveAuthority &&
        this.#archiveAuthorityMatchesDirectIdentity(
          archiveAuthority,
          input,
          "projected",
        ),
    );
    const terminalAuthority = exactDirect ? authority : exactArchive ? archiveAuthority : null;
    if (
      !terminalAuthority ||
      liveEmail?.origin !== RecipientMemoryOrigins.LIVE_INBOUND ||
      tombstone
    ) {
      return null;
    }
    return { generation: terminalAuthority.generation };
  }

  async recordInboundTerminalFailure(input: {
    id: string;
    archiveAuthority: InboundArchiveAuthority;
    queueRef: string;
    attempts: number;
    errorCode: "QUEUE_RETRY_EXHAUSTED";
  }): Promise<"deleted" | "ledgered" | "stored"> {
    if (
      input.errorCode !== "QUEUE_RETRY_EXHAUSTED" ||
      input.archiveAuthority.ingressId !== input.id ||
      input.archiveAuthority.schemaVersion !== 1 ||
      !isInboundRawKeyForIngress(
        input.archiveAuthority.rawKey,
        input.archiveAuthority.ingressId,
      ) ||
      !/^[a-f0-9]{64}$/.test(input.archiveAuthority.rawSha256) ||
      !/^[a-f0-9]{16}$/.test(input.queueRef) ||
      !Number.isSafeInteger(input.attempts) ||
      input.attempts < 0
    ) {
      throw new Error("Inbound terminal failure is invalid");
    }
    return this.ctx.storage.transactionSync(() => {
      const authority = this.db
        .select()
        .from(schema.inboundDeliveryAuthorities)
        .where(eq(schema.inboundDeliveryAuthorities.id, input.id))
        .get();
      const directAuthority = this.db
        .select()
        .from(schema.directInboundDeliveryAuthorities)
        .where(eq(schema.directInboundDeliveryAuthorities.id, input.id))
        .get();
      const email = this.db
        .select({ origin: schema.emails.recipient_memory_origin })
        .from(schema.emails)
        .where(eq(schema.emails.id, input.id))
        .get();
      const tombstone = this.db
        .select({ deletedAt: schema.emailDeletionTombstones.deleted_at })
        .from(schema.emailDeletionTombstones)
        .where(eq(schema.emailDeletionTombstones.id, input.id))
        .get();
      const exactDeletedOwner =
        authority && !directAuthority
          ? this.#archiveInboundAuthorityMatches(
              authority,
              input.archiveAuthority,
              "deleted",
            )
            ? authority
            : null
          : directAuthority && !authority
            ? this.#directAuthorityMatchesArchiveIdentity(
                directAuthority,
                input.archiveAuthority,
                "deleted",
              )
              ? directAuthority
              : null
            : null;
      if (
        exactDeletedOwner?.deleted_at &&
        tombstone?.deletedAt === exactDeletedOwner.deleted_at &&
        !email
      ) {
        this.db
          .delete(schema.inboundTerminalFailures)
          .where(eq(schema.inboundTerminalFailures.id, input.id))
          .run();
        return "deleted";
      }
      const exactProjectedOwner =
        authority && !directAuthority
          ? this.#archiveInboundAuthorityMatches(
              authority,
              input.archiveAuthority,
              "projected",
            )
          : directAuthority && !authority
            ? this.#directAuthorityMatchesArchiveIdentity(
                directAuthority,
                input.archiveAuthority,
                "projected",
              )
            : false;
      if (
        exactProjectedOwner &&
        email?.origin === RecipientMemoryOrigins.LIVE_INBOUND &&
        !tombstone
      ) {
        this.db
          .delete(schema.inboundTerminalFailures)
          .where(eq(schema.inboundTerminalFailures.id, input.id))
          .run();
        return "stored";
      }
      this.db
        .insert(schema.inboundTerminalFailures)
        .values({
          id: input.id,
          queue_ref: input.queueRef,
          attempts: input.attempts,
          error_code: input.errorCode,
          recorded_at: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
      return "ledgered";
    });
  }

  async getInboundTerminalFailure(id: string): Promise<{
    queueRef: string;
    attempts: number;
    errorCode: "QUEUE_RETRY_EXHAUSTED";
    recordedAt: string;
  } | null> {
    const failure = this.db
      .select()
      .from(schema.inboundTerminalFailures)
      .where(eq(schema.inboundTerminalFailures.id, id))
      .get();
    if (!failure) return null;
    if (failure.error_code !== "QUEUE_RETRY_EXHAUSTED") {
      throw new Error("Inbound terminal failure error code is invalid");
    }
    return {
      queueRef: failure.queue_ref,
      attempts: failure.attempts,
      errorCode: failure.error_code,
      recordedAt: failure.recorded_at,
    };
  }

  async getInboundDerivedContentManifest(
    id: string,
  ): Promise<InboundDerivedContentManifest> {
    if (!id || id.length > 300) return { status: "missing" };
    if (
      this.db
        .select({ id: schema.emailDeletionTombstones.id })
        .from(schema.emailDeletionTombstones)
        .where(eq(schema.emailDeletionTombstones.id, id))
        .get()
    )
      return { status: "deleted" };
    const email = this.db
      .select({
        id: schema.emails.id,
        recipientMemoryOrigin: schema.emails.recipient_memory_origin,
      })
      .from(schema.emails)
      .where(eq(schema.emails.id, id))
      .get();
    if (!email) return { status: "missing" };
    if (email.recipientMemoryOrigin !== RecipientMemoryOrigins.LIVE_INBOUND) {
      return { status: "not_live_inbound" };
    }
    this.db
      .insert(schema.inboundDerivedContentState)
      .values({ email_id: id })
      .onConflictDoNothing()
      .run();
    const state = this.db
      .select({
        generation: schema.inboundDerivedContentState.generation,
        lastRepairMarkerId:
          schema.inboundDerivedContentState.last_repair_marker_id,
      })
      .from(schema.inboundDerivedContentState)
      .where(eq(schema.inboundDerivedContentState.email_id, id))
      .get();
    if (!state) throw new Error("Inbound derived-content state is unavailable");
    const attachments = this.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.email_id, id))
      .orderBy(asc(schema.attachments.id))
      .all()
      .map((attachment) => ({
        id: attachment.id,
        r2Key: storedAttachmentKey(attachment),
        byteLength: attachment.size,
      }));
    const bodyObjects = this.db
      .select({
        id: schema.emailBodyObjects.id,
        r2Key: schema.emailBodyObjects.r2_key,
        byteLength: schema.emailBodyObjects.byte_length,
      })
      .from(schema.emailBodyObjects)
      .where(eq(schema.emailBodyObjects.email_id, id))
      .orderBy(asc(schema.emailBodyObjects.part_index))
      .all();
    return {
      status: "live_inbound",
      generation: state.generation,
      lastRepairMarkerId: state.lastRepairMarkerId,
      attachments,
      bodyObjects,
    };
  }

  #adoptR2OwnershipSync(
    ownedObjects: ReadonlyArray<{
      r2Key: string;
      projectionAttemptId: string | null;
    }>,
  ): boolean {
    if (ownedObjects.length === 0) return true;
    const ownedKeys = [...new Set(ownedObjects.map(({ r2Key }) => r2Key))];
    const projectionAttemptIds = [
      ...new Set(
        ownedObjects.flatMap(({ projectionAttemptId }) =>
          projectionAttemptId ? [projectionAttemptId] : [],
        ),
      ),
    ];
    for (const attemptChunk of sqlParameterChunks(
      projectionAttemptIds,
      R2_CLAIM_KEY_CHUNK_SIZE,
    )) {
      const retiredAttempt = this.db
        .select({
          attemptId: schema.inboundDerivedContentRetiredAttempts.attempt_id,
        })
        .from(schema.inboundDerivedContentRetiredAttempts)
        .where(
          inArray(
            schema.inboundDerivedContentRetiredAttempts.attempt_id,
            attemptChunk,
          ),
        )
        .limit(1)
        .get();
      if (retiredAttempt) return false;
    }

    for (const keyChunk of sqlParameterChunks(
      ownedKeys,
      R2_CLAIM_KEY_CHUNK_SIZE,
    )) {
      const exactFence = this.db
        .select({ r2Key: schema.r2RetiredKeyFences.r2_key })
        .from(schema.r2RetiredKeyFences)
        .where(inArray(schema.r2RetiredKeyFences.r2_key, keyChunk))
        .limit(1)
        .get();
      if (exactFence) return false;
      const activeDeletion = this.db
        .select({ state: schema.r2DeletionOutbox.state })
        .from(schema.r2DeletionOutbox)
        .where(
          and(
            inArray(schema.r2DeletionOutbox.r2_key, keyChunk),
            eq(schema.r2DeletionOutbox.state, "deleting"),
          ),
        )
        .limit(1)
        .get();
      if (activeDeletion) return false;
    }

    for (const keyChunk of sqlParameterChunks(
      ownedKeys,
      R2_CLAIM_KEY_CHUNK_SIZE,
    )) {
      this.db
        .delete(schema.r2DeletionOutbox)
        .where(
          and(
            inArray(schema.r2DeletionOutbox.r2_key, keyChunk),
            eq(schema.r2DeletionOutbox.state, "pending"),
          ),
        )
        .run();
    }
    return true;
  }

  #authoritativelyOwnedR2KeysSync(r2Keys: readonly string[]): Set<string> {
    const ownedKeys = new Set<string>();
    for (const keyChunk of sqlParameterChunks(
      [...new Set(r2Keys)],
      R2_CLAIM_KEY_CHUNK_SIZE,
    )) {
      for (const attachment of this.db
        .select({ r2Key: schema.attachments.r2_key })
        .from(schema.attachments)
        .where(inArray(schema.attachments.r2_key, keyChunk))
        .all()) {
        if (attachment.r2Key) ownedKeys.add(attachment.r2Key);
      }
      for (const bodyObject of this.db
        .select({ r2Key: schema.emailBodyObjects.r2_key })
        .from(schema.emailBodyObjects)
        .where(inArray(schema.emailBodyObjects.r2_key, keyChunk))
        .all()) {
        ownedKeys.add(bodyObject.r2Key);
      }

      const legacyEmailIds = [
        ...new Set(
          keyChunk.flatMap((r2Key) => {
            if (!r2Key.startsWith("attachments/")) return [];
            const emailId = r2Key.split("/", 3)[1];
            return emailId && emailId.length <= 300 ? [emailId] : [];
          }),
        ),
      ];
      if (legacyEmailIds.length === 0) continue;
      const legacyStoredKey = sql<string>`'attachments/' || ${schema.attachments.email_id} || '/' || ${schema.attachments.id} || '/' || ${schema.attachments.filename}`;
      for (const attachment of this.db
        .select({ r2Key: legacyStoredKey })
        .from(schema.attachments)
        .where(
          and(
            isNull(schema.attachments.r2_key),
            inArray(schema.attachments.email_id, legacyEmailIds),
            inArray(legacyStoredKey, keyChunk),
          ),
        )
        .all()) {
        ownedKeys.add(attachment.r2Key);
      }
    }
    return ownedKeys;
  }

  #enqueueUnownedR2DeletionSync(
    objects: ReadonlyArray<{
      r2Key: string;
      emailId: string;
      projectionAttemptId: string | null;
    }>,
    createdAt: string,
  ): void {
    const uniqueObjects = [
      ...new Map(objects.map((object) => [object.r2Key, object])).values(),
    ];
    const authoritativeKeys = this.#authoritativelyOwnedR2KeysSync(
      uniqueObjects.map(({ r2Key }) => r2Key),
    );
    for (const object of uniqueObjects) {
      if (authoritativeKeys.has(object.r2Key)) continue;
      this.#enqueueR2DeletionSync({ ...object, createdAt });
    }
  }

  #enqueueR2DeletionSync(input: {
    r2Key: string;
    emailId: string;
    projectionAttemptId: string | null;
    createdAt: string;
	nextAttemptAt?: string;
  }): void {
    this.db
      .insert(schema.r2DeletionOutbox)
      .values({
        r2_key: input.r2Key,
        email_id: input.emailId,
        projection_attempt_id: input.projectionAttemptId,
        state: "pending",
        claim_generation: 0,
        lease_token: null,
        lease_expires_at: null,
        attempts: 0,
		next_attempt_at: input.nextAttemptAt ?? input.createdAt,
        last_error: null,
        created_at: input.createdAt,
      })
      .onConflictDoNothing()
      .run();
  }

  async repairInboundDerivedContent(
    command: InboundDerivedContentRepairCommand,
  ): Promise<InboundDerivedContentRepairResult> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        command.attemptId,
      ) ||
      !/^[a-f0-9]{64}$/.test(command.commandFingerprint) ||
      !command.emailId ||
      command.emailId.length > 300 ||
      !Number.isSafeInteger(command.expectedGeneration) ||
      command.expectedGeneration < 1 ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(command.markerId) ||
      command.attachments.some(
        (attachment) =>
          attachment.email_id !== command.emailId ||
          !attachment.r2_key ||
          attachment.size < 0,
      ) ||
      command.bodyObjects.some(
        (bodyObject) =>
          bodyObject.email_id !== command.emailId || bodyObject.byte_length < 0,
      )
    )
      throw new Error("Inbound derived-content repair command is invalid");
    const repairProof = validateInboundDerivedContentProjectionProof({
      emailId: command.emailId,
      projectionAttemptId: command.attemptId,
      objects: [
        ...command.attachments.map((attachment) => ({
          r2Key: attachment.r2_key!,
          byteLength: attachment.size,
        })),
        ...command.bodyObjects.map((bodyObject) => ({
          r2Key: bodyObject.r2_key,
          byteLength: bodyObject.byte_length,
        })),
      ],
    });
    const attachmentPrefix = `attachments/${command.emailId}/${command.attemptId}/`;
    const bodyPrefix = `email-bodies/${command.emailId}/${command.attemptId}/`;
    if (
      !command.attachments.every((attachment) =>
        attachment.r2_key!.startsWith(attachmentPrefix),
      ) ||
      !command.bodyObjects.every((bodyObject) =>
        bodyObject.r2_key.startsWith(bodyPrefix),
      )
    ) {
      throw new Error("Inbound derived-content repair command is invalid");
    }

    const newKeys = new Set(repairProof.map(({ r2Key }) => r2Key));
    if (
      newKeys.size !==
      command.attachments.length + command.bodyObjects.length
    )
      throw new Error("Inbound derived-content repair keys must be unique");
    const { commandFingerprint, ...commandWithoutFingerprint } = command;
    if (
      (await inboundDerivedContentRepairCommandFingerprint(
        commandWithoutFingerprint,
      )) !== commandFingerprint
    )
      throw new Error("Inbound derived-content repair fingerprint is invalid");

    // Register cleanup delivery before accepting a repair. The input gate keeps
    // the alarm from running until this event completes; a rejected or stale
    // repair leaves only a harmless alarm with no due work.
    await this.#scheduleAlarmAt(Date.now() + 100);
    const repairedAt = new Date().toISOString();
    const result =
      this.ctx.storage.transactionSync<InboundDerivedContentRepairResult>(
        () => {
          const existingAttempt = this.db
            .select()
            .from(schema.inboundDerivedContentRepairAttempts)
            .where(
              eq(
                schema.inboundDerivedContentRepairAttempts.attempt_id,
                command.attemptId,
              ),
            )
            .get();
          if (existingAttempt) {
            if (
              existingAttempt.email_id !== command.emailId ||
              existingAttempt.expected_generation !==
                command.expectedGeneration ||
              existingAttempt.marker_id !== command.markerId ||
              existingAttempt.command_fingerprint !== command.commandFingerprint
            )
              throw new Error(
                "Inbound repair attempt identity cannot be reused",
              );
            if (existingAttempt.outcome === "committed") {
              if (existingAttempt.result_generation === null) {
                throw new Error(
                  "Committed inbound repair attempt has no generation",
                );
              }
              return {
                status: "repaired",
                generation: existingAttempt.result_generation,
              };
            }
            if (
              existingAttempt.outcome === "abandoned" ||
              existingAttempt.outcome === "rejected"
            )
              return { status: "stale_marker" };
          }
          const finishAttempt = (
            outcome: "committed" | "rejected",
            result: InboundDerivedContentRepairResult,
          ) => {
            const resultGeneration =
              outcome === "committed" ? (result.generation ?? null) : null;
            if (outcome === "committed" && resultGeneration === null) {
              throw new Error(
                "Committed inbound repair result has no generation",
              );
            }
            this.db
              .insert(schema.inboundDerivedContentRepairAttempts)
              .values({
                attempt_id: command.attemptId,
                email_id: command.emailId,
                expected_generation: command.expectedGeneration,
                marker_id: command.markerId,
                command_fingerprint: command.commandFingerprint,
                outcome,
                result_generation: resultGeneration,
                recorded_at: repairedAt,
              })
              .onConflictDoUpdate({
                target: schema.inboundDerivedContentRepairAttempts.attempt_id,
                set: {
                  outcome,
                  result_generation: resultGeneration,
                  recorded_at: repairedAt,
                },
              })
              .run();
            return result;
          };
          if (
            this.db
              .select({ id: schema.emailDeletionTombstones.id })
              .from(schema.emailDeletionTombstones)
              .where(eq(schema.emailDeletionTombstones.id, command.emailId))
              .get()
          )
            return finishAttempt("rejected", { status: "deleted" });
          const email = this.db
            .select({
              id: schema.emails.id,
              recipientMemoryOrigin: schema.emails.recipient_memory_origin,
            })
            .from(schema.emails)
            .where(eq(schema.emails.id, command.emailId))
            .get();
          if (!email) return finishAttempt("rejected", { status: "missing" });
          if (
            email.recipientMemoryOrigin !== RecipientMemoryOrigins.LIVE_INBOUND
          ) {
            return finishAttempt("rejected", { status: "not_live_inbound" });
          }
          this.db
            .insert(schema.inboundDerivedContentState)
            .values({ email_id: command.emailId })
            .onConflictDoNothing()
            .run();
          const state = this.db
            .select()
            .from(schema.inboundDerivedContentState)
            .where(
              eq(schema.inboundDerivedContentState.email_id, command.emailId),
            )
            .get();
          if (!state)
            throw new Error("Inbound derived-content state is unavailable");
          if (state.last_repair_marker_id === command.markerId) {
            return finishAttempt("rejected", {
              status: "already_repaired",
              generation: state.generation,
            });
          }
          if (state.generation !== command.expectedGeneration) {
            return finishAttempt("rejected", {
              status: "stale_marker",
              generation: state.generation,
            });
          }
          const oldAttachments = this.db
            .select()
            .from(schema.attachments)
            .where(eq(schema.attachments.email_id, command.emailId))
            .all();
          const oldBodyObjects = this.db
            .select({ r2Key: schema.emailBodyObjects.r2_key })
            .from(schema.emailBodyObjects)
            .where(eq(schema.emailBodyObjects.email_id, command.emailId))
            .all();
          const currentAuthoritativeKeys = new Set([
            ...oldAttachments.map((attachment) =>
              storedAttachmentKey(attachment),
            ),
            ...oldBodyObjects.map((bodyObject) => bodyObject.r2Key),
          ]);
          if (
            !this.#adoptR2OwnershipSync(
              [...newKeys].map((r2Key) => ({
                r2Key,
                projectionAttemptId: command.attemptId,
              })),
            )
          ) {
            this.#enqueueUnownedR2DeletionSync(
              [...newKeys]
                .filter((r2Key) => !currentAuthoritativeKeys.has(r2Key))
                .map((r2Key) => ({
                  r2Key,
                  emailId: command.emailId,
                  projectionAttemptId: command.attemptId,
                })),
              repairedAt,
            );
            return finishAttempt("rejected", {
              status: "cleanup_conflict",
              generation: state.generation,
            });
          }
          const supersededKeys = [
            ...oldAttachments.map((attachment) =>
              storedAttachmentKey(attachment),
            ),
            ...oldBodyObjects.map((bodyObject) => bodyObject.r2Key),
          ].filter((key) => !newKeys.has(key));
          for (const key of supersededKeys) {
            this.#enqueueR2DeletionSync({
              r2Key: key,
              emailId: command.emailId,
              projectionAttemptId: projectionAttemptIdFromDerivedContentKey(
                command.emailId,
                key,
              ),
              createdAt: repairedAt,
            });
          }
          this.db
            .delete(schema.attachments)
            .where(eq(schema.attachments.email_id, command.emailId))
            .run();
          this.db
            .delete(schema.emailBodyObjects)
            .where(eq(schema.emailBodyObjects.email_id, command.emailId))
            .run();
          if (command.attachments.length > 0) {
            insertSqliteRowsBounded(command.attachments, 10, (chunk) => {
              this.db.insert(schema.attachments).values(chunk).run();
            });
          }
          if (command.bodyObjects.length > 0) {
            insertSqliteRowsBounded(command.bodyObjects, 8, (chunk) => {
              this.db.insert(schema.emailBodyObjects).values(chunk).run();
            });
          }
          this.db
            .update(schema.emails)
            .set({ body: command.body })
            .where(eq(schema.emails.id, command.emailId))
            .run();
          const generation = state.generation + 1;
          this.db
            .update(schema.inboundDerivedContentState)
            .set({
              generation,
              last_repair_marker_id: command.markerId,
              last_repaired_at: repairedAt,
            })
            .where(
              eq(schema.inboundDerivedContentState.email_id, command.emailId),
            )
            .run();
          return finishAttempt("committed", { status: "repaired", generation });
        },
      );
    return result;
  }

  async enqueueUnownedInboundDerivedContentCleanup(
    input: InboundDerivedContentCleanupInput,
  ): Promise<{ queued: number; retained: number; absent: number }> {
    const proof =
      "objects" in input
        ? validateInboundDerivedContentCleanupProof(input)
        : validateInboundDerivedContentCleanupRequest(input).map((r2Key) => ({
            r2Key,
            byteLength: null,
          }));
    const observedSizes = new Map<string, number | null>();
    for (const candidate of proof) {
      const object = await this.env.BUCKET.head(candidate.r2Key);
      observedSizes.set(candidate.r2Key, object?.size ?? null);
    }

    await this.#scheduleAlarmAt(Date.now() + 100);
    const createdAt = new Date().toISOString();
    return this.ctx.storage.transactionSync(() => {
      const owned = new Map([
        ...this.db
          .select()
          .from(schema.attachments)
          .where(eq(schema.attachments.email_id, input.emailId))
          .all()
          .map(
            (attachment) =>
              [storedAttachmentKey(attachment), attachment.size] as const,
          ),
        ...this.db
          .select({
            r2Key: schema.emailBodyObjects.r2_key,
            byteLength: schema.emailBodyObjects.byte_length,
          })
          .from(schema.emailBodyObjects)
          .where(eq(schema.emailBodyObjects.email_id, input.emailId))
          .all()
          .map(
            (bodyObject) => [bodyObject.r2Key, bodyObject.byteLength] as const,
          ),
      ]);
      const cleanup = classifyInboundDerivedContentCleanup(
        proof,
        observedSizes,
        owned,
      );
      for (const candidate of cleanup.queued) {
        this.#enqueueR2DeletionSync({
          r2Key: candidate.r2Key,
          emailId: input.emailId,
          projectionAttemptId: input.projectionAttemptId,
          createdAt,
        });
      }
      return {
        queued: cleanup.queued.length,
        retained: cleanup.retained,
        absent: cleanup.absent,
      };
    });
  }

  async finalizeInboundDerivedContentRepairAttempt(
    identity: InboundDerivedContentRepairAttemptIdentity,
  ): Promise<InboundDerivedContentRepairAttemptTerminal> {
    if (
      !/^[a-zA-Z0-9_-]{8,100}$/.test(identity.attemptId) ||
      !/^[a-f0-9]{64}$/.test(identity.commandFingerprint) ||
      !identity.emailId ||
      identity.emailId.length > 300 ||
      !Number.isSafeInteger(identity.expectedGeneration) ||
      identity.expectedGeneration < 1 ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(identity.markerId)
    )
      throw new Error("Inbound repair attempt identity is invalid");
    const recordedAt = new Date().toISOString();
    // Per Cloudflare Durable Objects SQLite storage docs
    // (developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactions),
    // transactionSync accepts only synchronous storage work and rolls back on throw.
    // Keep this terminal race wholly inside that transaction.
    return this.ctx.storage.transactionSync(() => {
      const existing = this.db
        .select()
        .from(schema.inboundDerivedContentRepairAttempts)
        .where(
          eq(
            schema.inboundDerivedContentRepairAttempts.attempt_id,
            identity.attemptId,
          ),
        )
        .get();
      if (existing) {
        if (
          existing.email_id !== identity.emailId ||
          existing.expected_generation !== identity.expectedGeneration ||
          existing.marker_id !== identity.markerId ||
          existing.command_fingerprint !== identity.commandFingerprint
        )
          throw new Error("Inbound repair attempt identity cannot be reused");
        if (existing.outcome === "committed") {
          if (existing.result_generation === null) {
            throw new Error(
              "Committed inbound repair attempt has no generation",
            );
          }
          return {
            outcome: "committed",
            generation: existing.result_generation,
          };
        }
        return { outcome: existing.outcome };
      }
      this.db
        .insert(schema.inboundDerivedContentRepairAttempts)
        .values({
          attempt_id: identity.attemptId,
          email_id: identity.emailId,
          expected_generation: identity.expectedGeneration,
          marker_id: identity.markerId,
          command_fingerprint: identity.commandFingerprint,
          outcome: "abandoned",
          result_generation: null,
          recorded_at: recordedAt,
        })
        .run();
      return { outcome: "abandoned" };
    });
  }

  async getConversationIntelligenceEvidence(emailId: string) {
    await this.#selfHealSnoozes();
    return readConversationIntelligenceEvidenceProjection(
      this.ctx.storage.sql,
      emailId,
    );
  }

  /** Read a bounded, redacted history projection without recording another event. */
  async getConversationActivity(
    emailId: string,
    limit: number,
    cursor: string | null,
  ) {
    return readConversationActivityProjection(this.ctx.storage.sql, {
      emailId,
      limit,
      cursor,
    });
  }

  /** Read folder and label identity only, without healing or changing mail. */
  async getAiSearchInterpreterCatalog() {
    return readAiSearchInterpreterCatalog(this.ctx.storage.sql);
  }

  /** Project the exact visible Inbox page and bounded evidence for manual AI review. */
  async getInboxTriageCandidates(
    request: NormalizedInboxTriageSuggestionRequest,
    mailboxAddress: string,
  ) {
    const normalized = validateNormalizedInboxTriageSuggestionRequest(request);
    const rows = await this.getThreadedEmails({
      folder: Folders.INBOX,
      page: normalized.page,
      limit: 25,
      label_id: normalized.labelId ?? undefined,
    });
    return projectInboxTriageCandidates(
      this.ctx.storage.sql,
      rows,
      normalized,
      mailboxAddress,
    );
  }

  /** Resolve reminder identity from stored mail, never from client thread claims. */
  async getFollowUpReminderAnchor(emailId: string) {
    await this.#selfHealSnoozes();
    return readStoredReminderAnchor(this.ctx.storage.sql, emailId);
  }

  /** Project one bounded page of display-only reminder context. */
  async getFollowUpReminderPreviews(
    baselineMessageIds: string[],
    mailboxAddress: string,
  ) {
    await this.#selfHealSnoozes();
    return readFollowUpReminderPreviews(
      this.ctx.storage.sql,
      mailboxAddress,
      baselineMessageIds,
    );
  }

  /**
   * Read the global Today pulse without self-healing, queue work, alarms, or
   * activity. Merely viewing the cross-Mailbox hub must never mutate mail.
   */
  async getGlobalTodaySnapshot(
    mailboxAddress: string,
    baselineMessageIds: string[],
  ) {
    return readGlobalTodayMailboxSnapshot(
      this.ctx.storage.sql,
      mailboxAddress,
      baselineMessageIds,
    );
  }

  /** Project bounded authoritative mail evidence for one actor's Today brief. */
  async getTodayBriefCandidates(
    mailboxAddress: string,
    reminders: FollowUpReminder[],
    boundaries: { now: string; tomorrowStart: string },
  ) {
    await this.#selfHealSnoozes();
    return readTodayBriefCandidates(
      this.ctx.storage.sql,
      mailboxAddress,
      reminders,
      boundaries,
    );
  }

  /** Mutation-free aggregate Today AI metadata. No mail body crosses this RPC. */
  async getGlobalTodayBriefMetadata(
    mailboxAddress: string,
    reminders: FollowUpReminder[],
    boundaries: { now: string; tomorrowStart: string },
  ) {
    return readGlobalTodayBriefMetadata(
      this.ctx.storage.sql,
      mailboxAddress,
      reminders,
      boundaries,
    );
  }

  /** Mutation-free evidence for only globally selected compound Conversations. */
  async getGlobalTodayBriefEvidence(
    requests: GlobalTodayBriefEvidenceRequest[],
  ) {
    return readGlobalTodayBriefEvidence(this.ctx.storage.sql, requests);
  }

  /** Mutation-free sequence check for aggregate Today AI freshness gates. */
  async getGlobalTodayBriefSequence() {
    return readMailboxCurrentSequence(this.ctx.storage.sql);
  }

  /** Advance the bounded local semantic projection and return truthful readiness. */
  async prepareSemanticIndex() {
    if (!this.#semanticPreparation) {
      this.#semanticPreparation = createSemanticIndex({
        store: this.ctx.storage,
      })
        .prepare()
        .finally(() => {
          this.#semanticPreparation = null;
        });
    }
    return this.#semanticPreparation;
  }

  async readSemanticIndexReadiness() {
    return createSemanticIndex({ store: this.ctx.storage }).readiness();
  }

  /** Persist one autonomous semantic continuation lane for this Mailbox. */
  async scheduleSemanticIndexAdvance(mailboxId: string) {
    const normalized = normalizeMailAddress(mailboxId);
    if (!normalized || normalized !== mailboxId) {
      throw new Error(
        "Semantic scheduler received an invalid Mailbox identity",
      );
    }
    const existing = await this.ctx.storage.get<string>(
      SEMANTIC_SCHEDULER_MAILBOX_KEY,
    );
    if (existing && existing !== normalized) {
      throw new Error("Semantic scheduler Mailbox identity changed");
    }
    if (!existing)
      await this.ctx.storage.put(SEMANTIC_SCHEDULER_MAILBOX_KEY, normalized);
    await this.#scheduleAlarmAt(Date.now() + 100);
  }

  /** Operator repair primitive. The next alarm rebuilds solely from current mail truth. */
  async rebuildSemanticIndex(mailboxId: string) {
    const normalized = normalizeMailAddress(mailboxId);
    if (!normalized || normalized !== mailboxId) {
      throw new Error("Semantic rebuild received an invalid Mailbox identity");
    }
    const existing = await this.ctx.storage.get<string>(
      SEMANTIC_SCHEDULER_MAILBOX_KEY,
    );
    if (existing && existing !== normalized) {
      throw new Error("Semantic rebuild Mailbox identity changed");
    }
    createSemanticIndex({ store: this.ctx.storage }).rebuild();
    await this.ctx.storage.put(SEMANTIC_SCHEDULER_MAILBOX_KEY, normalized);
    await this.ctx.storage.delete(SEMANTIC_SCHEDULER_FAILURES_KEY);
    await this.#scheduleAlarmAt(Date.now() + 100);
  }

  /** Lease bounded opaque vector mutations. Content never persists outside this RPC. */
  async leaseSemanticIndexJobs(
    leaseToken: string,
    nowMs: number,
    leaseMs: number,
    limit: number,
  ) {
    return createSemanticIndex({ store: this.ctx.storage }).leaseJobs(
      leaseToken,
      nowMs,
      leaseMs,
      limit,
    );
  }

  async submitSemanticIndexJobs(
    jobs: Array<{ vectorId: string; leaseToken: string }>,
    mutationId: string,
    submittedAt: number,
  ) {
    return createSemanticIndex({ store: this.ctx.storage }).submitJobs(
      jobs,
      mutationId,
      submittedAt,
    );
  }

  async retrySemanticIndexJobs(
    jobs: Array<{
      vectorId: string;
      leaseToken: string;
      nextAttemptAt: number;
      errorCode: string;
      failedAt: number;
    }>,
  ) {
    return createSemanticIndex({ store: this.ctx.storage }).retryJobs(jobs);
  }

  async deferSemanticIndexJobs(
    jobs: Array<{
      vectorId: string;
      leaseToken: string;
      nextAttemptAt: number;
      reasonCode: string;
      deferredAt: number;
    }>,
  ) {
    return createSemanticIndex({ store: this.ctx.storage }).deferJobs(jobs);
  }

  async listSubmittedSemanticIndexJobs(limit: number, observedAt: number) {
    return createSemanticIndex({ store: this.ctx.storage }).dueSubmittedJobs(
      observedAt,
      limit,
    );
  }

  async confirmSemanticIndexVisibility(
    observations: Array<{ vectorId: string; visible: boolean }>,
    observedAt: number,
  ) {
    createSemanticIndex({ store: this.ctx.storage }).confirmVisibility(
      observations,
      observedAt,
    );
  }

  async leaseSemanticAttachmentExtraction(
    leaseToken: string,
    nowMs: number,
    leaseMs: number,
  ) {
    return createSemanticIndex({
      store: this.ctx.storage,
    }).leaseAttachmentExtraction(leaseToken, nowMs, leaseMs);
  }

  async completeSemanticAttachmentExtraction(
    completion: Parameters<
      ReturnType<typeof createSemanticIndex>["completeAttachmentExtraction"]
    >[0],
  ) {
    return createSemanticIndex({
      store: this.ctx.storage,
    }).completeAttachmentExtraction(completion);
  }

  async rejectSemanticAttachmentExtraction(
    input: Parameters<
      ReturnType<typeof createSemanticIndex>["rejectAttachmentExtraction"]
    >[0],
  ) {
    return createSemanticIndex({
      store: this.ctx.storage,
    }).rejectAttachmentExtraction(input);
  }

  async retrySemanticAttachmentExtraction(
    input: Parameters<
      ReturnType<typeof createSemanticIndex>["retryAttachmentExtraction"]
    >[0],
  ) {
    return createSemanticIndex({
      store: this.ctx.storage,
    }).retryAttachmentExtraction(input);
  }

  async resolveSemanticCandidates(
    candidates: ReadonlyArray<{ vectorId: string; score: number }>,
  ) {
    const semanticIndex = createSemanticIndex({ store: this.ctx.storage });
    const initiallyResolved = semanticIndex.resolveCandidates(candidates);
    const attachmentAuthority = new Map<string, boolean>();
    await Promise.all(
      initiallyResolved.map(async (candidate) => {
        if (
          candidate.source !== "attachment" ||
          !candidate.attachmentId ||
          !candidate.attachmentStorageFilename
        )
          return;
        const attachment = this.db
          .select()
          .from(schema.attachments)
          .where(
            and(
              eq(schema.attachments.id, candidate.attachmentId),
              eq(schema.attachments.email_id, candidate.messageId),
            ),
          )
          .get();
        const object = attachment
          ? await this.env.BUCKET.head(storedAttachmentKey(attachment))
          : null;
        const authoritative = Boolean(
          object &&
          object.version === candidate.r2Version &&
          object.etag === candidate.r2Etag &&
          object.size === candidate.actualSize,
        );
        if (!authoritative) {
          semanticIndex.invalidateAttachmentAuthority({
            vectorId: candidate.vectorId,
            attachmentId: candidate.attachmentId,
            sourceFingerprint: candidate.sourceFingerprint,
            r2Version: candidate.r2Version,
            r2Etag: candidate.r2Etag,
            actualSize: candidate.actualSize,
            errorCode: object ? "r2_authority_changed" : "r2_object_missing",
          });
        }
        attachmentAuthority.set(candidate.vectorId, authoritative);
      }),
    );
    const current = semanticIndex
      .resolveCandidates(candidates)
      .filter(
        (candidate) =>
          candidate.source === "message" ||
          attachmentAuthority.get(candidate.vectorId) === true,
      );
    return {
      candidates: current,
      readiness: semanticIndex.readiness(),
    };
  }

  /** Coordinate paid Today inference across every Worker isolate for this mailbox. */
  async claimTodayBriefGeneration(
    cacheKey: string,
    ownerUserId: string,
    claimToken: string,
    expiresAt: number,
  ) {
    const now = Date.now();
    if (
      cacheKey.length < 20 ||
      cacheKey.length > 300 ||
      ownerUserId.length < 1 ||
      ownerUserId.length > 200 ||
      claimToken.length < 16 ||
      claimToken.length > 200 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + 5 * 60 * 1_000
    ) {
      throw new Error("Today brief generation claim is invalid");
    }
    const current = [
      ...this.ctx.storage.sql.exec<{
        owner_user_id: string;
        claim_token: string;
        expires_at: number;
      }>(
        `SELECT owner_user_id, claim_token, expires_at
				 FROM today_brief_generation_claims
				 WHERE cache_key = ?1 LIMIT 1`,
        cacheKey,
      ),
    ][0];
    if (current && current.expires_at > now) {
      const sameOwner =
        current.owner_user_id === ownerUserId &&
        current.claim_token === claimToken;
      if (sameOwner && expiresAt > current.expires_at) {
        this.ctx.storage.sql.exec(
          `UPDATE today_brief_generation_claims SET expires_at = ?2
					 WHERE cache_key = ?1 AND owner_user_id = ?3 AND claim_token = ?4`,
          cacheKey,
          expiresAt,
          ownerUserId,
          claimToken,
        );
      }
      return sameOwner;
    }
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO today_brief_generation_claims
			 (cache_key, owner_user_id, claim_token, expires_at, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)`,
      cacheKey,
      ownerUserId,
      claimToken,
      expiresAt,
      now,
    );
    return true;
  }

  async releaseTodayBriefGeneration(
    cacheKey: string,
    ownerUserId: string,
    claimToken: string,
  ) {
    if (
      cacheKey.length < 20 ||
      cacheKey.length > 300 ||
      ownerUserId.length < 1 ||
      ownerUserId.length > 200 ||
      claimToken.length < 16 ||
      claimToken.length > 200
    ) {
      return false;
    }
    const before =
      [
        ...this.ctx.storage.sql.exec<{ total: number }>(
          `SELECT COUNT(*) AS total FROM today_brief_generation_claims
				 WHERE cache_key = ?1 AND owner_user_id = ?2 AND claim_token = ?3`,
          cacheKey,
          ownerUserId,
          claimToken,
        ),
      ][0]?.total ?? 0;
    if (before === 0) return false;
    this.ctx.storage.sql.exec(
      `DELETE FROM today_brief_generation_claims
			 WHERE cache_key = ?1 AND owner_user_id = ?2 AND claim_token = ?3`,
      cacheKey,
      ownerUserId,
      claimToken,
    );
    return true;
  }

  async updateEmail(
    id: string,
    { read, starred }: { read?: boolean; starred?: boolean },
    actor: ActivityActor = { kind: "system" },
  ) {
    if (read === undefined && starred === undefined) {
      return this.getEmail(id);
    }

    const occurredAt = new Date().toISOString();
    let visible = false;
    this.ctx.storage.transactionSync(() => {
      const current = this.db
        .select({
          id: schema.emails.id,
          read: schema.emails.read,
          starred: schema.emails.starred,
        })
        .from(schema.emails)
        .where(
          and(
            eq(schema.emails.id, id),
            sql`${schema.emails.folder_id} <> ${InternalFolders.RETIRED_OUTBOUND}`,
          ),
        )
        .get();
      if (!current) return;
      visible = true;
      const data: { read?: number; starred?: number } = {};
      if (read !== undefined && (current.read ?? 0) !== (read ? 1 : 0)) {
        data.read = read ? 1 : 0;
      }
      if (
        starred !== undefined &&
        (current.starred ?? 0) !== (starred ? 1 : 0)
      ) {
        data.starred = starred ? 1 : 0;
      }
      if (Object.keys(data).length === 0) return;
      this.db
        .update(schema.emails)
        .set(data)
        .where(
          and(
            eq(schema.emails.id, id),
            sql`${schema.emails.folder_id} <> ${InternalFolders.RETIRED_OUTBOUND}`,
          ),
        )
        .run();
      if (data.read !== undefined) {
        this.#recordActivity(
          actor,
          "email_updated",
          "email",
          id,
          { read },
          occurredAt,
        );
      }
      if (data.starred !== undefined) {
        this.#recordActivity(
          actor,
          "email_updated",
          "email",
          id,
          { starred },
          occurredAt,
        );
      }
    });

    return visible ? this.getEmail(id) : null;
  }

  async markThreadRead(
    threadId: string,
    actor: ActivityActor = { kind: "system" },
  ) {
    const occurredAt = new Date().toISOString();
    let markedRead = false;
    this.ctx.storage.transactionSync(() => {
      const visibleUnread = [
        ...this.ctx.storage.sql.exec(
          `SELECT 1 FROM emails
				 WHERE thread_id = ? AND read = 0 AND folder_id <> ?
				 LIMIT 1`,
          threadId,
          InternalFolders.RETIRED_OUTBOUND,
        ),
      ];
      if (visibleUnread.length === 0) return;
      this.ctx.storage.sql.exec(
        `UPDATE emails SET read = 1
				 WHERE thread_id = ? AND read = 0 AND folder_id <> ?`,
        threadId,
        InternalFolders.RETIRED_OUTBOUND,
      );
      markedRead = true;
      this.#recordActivity(
        actor,
        "thread_marked_read",
        "thread",
        threadId,
        {},
        occurredAt,
      );
    });
    return { threadId, markedRead };
  }

  #conversationScope(conversationId: string, folderId: string) {
    const folder = this.db
      .select({ id: schema.folders.id })
      .from(schema.folders)
      .where(
        or(eq(schema.folders.id, folderId), eq(schema.folders.name, folderId)),
      )
      .limit(1)
      .get();
    if (!folder || isInternalFolderId(folder.id)) return null;
    const rows = [
      ...this.ctx.storage.sql.exec(
        `WITH
			folder_emails AS (
				SELECT id, thread_id,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = ?1
			),
			thread_to_conversation AS (
				SELECT raw_thread_id,
					${CONVERSATION_ID_SQL} as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			)
			SELECT fe.id
			FROM folder_emails fe
			LEFT JOIN thread_to_conversation tc ON fe.raw_thread_id = tc.raw_thread_id
			WHERE COALESCE(tc.conversation_id, fe.raw_thread_id) = ?2`,
        folder.id,
        conversationId,
      ),
    ] as Array<{ id: string }>;
    return { folderId: folder.id, emailIds: rows.map((row) => row.id) };
  }

  async setConversationRead(
    conversationId: string,
    folderId: string,
    read: boolean,
    actor: ActivityActor = { kind: "system" },
  ) {
    const scope = this.#conversationScope(conversationId, folderId);
    if (!scope || scope.emailIds.length === 0) {
      return { status: "not_found" as const, affectedCount: 0 };
    }
    const occurredAt = new Date().toISOString();
    let affectedCount = 0;
    this.ctx.storage.transactionSync(() => {
      const changedIds = this.db
        .select({ id: schema.emails.id })
        .from(schema.emails)
        .where(
          and(
            inArray(schema.emails.id, scope.emailIds),
            sql`COALESCE(${schema.emails.read}, 0) <> ${read ? 1 : 0}`,
          ),
        )
        .all()
        .map((row) => row.id);
      affectedCount = changedIds.length;
      if (affectedCount === 0) return;
      this.db
        .update(schema.emails)
        .set({ read: read ? 1 : 0 })
        .where(inArray(schema.emails.id, changedIds))
        .run();
      this.#recordActivity(
        actor,
        "conversation_read_state_changed",
        "conversation",
        conversationId,
        {
          folderId: scope.folderId,
          read,
          affectedCount,
        },
        occurredAt,
      );
    });
    return { status: "updated" as const, affectedCount };
  }

  async archiveConversation(
    conversationId: string,
    folderId: string,
    representativeEmailId: string,
    actor: ActivityActor = { kind: "system" },
  ) {
    return this.#moveConversationInFolder(
      conversationId,
      folderId,
      Folders.ARCHIVE,
      representativeEmailId,
      actor,
    );
  }

  async trashConversation(
    conversationId: string,
    folderId: string,
    representativeEmailId: string,
    actor: ActivityActor = { kind: "system" },
  ) {
    return this.#moveConversationInFolder(
      conversationId,
      folderId,
      Folders.TRASH,
      representativeEmailId,
      actor,
    );
  }

  async batchTriage(command: BatchTriageCommand, actor: ActivityActor) {
    const repository: BatchTriageRepository = {
      transaction: (run) => this.ctx.storage.transactionSync(run),
      resolveFolder: (folderId) => this.#visibleFolderId(folderId),
      resolveTarget: (target) => {
        const folderId = this.#visibleFolderId(target.folderId);
        if (!folderId) return null;
        if (!target.conversationId) {
          const email = this.db
            .select({ id: schema.emails.id })
            .from(schema.emails)
            .where(
              and(
                eq(schema.emails.id, target.emailId),
                eq(schema.emails.folder_id, folderId),
              ),
            )
            .get();
          return email ? { emailIds: [email.id], folderId } : null;
        }

        const scope = this.#conversationScope(target.conversationId, folderId);
        if (!scope || !scope.emailIds.includes(target.emailId)) return null;
        return { emailIds: scope.emailIds, folderId: scope.folderId };
      },
      isTargetStateSatisfied: (target, targetFolderId) => {
        const folderId = this.#visibleFolderId(targetFolderId);
        if (!folderId) return false;
        if (!target.conversationId) {
          return Boolean(
            this.db
              .select({ id: schema.emails.id })
              .from(schema.emails)
              .where(
                and(
                  eq(schema.emails.id, target.emailId),
                  eq(schema.emails.folder_id, folderId),
                ),
              )
              .get(),
          );
        }
        const scope = this.#conversationScope(target.conversationId, folderId);
        return Boolean(scope?.emailIds.includes(target.emailId));
      },
      hasActiveOutbound: (emailIds) =>
        Boolean(
          this.db
            .select({ id: schema.outboundDeliveries.id })
            .from(schema.outboundDeliveries)
            .where(
              and(
                inArray(schema.outboundDeliveries.email_id, emailIds),
                inArray(schema.outboundDeliveries.status, [
                  "queued",
                  "sending",
                  "retrying",
                ]),
              ),
            )
            .limit(1)
            .get(),
        ),
      setRead: (emailIds, read) => {
        const changedIds = this.db
          .select({ id: schema.emails.id })
          .from(schema.emails)
          .where(
            and(
              inArray(schema.emails.id, emailIds),
              sql`COALESCE(${schema.emails.read}, 0) <> ${read ? 1 : 0}`,
            ),
          )
          .all()
          .map((row) => row.id);
        if (changedIds.length === 0) return 0;
        this.db
          .update(schema.emails)
          .set({ read: read ? 1 : 0 })
          .where(inArray(schema.emails.id, changedIds))
          .run();
        return changedIds.length;
      },
      move: (emailIds, fromFolderId, toFolderId) => {
        const occurredAt = new Date().toISOString();
        this.db
          .update(schema.emails)
          .set({
            folder_id: toFolderId,
            ...(toFolderId === Folders.TRASH
              ? { previous_folder_id: fromFolderId, trashed_at: occurredAt }
              : { previous_folder_id: null, trashed_at: null }),
          })
          .where(inArray(schema.emails.id, emailIds))
          .run();
      },
      recordActivity: ({
        actor: activityActor,
        action,
        target,
        affectedCount,
      }) => {
        this.#recordActivity(
          activityActor,
          action,
          target.conversationId ? "conversation" : "email",
          target.conversationId ?? target.emailId,
          {
            representativeEmailId: target.emailId,
            folderId: target.folderId,
            affectedCount,
          },
        );
      },
    };
    return executeBatchTriage(repository, command, actor);
  }

  #snoozeRepository(): SnoozeRepository {
    return {
      transaction: (run) => this.ctx.storage.transactionSync(run),
      resolveScope: (scope, mode) => {
        const folderReference =
          mode === "unsnooze"
            ? Folders.SNOOZED
            : scope.kind === "conversation"
              ? scope.folderId
              : null;
        let emailIds: string[];
        if (scope.kind === "message") {
          emailIds = [scope.emailId];
        } else {
          const conversation = this.#conversationScope(
            scope.conversationId,
            folderReference!,
          );
          if (!conversation || !conversation.emailIds.includes(scope.emailId)) {
            return null;
          }
          if (conversation.emailIds.length > 100) return { tooLarge: true };
          emailIds = conversation.emailIds;
        }
        const rows = this.db
          .select({
            id: schema.emails.id,
            folderId: schema.emails.folder_id,
            sourceFolderId: schema.emails.snooze_source_folder_id,
          })
          .from(schema.emails)
          .where(inArray(schema.emails.id, emailIds))
          .all();
        if (rows.length !== emailIds.length) return null;
        return rows;
      },
      hasActiveOutbound: (emailIds) =>
        Boolean(
          this.db
            .select({ id: schema.outboundDeliveries.id })
            .from(schema.outboundDeliveries)
            .where(
              and(
                inArray(schema.outboundDeliveries.email_id, emailIds),
                inArray(schema.outboundDeliveries.status, [
                  "queued",
                  "sending",
                  "retrying",
                ]),
              ),
            )
            .limit(1)
            .get(),
        ),
      folderExists: (folderId) =>
        Boolean(
          this.db
            .select({ id: schema.folders.id })
            .from(schema.folders)
            .where(eq(schema.folders.id, folderId))
            .get(),
        ),
      applySnooze: ({ emailIds, sourceFolderId, wakeAt }) => {
        this.db
          .update(schema.emails)
          .set({
            folder_id: Folders.SNOOZED,
            snooze_source_folder_id: sourceFolderId,
            snoozed_until: wakeAt,
            previous_folder_id: null,
            trashed_at: null,
          })
          .where(inArray(schema.emails.id, emailIds))
          .run();
      },
      clearSnooze: ({ targets }) => {
        for (const target of targets) {
          this.db
            .update(schema.emails)
            .set({
              folder_id: target.folderId,
              snooze_source_folder_id: null,
              snoozed_until: null,
            })
            .where(eq(schema.emails.id, target.id))
            .run();
        }
      },
      recordActivity: ({ actor, action, entityType, entityId, metadata }) =>
        this.#recordActivity(actor, action, entityType, entityId, metadata),
    };
  }

  async snooze(input: unknown, actor: ActivityActor = { kind: "system" }) {
    const request = normalizeSnoozeRequest(input);
    const result = executeSnooze(this.#snoozeRepository(), request, actor);
    if (result.status === "snoozed") {
      await finalizeCommittedSnooze({
        ensureAlarm: () => this.#scheduleAlarmAt(Date.parse(request.wakeAt)),
        logFailure: (error) =>
          console.error("failed to schedule Snooze wake alarm", {
            wakeAt: request.wakeAt,
            error: error instanceof Error ? error.message : String(error),
          }),
      });
    }
    return result;
  }

  async unsnooze(input: unknown, actor: ActivityActor = { kind: "system" }) {
    return executeUnsnooze(
      this.#snoozeRepository(),
      normalizeSnoozeScope(input),
      actor,
    );
  }

  #moveConversationInFolder(
    conversationId: string,
    folderId: string,
    targetFolderId: string,
    representativeEmailId: string,
    actor: ActivityActor,
  ) {
    const sourceFolderId = this.#visibleFolderId(folderId);
    const policyFolderId = sourceFolderId ?? folderId;
    const action = targetFolderId === Folders.ARCHIVE ? "archive" : "trash";
    if (!isBatchTriageActionAllowed(action, policyFolderId)) {
      return { status: "invalid_action" as const, affectedCount: 0 };
    }
    const target = this.db
      .select({ id: schema.folders.id })
      .from(schema.folders)
      .where(eq(schema.folders.id, targetFolderId))
      .get();
    if (!target || isInternalFolderId(target.id)) {
      return { status: "not_found" as const, affectedCount: 0 };
    }
    const targetScope = this.#conversationScope(conversationId, target.id);
    if (targetScope?.emailIds.includes(representativeEmailId)) {
      return {
        status:
          target.id === Folders.TRASH
            ? ("trashed" as const)
            : ("archived" as const),
        affectedCount: 0,
      };
    }
    if (!sourceFolderId) {
      return { status: "not_found" as const, affectedCount: 0 };
    }

    const scope = this.#conversationScope(conversationId, sourceFolderId);
    if (
      !scope ||
      scope.emailIds.length === 0 ||
      !scope.emailIds.includes(representativeEmailId)
    ) {
      return { status: "not_found" as const, affectedCount: 0 };
    }
    if (scope.folderId === Folders.SNOOZED) {
      return {
        status: "snoozed_state_requires_unsnooze" as const,
        affectedCount: 0,
      };
    }
    const snoozedMember = this.db
      .select({ id: schema.emails.id })
      .from(schema.emails)
      .where(
        and(
          inArray(schema.emails.id, scope.emailIds),
          or(
            eq(schema.emails.folder_id, Folders.SNOOZED),
            isNotNull(schema.emails.snoozed_until),
            isNotNull(schema.emails.snooze_source_folder_id),
          ),
        ),
      )
      .limit(1)
      .get();
    if (snoozedMember) {
      return {
        status: "snoozed_state_requires_unsnooze" as const,
        affectedCount: 0,
      };
    }
    const active = this.db
      .select({ id: schema.outboundDeliveries.id })
      .from(schema.outboundDeliveries)
      .where(
        and(
          inArray(schema.outboundDeliveries.email_id, scope.emailIds),
          inArray(schema.outboundDeliveries.status, [
            "queued",
            "sending",
            "retrying",
          ]),
        ),
      )
      .limit(1)
      .get();
    if (active) {
      return { status: "outbound_delivery_active" as const, affectedCount: 0 };
    }
    const occurredAt = new Date().toISOString();
    const isTrash = target.id === Folders.TRASH;
    this.ctx.storage.transactionSync(() => {
      this.db
        .update(schema.emails)
        .set({
          folder_id: target.id,
          ...(isTrash
            ? { previous_folder_id: scope.folderId, trashed_at: occurredAt }
            : { previous_folder_id: null, trashed_at: null }),
        })
        .where(inArray(schema.emails.id, scope.emailIds))
        .run();
      this.#recordActivity(
        actor,
        isTrash ? "conversation_trashed" : "conversation_archived",
        "conversation",
        conversationId,
        {
          fromFolderId: scope.folderId,
          toFolderId: target.id,
          affectedCount: scope.emailIds.length,
        },
        occurredAt,
      );
    });
    return {
      status: isTrash ? ("trashed" as const) : ("archived" as const),
      affectedCount: scope.emailIds.length,
    };
  }

  async deleteEmail(id: string) {
    const email = this.db
      .select({
        id: schema.emails.id,
        folder_id: schema.emails.folder_id,
        recipient_memory_origin: schema.emails.recipient_memory_origin,
        snooze_source_folder_id: schema.emails.snooze_source_folder_id,
        snoozed_until: schema.emails.snoozed_until,
        draft_version: schema.emails.draft_version,
      })
      .from(schema.emails)
      .where(eq(schema.emails.id, id))
      .get();

    if (
      !email ||
      isInternalFolderId(email.folder_id) ||
      snoozeBlocksGenericMove({
        folderId: email.folder_id,
        wakeAt: email.snoozed_until,
        sourceFolderId: email.snooze_source_folder_id,
      })
    )
      return null;

    const emailAttachments = this.db
      .select({
        id: schema.attachments.id,
        email_id: schema.attachments.email_id,
        filename: schema.attachments.filename,
        r2_key: schema.attachments.r2_key,
      })
      .from(schema.attachments)
      .where(eq(schema.attachments.email_id, id))
      .all();

    const bodyObjects = this.db
      .select()
      .from(schema.emailBodyObjects)
      .where(eq(schema.emailBodyObjects.email_id, id))
      .all();
    const occurredAt = new Date().toISOString();
    const tombstoneLiveInbound =
      email.recipient_memory_origin === RecipientMemoryOrigins.LIVE_INBOUND;
    if (
      tombstoneLiveInbound &&
      (emailAttachments.length > 0 || bodyObjects.length > 0)
    ) {
      await this.#scheduleAlarmAt(Date.now() + 100);
    }
    this.ctx.storage.transactionSync(() => {
      this.#markDraftCreateOperation(
        id,
        "deleted",
        email.draft_version,
        occurredAt,
      );
      this.#refreshTerminalDraftSaveRetention(id, occurredAt);
      if (tombstoneLiveInbound) {
        const archiveAuthority = this.db
          .select({
            id: schema.inboundDeliveryAuthorities.id,
            state: schema.inboundDeliveryAuthorities.state,
          })
          .from(schema.inboundDeliveryAuthorities)
          .where(eq(schema.inboundDeliveryAuthorities.id, id))
          .get();
        const directAuthority = this.db
          .select({
            id: schema.directInboundDeliveryAuthorities.id,
            state: schema.directInboundDeliveryAuthorities.state,
          })
          .from(schema.directInboundDeliveryAuthorities)
          .where(eq(schema.directInboundDeliveryAuthorities.id, id))
          .get();
        if (archiveAuthority && directAuthority) {
          throw new Error("Inbound email has conflicting authority owners");
        }
        if (
          archiveAuthority?.state !== undefined &&
          archiveAuthority.state !== "projected"
        ) {
          throw new Error("Inbound archive authority is not projected");
        }
        if (
          directAuthority?.state !== undefined &&
          directAuthority.state !== "projected"
        ) {
          throw new Error("Direct inbound authority is not projected");
        }
        const keys = [
          ...emailAttachments.map((attachment) =>
            storedAttachmentKey(attachment),
          ),
          ...bodyObjects.map((bodyObject) => bodyObject.r2_key),
        ];
        for (const key of keys) {
          this.#enqueueR2DeletionSync({
            r2Key: key,
            emailId: id,
            projectionAttemptId: projectionAttemptIdFromDerivedContentKey(
              id,
              key,
            ),
            createdAt: occurredAt,
          });
        }
        this.db
          .insert(schema.emailDeletionTombstones)
          .values({ id, deleted_at: occurredAt })
          .onConflictDoUpdate({
            target: schema.emailDeletionTombstones.id,
            set: { deleted_at: occurredAt },
          })
          .run();
        if (archiveAuthority?.state === "projected") {
          this.db
            .update(schema.inboundDeliveryAuthorities)
            .set({
              state: "deleted",
              generation: sql`${schema.inboundDeliveryAuthorities.generation} + 1`,
              deleted_at: occurredAt,
            })
            .where(eq(schema.inboundDeliveryAuthorities.id, id))
            .run();
        } else if (directAuthority?.state === "projected") {
          this.db
            .update(schema.directInboundDeliveryAuthorities)
            .set({
              state: "deleted",
              generation: sql`${schema.directInboundDeliveryAuthorities.generation} + 1`,
              deleted_at: occurredAt,
            })
            .where(eq(schema.directInboundDeliveryAuthorities.id, id))
            .run();
        }
        if (archiveAuthority?.state === "projected") {
          this.db
            .delete(schema.inboundTerminalFailures)
            .where(eq(schema.inboundTerminalFailures.id, id))
            .run();
        }
      }
      this.db.delete(schema.emails).where(eq(schema.emails.id, id)).run();
    });
    return emailAttachments;
  }

  /** Permanently remove only a draft the user explicitly chose to discard. */
  async discardDraft(
    id: string,
    expectedVersion: number,
    actor: ActivityActor = { kind: "system" },
  ) {
    const email = this.db
      .select({
        id: schema.emails.id,
        folder_id: schema.emails.folder_id,
        draft_version: schema.emails.draft_version,
      })
      .from(schema.emails)
      .where(eq(schema.emails.id, id))
      .get();

    if (!email) return null;
    if (email.folder_id !== Folders.DRAFT) {
      return { status: "not_draft" as const };
    }
    if (email.draft_version !== expectedVersion) {
      return {
        status: "version_conflict" as const,
        currentVersion: email.draft_version,
      };
    }

    const emailAttachments = this.db
      .select({
        id: schema.attachments.id,
        email_id: schema.attachments.email_id,
        filename: schema.attachments.filename,
        r2_key: schema.attachments.r2_key,
      })
      .from(schema.attachments)
      .where(eq(schema.attachments.email_id, id))
      .all();
    const occurredAt = new Date().toISOString();

    this.ctx.storage.transactionSync(() => {
      this.#markDraftCreateOperation(
        id,
        "discarded",
        expectedVersion,
        occurredAt,
      );
      this.#refreshTerminalDraftSaveRetention(id, occurredAt);
	  for (const attachment of emailAttachments) {
		this.#enqueueR2DeletionSync({
		  r2Key: storedAttachmentKey(attachment),
		  emailId: id,
		  projectionAttemptId: null,
		  createdAt: occurredAt,
		});
	  }
      this.db
        .delete(schema.emails)
        .where(
          and(
            eq(schema.emails.id, id),
            eq(schema.emails.draft_version, expectedVersion),
          ),
        )
        .run();
      this.#recordActivity(
        actor,
        "draft_discarded",
        "email",
        id,
        { attachmentCount: emailAttachments.length },
        occurredAt,
      );
    });
	if (emailAttachments.length > 0) {
	  try {
		await this.#scheduleAlarmAt(Date.now() + 100);
	  } catch (error) {
		console.error("Draft discarded with durable attachment cleanup pending", {
		  draftId: id,
		  objectCount: emailAttachments.length,
		  errorName: error instanceof Error ? error.name : "UnknownError",
		});
	  }
	}

    return { status: "discarded" as const };
  }

  #applyDraftUpdate(input: {
    draftId: string;
    expectedVersion: number;
    changes: { recipient: string; subject: string; body: string };
    actor: ActivityActor;
  }) {
    const draft = this.db
      .select({
        id: schema.emails.id,
        folder_id: schema.emails.folder_id,
        draft_version: schema.emails.draft_version,
      })
      .from(schema.emails)
      .where(eq(schema.emails.id, input.draftId))
      .get();
    if (!draft) return null;
    if (draft.folder_id !== Folders.DRAFT) {
      return { status: "not_draft" as const };
    }
    if (draft.draft_version !== input.expectedVersion) {
      return {
        status: "version_conflict" as const,
        currentVersion: draft.draft_version,
      };
    }

    const occurredAt = new Date().toISOString();
    const resultVersion = input.expectedVersion + 1;
    this.db
      .update(schema.emails)
      .set({
        recipient: input.changes.recipient.toLowerCase(),
        subject: input.changes.subject,
        body: input.changes.body,
        date: occurredAt,
        draft_version: resultVersion,
      })
      .where(
        and(
          eq(schema.emails.id, input.draftId),
          eq(schema.emails.draft_version, input.expectedVersion),
        ),
      )
      .run();
    this.#markDraftCreateOperation(
      input.draftId,
      "active",
      resultVersion,
      occurredAt,
    );
    this.#recordActivity(
      input.actor,
      "draft_updated",
      "email",
      input.draftId,
      {},
      occurredAt,
    );
    return {
      status: "updated" as const,
      draftId: input.draftId,
      draftVersion: resultVersion,
      occurredAt,
    };
  }

  async updateDraft(
    id: string,
    expectedVersion: number,
    changes: { recipient: string; subject: string; body: string },
    actor: ActivityActor = { kind: "system" },
  ) {
    const result = this.ctx.storage.transactionSync(() =>
      this.#applyDraftUpdate({
        draftId: id,
        expectedVersion,
        changes,
        actor,
      }),
    );
    if (!result || result.status !== "updated") return result;
    return {
      status: result.status,
      draftId: result.draftId,
      draftVersion: result.draftVersion,
    };
  }

  async getDraftUpdateOutcome(updateKey: string, fingerprint: string) {
    const operation = this.db
      .select()
      .from(schema.draftUpdateOperations)
      .where(eq(schema.draftUpdateOperations.update_key, updateKey))
      .get();
    if (!operation) return { status: "missing" as const };
    if (operation.fingerprint !== fingerprint) {
      return { status: "conflict" as const };
    }
    return {
      status: "replay" as const,
      draftId: operation.draft_id,
      resultVersion: operation.result_version,
    };
  }

  async updateDraftIdempotently(input: {
    updateKey: string;
    fingerprint: string;
    draftId: string;
    expectedVersion: number;
    changes: { recipient: string; subject: string; body: string };
    actor?: ActivityActor;
  }) {
    return this.ctx.storage.transactionSync(() => {
      const prior = this.db
        .select()
        .from(schema.draftUpdateOperations)
        .where(eq(schema.draftUpdateOperations.update_key, input.updateKey))
        .get();
      if (prior) {
        return prior.fingerprint === input.fingerprint
          ? {
              status: "replay" as const,
              draftId: prior.draft_id,
              draftVersion: prior.result_version,
            }
          : { status: "idempotency_conflict" as const };
      }

      const result = this.#applyDraftUpdate({
        draftId: input.draftId,
        expectedVersion: input.expectedVersion,
        changes: input.changes,
        actor: input.actor ?? { kind: "system" },
      });
      if (!result) return { status: "not_found" as const };
      if (result.status !== "updated") return result;
      this.db
        .insert(schema.draftUpdateOperations)
        .values({
          update_key: input.updateKey,
          fingerprint: input.fingerprint,
          draft_id: input.draftId,
          previous_version: input.expectedVersion,
          result_version: result.draftVersion,
          committed_at: result.occurredAt,
        })
        .run();
      return {
        status: "updated" as const,
        draftId: input.draftId,
        draftVersion: result.draftVersion,
      };
    });
  }

  #getDraftCreateRecord(createKey: string): {
    id: string;
    fingerprint: string;
    draftVersion: number;
    state: "active" | "discarded" | "consumed" | "deleted" | "unavailable";
  } | null {
    const row = this.db
      .select({
        id: schema.draftCreateOperations.draft_id,
        fingerprint: schema.draftCreateOperations.fingerprint,
        draft_version: schema.draftCreateOperations.draft_version,
        state: schema.draftCreateOperations.state,
      })
      .from(schema.draftCreateOperations)
      .where(eq(schema.draftCreateOperations.create_key, createKey))
      .limit(1)
      .get();
    return row
      ? {
          id: row.id,
          fingerprint: row.fingerprint,
          draftVersion: row.draft_version,
          state: row.state,
        }
      : null;
  }

  #markDraftCreateOperation(
    draftId: string,
    state: "active" | "discarded" | "consumed" | "deleted" | "unavailable",
    draftVersion: number,
    updatedAt: string,
  ) {
    this.db
      .update(schema.draftCreateOperations)
      .set({
        state,
        draft_version: draftVersion,
        updated_at: updatedAt,
      })
      .where(eq(schema.draftCreateOperations.draft_id, draftId))
      .run();
  }

  #refreshTerminalDraftSaveRetention(draftId: string, updatedAt: string) {
    this.db
      .update(schema.draftSaveOperations)
      .set({ updated_at: updatedAt })
      .where(
        and(
          eq(schema.draftSaveOperations.draft_id, draftId),
          inArray(schema.draftSaveOperations.state, ["committed", "aborted"]),
        ),
      )
      .run();
  }

  #getDraftCreateReplay(createKey: string, fingerprint: string) {
    const record = this.#getDraftCreateRecord(createKey);
    if (
      record &&
      record.fingerprint === fingerprint &&
      record.state !== "active"
    ) {
      return {
        status: "unavailable" as const,
        draftId: record.id,
        currentVersion: record.draftVersion,
        reason: record.state,
      };
    }
    const replay = classifyDraftCreateReplay(record, fingerprint);
    if (replay.status !== "replay") return replay;
    if (!record) return { status: "missing" as const };
    const draft = this.db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.id, replay.draftId))
      .get();
    if (!draft || draft.folder_id !== Folders.DRAFT) {
      return {
        status: "unavailable" as const,
        draftId: replay.draftId,
        currentVersion: draft?.draft_version ?? record.draftVersion,
        reason: "unavailable" as const,
      };
    }
    if (draft.draft_version !== 1) {
      return {
        status: "superseded" as const,
        draftId: replay.draftId,
        currentVersion: draft.draft_version,
      };
    }
    const emailAttachments = this.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.email_id, replay.draftId))
      .all();
    return {
      status: "replay" as const,
      draftId: replay.draftId,
      draft: {
        ...draft,
        read: !!draft.read,
        starred: !!draft.starred,
        attachments: emailAttachments,
        labels:
          this.#labelsForEmailIds([replay.draftId]).get(replay.draftId) ?? [],
      },
    };
  }

  #readDraftSnapshot(draftId: string) {
	const draft = this.db
	  .select()
	  .from(schema.emails)
	  .where(eq(schema.emails.id, draftId))
	  .get();
	if (!draft || draft.folder_id !== Folders.DRAFT) return null;
	return {
	  ...draft,
	  read: Boolean(draft.read),
	  starred: Boolean(draft.starred),
	  attachments: this.db
		.select()
		.from(schema.attachments)
		.where(eq(schema.attachments.email_id, draftId))
		.all(),
	  labels: this.#labelsForEmailIds([draftId]).get(draftId) ?? [],
	};
  }

  async getDraftCreateReplay(createKey: string, fingerprint: string) {
    return this.#getDraftCreateReplay(createKey, fingerprint);
  }

  async claimDraftSave(input: {
    saveKey: string;
    fingerprint: string;
    draftId: string;
    expectedVersion: number;
    claimToken: string;
    claimExpiresAt: number;
  }) {
    const claim = this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const retentionCutoff = new Date(
        now - DRAFT_SAVE_REPLAY_RETENTION_MS,
      ).toISOString();
      this.ctx.storage.sql.exec(
        `DELETE FROM draft_save_operations
				 WHERE save_key IN (
					SELECT save_key
					FROM draft_save_operations
					WHERE state IN ('committed', 'aborted')
					  AND updated_at <= ?
					ORDER BY updated_at, save_key
					LIMIT ?
				 )`,
        retentionCutoff,
        DRAFT_SAVE_PRUNE_BATCH,
      );
      const existingOperation = this.db
        .select()
        .from(schema.draftSaveOperations)
        .where(eq(schema.draftSaveOperations.save_key, input.saveKey))
        .get();
      if (
        existingOperation &&
        (existingOperation.fingerprint !== input.fingerprint ||
          existingOperation.draft_id !== input.draftId ||
          existingOperation.expected_version !== input.expectedVersion)
      ) {
        return { status: "key_conflict" as const };
      }
      if (existingOperation?.state === "committed") {
        return {
          status: "committed" as const,
          draftId: existingOperation.draft_id,
          committedVersion: existingOperation.committed_version,
          claimToken: existingOperation.claim_token,
		  draft: this.#readDraftSnapshot(existingOperation.draft_id),
        };
      }
      if (
        existingOperation?.state === "claimed" &&
        existingOperation.claim_expires_at > now
      ) {
        return { status: "in_progress" as const };
      }

      const expiredOperations = this.db
        .select({
          saveKey: schema.draftSaveOperations.save_key,
          destinationKeys: schema.draftSaveOperations.destination_keys,
          claimToken: schema.draftSaveOperations.claim_token,
        })
        .from(schema.draftSaveOperations)
        .where(
          and(
            eq(schema.draftSaveOperations.draft_id, input.draftId),
            eq(
              schema.draftSaveOperations.expected_version,
              input.expectedVersion,
            ),
            eq(schema.draftSaveOperations.state, "claimed"),
            lte(schema.draftSaveOperations.claim_expires_at, now),
          ),
        )
        .all();
      const staleCleanupPlans = expiredOperations.flatMap((operation) => {
        const plan = decodeDraftSaveDestinationPlan(operation.destinationKeys);
        if (plan.ok && plan.keys.length === 0) return [];
        return [{
          destinationKeys: plan.ok ? plan.keys : [],
          serializedDestinationKeys: plan.ok
            ? JSON.stringify(plan.keys)
            : operation.destinationKeys,
          promotionOwner: operation.claimToken ?? operation.saveKey,
          integrityFailure: !plan.ok,
        }];
      });
      const stalePromotions = staleCleanupPlans.flatMap((plan) =>
        plan.integrityFailure
          ? []
          : [{
              destinationKeys: plan.destinationKeys,
              promotionOwner: plan.promotionOwner,
            }],
      );
      const occurredAt = new Date(now).toISOString();
      for (const stalePlan of staleCleanupPlans) {
        this.db
          .insert(schema.draftSaveCleanupIntents)
          .values({
            claim_token: stalePlan.promotionOwner,
            draft_id: input.draftId,
            destination_keys: stalePlan.serializedDestinationKeys,
            next_attempt_at: now + DRAFT_SAVE_CLEANUP_INITIAL_DELAY_MS,
            verify_until: now + DRAFT_SAVE_REPLAY_RETENTION_MS,
            attempts: 0,
            state: stalePlan.integrityFailure ? "parked" : "pending",
            last_error_code: stalePlan.integrityFailure
              ? "draft_save_destination_plan_invalid"
              : null,
            parked_at: stalePlan.integrityFailure ? now : null,
            updated_at: occurredAt,
          })
          .onConflictDoUpdate({
            target: schema.draftSaveCleanupIntents.claim_token,
            set: {
              destination_keys: stalePlan.serializedDestinationKeys,
              next_attempt_at: now + DRAFT_SAVE_CLEANUP_INITIAL_DELAY_MS,
              verify_until: now + DRAFT_SAVE_REPLAY_RETENTION_MS,
              state: stalePlan.integrityFailure ? "parked" : "pending",
              last_error_code: stalePlan.integrityFailure
                ? "draft_save_destination_plan_invalid"
                : null,
              parked_at: stalePlan.integrityFailure ? now : null,
              updated_at: occurredAt,
            },
          })
          .run();
      }
      this.db
        .update(schema.draftSaveOperations)
        .set({ state: "aborted", updated_at: new Date(now).toISOString() })
        .where(
          and(
            eq(schema.draftSaveOperations.draft_id, input.draftId),
            eq(
              schema.draftSaveOperations.expected_version,
              input.expectedVersion,
            ),
            eq(schema.draftSaveOperations.state, "claimed"),
            lte(schema.draftSaveOperations.claim_expires_at, now),
          ),
        )
        .run();
      const competingOperation = this.db
        .select({ saveKey: schema.draftSaveOperations.save_key })
        .from(schema.draftSaveOperations)
        .where(
          and(
            eq(schema.draftSaveOperations.draft_id, input.draftId),
            eq(
              schema.draftSaveOperations.expected_version,
              input.expectedVersion,
            ),
            eq(schema.draftSaveOperations.state, "claimed"),
          ),
        )
        .get();
      if (competingOperation) {
        return { status: "revision_in_progress" as const };
      }

      const draft = this.db
        .select({
          folderId: schema.emails.folder_id,
          draftVersion: schema.emails.draft_version,
        })
        .from(schema.emails)
        .where(eq(schema.emails.id, input.draftId))
        .get();
      if (input.expectedVersion === 0) {
        if (draft) {
          return {
            status: "version_conflict" as const,
            currentVersion: draft.draftVersion,
          };
        }
      } else if (!draft) {
        return { status: "not_found" as const };
      } else if (draft.folderId !== Folders.DRAFT) {
        return { status: "not_draft" as const };
      } else if (draft.draftVersion !== input.expectedVersion) {
        return {
          status: "version_conflict" as const,
          currentVersion: draft.draftVersion,
        };
      }

      this.db
        .insert(schema.draftSaveOperations)
        .values({
          save_key: input.saveKey,
          fingerprint: input.fingerprint,
          draft_id: input.draftId,
          expected_version: input.expectedVersion,
          state: "claimed",
          destination_keys: "[]",
          committed_version: null,
          claim_expires_at: input.claimExpiresAt,
          claim_token: input.claimToken,
          updated_at: occurredAt,
        })
        .onConflictDoUpdate({
          target: schema.draftSaveOperations.save_key,
          set: {
            state: "claimed",
            destination_keys: "[]",
            committed_version: null,
            claim_expires_at: input.claimExpiresAt,
            claim_token: input.claimToken,
            updated_at: occurredAt,
          },
        })
        .run();
      return { status: "claimed" as const, stalePromotions };
    });
    const nextDraftSaveAlarm = earliestMailboxAlarm([
      this.#nextDraftSaveCleanupAt(),
      this.#nextDraftSaveClaimExpiryAt(),
    ]);
    if (nextDraftSaveAlarm !== null) {
      try {
        await this.#scheduleAlarmAt(Math.max(Date.now(), nextDraftSaveAlarm));
      } catch (error) {
        console.error("Draft save recovery remains durably pending", {
          saveKey: input.saveKey,
          objectCount:
            claim.status === "claimed"
              ? claim.stalePromotions.reduce(
                  (count, promotion) => count + promotion.destinationKeys.length,
                  0,
                )
              : 0,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
    return claim;
  }

  async recordDraftSavePromotion(
    saveKey: string,
    fingerprint: string,
    claimToken: string,
    destinationKeys: string[],
  ) {
    const destinationPlan = decodeDraftSaveDestinationPlan(
      JSON.stringify(destinationKeys),
    );
    if (!destinationPlan.ok) return false;
    const recorded = this.ctx.storage.transactionSync(() => {
      const serializedDestinationKeys = JSON.stringify(destinationPlan.keys);
      this.db
        .update(schema.draftSaveOperations)
        .set({
          destination_keys: serializedDestinationKeys,
          updated_at: new Date().toISOString(),
        })
        .where(
          and(
            eq(schema.draftSaveOperations.save_key, saveKey),
            eq(schema.draftSaveOperations.fingerprint, fingerprint),
            eq(schema.draftSaveOperations.claim_token, claimToken),
            eq(schema.draftSaveOperations.state, "claimed"),
          ),
        )
        .run();
      const recorded = this.db
        .select({
          destinationKeys: schema.draftSaveOperations.destination_keys,
          claimExpiresAt: schema.draftSaveOperations.claim_expires_at,
        })
        .from(schema.draftSaveOperations)
        .where(
          and(
            eq(schema.draftSaveOperations.save_key, saveKey),
            eq(schema.draftSaveOperations.fingerprint, fingerprint),
            eq(schema.draftSaveOperations.claim_token, claimToken),
            eq(schema.draftSaveOperations.state, "claimed"),
          ),
        )
        .get();
      return recorded?.destinationKeys === serializedDestinationKeys
        ? recorded
        : null;
    });
    if (!recorded) return false;

    // This is the hard recovery gate before the caller writes any promoted R2
    // object. If the alarm cannot be armed, the save aborts without creating
    // bytes that have no autonomous expiry path.
    await this.#scheduleAlarmAt(
      Math.max(Date.now(), recorded.claimExpiresAt),
    );
    return true;
  }

  async abortDraftSave(
    saveKey: string,
    fingerprint: string,
    claimToken: string,
  ) {
    let cleanupQueued = 0;
    const result = this.ctx.storage.transactionSync(() => {
      const operation = this.db
        .select({
          draftId: schema.draftSaveOperations.draft_id,
          destinationKeys: schema.draftSaveOperations.destination_keys,
        })
        .from(schema.draftSaveOperations)
        .where(
          and(
            eq(schema.draftSaveOperations.save_key, saveKey),
            eq(schema.draftSaveOperations.fingerprint, fingerprint),
            eq(schema.draftSaveOperations.claim_token, claimToken),
            eq(schema.draftSaveOperations.state, "claimed"),
          ),
        )
        .get();
      if (!operation)
        return { status: "not_claimed" as const, destinationKeys: [] };
      const destinationPlan = decodeDraftSaveDestinationPlan(
        operation.destinationKeys,
      );
      const destinationKeys = destinationPlan.ok ? destinationPlan.keys : [];
      const cleanupNow = Date.now();
      const occurredAt = new Date(cleanupNow).toISOString();
      if (!destinationPlan.ok) {
        this.db
          .insert(schema.draftSaveCleanupIntents)
          .values({
            claim_token: claimToken,
            draft_id: operation.draftId,
            destination_keys: operation.destinationKeys,
            next_attempt_at: cleanupNow,
            verify_until: cleanupNow + DRAFT_SAVE_REPLAY_RETENTION_MS,
            attempts: 0,
            state: "parked",
            last_error_code: "draft_save_destination_plan_invalid",
            parked_at: cleanupNow,
            updated_at: occurredAt,
          })
          .onConflictDoNothing()
          .run();
        cleanupQueued = 1;
      } else if (destinationKeys.length > 0) {
        this.db
          .insert(schema.draftSaveCleanupIntents)
          .values({
            claim_token: claimToken,
            draft_id: operation.draftId,
            destination_keys: JSON.stringify(destinationKeys),
            next_attempt_at: cleanupNow,
            verify_until: cleanupNow + DRAFT_SAVE_REPLAY_RETENTION_MS,
            attempts: 0,
            state: "pending",
            last_error_code: null,
            parked_at: null,
            updated_at: occurredAt,
          })
          .onConflictDoUpdate({
            target: schema.draftSaveCleanupIntents.claim_token,
            set: {
              draft_id: operation.draftId,
              destination_keys: JSON.stringify(destinationKeys),
              next_attempt_at: cleanupNow,
              verify_until: cleanupNow + DRAFT_SAVE_REPLAY_RETENTION_MS,
              state: "pending",
              last_error_code: null,
              parked_at: null,
              updated_at: occurredAt,
            },
          })
          .run();
        cleanupQueued = destinationKeys.length;
      }
      this.db
        .update(schema.draftSaveOperations)
        .set({ state: "aborted", updated_at: occurredAt })
        .where(
          and(
            eq(schema.draftSaveOperations.save_key, saveKey),
            eq(schema.draftSaveOperations.fingerprint, fingerprint),
            eq(schema.draftSaveOperations.claim_token, claimToken),
            eq(schema.draftSaveOperations.state, "claimed"),
          ),
        )
        .run();
      return {
        status: "aborted" as const,
        promotionOwner: claimToken,
        destinationKeys,
      };
    });
    if (cleanupQueued > 0) {
      try {
        await this.#scheduleAlarmAt(Date.now() + 100);
      } catch (error) {
        console.error("Draft abort committed with durable attachment cleanup pending", {
          saveKey,
          objectCount: cleanupQueued,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
    return result;
  }

  async getDraftSaveOutcome(saveKey: string, fingerprint: string) {
    const operation = this.db
      .select()
      .from(schema.draftSaveOperations)
      .where(eq(schema.draftSaveOperations.save_key, saveKey))
      .get();
    if (!operation) return { status: "missing" as const };
    if (operation.fingerprint !== fingerprint) {
      return { status: "key_conflict" as const };
    }
    return {
      status: operation.state,
      draftId: operation.draft_id,
      committedVersion: operation.committed_version,
      claimToken: operation.claim_token,
	  ...(operation.state === "committed"
		? { draft: this.#readDraftSnapshot(operation.draft_id) }
		: {}),
    };
  }

  async getCommittedDraftAttachmentScope(
    draftId: string,
    committedVersion: number,
  ) {
    const operation = this.db
      .select({
        saveKey: schema.draftSaveOperations.save_key,
        claimToken: schema.draftSaveOperations.claim_token,
      })
      .from(schema.draftSaveOperations)
      .where(
        and(
          eq(schema.draftSaveOperations.draft_id, draftId),
          eq(schema.draftSaveOperations.state, "committed"),
          eq(schema.draftSaveOperations.committed_version, committedVersion),
        ),
      )
      .orderBy(desc(schema.draftSaveOperations.updated_at))
      .limit(1)
      .get();
    return operation ? (operation.claimToken ?? operation.saveKey) : null;
  }

  /**
   * Create or replace a draft in one SQL transaction. Existing drafts require
   * an exact expected version so two browser sessions cannot silently replace
   * each other's content or attachment rows.
   */
  async upsertDraft(
    input: {
      id: string;
      expectedVersion?: number;
      createKey?: string;
      createFingerprint?: string;
      subject: string;
      sender: string;
      recipient: string;
      cc: string | null;
      bcc: string | null;
      body: string;
      in_reply_to: string | null;
      thread_id: string;
      saveKey?: string;
      saveFingerprint?: string;
      saveClaimToken?: string;
	  stagingCleanupKeys?: string[];
    },
    attachments: AttachmentData[],
    actor: ActivityActor = { kind: "system" },
  ) {
	const stagingCleanupKeys = input.stagingCleanupKeys ?? [];
	if (
		stagingCleanupKeys.length > ATTACHMENT_LIMITS.maxFiles ||
		new Set(stagingCleanupKeys).size !== stagingCleanupKeys.length ||
		stagingCleanupKeys.some(
			(key) =>
				typeof key !== "string" ||
				key.length === 0 ||
				key.length > 1_024 ||
				!key.startsWith("uploads/") ||
				key.includes(".."),
		)
	) {
		throw new Error("Draft staging cleanup scope is invalid");
	}
	let cleanupQueued = 0;
	const result = this.ctx.storage.transactionSync(() => {
      const hasSaveClaim = Boolean(
        input.saveKey || input.saveFingerprint || input.saveClaimToken,
      );
      if (
        hasSaveClaim &&
        (!input.saveKey || !input.saveFingerprint || !input.saveClaimToken)
      ) {
        return { status: "save_claim_lost" as const };
      }
      if (input.saveKey && input.saveFingerprint && input.saveClaimToken) {
        const claim = this.db
          .select()
          .from(schema.draftSaveOperations)
          .where(eq(schema.draftSaveOperations.save_key, input.saveKey))
          .get();
        if (
          !claim ||
          claim.fingerprint !== input.saveFingerprint ||
          claim.claim_token !== input.saveClaimToken ||
          claim.draft_id !== input.id ||
          claim.expected_version !== (input.expectedVersion ?? 0) ||
          claim.state !== "claimed"
        ) {
          return { status: "save_claim_lost" as const };
        }
      }
      if (input.createKey && input.createFingerprint) {
        const replay = this.#getDraftCreateReplay(
          input.createKey,
          input.createFingerprint,
        );
        if (replay.status === "replay") {
          return {
            status: "creation_replay" as const,
            draftId: replay.draftId,
            draft: replay.draft,
          };
        }
        if (replay.status === "conflict") {
          return { ...replay, status: "creation_conflict" as const };
        }
        if (replay.status === "superseded") {
          return { ...replay, status: "creation_superseded" as const };
        }
        if (replay.status === "unavailable") {
          return { ...replay, status: "creation_unavailable" as const };
        }
      }
      const existing = this.db
        .select({
          id: schema.emails.id,
          folder_id: schema.emails.folder_id,
          draft_version: schema.emails.draft_version,
        })
        .from(schema.emails)
        .where(eq(schema.emails.id, input.id))
        .get();
      if (existing && existing.folder_id !== Folders.DRAFT) {
        return { status: "not_draft" as const };
      }
      if (!existing && input.expectedVersion !== undefined) {
        return { status: "not_found" as const };
      }
      if (
        existing &&
        (input.expectedVersion === undefined ||
          existing.draft_version !== input.expectedVersion)
      ) {
        return {
          status: "version_conflict" as const,
          currentVersion: existing.draft_version,
        };
      }

      const replacedAttachments = existing
        ? this.db
            .select({
          id: schema.attachments.id,
		  email_id: schema.attachments.email_id,
          filename: schema.attachments.filename,
		  r2_key: schema.attachments.r2_key,
            })
            .from(schema.attachments)
            .where(eq(schema.attachments.email_id, input.id))
            .all()
        : [];
      const draftVersion = existing ? existing.draft_version + 1 : 1;
      const occurredAt = new Date().toISOString();

      if (existing) {
        this.db
          .update(schema.emails)
          .set({
            subject: input.subject,
            sender: input.sender,
            recipient: input.recipient,
            cc: input.cc,
            bcc: input.bcc,
            date: occurredAt,
            body: input.body,
            in_reply_to: input.in_reply_to,
            thread_id: input.thread_id,
            draft_version: draftVersion,
          })
          .where(
            and(
              eq(schema.emails.id, input.id),
              eq(schema.emails.draft_version, input.expectedVersion!),
            ),
          )
          .run();
        this.db
          .delete(schema.attachments)
          .where(eq(schema.attachments.email_id, input.id))
          .run();
        this.#markDraftCreateOperation(
          input.id,
          "active",
          draftVersion,
          occurredAt,
        );
      } else {
        this.db
          .insert(schema.emails)
          .values({
            id: input.id,
            folder_id: Folders.DRAFT,
            subject: input.subject,
            sender: input.sender,
            recipient: input.recipient,
            cc: input.cc,
            bcc: input.bcc,
            date: occurredAt,
            read: 0,
            starred: 0,
            body: input.body,
            in_reply_to: input.in_reply_to,
            thread_id: input.thread_id,
            draft_create_key: input.createKey ?? null,
            draft_create_fingerprint: input.createFingerprint ?? null,
            draft_version: draftVersion,
          })
          .run();
        if (input.createKey && input.createFingerprint) {
          this.db
            .insert(schema.draftCreateOperations)
            .values({
              create_key: input.createKey,
              fingerprint: input.createFingerprint,
              draft_id: input.id,
              draft_version: 1,
              state: "active",
              updated_at: occurredAt,
            })
            .run();
        }
      }
      if (attachments.length > 0) {
        insertSqliteRowsBounded(attachments, 10, (chunk) => {
          this.db.insert(schema.attachments).values(chunk).run();
        });
      }
	  const cleanupCandidates = [
		...replacedAttachments.map((attachment) => ({
		  r2Key: storedAttachmentKey(attachment),
		  emailId: input.id,
		  projectionAttemptId: null,
		})),
		...stagingCleanupKeys.map((r2Key) => ({
		  r2Key,
		  emailId: input.id,
		  projectionAttemptId: null,
		})),
	  ];
	  if (cleanupCandidates.length > 0) {
		this.#enqueueUnownedR2DeletionSync(cleanupCandidates, occurredAt);
		cleanupQueued = cleanupCandidates.length;
	  }
      if (input.saveKey && input.saveFingerprint && input.saveClaimToken) {
        this.db
          .update(schema.draftSaveOperations)
          .set({
            state: "committed",
            committed_version: draftVersion,
            updated_at: occurredAt,
          })
          .where(
            and(
              eq(schema.draftSaveOperations.save_key, input.saveKey),
              eq(schema.draftSaveOperations.fingerprint, input.saveFingerprint),
              eq(schema.draftSaveOperations.claim_token, input.saveClaimToken),
              eq(schema.draftSaveOperations.state, "claimed"),
            ),
          )
          .run();
      }
      this.#recordActivity(
        actor,
        existing ? "draft_updated" : "draft_created",
        "email",
        input.id,
        { draftVersion },
        occurredAt,
      );
	  const savedDraft = this.#readDraftSnapshot(input.id);
	  if (!savedDraft || savedDraft.draft_version !== draftVersion) {
		throw new Error("Committed draft snapshot could not be materialized");
	  }
      return {
        status: "saved" as const,
        draftId: input.id,
        draftVersion,
        replacedAttachments,
		draft: savedDraft,
      };
    });
	if (cleanupQueued > 0) {
		try {
			await this.#scheduleAlarmAt(Date.now() + 100);
		} catch (error) {
			console.error("Draft committed with durable attachment cleanup pending", {
				draftId: input.id,
				objectCount: cleanupQueued,
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
		}
	}
	return result;
  }

  /** Consume only the exact draft revision captured by the outbound snapshot. */
  async consumeDraftVersion(
    id: string,
    expectedVersion: number,
    actor: ActivityActor = { kind: "system" },
  ) {
    return this.ctx.storage.transactionSync(() => {
      const draft = this.db
        .select({
          id: schema.emails.id,
          folder_id: schema.emails.folder_id,
          draft_version: schema.emails.draft_version,
        })
        .from(schema.emails)
        .where(eq(schema.emails.id, id))
        .get();
      if (!draft) return { status: "missing" as const };
      if (draft.folder_id !== Folders.DRAFT) {
        return { status: "not_draft" as const };
      }
      if (draft.draft_version !== expectedVersion) {
        return {
          status: "version_changed" as const,
          currentVersion: draft.draft_version,
        };
      }
      const draftAttachments = this.db
        .select({
          id: schema.attachments.id,
          email_id: schema.attachments.email_id,
          filename: schema.attachments.filename,
          r2_key: schema.attachments.r2_key,
        })
        .from(schema.attachments)
        .where(eq(schema.attachments.email_id, id))
        .all();
      const occurredAt = new Date().toISOString();
	  for (const attachment of draftAttachments) {
		this.#enqueueR2DeletionSync({
			r2Key: storedAttachmentKey(attachment),
			emailId: id,
			projectionAttemptId: null,
			createdAt: occurredAt,
		});
	  }
      this.#markDraftCreateOperation(
        id,
        "consumed",
        expectedVersion,
        occurredAt,
      );
      this.#refreshTerminalDraftSaveRetention(id, occurredAt);
      this.db
        .delete(schema.emails)
        .where(
          and(
            eq(schema.emails.id, id),
            eq(schema.emails.draft_version, expectedVersion),
          ),
        )
        .run();
      this.#recordActivity(
        actor,
        "draft_consumed_after_delivery",
        "email",
        id,
        { draftVersion: expectedVersion },
        occurredAt,
      );
      return {
        status: "consumed" as const,
        attachments: draftAttachments,
      };
    });
  }

  #nextDraftSaveCleanupAt() {
    return (
      this.db
        .select({
          nextAttemptAt: schema.draftSaveCleanupIntents.next_attempt_at,
        })
        .from(schema.draftSaveCleanupIntents)
        .where(eq(schema.draftSaveCleanupIntents.state, "pending"))
        .orderBy(
          asc(schema.draftSaveCleanupIntents.next_attempt_at),
          asc(schema.draftSaveCleanupIntents.claim_token),
        )
        .limit(1)
        .get()?.nextAttemptAt ?? null
    );
  }

  #nextDraftSaveClaimExpiryAt() {
    return (
      this.db
        .select({
          claimExpiresAt: schema.draftSaveOperations.claim_expires_at,
        })
        .from(schema.draftSaveOperations)
        .where(eq(schema.draftSaveOperations.state, "claimed"))
        .orderBy(
          asc(schema.draftSaveOperations.claim_expires_at),
          asc(schema.draftSaveOperations.save_key),
        )
        .limit(1)
        .get()?.claimExpiresAt ?? null
    );
  }

  #promoteExpiredDraftSaveClaimsToCleanup(now: number) {
    return this.ctx.storage.transactionSync(() => {
      const expiredOperations = this.db
        .select({
          saveKey: schema.draftSaveOperations.save_key,
          draftId: schema.draftSaveOperations.draft_id,
          destinationKeys: schema.draftSaveOperations.destination_keys,
          claimToken: schema.draftSaveOperations.claim_token,
        })
        .from(schema.draftSaveOperations)
        .where(
          and(
            eq(schema.draftSaveOperations.state, "claimed"),
            lte(schema.draftSaveOperations.claim_expires_at, now),
          ),
        )
        .orderBy(
          asc(schema.draftSaveOperations.claim_expires_at),
          asc(schema.draftSaveOperations.save_key),
        )
        .limit(DRAFT_SAVE_EXPIRY_SWEEP_BATCH)
        .all();
      const occurredAt = new Date(now).toISOString();
      let integrityFailures = 0;

      for (const operation of expiredOperations) {
        const destinationPlan = decodeDraftSaveDestinationPlan(
          operation.destinationKeys,
        );
        const promotionOwner = operation.claimToken ?? operation.saveKey;
        if (!destinationPlan.ok) integrityFailures += 1;
        if (!destinationPlan.ok || destinationPlan.keys.length > 0) {
          const serializedDestinationKeys = destinationPlan.ok
            ? JSON.stringify(destinationPlan.keys)
            : operation.destinationKeys;
          this.db
            .insert(schema.draftSaveCleanupIntents)
            .values({
              claim_token: promotionOwner,
              draft_id: operation.draftId,
              destination_keys: serializedDestinationKeys,
              next_attempt_at: now,
              verify_until: now + DRAFT_SAVE_REPLAY_RETENTION_MS,
              attempts: 0,
              state: destinationPlan.ok ? "pending" : "parked",
              last_error_code: destinationPlan.ok
                ? null
                : "draft_save_destination_plan_invalid",
              parked_at: destinationPlan.ok ? null : now,
              updated_at: occurredAt,
            })
            .onConflictDoUpdate({
              target: schema.draftSaveCleanupIntents.claim_token,
              set: {
                draft_id: operation.draftId,
                destination_keys: serializedDestinationKeys,
                next_attempt_at: now,
                verify_until: now + DRAFT_SAVE_REPLAY_RETENTION_MS,
                state: destinationPlan.ok ? "pending" : "parked",
                last_error_code: destinationPlan.ok
                  ? null
                  : "draft_save_destination_plan_invalid",
                parked_at: destinationPlan.ok ? null : now,
                updated_at: occurredAt,
              },
            })
            .run();
        }
        this.db
          .update(schema.draftSaveOperations)
          .set({ state: "aborted", updated_at: occurredAt })
          .where(
            and(
              eq(schema.draftSaveOperations.save_key, operation.saveKey),
              eq(schema.draftSaveOperations.state, "claimed"),
              lte(schema.draftSaveOperations.claim_expires_at, now),
            ),
          )
          .run();
      }

      return {
        moreDue:
          expiredOperations.length === DRAFT_SAVE_EXPIRY_SWEEP_BATCH,
        promoted: expiredOperations.length,
        integrityFailures,
      };
    });
  }

  async #processDraftSaveCleanup(now: number): Promise<number | null> {
    const intent = this.db
      .select()
      .from(schema.draftSaveCleanupIntents)
      .where(
        and(
          eq(schema.draftSaveCleanupIntents.state, "pending"),
          lte(schema.draftSaveCleanupIntents.next_attempt_at, now),
        ),
      )
      .orderBy(
        asc(schema.draftSaveCleanupIntents.next_attempt_at),
        asc(schema.draftSaveCleanupIntents.claim_token),
      )
      .limit(1)
      .get();
    if (!intent) return this.#nextDraftSaveCleanupAt();

    let succeeded = false;
    let integrityFailure = false;
    try {
      const destinationPlan = decodeDraftSaveDestinationPlan(
        intent.destination_keys,
      );
      if (!destinationPlan.ok) {
        integrityFailure = true;
        throw new Error(destinationPlan.code);
      }
      const ownedKeys: string[] = [];
      for (const key of destinationPlan.keys) {
        const object = await this.env.BUCKET.get(key);
        if (object?.customMetadata?.promotionOwner === intent.claim_token) {
          ownedKeys.push(key);
        }
      }
      if (ownedKeys.length > 0) await this.env.BUCKET.delete(ownedKeys);
      succeeded = true;
    } catch (error) {
      console.error("[draft-save-cleanup] verification failed", {
        draftId: intent.draft_id,
        attempts: intent.attempts + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const completedAt = Date.now();
    this.ctx.storage.transactionSync(() => {
      const current = this.db
        .select()
        .from(schema.draftSaveCleanupIntents)
        .where(
          eq(schema.draftSaveCleanupIntents.claim_token, intent.claim_token),
        )
        .get();
      if (!current || current.state !== "pending") return;
      if (integrityFailure) {
        this.db
          .update(schema.draftSaveCleanupIntents)
          .set({
            state: "parked",
            generation: current.generation + 1,
            attempts: current.attempts + 1,
            last_error_code: "draft_save_destination_plan_invalid",
            parked_at: completedAt,
            updated_at: new Date(completedAt).toISOString(),
          })
          .where(
            and(
              eq(schema.draftSaveCleanupIntents.claim_token, intent.claim_token),
              eq(schema.draftSaveCleanupIntents.state, "pending"),
              eq(schema.draftSaveCleanupIntents.generation, current.generation),
            ),
          )
          .run();
        return;
      }
      if (succeeded && completedAt >= current.verify_until) {
        this.db
          .delete(schema.draftSaveCleanupIntents)
          .where(
            eq(schema.draftSaveCleanupIntents.claim_token, intent.claim_token),
          )
          .run();
        return;
      }
      const attempts = current.attempts + 1;
      const delay = Math.min(
        DRAFT_SAVE_CLEANUP_INITIAL_DELAY_MS * 2 ** Math.min(attempts, 8),
        DRAFT_SAVE_CLEANUP_MAX_DELAY_MS,
      );
      this.db
        .update(schema.draftSaveCleanupIntents)
        .set({
          attempts,
          next_attempt_at: completedAt + delay,
          last_error_code: succeeded ? null : "draft_save_cleanup_r2_failed",
          updated_at: new Date(completedAt).toISOString(),
        })
        .where(
          eq(schema.draftSaveCleanupIntents.claim_token, intent.claim_token),
        )
        .run();
    });
    return this.#nextDraftSaveCleanupAt();
  }

  listParkedDraftSaveCleanupIntents(
    afterClaimToken: string | undefined,
    limit: number,
  ) {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.db
      .select({
        claimToken: schema.draftSaveCleanupIntents.claim_token,
        draftId: schema.draftSaveCleanupIntents.draft_id,
        generation: schema.draftSaveCleanupIntents.generation,
        attempts: schema.draftSaveCleanupIntents.attempts,
        lastErrorCode: schema.draftSaveCleanupIntents.last_error_code,
        parkedAt: schema.draftSaveCleanupIntents.parked_at,
      })
      .from(schema.draftSaveCleanupIntents)
      .where(
        and(
          eq(schema.draftSaveCleanupIntents.state, "parked"),
          ...(afterClaimToken
            ? [gt(schema.draftSaveCleanupIntents.claim_token, afterClaimToken)]
            : []),
        ),
      )
      .orderBy(asc(schema.draftSaveCleanupIntents.claim_token))
      .limit(boundedLimit + 1)
      .all();
    const hasMore = rows.length > boundedLimit;
    const items = rows.slice(0, boundedLimit);
    return {
      items,
      ...(hasMore ? { next: items.at(-1)?.claimToken } : {}),
    };
  }

  async repairParkedDraftSaveCleanupIntent(
    claimToken: string,
    input: { expectedGeneration: number; destinationKeys: string[] },
    actor: ActivityActor,
  ) {
    const destinationPlan = decodeDraftSaveDestinationPlan(
      JSON.stringify(input.destinationKeys),
    );
    if (!destinationPlan.ok || destinationPlan.keys.length === 0) {
      return { status: "invalid_plan" as const };
    }
    const repairedAt = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      const current = this.db
        .select()
        .from(schema.draftSaveCleanupIntents)
        .where(eq(schema.draftSaveCleanupIntents.claim_token, claimToken))
        .get();
      if (!current) return { status: "not_found" as const };
      if (current.state !== "parked") {
        return { status: "not_parked" as const };
      }
      if (current.generation !== input.expectedGeneration) {
        return {
          status: "generation_conflict" as const,
          generation: current.generation,
        };
      }
      const generation = current.generation + 1;
      const occurredAt = new Date(repairedAt).toISOString();
      this.db
        .update(schema.draftSaveCleanupIntents)
        .set({
          destination_keys: JSON.stringify(destinationPlan.keys),
          state: "pending",
          generation,
          attempts: 0,
          next_attempt_at: repairedAt,
          verify_until: repairedAt + DRAFT_SAVE_REPLAY_RETENTION_MS,
          last_error_code: null,
          parked_at: null,
          updated_at: occurredAt,
        })
        .where(
          and(
            eq(schema.draftSaveCleanupIntents.claim_token, claimToken),
            eq(schema.draftSaveCleanupIntents.state, "parked"),
            eq(schema.draftSaveCleanupIntents.generation, current.generation),
          ),
        )
        .run();
      this.#recordActivity(
        actor,
        "draft_save_cleanup_repaired",
        "draft",
        current.draft_id,
        { generation, objectCount: destinationPlan.keys.length },
        occurredAt,
      );
      return { status: "repaired" as const, generation };
    });
    if (result.status === "repaired") {
      try {
        await this.#scheduleAlarmAt(repairedAt + 100);
      } catch {
        console.error(
          "[draft-save-cleanup] repaired intent remains durably pending",
        );
      }
    }
    return result;
  }

  async queueAttachmentCleanup(
    emailId: string,
    keys: string[],
    actor: ActivityActor = { kind: "system" },
    promotionOwner?: string,
	  ) {
	    if (keys.length === 0) return;
	const createdAt = Date.now();
	await this.ctx.storage.transaction(async (transaction) => {
	  const queue =
		(await transaction.get<AttachmentCleanupJob[]>(
		  ATTACHMENT_CLEANUP_QUEUE_KEY,
		)) ?? [];
	  for (const key of [...new Set(keys)]) {
		queue.push({
		  id: crypto.randomUUID(),
		  emailId,
		  keys: [key],
		  ...(promotionOwner ? { promotionOwner } : {}),
		  attempts: 0,
		  createdAt,
		  state: "pending",
		  generation: 0,
		  nextAttemptAt: createdAt,
		});
	  }
	  await transaction.put(ATTACHMENT_CLEANUP_QUEUE_KEY, queue);
	});
	try {
	  this.#recordActivity(actor, "attachment_cleanup_queued", "email", emailId, {
		objectCount: keys.length,
	  });
	} catch (error) {
	  console.error("Attachment cleanup queued without activity projection", {
		emailId,
		objectCount: keys.length,
		errorName: error instanceof Error ? error.name : "UnknownError",
	  });
	}
	try {
	  await this.#scheduleAlarmAt(Date.now() + 100);
	} catch (error) {
	  console.error("Attachment cleanup remains durably pending", {
		emailId,
		objectCount: keys.length,
		errorName: error instanceof Error ? error.name : "UnknownError",
	  });
	}
  }

	#normalizeAttachmentCleanupQueue(
	  queue: AttachmentCleanupJob[],
	  now: number,
	): AttachmentCleanupJob[] {
	  return queue.flatMap((job) =>
		[...new Set(job.keys)]
		  .filter((key) => typeof key === "string" && key.length > 0 && key.length <= 1024)
		  .map((key, index) => ({
			...job,
			id: job.keys.length === 1 ? job.id : `${job.id}:${index}`,
			keys: [key],
			state: job.state === "parked" ? "parked" as const : "pending" as const,
			generation: Number.isInteger(job.generation) && (job.generation ?? 0) >= 0
			  ? job.generation
			  : 0,
			nextAttemptAt: Number.isFinite(job.nextAttemptAt)
			  ? job.nextAttemptAt
			  : now,
		  })),
	  );
	}

	#nextAttachmentCleanupAt(queue: AttachmentCleanupJob[]): number | null {
	  return queue
		.filter((job) => job.state !== "parked")
		.map((job) => job.nextAttemptAt ?? job.createdAt)
		.filter(Number.isFinite)
		.sort((a, b) => a - b)[0] ?? null;
	}

	  async #processAttachmentCleanup(now = Date.now()): Promise<number | null> {
	    const queue =
	      (await this.ctx.storage.get<AttachmentCleanupJob[]>(
	        ATTACHMENT_CLEANUP_QUEUE_KEY,
	      )) ?? [];
	const normalized = this.#normalizeAttachmentCleanupQueue(queue, now);
	const job = normalized
	  .filter((candidate) =>
		candidate.state !== "parked" && (candidate.nextAttemptAt ?? now) <= now,
	  )
	  .sort((a, b) =>
		(a.nextAttemptAt ?? a.createdAt) - (b.nextAttemptAt ?? b.createdAt) ||
		a.createdAt - b.createdAt || a.id.localeCompare(b.id),
	  )[0];
	if (!job) {
	  if (JSON.stringify(normalized) !== JSON.stringify(queue)) {
		await this.ctx.storage.put(ATTACHMENT_CLEANUP_QUEUE_KEY, normalized);
	  }
	  return this.#nextAttachmentCleanupAt(normalized);
	}
    let succeeded = false;
    try {
      if (job.promotionOwner) {
        const ownedKeys: string[] = [];
        for (const key of job.keys) {
          const object = await this.env.BUCKET.get(key);
          if (object?.customMetadata?.promotionOwner === job.promotionOwner) {
            ownedKeys.push(key);
          }
        }
        if (ownedKeys.length > 0) await this.env.BUCKET.delete(ownedKeys);
      } else {
        await this.env.BUCKET.delete(job.keys);
      }
      succeeded = true;
      this.#recordActivity(
        { kind: "system" },
        "attachment_cleanup_completed",
        "email",
        job.emailId,
        { objectCount: job.keys.length, attempts: job.attempts + 1 },
      );
	} catch {
	  console.error("[mail-cleanup] legacy attachment deletion failed", {
		count: 1,
		operation: "legacy_attachment_cleanup",
		status: "pending",
		errorCode: "R2_DELETION_FAILED",
	  });
    }
    // R2 I/O yields the input gate. Re-read before finalization so a cleanup
    // queued during that yield cannot be overwritten by this job's old snapshot.
	return this.ctx.storage.transaction(async (transaction) => {
	  const latestQueue = this.#normalizeAttachmentCleanupQueue(
		(await transaction.get<AttachmentCleanupJob[]>(
		  ATTACHMENT_CLEANUP_QUEUE_KEY,
		)) ?? [],
		now,
	  );
	  const latestJob = latestQueue.find(
		(candidate) => candidate.id === job.id && candidate.generation === job.generation,
	  );
	  if (succeeded) {
		const remaining = latestQueue.filter(
		  (candidate) =>
			candidate.id !== job.id || candidate.generation !== job.generation,
		);
		await transaction.put(ATTACHMENT_CLEANUP_QUEUE_KEY, remaining);
		return this.#nextAttachmentCleanupAt(remaining);
	  }
	  if (latestJob) {
		latestJob.attempts += 1;
		latestJob.generation = (latestJob.generation ?? 0) + 1;
		latestJob.lastErrorCode = "attachment_cleanup_r2_failed";
		if (latestJob.attempts >= 6) {
		  latestJob.state = "parked";
		  latestJob.parkedAt = now;
		  delete latestJob.nextAttemptAt;
		} else {
		  const delays = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
		  latestJob.nextAttemptAt = now + delays[latestJob.attempts - 1]!;
		}
	  }
	  await transaction.put(ATTACHMENT_CLEANUP_QUEUE_KEY, latestQueue);
	  return this.#nextAttachmentCleanupAt(latestQueue);
	});
	  }

	async listParkedAttachmentCleanupJobs(limit: number) {
	  const queue = this.#normalizeAttachmentCleanupQueue(
		(await this.ctx.storage.get<AttachmentCleanupJob[]>(ATTACHMENT_CLEANUP_QUEUE_KEY)) ?? [],
		Date.now(),
	  );
	  return {
		items: queue
		  .filter((job) => job.state === "parked")
		  .sort((a, b) => (a.parkedAt ?? 0) - (b.parkedAt ?? 0) || a.id.localeCompare(b.id))
		  .slice(0, Math.max(1, Math.min(100, Math.trunc(limit))))
		  .map((job) => ({
			recoveryRef: job.id,
			emailId: job.emailId,
			generation: job.generation ?? 0,
			attempts: job.attempts,
			lastErrorCode: job.lastErrorCode ?? null,
			parkedAt: job.parkedAt ?? null,
		  })),
	  };
	}

	async repairParkedAttachmentCleanupJob(
	  recoveryRef: string,
	  input: { operationKey: string; expectedGeneration: number },
	  actor: ActivityActor,
	) {
	  const now = Date.now();
	  const result = await this.ctx.storage.transaction(async (transaction) => {
		const queue = this.#normalizeAttachmentCleanupQueue(
		  (await transaction.get<AttachmentCleanupJob[]>(ATTACHMENT_CLEANUP_QUEUE_KEY)) ?? [],
		  now,
		);
		const job = queue.find((candidate) => candidate.id === recoveryRef);
		if (!job) return { status: "not_found" as const };
		if (job.state !== "parked") return { status: "not_parked" as const };
		if ((job.generation ?? 0) !== input.expectedGeneration) {
		  return { status: "generation_conflict" as const, generation: job.generation ?? 0 };
		}
		const generation = (job.generation ?? 0) + 1;
		job.state = "pending";
		job.generation = generation;
		job.attempts = 0;
		job.nextAttemptAt = now;
		delete job.lastErrorCode;
		delete job.parkedAt;
		await transaction.put(ATTACHMENT_CLEANUP_QUEUE_KEY, queue);
		return { status: "repaired" as const, generation, emailId: job.emailId };
	  });
	  if (result.status !== "repaired") return result;
	  try {
		this.#recordActivityOnce(
		  `attachment_cleanup_repaired:${recoveryRef}:${input.operationKey}`,
		  actor,
		  "attachment_cleanup_repaired",
		  "email",
		  result.emailId,
		  { generation: result.generation },
		  new Date(now).toISOString(),
		);
	  } catch {
		console.error("Attachment cleanup repair committed without activity projection", {
		  recoveryRef,
		});
	  }
	  try {
		await this.#scheduleAlarmAt(now + 100);
	  } catch {
		console.error("Attachment cleanup repair remains durably pending", {
		  recoveryRef,
		});
	  }
	  return { status: "repaired" as const, generation: result.generation };
	}

  #activeOutboundDeliveryForEmail(emailId: string) {
    const delivery = this.db
      .select({
        id: schema.outboundDeliveries.id,
        status: schema.outboundDeliveries.status,
      })
      .from(schema.outboundDeliveries)
      .where(eq(schema.outboundDeliveries.email_id, emailId))
      .limit(1)
      .get();
    return delivery &&
      outboundDeliveryBlocksGenericLifecycle(
        delivery.status as OutboundDeliveryStatus,
      )
      ? delivery
      : undefined;
  }

  /** Move user-visible mail to Trash without ever permanently deleting it. */
  async trashEmail(id: string, actor: ActivityActor = { kind: "system" }) {
    const email = this.db
      .select({
        id: schema.emails.id,
        folder_id: schema.emails.folder_id,
        snooze_source_folder_id: schema.emails.snooze_source_folder_id,
        snoozed_until: schema.emails.snoozed_until,
      })
      .from(schema.emails)
      .where(eq(schema.emails.id, id))
      .get();

    if (!email) return null;
    if (isInternalFolderId(email.folder_id)) {
      return { status: "protected_internal_state" as const };
    }
    if (
      snoozeBlocksGenericMove({
        folderId: email.folder_id,
        wakeAt: email.snoozed_until,
        sourceFolderId: email.snooze_source_folder_id,
      })
    ) {
      return { status: "snoozed_state_requires_unsnooze" as const };
    }
    const activeDelivery = this.#activeOutboundDeliveryForEmail(id);
    if (activeDelivery) {
      return {
        status: "outbound_delivery_active" as const,
        deliveryId: activeDelivery.id,
      };
    }

    const plan = planTrash(email.folder_id);
    if (plan.status === "already_trashed") return plan;

    const occurredAt = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.db
        .update(schema.emails)
        .set({
          folder_id: Folders.TRASH,
          previous_folder_id: plan.previousFolderId,
          trashed_at: occurredAt,
        })
        .where(eq(schema.emails.id, id))
        .run();
      this.#recordActivity(
        actor,
        "email_trashed",
        "email",
        id,
        { fromFolderId: email.folder_id },
        occurredAt,
      );
    });

    return { status: "trashed" as const };
  }

  /** Restore an email from Trash to its previous folder, or Inbox as fallback. */
  async restoreEmail(id: string, actor: ActivityActor = { kind: "system" }) {
    const email = this.db
      .select({
        id: schema.emails.id,
        folder_id: schema.emails.folder_id,
        previous_folder_id: schema.emails.previous_folder_id,
      })
      .from(schema.emails)
      .where(eq(schema.emails.id, id))
      .get();

    if (!email) return null;
    if (email.folder_id !== Folders.TRASH) {
      return { status: "not_trashed" as const };
    }

    const previousFolder = email.previous_folder_id
      ? this.db
          .select({ id: schema.folders.id })
          .from(schema.folders)
          .where(eq(schema.folders.id, email.previous_folder_id))
          .get()
      : null;
    const folderId = resolveRestoreFolder(
      email.previous_folder_id,
      Boolean(previousFolder),
    );
    const occurredAt = new Date().toISOString();

    this.ctx.storage.transactionSync(() => {
      this.db
        .update(schema.emails)
        .set({
          folder_id: folderId,
          previous_folder_id: null,
          trashed_at: null,
        })
        .where(eq(schema.emails.id, id))
        .run();
      this.#recordActivity(
        actor,
        "email_restored",
        "email",
        id,
        { toFolderId: folderId },
        occurredAt,
      );
    });

    return { status: "restored" as const, folderId };
  }

  #recordActivity(
    actor: ActivityActor,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>,
    occurredAt = new Date().toISOString(),
  ) {
    this.db
      .insert(schema.activityEvents)
      .values({
        id: crypto.randomUUID(),
        actor_kind: actor.kind,
        actor_id: actor.id ?? null,
        action,
        entity_type: entityType,
        entity_id: entityId,
        metadata_json: JSON.stringify(metadata),
        occurred_at: occurredAt,
      })
      .run();
  }

  #recordActivityOnce(
    id: string,
    actor: ActivityActor,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>,
    occurredAt: string,
  ) {
    this.db
      .insert(schema.activityEvents)
      .values({
        id,
        actor_kind: actor.kind,
        actor_id: actor.id ?? null,
        action,
        entity_type: entityType,
        entity_id: entityId,
        metadata_json: JSON.stringify(metadata),
        occurred_at: occurredAt,
      })
      .onConflictDoNothing()
      .run();
  }

  async getAttachment(id: string) {
    return (
      this.db
        .select({ attachment: schema.attachments })
        .from(schema.attachments)
        .innerJoin(
          schema.emails,
          eq(schema.emails.id, schema.attachments.email_id),
        )
        .where(
          and(
            eq(schema.attachments.id, id),
            sql`${schema.emails.folder_id} <> ${InternalFolders.RETIRED_OUTBOUND}`,
          ),
        )
        .get()?.attachment ?? null
    );
  }

  async listMailboxAttachments(
    options: NormalizedMailboxAttachmentListOptions,
  ) {
    return readMailboxAttachmentPage(
      this.ctx.storage.sql,
      validateNormalizedMailboxAttachmentListOptions(options),
    );
  }

  async getMailboxAttachment(attachmentId: string) {
    if (!attachmentId || attachmentId.length > 300) return null;
    return readMailboxAttachmentDetail(this.ctx.storage.sql, attachmentId);
  }

  /** Exact byte authority: path email and attachment identities must match one visible row. */
  async getAttachmentForEmail(emailId: string, attachmentId: string) {
    return readMailboxAttachmentForEmail(
      this.ctx.storage.sql,
      emailId,
      attachmentId,
    );
  }

  async listMailboxChanges(options: NormalizedMailboxChangeQuery) {
    return readMailboxChanges(
      this.ctx.storage.sql,
      validateNormalizedMailboxChangeQuery(options),
    );
  }

  async claimImportedEmail(
    emailId: string,
    legacyId: string,
    token: string,
    identitySource: "message-id" | "raw-sha256",
    rawSha256: string | null,
  ) {
    if (
      !emailId ||
      emailId.length > 300 ||
      !legacyId ||
      legacyId.length > 300 ||
      token.length < 16 ||
      token.length > 100 ||
      !["message-id", "raw-sha256"].includes(identitySource) ||
      (identitySource === "raw-sha256" &&
        (legacyId !== emailId ||
          !rawSha256 ||
          !/^[0-9a-f]{64}$/.test(rawSha256))) ||
      (identitySource === "message-id" && rawSha256 !== null)
    )
      throw new Error("Import claim identity is invalid");
    const now = Date.now();
    await this.#scheduleAlarmAt(now + 100);
    return this.ctx.storage.transactionSync(() =>
      claimImportedEmailRecord(
        this.ctx.storage.sql,
        emailId,
        legacyId,
        token,
        now,
        now + 15 * 60_000,
        identitySource,
        rawSha256,
      ),
    );
  }

  async releaseImportedEmailClaim(emailId: string, token: string) {
    if (
      !emailId ||
      emailId.length > 300 ||
      token.length < 16 ||
      token.length > 100
    )
      return false;
    return this.ctx.storage.transactionSync(() =>
      releaseImportedEmailClaimRecord(this.ctx.storage.sql, emailId, token),
    );
  }

  async renewImportedEmailClaim(emailId: string, token: string) {
    if (
      !emailId ||
      emailId.length > 300 ||
      token.length < 16 ||
      token.length > 100
    )
      return false;
    const now = Date.now();
    const expiresAt = now + 15 * 60_000;
    await this.#scheduleAlarmAt(expiresAt);
    return this.ctx.storage.transactionSync(() =>
      renewImportedEmailClaimRecord(
        this.ctx.storage.sql,
        emailId,
        token,
        now,
        expiresAt,
      ),
    );
  }

  async beginImportedEmailPromotionIntent(
    emailId: string,
    claimToken: string,
    objectCount: number,
    totalByteLength: number,
  ) {
    const now = Date.now();
    const initialFingerprint = await importPromotionInitialFingerprint({
      emailId,
      claimToken,
    });
    return this.ctx.storage.transactionSync(() =>
      beginImportPromotionIntent(
        this.ctx.storage.sql,
        { emailId, claimToken },
        objectCount,
        totalByteLength,
        initialFingerprint,
        now,
      ),
    );
  }

  async appendImportedEmailPromotionIntent(
    emailId: string,
    claimToken: string,
    objects: ImportPromotionObject[],
  ) {
    const identity = { emailId, claimToken };
    const snapshot = this.ctx.storage.transactionSync(() =>
      readImportPromotionAppendSnapshot(this.ctx.storage.sql, identity),
    );
    const nextFingerprint = await advanceImportPromotionFingerprint(
      identity,
      snapshot.rollingFingerprint,
      objects,
    );
    const now = Date.now();
    return this.ctx.storage.transactionSync(() =>
      appendImportPromotionIntent(
        this.ctx.storage.sql,
        identity,
        objects,
        snapshot,
        nextFingerprint,
        now,
      ),
    );
  }

  async sealImportedEmailPromotionIntent(emailId: string, claimToken: string) {
    const identity = { emailId, claimToken };
    const now = Date.now();
    await this.#scheduleAlarmAt(now + 100);
    return this.ctx.storage.transactionSync(() =>
      sealImportPromotionIntent(this.ctx.storage.sql, identity, now),
    );
  }

  async finalizeImportedEmailPromotionIntent(
    emailId: string,
    claimToken: string,
    proofFingerprint: string,
  ) {
    return this.#reconcileImportedEmailPromotionIntent(
      emailId,
      claimToken,
      proofFingerprint,
      true,
    );
  }

  async #reconcileImportedEmailPromotionIntent(
    emailId: string,
    claimToken: string,
    proofFingerprint: string,
    closeWriter: boolean,
  ): Promise<{
    status: "pending" | "finalized" | "integrity_blocked";
    proofFingerprint: string;
  }> {
    if (!/^[0-9a-f]{64}$/.test(proofFingerprint)) {
      throw new Error("Import promotion proof fingerprint is invalid");
    }
    const now = Date.now();
    await this.#scheduleAlarmAt(now + 100);
    const leaseToken = crypto.randomUUID();
    const claim = this.ctx.storage.transactionSync(() => {
      const intent = [
        ...this.ctx.storage.sql.exec<{
          state: string;
          proof_fingerprint: string | null;
          writer_closed: number;
          claim_generation: number;
          lease_expires_at: number | null;
          reconciliation_phase: "validation" | "settlement" | null;
          reconciliation_cycle: number;
          validation_cursor: number;
          settlement_cursor: number;
          object_count: number;
        }>(
          `SELECT state, proof_fingerprint, writer_closed, claim_generation,
           lease_expires_at, reconciliation_phase, reconciliation_cycle,
           validation_cursor, settlement_cursor, object_count
           FROM import_promotion_intents
           WHERE email_id = ? AND claim_token = ? LIMIT 1`,
          emailId,
          claimToken,
        ),
      ][0];
      if (!intent || intent.proof_fingerprint !== proofFingerprint) {
        throw new Error(
          "Import promotion finalizer does not match durable intent",
        );
      }
      if (intent.state === "integrity_blocked") {
        return { terminal: "integrity_blocked" as const, objects: [] };
      }
      if (intent.state === "finalized") {
        return { terminal: "finalized" as const, objects: [] };
      }
      if (
        intent.state === "reconciling" &&
        intent.lease_expires_at !== null &&
        intent.lease_expires_at > now
      ) {
        return { terminal: "pending" as const, objects: [] };
      }
      if (
        !["recorded", "reconciling", "abandoned_watching"].includes(
          intent.state,
        )
      ) {
        throw new Error("Import promotion intent is not sealed");
      }
      if (!intent.reconciliation_phase) {
        throw new Error("Import promotion reconciliation phase is invalid");
      }
      const generation = intent.claim_generation + 1;
      this.ctx.storage.sql.exec(
        `UPDATE import_promotion_intents SET state = 'reconciling',
         writer_closed = CASE WHEN ? = 1 THEN 1 ELSE writer_closed END,
         claim_generation = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE email_id = ? AND claim_token = ?`,
        closeWriter ? 1 : 0,
        generation,
        leaseToken,
        now + IMPORT_PROMOTION_LEASE_MS,
        now,
        emailId,
        claimToken,
      );
      const writerClosed = closeWriter || intent.writer_closed === 1;
      const cursor =
        intent.reconciliation_phase === "validation"
          ? intent.validation_cursor
          : intent.settlement_cursor;
      const objects = [
        ...this.ctx.storage.sql.exec<{
          ordinal: number;
          r2_key: string;
          byte_length: number;
          observation_state:
            | "authoritative"
            | "unowned_present"
            | "absent"
            | null;
          observation_cycle: number | null;
          observed_byte_length: number | null;
        }>(
          `SELECT ordinal, r2_key, byte_length, observation_state,
           observation_cycle, observed_byte_length
           FROM import_promotion_intent_objects
           WHERE email_id = ? AND claim_token = ? AND ordinal >= ?
           ORDER BY ordinal LIMIT ?`,
          emailId,
          claimToken,
          cursor,
          IMPORT_PROMOTION_RECONCILE_BATCH_SIZE,
        ),
      ];
      return {
        generation,
        writerClosed,
        phase: intent.reconciliation_phase,
        cycle: intent.reconciliation_cycle,
        cursor,
        objectCount: intent.object_count,
        objects,
      };
    });
    if ("terminal" in claim && claim.terminal) {
      return { status: claim.terminal, proofFingerprint };
    }

    // Durable Objects may interleave while this R2 network wait is pending. The
    // generation and lease below fence the result before any SQL is committed.
    // https://developers.cloudflare.com/durable-objects/reference/in-memory-state/
    const observations =
      claim.phase === "validation"
        ? await Promise.all(
            claim.objects.map(async (object) => ({
              object,
              present: await this.headR2Object(object.r2_key),
            })),
          )
        : [];
    const outcome = this.ctx.storage.transactionSync(() => {
      const current = [
        ...this.ctx.storage.sql.exec<{
          state: string;
          claim_generation: number;
          lease_token: string | null;
          reconciliation_phase: string | null;
          reconciliation_cycle: number;
          validation_cursor: number;
          settlement_cursor: number;
        }>(
          `SELECT state, claim_generation, lease_token, reconciliation_phase,
           reconciliation_cycle, validation_cursor, settlement_cursor
           FROM import_promotion_intents
           WHERE email_id = ? AND claim_token = ? LIMIT 1`,
          emailId,
          claimToken,
        ),
      ][0];
      if (
        !current ||
        current.state !== "reconciling" ||
        current.claim_generation !== claim.generation ||
        current.lease_token !== leaseToken ||
        current.reconciliation_phase !== claim.phase ||
        current.reconciliation_cycle !== claim.cycle ||
        (claim.phase === "validation"
          ? current.validation_cursor
          : current.settlement_cursor) !== claim.cursor
      )
        return { status: "pending" as const, nextAt: now + 100 };

      const blockIntent = () => {
        this.ctx.storage.sql.exec(
          `UPDATE import_promotion_intents SET state = 'integrity_blocked',
           reconciliation_phase = 'validation', validation_cursor = 0,
           settlement_cursor = 0, lease_token = NULL, lease_expires_at = NULL,
           updated_at = ?
           WHERE email_id = ? AND claim_token = ?`,
          now,
          emailId,
          claimToken,
        );
        return { status: "integrity_blocked" as const, nextAt: null };
      };

      if (claim.objects.length === 0 && claim.cursor < claim.objectCount) {
        return blockIntent();
      }

      if (claim.phase === "validation") {
        let blocked = false;
        const recordedObservations: Array<{
          ordinal: number;
          state: "authoritative" | "unowned_present" | "absent";
          observedByteLength: number | null;
        }> = [];
        for (const { object, present } of observations) {
          const authoritative = [
            ...this.ctx.storage.sql.exec<{ size: number }>(
              `SELECT size FROM attachments
               WHERE email_id = ?
               AND COALESCE(r2_key,
                 'attachments/' || email_id || '/' || id || '/' || filename) = ?
               LIMIT 1`,
              emailId,
              object.r2_key,
            ),
          ][0];
          if (authoritative) {
            if (
              authoritative.size !== object.byte_length ||
              !present ||
              present.size !== object.byte_length
            ) {
              blocked = true;
              this.ctx.storage.sql.exec(
                `UPDATE import_promotion_intent_objects
                 SET resolution = 'integrity_blocked', last_observed_at = ?
                 WHERE email_id = ? AND claim_token = ? AND ordinal = ?`,
                now,
                emailId,
                claimToken,
                object.ordinal,
              );
              continue;
            }
            recordedObservations.push({
              ordinal: object.ordinal,
              state: "authoritative",
              observedByteLength: present.size,
            });
          } else if (present && present.size !== object.byte_length) {
            blocked = true;
            this.ctx.storage.sql.exec(
              `UPDATE import_promotion_intent_objects
               SET resolution = 'integrity_blocked', last_observed_at = ?
               WHERE email_id = ? AND claim_token = ? AND ordinal = ?`,
              now,
              emailId,
              claimToken,
              object.ordinal,
            );
          } else {
            recordedObservations.push({
              ordinal: object.ordinal,
              state: present ? "unowned_present" : "absent",
              observedByteLength: present?.size ?? null,
            });
          }
        }
        if (blocked) return blockIntent();
        if (
          !this.#adoptR2OwnershipSync(
            observations
              .filter(({ object }) =>
                recordedObservations.some(
                  (observation) =>
                    observation.ordinal === object.ordinal &&
                    observation.state === "authoritative",
                ),
              )
              .map(({ object }) => ({
                r2Key: object.r2_key,
                projectionAttemptId: null,
              })),
          )
        ) {
          return blockIntent();
        }
        for (const observation of recordedObservations) {
          this.ctx.storage.sql.exec(
            `UPDATE import_promotion_intent_objects
             SET observation_state = ?, observation_cycle = ?,
                 observed_byte_length = ?, last_observed_at = ?
             WHERE email_id = ? AND claim_token = ? AND ordinal = ?`,
            observation.state,
            claim.cycle,
            observation.observedByteLength,
            now,
            emailId,
            claimToken,
            observation.ordinal,
          );
        }
        const nextCursor = claim.cursor + claim.objects.length;
        const validationComplete = nextCursor === claim.objectCount;
        if (validationComplete) {
          const validationCount =
            [
            ...this.ctx.storage.sql.exec<{ total: number }>(
              `SELECT COUNT(*) AS total
               FROM import_promotion_intent_objects
               WHERE email_id = ? AND claim_token = ?
               AND observation_cycle = ?
               AND (
                 (observation_state = 'absent' AND observed_byte_length IS NULL)
                 OR (observation_state IN ('authoritative', 'unowned_present')
                   AND observed_byte_length = byte_length)
               )`,
              emailId,
              claimToken,
              claim.cycle,
            ),
          ][0]?.total ?? 0;
          if (validationCount !== claim.objectCount) return blockIntent();
        }
        const nextAt = now + 100;
        this.ctx.storage.sql.exec(
          `UPDATE import_promotion_intents SET state = ?,
           reconciliation_phase = ?, validation_cursor = ?,
           settlement_cursor = 0, lease_token = NULL, lease_expires_at = NULL,
           next_reconcile_at = ?, updated_at = ?
           WHERE email_id = ? AND claim_token = ?`,
          claim.writerClosed ? "recorded" : "abandoned_watching",
          validationComplete ? "settlement" : "validation",
          nextCursor,
          nextAt,
          now,
          emailId,
          claimToken,
        );
        return { status: "pending" as const, nextAt };
      }

      if (
        claim.objects.some(
          (object) =>
            object.observation_cycle !== claim.cycle ||
            object.observation_state === null ||
            (object.observation_state !== "absent" &&
              object.observed_byte_length !== object.byte_length),
        )
      ) {
        throw new Error("Import promotion settlement evidence is incomplete");
      }
      this.#enqueueUnownedR2DeletionSync(
        claim.objects
          .filter((object) => object.observation_state === "unowned_present")
          .map((object) => ({
            r2Key: object.r2_key,
            emailId,
            projectionAttemptId: null,
          })),
        new Date(now).toISOString(),
      );
      for (const object of claim.objects) {
        const resolution =
          object.observation_state === "authoritative"
            ? "retained"
            : object.observation_state === "unowned_present"
              ? "outboxed"
              : "absent";
        this.ctx.storage.sql.exec(
          `UPDATE import_promotion_intent_objects
           SET resolution = ?, last_observed_at = ?
           WHERE email_id = ? AND claim_token = ? AND ordinal = ?`,
          resolution,
          now,
          emailId,
          claimToken,
          object.ordinal,
        );
      }
      const nextCursor = claim.cursor + claim.objects.length;
      if (nextCursor === claim.objectCount) {
        const counts = [
          ...this.ctx.storage.sql.exec<{
            retained: number;
            outboxed: number;
            absent: number;
          }>(
            `SELECT
             COALESCE(SUM(CASE WHEN resolution = 'retained' THEN 1 ELSE 0 END), 0) AS retained,
             COALESCE(SUM(CASE WHEN resolution = 'outboxed' THEN 1 ELSE 0 END), 0) AS outboxed,
             COALESCE(SUM(CASE WHEN resolution = 'absent' THEN 1 ELSE 0 END), 0) AS absent
             FROM import_promotion_intent_objects
             WHERE email_id = ? AND claim_token = ?`,
            emailId,
            claimToken,
          ),
        ][0] ?? { retained: 0, outboxed: 0, absent: 0 };
        if (!claim.writerClosed && (counts.outboxed > 0 || counts.absent > 0)) {
          const nextAt = now + IMPORT_PROMOTION_ABANDONED_WATCH_MS;
          this.ctx.storage.sql.exec(
            `UPDATE import_promotion_intents SET state = 'abandoned_watching',
             reconciliation_phase = 'validation',
             reconciliation_cycle = reconciliation_cycle + 1,
             validation_cursor = 0, settlement_cursor = 0,
             lease_token = NULL, lease_expires_at = NULL,
             next_reconcile_at = ?, updated_at = ?
             WHERE email_id = ? AND claim_token = ?`,
            nextAt,
            now,
            emailId,
            claimToken,
          );
          return { status: "pending" as const, nextAt };
        }
        this.ctx.storage.sql.exec(
          `UPDATE import_promotion_intents SET state = 'finalized',
           reconciliation_phase = NULL, settlement_cursor = ?,
           lease_token = NULL, lease_expires_at = NULL,
           retained_count = ?, outboxed_count = ?, absent_count = ?,
           finalized_at = ?, updated_at = ?
           WHERE email_id = ? AND claim_token = ?`,
          nextCursor,
          counts.retained,
          counts.outboxed,
          counts.absent,
          now,
          now,
          emailId,
          claimToken,
        );
        this.ctx.storage.sql.exec(
          `DELETE FROM import_generation_claims
           WHERE message_id = ? AND claim_token = ?`,
          emailId,
          claimToken,
        );
        return { status: "finalized" as const, nextAt: null };
      }
      const nextAt = now + 100;
      this.ctx.storage.sql.exec(
        `UPDATE import_promotion_intents SET state = ?, lease_token = NULL,
         lease_expires_at = NULL, settlement_cursor = ?,
         next_reconcile_at = ?, updated_at = ?
         WHERE email_id = ? AND claim_token = ?`,
        claim.writerClosed ? "recorded" : "abandoned_watching",
        nextCursor,
        nextAt,
        now,
        emailId,
        claimToken,
      );
      return { status: "pending" as const, nextAt };
    });
    if (outcome.nextAt !== null) await this.#scheduleAlarmAt(outcome.nextAt);
    return { status: outcome.status, proofFingerprint };
  }

  async #processImportPromotionIntents(now: number): Promise<void> {
    const due = this.ctx.storage.transactionSync(() => {
      const expired = [
        ...this.ctx.storage.sql.exec<{
          message_id: string;
          claim_token: string;
        }>(
          `SELECT message_id, claim_token FROM import_generation_claims
           WHERE expires_at <= ? ORDER BY expires_at, message_id LIMIT 5`,
          now,
        ),
      ];
      for (const claim of expired) {
        this.ctx.storage.sql.exec(
          `UPDATE import_promotion_intents SET state = 'abandoned_watching',
           lease_token = NULL, lease_expires_at = NULL,
           next_reconcile_at = ?, updated_at = ?
           WHERE email_id = ? AND claim_token = ?
           AND state IN ('recorded', 'reconciling', 'abandoned_watching')`,
          now,
          now,
          claim.message_id,
          claim.claim_token,
        );
        this.ctx.storage.sql.exec(
          `DELETE FROM import_promotion_intents
           WHERE email_id = ? AND claim_token = ? AND state = 'staging'`,
          claim.message_id,
          claim.claim_token,
        );
        this.ctx.storage.sql.exec(
          `DELETE FROM import_generation_claims
           WHERE message_id = ? AND claim_token = ? AND expires_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM import_promotion_intents
             WHERE email_id = ? AND claim_token = ?
             AND state = 'integrity_blocked'
           )`,
          claim.message_id,
          claim.claim_token,
          now,
          claim.message_id,
          claim.claim_token,
        );
      }
      return [
        ...this.ctx.storage.sql.exec<{
          email_id: string;
          claim_token: string;
          proof_fingerprint: string;
          writer_closed: number;
        }>(
          `SELECT email_id, claim_token, proof_fingerprint, writer_closed
           FROM import_promotion_intents
           WHERE proof_fingerprint IS NOT NULL AND (
             (state IN ('recorded', 'abandoned_watching') AND next_reconcile_at <= ?)
             OR (state = 'reconciling' AND lease_expires_at <= ?)
           )
           ORDER BY COALESCE(lease_expires_at, next_reconcile_at), email_id, claim_token
           LIMIT 5`,
          now,
          now,
        ),
      ];
    });
    for (const intent of due) {
      await this.#reconcileImportedEmailPromotionIntent(
        intent.email_id,
        intent.claim_token,
        intent.proof_fingerprint,
        intent.writer_closed === 1,
      );
    }
    const next = [
      ...this.ctx.storage.sql.exec<{ due_at: number }>(
        `SELECT CASE WHEN state = 'reconciling'
           THEN lease_expires_at ELSE next_reconcile_at END AS due_at
         FROM import_promotion_intents
         WHERE state IN ('recorded', 'abandoned_watching', 'reconciling')
         ORDER BY due_at, email_id, claim_token LIMIT 1`,
      ),
    ][0];
    if (next) {
      await this.#scheduleAlarmAt(Math.max(Date.now() + 100, next.due_at));
    }
  }

  async hasEmailOrThreadIdentity(identity: string) {
    if (!identity || identity.length > 300) return false;
    const row = [
      ...this.ctx.storage.sql.exec<{ found: number }>(
        `SELECT 1 AS found FROM emails
			 WHERE id = ?1 OR thread_id = ?1 LIMIT 1`,
        identity,
      ),
    ][0];
    return row?.found === 1;
  }

  // ── Folders (Drizzle) ──────────────────────────────────────────

  async getFolders() {
    await this.#selfHealSnoozes();
    const result = this.db
      .select({
        id: schema.folders.id,
        name: schema.folders.name,
        unreadCount:
          sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(
            Number,
          ),
      })
      .from(schema.folders)
      .leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
      .where(sql`${schema.folders.id} <> ${InternalFolders.RETIRED_OUTBOUND}`)
      .groupBy(schema.folders.id, schema.folders.name)
      .all();
    return result;
  }

  async listLabels() {
    return this.db
      .select({
        id: schema.labels.id,
        name: schema.labels.name,
        color: schema.labels.color,
        createdAt: schema.labels.created_at,
        updatedAt: schema.labels.updated_at,
      })
      .from(schema.labels)
      .orderBy(asc(schema.labels.name))
      .all();
  }

  async createLabel(
    name: string,
    color: string,
    actor: ActivityActor = { kind: "system" },
  ) {
    const definition = validateLabelDefinition(name, color);
    const now = new Date().toISOString();
    const label = {
      id: `label_${crypto.randomUUID()}`,
      name: definition.name,
      normalized_name: definition.normalizedName,
      color: definition.color,
      created_at: now,
      updated_at: now,
    };
    this.ctx.storage.transactionSync(() => {
      this.db.insert(schema.labels).values(label).run();
      this.#recordActivity(
        actor,
        "label_created",
        "label",
        label.id,
        { name: label.name, color: label.color },
        now,
      );
    });
    return {
      id: label.id,
      name: label.name,
      color: label.color,
      createdAt: label.created_at,
      updatedAt: label.updated_at,
    };
  }

  async createMailboxResourceIdempotently(input: {
    kind: "folder" | "label";
    operationKey: string;
    fingerprint: string;
    resourceId: string;
    name: string;
    color?: string;
    actor: ActivityActor;
  }) {
    const now = new Date().toISOString();
    const cutoff = resourceCreateReplayCutoff(Date.now());
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `DELETE FROM resource_create_operations
				 WHERE operation_key IN (
					 SELECT operation_key FROM resource_create_operations
					 WHERE state IN ('superseded', 'unavailable') AND updated_at < ?1
					 ORDER BY CASE WHEN operation_key = ?2 THEN 0 ELSE 1 END,
					          updated_at, operation_key
					 LIMIT 100
				 )`,
        cutoff,
        input.operationKey,
      );
      const operation = this.db
        .select()
        .from(schema.resourceCreateOperations)
        .where(
          eq(schema.resourceCreateOperations.operation_key, input.operationKey),
        )
        .get();
      if (operation) {
        if (operation.fingerprint !== input.fingerprint) {
          return { status: "idempotency_conflict" as const };
        }
        if (operation.state !== "active") {
          return {
            status:
              operation.state === "superseded"
                ? ("creation_superseded" as const)
                : ("creation_unavailable" as const),
            resourceId: operation.resource_id,
            currentRevision: operation.updated_at,
          };
        }
        const resource =
          input.kind === "folder"
            ? this.db
                .select({
                  id: schema.folders.id,
                  name: schema.folders.name,
                  unreadCount:
                    sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(
                      Number,
                    ),
                })
                .from(schema.folders)
                .leftJoin(
                  schema.emails,
                  eq(schema.emails.folder_id, schema.folders.id),
                )
                .where(eq(schema.folders.id, operation.resource_id))
                .groupBy(schema.folders.id, schema.folders.name)
                .get()
            : this.db
                .select({
                  id: schema.labels.id,
                  name: schema.labels.name,
                  color: schema.labels.color,
                  createdAt: schema.labels.created_at,
                  updatedAt: schema.labels.updated_at,
                })
                .from(schema.labels)
                .where(eq(schema.labels.id, operation.resource_id))
                .get();
        if (!resource) {
          this.db
            .update(schema.resourceCreateOperations)
            .set({ state: "unavailable", updated_at: now })
            .where(
              eq(
                schema.resourceCreateOperations.operation_key,
                input.operationKey,
              ),
            )
            .run();
          return {
            status: "creation_unavailable" as const,
            resourceId: operation.resource_id,
            currentRevision: now,
          };
        }
        return {
          status: "replayed" as const,
          resource,
        };
      }

      try {
        let resource;
        if (input.kind === "folder") {
          resource = this.db
            .insert(schema.folders)
            .values({ id: input.resourceId, name: input.name, is_deletable: 1 })
            .returning({ id: schema.folders.id, name: schema.folders.name })
            .get();
          this.#recordActivity(
            input.actor,
            "folder_created",
            "folder",
            resource.id,
            { name: resource.name },
            now,
          );
          resource = { ...resource, unreadCount: 0 };
        } else {
          const definition = validateLabelDefinition(
            input.name,
            input.color ?? "",
          );
          const row = {
            id: input.resourceId,
            name: definition.name,
            normalized_name: definition.normalizedName,
            color: definition.color,
            created_at: now,
            updated_at: now,
          };
          this.db.insert(schema.labels).values(row).run();
          this.#recordActivity(
            input.actor,
            "label_created",
            "label",
            row.id,
            { name: row.name, color: row.color },
            now,
          );
          resource = {
            id: row.id,
            name: row.name,
            color: row.color,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
        }
        this.db
          .insert(schema.resourceCreateOperations)
          .values({
            operation_key: input.operationKey,
            resource_kind: input.kind,
            fingerprint: input.fingerprint,
            resource_id: input.resourceId,
            state: "active",
            updated_at: now,
          })
          .run();
        return { status: "created" as const, resource };
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("UNIQUE constraint failed")
        ) {
          return { status: "name_conflict" as const };
        }
        throw error;
      }
    });
  }

  async updateLabel(
    id: string,
    name: string,
    color: string,
    actor: ActivityActor = { kind: "system" },
  ) {
    const definition = validateLabelDefinition(name, color);
    const now = new Date().toISOString();
    const current = this.db
      .select({
        id: schema.labels.id,
        name: schema.labels.name,
        color: schema.labels.color,
        createdAt: schema.labels.created_at,
        updatedAt: schema.labels.updated_at,
      })
      .from(schema.labels)
      .where(eq(schema.labels.id, id))
      .get();
    if (!current) return null;
    if (
      current.name === definition.name &&
      current.color === definition.color
    ) {
      return current;
    }
    let updated: { id: string } | undefined;
    this.ctx.storage.transactionSync(() => {
      updated = this.db
        .update(schema.labels)
        .set({
          name: definition.name,
          normalized_name: definition.normalizedName,
          color: definition.color,
          updated_at: now,
        })
        .where(eq(schema.labels.id, id))
        .returning({ id: schema.labels.id })
        .get();
      if (updated) {
        this.db
          .update(schema.resourceCreateOperations)
          .set({ state: "superseded", updated_at: now })
          .where(
            and(
              eq(schema.resourceCreateOperations.resource_kind, "label"),
              eq(schema.resourceCreateOperations.resource_id, id),
              eq(schema.resourceCreateOperations.state, "active"),
            ),
          )
          .run();
        this.#recordActivity(
          actor,
          "label_updated",
          "label",
          id,
          { name: definition.name, color: definition.color },
          now,
        );
      }
    });
    return updated
      ? { id, name: definition.name, color: definition.color, updatedAt: now }
      : null;
  }

  async deleteLabel(id: string, actor: ActivityActor = { kind: "system" }) {
    this.#assertAutomationTargetUnused({ labelId: id });
    const now = new Date().toISOString();
    let deleted: { id: string } | undefined;
    this.ctx.storage.transactionSync(() => {
      deleted = this.db
        .delete(schema.labels)
        .where(eq(schema.labels.id, id))
        .returning({ id: schema.labels.id })
        .get();
      if (deleted) {
        this.db
          .update(schema.resourceCreateOperations)
          .set({ state: "unavailable", updated_at: now })
          .where(
            and(
              eq(schema.resourceCreateOperations.resource_kind, "label"),
              eq(schema.resourceCreateOperations.resource_id, id),
              inArray(schema.resourceCreateOperations.state, [
                "active",
                "superseded",
              ]),
            ),
          )
          .run();
        this.#recordActivity(actor, "label_deleted", "label", id, {}, now);
      }
    });
    return Boolean(deleted);
  }

  async mutateLabels(
    input: {
      labelId: string;
      action: "apply" | "remove";
      targets: LabelMutationTarget[];
    },
    actor: ActivityActor = { kind: "system" },
  ) {
    const targets = validateLabelMutationTargets(input.targets);
    const label = this.db
      .select({ id: schema.labels.id })
      .from(schema.labels)
      .where(eq(schema.labels.id, input.labelId))
      .get();
    if (!label) return { status: "label_not_found" as const, results: [] };

    const results: Array<{
      emailId: string;
      status: "updated" | "not_found" | "outbound_delivery_active";
      affectedCount: number;
    }> = [];
    for (const target of targets) {
      const folderId = this.#visibleFolderId(target.folderId);
      const scope =
        target.conversationId && folderId
          ? this.#conversationScope(target.conversationId, folderId)
          : null;
      const emailIds = scope
        ? scope.emailIds
        : folderId
          ? this.db
              .select({ id: schema.emails.id })
              .from(schema.emails)
              .where(
                and(
                  eq(schema.emails.id, target.emailId),
                  eq(schema.emails.folder_id, folderId),
                ),
              )
              .all()
              .map((row) => row.id)
          : [];
      if (
        emailIds.length === 0 ||
        (target.conversationId && !emailIds.includes(target.emailId))
      ) {
        results.push({
          emailId: target.emailId,
          status: "not_found",
          affectedCount: 0,
        });
        continue;
      }
      const existingIds = new Set(
        this.db
          .select({ emailId: schema.emailLabels.email_id })
          .from(schema.emailLabels)
          .where(
            and(
              eq(schema.emailLabels.label_id, input.labelId),
              inArray(schema.emailLabels.email_id, emailIds),
            ),
          )
          .all()
          .map((row) => row.emailId),
      );
      const changedIds =
        input.action === "apply"
          ? emailIds.filter((emailId) => !existingIds.has(emailId))
          : emailIds.filter((emailId) => existingIds.has(emailId));
      if (changedIds.length === 0) {
        results.push({
          emailId: target.emailId,
          status: "updated",
          affectedCount: 0,
        });
        continue;
      }
      const active = this.db
        .select({ id: schema.outboundDeliveries.id })
        .from(schema.outboundDeliveries)
        .where(
          and(
            inArray(schema.outboundDeliveries.email_id, changedIds),
            inArray(schema.outboundDeliveries.status, [
              "queued",
              "sending",
              "retrying",
            ]),
          ),
        )
        .limit(1)
        .get();
      if (active) {
        results.push({
          emailId: target.emailId,
          status: "outbound_delivery_active",
          affectedCount: 0,
        });
        continue;
      }
      const now = new Date().toISOString();
      this.ctx.storage.transactionSync(() => {
        if (input.action === "apply") {
          this.db
            .insert(schema.emailLabels)
            .values(
              changedIds.map((emailId) => ({
                email_id: emailId,
                label_id: input.labelId,
                created_at: now,
              })),
            )
            .onConflictDoNothing()
            .run();
        } else {
          this.db
            .delete(schema.emailLabels)
            .where(
              and(
                eq(schema.emailLabels.label_id, input.labelId),
                inArray(schema.emailLabels.email_id, changedIds),
              ),
            )
            .run();
        }
        this.#recordActivity(
          actor,
          input.action === "apply" ? "label_applied" : "label_removed",
          target.conversationId ? "conversation" : "email",
          target.conversationId ?? target.emailId,
          { labelId: input.labelId, affectedCount: changedIds.length },
          now,
        );
      });
      results.push({
        emailId: target.emailId,
        status: "updated",
        affectedCount: changedIds.length,
      });
    }
    return { status: "completed" as const, results };
  }

  async createFolder(id: string, name: string, is_deletable: number = 1) {
    try {
      const result = this.db
        .insert(schema.folders)
        .values({ id, name, is_deletable })
        .returning({ id: schema.folders.id, name: schema.folders.name })
        .get();
      return { ...result, unreadCount: 0 };
    } catch (e: unknown) {
      if (
        e instanceof Error &&
        e.message.includes("UNIQUE constraint failed")
      ) {
        return null;
      }
      throw e;
    }
  }

  async updateFolder(id: string, name: string) {
    if (isInternalFolderId(id)) return null;
    const current = this.db
      .select({ id: schema.folders.id, name: schema.folders.name })
      .from(schema.folders)
      .where(eq(schema.folders.id, id))
      .get();
    if (!current || current.name === name) return current ?? null;
    let result: { id: string; name: string } | undefined;
    this.ctx.storage.transactionSync(() => {
      result = this.db
        .update(schema.folders)
        .set({ name })
        .where(eq(schema.folders.id, id))
        .returning({ id: schema.folders.id, name: schema.folders.name })
        .get();
      if (result) {
        this.db
          .update(schema.resourceCreateOperations)
          .set({ state: "superseded", updated_at: new Date().toISOString() })
          .where(
            and(
              eq(schema.resourceCreateOperations.resource_kind, "folder"),
              eq(schema.resourceCreateOperations.resource_id, id),
              eq(schema.resourceCreateOperations.state, "active"),
            ),
          )
          .run();
      }
    });
    return result;
  }

  async deleteFolder(id: string, actor: ActivityActor = { kind: "system" }) {
    const folder = this.db
      .select({ is_deletable: schema.folders.is_deletable })
      .from(schema.folders)
      .where(eq(schema.folders.id, id))
      .get();

    if (!folder) return "not_found" as const;
    if (folder.is_deletable === 0) return "protected" as const;
    this.#assertAutomationTargetUnused({ folderId: id });

    let deleted: { id: string } | undefined;
    const occurredAt = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      deleted = this.db
        .delete(schema.folders)
        .where(
          and(
            eq(schema.folders.id, id),
            sql`NOT EXISTS (
							SELECT 1 FROM ${schema.emails}
							WHERE ${schema.emails.folder_id} = ${schema.folders.id}
						)`,
          ),
        )
        .returning({ id: schema.folders.id })
        .get();
      if (deleted) {
        this.db
          .update(schema.resourceCreateOperations)
          .set({ state: "unavailable", updated_at: occurredAt })
          .where(
            and(
              eq(schema.resourceCreateOperations.resource_kind, "folder"),
              eq(schema.resourceCreateOperations.resource_id, id),
              inArray(schema.resourceCreateOperations.state, [
                "active",
                "superseded",
              ]),
            ),
          )
          .run();
        this.#recordActivity(
          actor,
          "folder_deleted",
          "folder",
          id,
          {},
          occurredAt,
        );
      }
    });

    return deleted ? ("deleted" as const) : ("not_empty" as const);
  }

  async moveEmail(
    id: string,
    folderId: string,
    actor: ActivityActor = { kind: "system" },
  ) {
    const folder = this.db
      .select({ id: schema.folders.id })
      .from(schema.folders)
      .where(eq(schema.folders.id, folderId))
      .get();

    if (!folder || isInternalFolderId(folder.id)) return false;
    if (folder.id === Folders.SNOOZED) {
      return { status: "snoozed_state_requires_explicit_action" as const };
    }
    const email = this.db
      .select({
        id: schema.emails.id,
        folder_id: schema.emails.folder_id,
        snooze_source_folder_id: schema.emails.snooze_source_folder_id,
        snoozed_until: schema.emails.snoozed_until,
      })
      .from(schema.emails)
      .where(eq(schema.emails.id, id))
      .get();
    if (!email || isInternalFolderId(email.folder_id)) return false;
    if (
      snoozeBlocksGenericMove({
        folderId: email.folder_id,
        wakeAt: email.snoozed_until,
        sourceFolderId: email.snooze_source_folder_id,
      })
    ) {
      return { status: "snoozed_state_requires_unsnooze" as const };
    }
    if (folder.id === email.folder_id && folder.id !== Folders.TRASH) {
      return true;
    }
    const activeDelivery = this.#activeOutboundDeliveryForEmail(id);
    if (activeDelivery) {
      return {
        status: "outbound_delivery_active" as const,
        deliveryId: activeDelivery.id,
      };
    }

    const plan = planMove(email.folder_id, folder.id);
    if (plan.kind === "trash") {
      const trashResult = await this.trashEmail(id, actor);
      if (trashResult?.status === "outbound_delivery_active") {
        return trashResult;
      }
      return trashResult !== null;
    }
    const occurredAt = new Date().toISOString();

    this.ctx.storage.transactionSync(() => {
      this.db
        .update(schema.emails)
        .set({
          folder_id: folder.id,
          ...(plan.clearTrashMetadata
            ? { previous_folder_id: null, trashed_at: null }
            : {}),
        })
        .where(eq(schema.emails.id, id))
        .run();
      this.#recordActivity(
        actor,
        "email_moved",
        "email",
        id,
        { fromFolderId: email.folder_id, toFolderId: folder.id },
        occurredAt,
      );
    });

    return true;
  }

  // ── Search ────────────────────────────────────────────────────

  async searchEmails(options: MailSearchOptions) {
    await this.#selfHealSnoozes();
    const plan = buildMailSearchPlan(options);
    const result = this.ctx.storage.sql.exec(plan.dataSql, ...plan.dataParams);
    const rows = [...result] as any[];
    const labelsByEmail = this.#labelsForEmailIds(
      rows.map((row) => String(row.id)),
    );
    return rows.map((row: any) => ({
      ...row,
      read: !!row.read,
      starred: !!row.starred,
      has_attachments: !!row.has_attachments,
      labels: labelsByEmail.get(String(row.id)) ?? [],
    }));
  }

  /**
   * Count total search results matching the given filters (for pagination).
   */
  async countSearchResults(options: MailSearchOptions) {
    await this.#selfHealSnoozes();
    const plan = buildMailSearchPlan(options);
    const row = [
      ...this.ctx.storage.sql.exec(plan.countSql, ...plan.countParams),
    ][0] as { total: number } | undefined;
    return row?.total ?? 0;
  }

  // ── Threading helpers (raw SQL) ────────────────────────────────

  async resolveCanonicalThreadId(messageIds: string[]): Promise<string | null> {
    const ids = [
      ...new Set(messageIds.map((id) => id.trim()).filter(Boolean)),
    ].slice(0, 50);
    if (ids.length === 0) return null;
    const rows = this.db
      .select({
        id: schema.emails.id,
        messageId: schema.emails.message_id,
        threadId: schema.emails.thread_id,
      })
      .from(schema.emails)
      .where(
        or(
          inArray(schema.emails.message_id, ids),
          inArray(schema.emails.id, ids),
        ),
      )
      .all();
    return resolveUnambiguousThreadReference(ids, rows);
  }

  // ── Rate limiting (raw SQL) ────────────────────────────────────

  /**
   * Check if the mailbox has exceeded the send rate limit.
   * Limits: 20 emails per hour, 100 per day per mailbox.
   * Returns null if under limit, or an error message string if exceeded.
   */
  async checkSendRateLimit(): Promise<string | null> {
    const cutoffs = mailboxSendCutoffs();
    const hourRow = [
      ...this.ctx.storage.sql.exec(
        `SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= ?2`,
        Folders.SENT,
        cutoffs.hour,
      ),
    ][0] as { cnt: number } | undefined;

    if ((hourRow?.cnt ?? 0) >= 20) {
      return "Rate limit exceeded: max 20 emails per hour per mailbox";
    }

    const dayRow = [
      ...this.ctx.storage.sql.exec(
        `SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= ?2`,
        Folders.SENT,
        cutoffs.day,
      ),
    ][0] as { cnt: number } | undefined;

    if ((dayRow?.cnt ?? 0) >= 100) {
      return "Rate limit exceeded: max 100 emails per day per mailbox";
    }

    return null;
  }

  // ── Email creation (Drizzle) ───────────────────────────────────
  async createInboundEmail(
    command: InboundProjectionCommand,
  ): Promise<InboundProjectionResult> {
    assertInboundProjectionDeadlineIsActive(command.projectionExpiresAt);
    if (
      command.folder !== Folders.INBOX ||
      command.email.recipient_memory_origin !==
        RecipientMemoryOrigins.LIVE_INBOUND ||
      command.email.automation_trigger !== "live_inbound" ||
      !command.mailboxAddress ||
      !command.archiveAuthority
    ) {
      throw new Error(
        "Inbound projection is not eligible for atomic acceptance",
      );
    }
    const archiveAuthority = command.archiveAuthority;
    if (
      archiveAuthority.schemaVersion !== 1 ||
      archiveAuthority.ingressId !== command.email.id ||
      archiveAuthority.mailboxId !== command.mailboxAddress ||
      !isInboundRawKeyForIngress(
        archiveAuthority.rawKey,
        archiveAuthority.ingressId,
      ) ||
      !Number.isSafeInteger(archiveAuthority.rawSize) ||
      archiveAuthority.rawSize <= 0 ||
      archiveAuthority.rawSize > 25 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(archiveAuthority.rawSha256) ||
      !Number.isFinite(Date.parse(archiveAuthority.archivedAt)) ||
      new Date(archiveAuthority.archivedAt).toISOString() !==
        archiveAuthority.archivedAt ||
      !archiveAuthority.etag ||
      !archiveAuthority.version
    ) {
      throw new Error("Inbound projection archive authority is invalid");
    }
    const hasProjectionAttempt = command.projectionAttemptId !== undefined;
    const hasDerivedContentProof = command.derivedContentProof !== undefined;
    if (hasProjectionAttempt !== hasDerivedContentProof) {
      throw new Error("Inbound projection cleanup proof is incomplete");
    }
    const projectionAttemptId = command.projectionAttemptId;
    const rawDerivedContentProof = command.derivedContentProof;
    const derivedContentProof =
      projectionAttemptId !== undefined && rawDerivedContentProof !== undefined
        ? validateInboundDerivedContentProjectionProof({
            emailId: command.email.id,
            projectionAttemptId,
            objects: rawDerivedContentProof,
          })
        : undefined;
    return this.createEmail(
      command.folder,
      command.email,
      command.attachments,
      undefined,
      command.mailboxAddress,
      {
        bodyObjects: command.bodyObjects,
        allowTerminalRecovery: command.allowTerminalRecovery,
        kind: "archive",
        archiveAuthority,
        projectionExpiresAt: command.projectionExpiresAt,
        projectionAttemptId,
        derivedContentProof,
      },
    );
  }

  async createDirectInboundEmail(
    command: DirectInboundProjectionCommand,
  ): Promise<InboundProjectionResult> {
    assertInboundProjectionDeadlineIsActive(command.projectionExpiresAt);
    const directAuthority = command.directAuthority;
    if (
      command.folder !== Folders.INBOX ||
      command.email.recipient_memory_origin !==
        RecipientMemoryOrigins.LIVE_INBOUND ||
      command.email.automation_trigger !== "live_inbound" ||
      !command.mailboxAddress ||
      command.projectionExpiresAt === undefined ||
      !this.#directInboundAuthorityInputIsValid(directAuthority) ||
      directAuthority.ingressId !== command.email.id ||
      directAuthority.mailboxId !== command.mailboxAddress ||
      directAuthority.receivedAt !== command.email.date
    ) {
      throw new Error(
        "Direct inbound projection is not eligible for atomic acceptance",
      );
    }
    const hasProjectionAttempt = command.projectionAttemptId !== undefined;
    const hasDerivedContentProof = command.derivedContentProof !== undefined;
    if (hasProjectionAttempt !== hasDerivedContentProof) {
      throw new Error("Direct inbound projection cleanup proof is incomplete");
    }
    const projectionAttemptId = command.projectionAttemptId;
    const rawDerivedContentProof = command.derivedContentProof;
    const derivedContentProof =
      projectionAttemptId !== undefined && rawDerivedContentProof !== undefined
        ? validateInboundDerivedContentProjectionProof({
            emailId: command.email.id,
            projectionAttemptId,
            objects: rawDerivedContentProof,
          })
        : undefined;
    return this.createEmail(
      command.folder,
      command.email,
      command.attachments,
      undefined,
      command.mailboxAddress,
      {
        bodyObjects: command.bodyObjects,
        allowTerminalRecovery: command.allowTerminalRecovery,
        kind: "direct",
        directAuthority,
        projectionExpiresAt: command.projectionExpiresAt,
        projectionAttemptId,
        derivedContentProof,
      },
    );
  }

  async createImportedEmail(
    folder: string,
    email: EmailData,
    attachments: AttachmentData[],
    mailboxAddress: string | undefined,
    claimToken: string,
    proofFingerprint: string,
    identitySource: "message-id" | "raw-sha256",
    rawSha256: string | null,
    legacyId: string,
  ): Promise<InboundProjectionResult> {
    if (email.recipient_memory_origin !== RecipientMemoryOrigins.ADMIN_IMPORT) {
      throw new Error("Imported Message origin is invalid");
    }
    if (
      !legacyId ||
      legacyId.length > 300 ||
      !["message-id", "raw-sha256"].includes(identitySource) ||
      (identitySource === "raw-sha256" &&
        (legacyId !== email.id ||
          !rawSha256 ||
          !/^[0-9a-f]{64}$/.test(rawSha256))) ||
      (identitySource === "message-id" && rawSha256 !== null)
    ) {
      throw new Error("Imported Message source identity is invalid");
    }
    return this.createEmail(
      folder,
      email,
      attachments,
      undefined,
      mailboxAddress,
      undefined,
      { claimToken, proofFingerprint, identitySource, rawSha256, legacyId },
    );
  }

  async createEmail(
    folder: string,
    email: EmailData,
    attachments: AttachmentData[],
    actor?: ActivityActor,
    mailboxAddress?: string,
    inboundProjection?: {
      bodyObjects: StoredEmailBodyObject[];
      allowTerminalRecovery: boolean;
      projectionExpiresAt?: number;
      projectionAttemptId?: string;
      derivedContentProof?: InboundDerivedContentCleanupCandidate[];
    } & (
      | { kind: "archive"; archiveAuthority: InboundArchiveAuthority }
      | { kind: "direct"; directAuthority: DirectInboundAuthority }
    ),
    importProjection?: {
      claimToken: string;
      proofFingerprint: string;
      identitySource: "message-id" | "raw-sha256";
      rawSha256: string | null;
      legacyId: string;
    },
  ): Promise<InboundProjectionResult> {
    if (
      email.recipient_memory_origin === RecipientMemoryOrigins.ADMIN_IMPORT &&
      !importProjection
    ) {
      throw new Error("Admin import requires a sealed promotion intent");
    }
    // Resolve folder name or ID to the actual folder ID.
    const folderRow = this.db
      .select({ id: schema.folders.id })
      .from(schema.folders)
      .where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
      .limit(1)
      .get();

    if (!folderRow) {
      throw new Error(
        `createEmail: folder "${folder}" not found. ` +
          "Ensure the folder exists before inserting an email.",
      );
    }

    const folderId = folderRow.id;
    const isSent = folderId === Folders.SENT;
    let pushTargetCount: number | null = null;
    let automationCaptureError: unknown = null;
    if (email.automation_trigger !== undefined) {
      if (
        email.automation_trigger !== "live_inbound" ||
        folderId !== Folders.INBOX ||
        email.recipient_memory_origin !== RecipientMemoryOrigins.LIVE_INBOUND
      )
        throw new Error("Automation trigger is not eligible for this Message");
    }
    if (
      email.automation_trigger !== undefined ||
      (!inboundProjection && attachments.length > 0)
    ) {
      // Register cleanup liveness before a transaction that can persist work. The
      // input gate keeps the alarm from running until this event completes; a
      // successful adoption leaves only a harmless alarm with no due cleanup.
      await this.#scheduleAlarmAt(Date.now() + 100);
    }
    const inboundCleanupCreatedAt = new Date().toISOString();
    const importValidationNow = Date.now();

    assertInboundProjectionDeadlineIsActive(
      inboundProjection?.projectionExpiresAt,
    );
    // Sent emails are always read — the sender obviously knows what they wrote.
    // This prevents sent replies from inflating thread_unread_count.
    const result = this.ctx.storage.transactionSync<InboundProjectionResult>(
      () => {
        const inboundArchiveAuthorityMatches = (
          existing: typeof schema.inboundDeliveryAuthorities.$inferSelect,
          authority: InboundArchiveAuthority,
        ): boolean =>
          this.#archiveInboundAuthorityMatches(
            existing,
            authority,
            "projected",
          );
        const sealInboundAuthority = () => {
          if (!inboundProjection) return;
          if (inboundProjection.kind === "archive") {
            const authority = inboundProjection.archiveAuthority;
            const direct = this.db
              .select({ id: schema.directInboundDeliveryAuthorities.id })
              .from(schema.directInboundDeliveryAuthorities)
              .where(eq(schema.directInboundDeliveryAuthorities.id, email.id))
              .get();
            if (direct) throw new Error("Direct inbound authority conflicts");
            const existing = this.db
              .select()
              .from(schema.inboundDeliveryAuthorities)
              .where(eq(schema.inboundDeliveryAuthorities.id, email.id))
              .get();
            if (existing) {
              if (!inboundArchiveAuthorityMatches(existing, authority)) {
                throw new Error("Inbound archive authority conflicts");
              }
              return;
            }
            this.db
              .insert(schema.inboundDeliveryAuthorities)
              .values({
                id: authority.ingressId,
                schema_version: authority.schemaVersion,
                raw_key: authority.rawKey,
                mailbox_id: authority.mailboxId,
                raw_size: authority.rawSize,
                raw_sha256: authority.rawSha256,
                archived_at: authority.archivedAt,
                archive_etag: authority.etag,
                archive_version: authority.version,
                generation: 1,
                state: "projected",
                deleted_at: null,
              })
              .run();
            return;
          }
          const authority = inboundProjection.directAuthority;
          const archived = this.db
            .select({ id: schema.inboundDeliveryAuthorities.id })
            .from(schema.inboundDeliveryAuthorities)
            .where(eq(schema.inboundDeliveryAuthorities.id, email.id))
            .get();
          if (archived) throw new Error("Archived inbound authority conflicts");
          const existing = this.db
            .select()
            .from(schema.directInboundDeliveryAuthorities)
            .where(eq(schema.directInboundDeliveryAuthorities.id, email.id))
            .get();
          if (existing) {
            if (
              !this.#directInboundAuthorityMatches(
                existing,
                authority,
                "projected",
              )
            ) {
              throw new Error("Direct inbound authority conflicts");
            }
            return;
          }
          this.db
            .insert(schema.directInboundDeliveryAuthorities)
            .values({
              id: authority.ingressId,
              schema_version: authority.schemaVersion,
              mailbox_id: authority.mailboxId,
              raw_size: authority.rawSize,
              raw_sha256: authority.rawSha256,
              received_at: authority.receivedAt,
              generation: 1,
              state: "projected",
              deleted_at: null,
            })
            .run();
        };
        const finishInboundProjection = (
          status: InboundProjectionResult["status"],
          intendedOwnedSizes?: ReadonlyMap<string, number>,
        ): InboundProjectionResult => {
          const proof = inboundProjection?.derivedContentProof;
          if (!proof) return { status };
          const ownedSizes = new Map(intendedOwnedSizes);
          const currentAuthoritativeKeys = new Set<string>();
          const addOwnedObject = (r2Key: string, byteLength: number) => {
            const existingSize = ownedSizes.get(r2Key);
            if (existingSize !== undefined && existingSize !== byteLength) {
              throw new Error(
                "Inbound projection has contradictory owned sizes",
              );
            }
            ownedSizes.set(r2Key, byteLength);
          };
          for (const attachment of this.db
            .select()
            .from(schema.attachments)
            .where(eq(schema.attachments.email_id, email.id))
            .all()) {
            const r2Key = storedAttachmentKey(attachment);
            currentAuthoritativeKeys.add(r2Key);
            addOwnedObject(r2Key, attachment.size);
          }
          for (const bodyObject of this.db
            .select({
              r2Key: schema.emailBodyObjects.r2_key,
              byteLength: schema.emailBodyObjects.byte_length,
            })
            .from(schema.emailBodyObjects)
            .where(eq(schema.emailBodyObjects.email_id, email.id))
            .all()) {
            currentAuthoritativeKeys.add(bodyObject.r2Key);
            addOwnedObject(bodyObject.r2Key, bodyObject.byteLength);
          }
          const projectionAttemptId = inboundProjection?.projectionAttemptId;
          if (!projectionAttemptId) {
            throw new Error("Inbound projection cleanup proof is incomplete");
          }
          const cleanup = classifyInboundProjectionDerivedContent(
            proof,
            ownedSizes,
            { emailId: email.id, projectionAttemptId },
          );
          if (
            intendedOwnedSizes &&
            cleanup.ownedKeys.length !== intendedOwnedSizes.size
          ) {
            throw new Error("Inbound projection ownership proof is incomplete");
          }
          this.#enqueueUnownedR2DeletionSync(
            cleanup.cleanupKeys.map((r2Key) => ({
              r2Key,
              emailId: email.id,
              projectionAttemptId,
            })),
            inboundCleanupCreatedAt,
          );
          if (
            !this.#adoptR2OwnershipSync(
              cleanup.ownedKeys.map((r2Key) => ({
                r2Key,
                projectionAttemptId,
              })),
            )
          ) {
            this.#enqueueUnownedR2DeletionSync(
              cleanup.ownedKeys
                .filter((r2Key) => !currentAuthoritativeKeys.has(r2Key))
                .map((r2Key) => ({
                  r2Key,
                  emailId: email.id,
                  projectionAttemptId,
                })),
              inboundCleanupCreatedAt,
            );
            return { status: "cleanup_conflict" };
          }
          return { status, cleanupKeys: cleanup.cleanupKeys };
        };
        if (importProjection) {
		  const candidateIds = importProjection.legacyId === email.id
			? [email.id]
			: [email.id, importProjection.legacyId];
		  const sourceEvidence = new Map<string, string>();
		  for (const candidateId of candidateIds) {
			const evidence = [
			  ...this.ctx.storage.sql.exec<{ raw_sha256: string }>(
				`SELECT raw_sha256 FROM import_source_identities
				 WHERE email_id = ? LIMIT 1`,
				candidateId,
			  ),
			][0];
			if (evidence) sourceEvidence.set(candidateId, evidence.raw_sha256);
		  }
		  if (
			(importProjection.identitySource === "message-id" && sourceEvidence.size > 0) ||
			(importProjection.identitySource === "raw-sha256" &&
			  sourceEvidence.get(email.id) !== importProjection.rawSha256)
		  ) {
			throw new Error("Import source identity conflict");
		  }
          const intent = [
            ...this.ctx.storage.sql.exec<{
              object_count: number;
              proof_fingerprint: string | null;
              state: string;
            }>(
              `SELECT object_count, proof_fingerprint, state
               FROM import_promotion_intents
               WHERE email_id = ? AND claim_token = ? LIMIT 1`,
              email.id,
              importProjection.claimToken,
            ),
          ][0];
          const claim = [
            ...this.ctx.storage.sql.exec<{
              legacy_id: string | null;
              identity_source: string | null;
              raw_sha256: string | null;
            }>(
              `SELECT legacy_id, identity_source, raw_sha256
               FROM import_generation_claims
               WHERE message_id = ? AND claim_token = ? AND expires_at > ? LIMIT 1`,
              email.id,
              importProjection.claimToken,
              importValidationNow,
            ),
          ][0];
          if (
            !claim ||
			claim.legacy_id !== importProjection.legacyId ||
			claim.identity_source !== importProjection.identitySource ||
			claim.raw_sha256 !== importProjection.rawSha256 ||
            !intent ||
            intent.state !== "recorded" ||
            intent.proof_fingerprint !== importProjection.proofFingerprint ||
            intent.object_count !== attachments.length
          ) {
            throw new Error(
              "Import promotion commitment is not live and sealed",
            );
          }
          for (
            let offset = 0;
            offset < intent.object_count;
            offset += IMPORT_PROMOTION_RECONCILE_BATCH_SIZE
          ) {
            const intendedPage = [
              ...this.ctx.storage.sql.exec<{
                ordinal: number;
                r2_key: string;
                byte_length: number;
              }>(
                `SELECT ordinal, r2_key, byte_length
                 FROM import_promotion_intent_objects
                 WHERE email_id = ? AND claim_token = ? AND ordinal >= ?
                 ORDER BY ordinal LIMIT ?`,
                email.id,
                importProjection.claimToken,
                offset,
                IMPORT_PROMOTION_RECONCILE_BATCH_SIZE,
              ),
            ];
            const expectedPageLength = Math.min(
              IMPORT_PROMOTION_RECONCILE_BATCH_SIZE,
              intent.object_count - offset,
            );
            if (
              intendedPage.length !== expectedPageLength ||
              intendedPage.some((object, index) => {
                const supplied = attachments[offset + index];
                return (
                  object.ordinal !== offset + index ||
                  !supplied ||
                  storedAttachmentKey(supplied) !== object.r2_key ||
                  supplied.size !== object.byte_length
                );
              })
            ) {
              throw new Error(
                "Import promotion proof does not match Message attachments",
              );
            }
            if (
              !this.#adoptR2OwnershipSync(
                intendedPage.map((object) => ({
                  r2Key: object.r2_key,
                  projectionAttemptId: null,
                })),
              )
            ) {
              return { status: "cleanup_conflict" };
            }
          }
          const existingImportedEmail = this.db
            .select({ id: schema.emails.id, folder: schema.emails.folder_id })
            .from(schema.emails)
            .where(eq(schema.emails.id, email.id))
            .get();
          if (existingImportedEmail) {
            return {
              status: "duplicate",
              folder: existingImportedEmail.folder,
            };
          }
        }
        if (inboundProjection) {
          const deleted = this.db
            .select({ deletedAt: schema.emailDeletionTombstones.deleted_at })
            .from(schema.emailDeletionTombstones)
            .where(eq(schema.emailDeletionTombstones.id, email.id))
            .get();
          if (deleted) {
            if (inboundProjection.kind === "direct") {
              const directAuthority = this.db
                .select()
                .from(schema.directInboundDeliveryAuthorities)
                .where(
                  eq(schema.directInboundDeliveryAuthorities.id, email.id),
                )
                .get();
              const archiveAuthority = this.db
                .select()
                .from(schema.inboundDeliveryAuthorities)
                .where(eq(schema.inboundDeliveryAuthorities.id, email.id))
                .get();
              if (
                (directAuthority && archiveAuthority) ||
                !(
                  (directAuthority &&
                    this.#directInboundAuthorityMatches(
                      directAuthority,
                      inboundProjection.directAuthority,
                      "deleted",
                    ) &&
                    directAuthority.deleted_at === deleted.deletedAt) ||
                  (archiveAuthority &&
                    this.#archiveAuthorityMatchesDirectIdentity(
                      archiveAuthority,
                      inboundProjection.directAuthority,
                      "deleted",
                    ) &&
                    archiveAuthority.deleted_at === deleted.deletedAt)
                )
              ) {
                return finishInboundProjection("identity_conflict");
              }
            } else {
              const directAuthority = this.db
                .select()
                .from(schema.directInboundDeliveryAuthorities)
                .where(
                  eq(schema.directInboundDeliveryAuthorities.id, email.id),
                )
                .get();
              const archiveAuthority = this.db
                .select()
                .from(schema.inboundDeliveryAuthorities)
                .where(eq(schema.inboundDeliveryAuthorities.id, email.id))
                .get();
              const authorityMatches = Boolean(
                !(directAuthority && archiveAuthority) &&
                  ((archiveAuthority &&
                    this.#archiveInboundAuthorityMatches(
                      archiveAuthority,
                      inboundProjection.archiveAuthority,
                      "deleted",
                    ) &&
                    archiveAuthority.deleted_at === deleted.deletedAt) ||
                    (directAuthority &&
                      this.#directAuthorityMatchesArchiveIdentity(
                        directAuthority,
                        inboundProjection.archiveAuthority,
                        "deleted",
                      ) &&
                      directAuthority.deleted_at === deleted.deletedAt)),
              );
              if (!authorityMatches) {
                return finishInboundProjection("identity_conflict");
              }
            }
            return finishInboundProjection("deleted");
          }

          const existing = this.db
            .select({
              id: schema.emails.id,
              origin: schema.emails.recipient_memory_origin,
            })
            .from(schema.emails)
            .where(eq(schema.emails.id, email.id))
            .get();
          if (existing) {
            let authorityMatches = false;
            if (inboundProjection.kind === "archive") {
              const archiveAuthority = this.db
                .select()
                .from(schema.inboundDeliveryAuthorities)
                .where(eq(schema.inboundDeliveryAuthorities.id, email.id))
                .get();
              const directAuthority = this.db
                .select()
                .from(schema.directInboundDeliveryAuthorities)
                .where(
                  eq(schema.directInboundDeliveryAuthorities.id, email.id),
                )
                .get();
              authorityMatches = Boolean(
                !(archiveAuthority && directAuthority) &&
                  ((archiveAuthority &&
                    inboundArchiveAuthorityMatches(
                      archiveAuthority,
                      inboundProjection.archiveAuthority,
                    )) ||
                    (directAuthority &&
                      this.#directAuthorityMatchesArchiveIdentity(
                        directAuthority,
                        inboundProjection.archiveAuthority,
                        "projected",
                      ))),
              );
            } else {
              const directAuthority = this.db
                .select()
                .from(schema.directInboundDeliveryAuthorities)
                .where(
                  eq(schema.directInboundDeliveryAuthorities.id, email.id),
                )
                .get();
              const archiveAuthority = this.db
                .select()
                .from(schema.inboundDeliveryAuthorities)
                .where(eq(schema.inboundDeliveryAuthorities.id, email.id))
                .get();
              authorityMatches = Boolean(
                !(archiveAuthority && directAuthority) &&
                  ((directAuthority &&
                    this.#directInboundAuthorityMatches(
                      directAuthority,
                      inboundProjection.directAuthority,
                      "projected",
                    )) ||
                    (archiveAuthority &&
                      this.#archiveAuthorityMatchesDirectIdentity(
                        archiveAuthority,
                        inboundProjection.directAuthority,
                        "projected",
                      ))),
              );
            }
            if (
              existing.origin !== RecipientMemoryOrigins.LIVE_INBOUND ||
              !authorityMatches
            ) {
              return finishInboundProjection("identity_conflict");
            }
            const duplicateResult = finishInboundProjection("duplicate");
            if (duplicateResult.status === "cleanup_conflict") {
              return duplicateResult;
            }
            if (inboundProjection.kind === "archive") {
              this.db
                .delete(schema.inboundTerminalFailures)
                .where(eq(schema.inboundTerminalFailures.id, email.id))
                .run();
            }
            return duplicateResult;
          }

          const terminal = this.db
            .select({ id: schema.inboundTerminalFailures.id })
            .from(schema.inboundTerminalFailures)
            .where(eq(schema.inboundTerminalFailures.id, email.id))
            .get();
          if (
            inboundProjection.kind === "archive" &&
            terminal &&
            !inboundProjection.allowTerminalRecovery
          )
            return finishInboundProjection("terminal");
        }
        let storedProjectionResult: InboundProjectionResult | undefined;
        if (inboundProjection) {
          const intendedOwnedSizes = new Map<string, number>();
          for (const attachment of attachments) {
            intendedOwnedSizes.set(
              storedAttachmentKey(attachment),
              attachment.size,
            );
          }
          for (const bodyObject of inboundProjection.bodyObjects) {
            intendedOwnedSizes.set(bodyObject.r2_key, bodyObject.byte_length);
          }
          storedProjectionResult = finishInboundProjection(
            "stored",
            intendedOwnedSizes,
          );
          if (storedProjectionResult.status === "cleanup_conflict") {
            return storedProjectionResult;
          }
        }
        if (!inboundProjection && !importProjection && attachments.length > 0) {
          const ownershipObjects = attachments.map((attachment) => {
            const r2Key = storedAttachmentKey(attachment);
            return {
              r2Key,
              projectionAttemptId: projectionAttemptIdFromDerivedContentKey(
                email.id,
                r2Key,
              ),
            };
          });
          if (!this.#adoptR2OwnershipSync(ownershipObjects)) {
            this.#enqueueUnownedR2DeletionSync(
              ownershipObjects.map((object) => ({
                ...object,
                emailId: email.id,
              })),
              inboundCleanupCreatedAt,
            );
            return { status: "cleanup_conflict" };
          }
        }
        sealInboundAuthority();
        this.db
          .insert(schema.emails)
          .values({
            id: email.id,
            folder_id: folderId,
            subject: email.subject,
            sender: email.sender,
            sender_name: email.sender_name ?? null,
            recipient: email.recipient,
            cc: email.cc ?? null,
            bcc: email.bcc ?? null,
            date: email.date,
            read: isSent ? 1 : email.read ? 1 : 0,
            starred: email.starred ? 1 : 0,
            body: email.body,
            in_reply_to: email.in_reply_to ?? null,
            email_references: email.email_references ?? null,
            thread_id: email.thread_id ?? null,
            message_id: email.message_id ?? null,
            raw_headers: email.raw_headers ?? null,
            recipient_memory_origin: email.recipient_memory_origin ?? null,
          })
          .run();
        if (importProjection?.identitySource === "message-id" && importProjection.rawSha256 !== null) {
          throw new Error("Message-ID imports cannot persist raw identity authority");
        }
        if (inboundProjection) {
          this.db
            .insert(schema.inboundDerivedContentState)
            .values({ email_id: email.id })
            .run();
        }

        if (attachments.length > 0) {
          insertSqliteRowsBounded(attachments, 10, (chunk) => {
            this.db.insert(schema.attachments).values(chunk).run();
          });
        }
        if (inboundProjection?.bodyObjects.length) {
          insertSqliteRowsBounded(inboundProjection.bodyObjects, 8, (chunk) => {
            this.db.insert(schema.emailBodyObjects).values(chunk).run();
          });
        }
        if (email.automation_trigger !== undefined) {
          const captured = this.#automationRules().captureLiveInbound(
            email.id,
            email.date,
          );
          if (captured.captureFailed) automationCaptureError = captured.error;
        }
        if (
          mailboxAddress &&
          email.recipient_memory_origin ===
            RecipientMemoryOrigins.LIVE_INBOUND &&
          recipientMemoryFolderEligible(folderId)
        ) {
          const interaction = storedEmailInteraction(email, mailboxAddress);
          recordRecipientInteractions(this.ctx.storage.sql, {
            sourceEmailId: email.id,
            direction: interaction.direction,
            occurredAt: email.date,
            mailboxAddress,
            addresses: interaction.addresses,
          });
        }
        if (mailboxAddress && email.recipient_memory_origin) {
          createMailPeopleProjector({
            store: this.ctx.storage,
            mailboxAddress,
          }).projectMessage(email.id);
        }
        if (folderId === Folders.INBOX && email.snooze_wake_thread_id) {
          this.ctx.storage.sql.exec(
            `INSERT INTO snooze_reply_wake_queue (thread_id, requested_at)
					 SELECT ?1, ?2
					 WHERE EXISTS (
						SELECT 1 FROM emails
						WHERE folder_id = ?3 AND thread_id = ?1
					 )
					 ON CONFLICT(thread_id) DO UPDATE SET requested_at = excluded.requested_at`,
            email.snooze_wake_thread_id,
            email.date,
            Folders.SNOOZED,
          );
        }
        if (
          folderId === Folders.INBOX &&
          email.follow_up_reply_mailbox_address
        ) {
          this.db
            .insert(schema.followUpReplyCompletionQueue)
            .values({
              inbound_message_id: email.id,
              mailbox_address: email.follow_up_reply_mailbox_address,
              conversation_key: email.thread_id?.trim() || email.id,
              inbound_message_date: email.date,
              attempts: 0,
              next_attempt_at: Date.now(),
              created_at: Date.now(),
              last_error: null,
            })
            .onConflictDoNothing()
            .run();
        }
        if (actor) {
          this.#recordActivity(
            actor,
            "email_created",
            "email",
            email.id,
            { folderId },
            email.date,
          );
        }
        if (email.push_notification !== undefined) {
          if (
            folderId !== Folders.INBOX ||
            email.recipient_memory_origin !==
              RecipientMemoryOrigins.LIVE_INBOUND ||
            !mailboxAddress
          )
            throw new Error(
              "Push notification is not eligible for this Message",
            );
          pushTargetCount = enqueuePushNotification(this.ctx.storage.sql, {
            emailId: email.id,
            mailboxId: mailboxAddress,
            payload: email.push_notification,
            now: email.date,
          }).targetCount;
        }
        if (inboundProjection?.kind === "archive") {
          this.db
            .delete(schema.inboundTerminalFailures)
            .where(eq(schema.inboundTerminalFailures.id, email.id))
            .run();
        }
        return storedProjectionResult ?? { status: "stored" };
      },
    );
    if (result.status !== "stored") return result;
    if (automationCaptureError) {
      console.error(
        "[automation-rules] capture failed after Message acceptance",
        {
          emailId: email.id,
          error:
            automationCaptureError instanceof Error
              ? automationCaptureError.message
              : String(automationCaptureError),
        },
      );
    }
    if (pushTargetCount !== null) {
      await this.#scheduleAlarmAt(Date.now() + 100).catch((error) =>
        console.error("[push-outbox] failed to schedule durable delivery", {
          emailId: email.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    if (folderId === Folders.INBOX && email.snooze_wake_thread_id) {
      const queued = this.db
        .select({ threadId: schema.snoozeReplyWakeQueue.thread_id })
        .from(schema.snoozeReplyWakeQueue)
        .where(
          eq(
            schema.snoozeReplyWakeQueue.thread_id,
            email.snooze_wake_thread_id,
          ),
        )
        .get();
      if (queued) {
        await this.#scheduleAlarmAt(Date.now() + 100).catch((error) =>
          console.error("failed to schedule Snooze reply wake alarm", {
            threadId: email.snooze_wake_thread_id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    if (folderId === Folders.INBOX && email.follow_up_reply_mailbox_address) {
      await this.#scheduleAlarmAt(Date.now() + 100).catch((error) =>
        console.error("failed to schedule follow-up reply completion", {
          inboundMessageId: email.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return result;
  }

  // ── Truthful outbound delivery ─────────────────────────────────

  #outboxService(
    pendingAttachments: readonly PendingOutboundAttachment[] = [],
    fixedEmailId?: string,
  ) {
    const storage = new DurableObjectOutboundDeliveryStorage(
      this.db,
      this.ctx.storage,
      {
        resolvePendingAttachments: () => pendingAttachments,
      },
    );
    return new TruthfulOutboxService(storage, {
      createId: (prefix) =>
        prefix === "email" && fixedEmailId
          ? fixedEmailId
          : `${prefix}_${crypto.randomUUID()}`,
    });
  }

	async recordOutboundPromotionIntent(emailId: string, keys: string[]) {
		const createdAt = new Date().toISOString();
		const nextAttemptAt = new Date(Date.parse(createdAt) + 20 * 60_000).toISOString();
		this.ctx.storage.transactionSync(() => {
			for (const r2Key of [...new Set(keys)]) {
				this.#enqueueR2DeletionSync({
					r2Key,
					emailId,
					projectionAttemptId: null,
					createdAt,
					nextAttemptAt,
				});
			}
		});
		await this.#scheduleAlarmAt(Date.parse(nextAttemptAt));
		return true;
	}

  async #enqueueOutboundInternal(
    command: EnqueueOutboundCommand,
    attachments: readonly PendingOutboundAttachment[],
    emailId: string,
    onCommittedSync?: (result: EnqueuedDelivery) => void,
	cleanupKeys: readonly string[] = [],
  ) {
    const inlineMapping = validateResolvedInlineImages(
      command.snapshot.html ?? "",
      attachments,
    );
    if (!inlineMapping.ok) {
      throw new InlineImageMappingError(inlineMapping.error);
    }
    const result = this.#outboxService(attachments, emailId).enqueue(command, (committed) => {
		const ownershipObjects = attachments.map((attachment) => ({
			r2Key: attachmentKey(emailId, attachment.id, attachment.filename),
			projectionAttemptId: null,
		}));
		if (
		  committed.delivery.emailId === emailId &&
		  !this.#adoptR2OwnershipSync(ownershipObjects)
		) {
			throw new Error(
				"Outbound attachment ownership was already retired for cleanup",
			);
		}
		for (const key of cleanupKeys) {
			this.#enqueueR2DeletionSync({
				r2Key: key,
				emailId: committed.delivery.emailId,
				projectionAttemptId: null,
				createdAt: command.requestedAt,
			});
		}
		onCommittedSync?.(committed);
		this.#recordActivity(
          command.actor,
		  committed.replayed ? "outbound_enqueue_replayed" : "outbound_enqueued",
          "outbound_delivery",
		  committed.delivery.id,
          {
			emailId: committed.delivery.emailId,
			kind: committed.delivery.kind,
			status: committed.delivery.status,
          },
          command.requestedAt,
		);
	});
	try {
		await this.#ensureOutboundAlarm();
	} catch (error) {
		console.error(
			"[outbound] enqueue committed but immediate alarm recovery is pending",
			error,
		);
	}
    if (result.replayed && result.delivery.emailId !== emailId) {
      const orphanKeys = attachments.map((attachment) =>
        attachmentKey(emailId, attachment.id, attachment.filename),
      );
      if (orphanKeys.length > 0) {
        try {
          await this.env.BUCKET.delete(orphanKeys);
        } catch {
          await this.queueAttachmentCleanup(emailId, orphanKeys, command.actor);
        }
      }
    }
    return result;
  }

  async enqueueOutbound(
    command: EnqueueOutboundCommand,
    attachments: readonly PendingOutboundAttachment[],
    emailId: string,
	cleanupKeys: readonly string[] = [],
  ) {
	return this.#enqueueOutboundInternal(
		command,
		attachments,
		emailId,
		undefined,
		cleanupKeys,
	);
  }

  async listOutboundDeliveries() {
    const deliveries = this.#outboxService().list();
    await this.#ensureOutboundAlarm();
    return deliveries;
  }

  async listOutboundDeliveriesForEmailIds(emailIds: string[]) {
    const uniqueIds = [...new Set(emailIds.filter(Boolean))].slice(0, 100);
    if (uniqueIds.length === 0) return [];
    const rows = this.db
      .select({ id: schema.outboundDeliveries.id })
      .from(schema.outboundDeliveries)
      .where(inArray(schema.outboundDeliveries.email_id, uniqueIds))
      .all();
    const service = this.#outboxService();
    const deliveries = rows.flatMap(({ id }) => {
      const delivery = service.get(id);
      return delivery ? [delivery] : [];
    });
    await this.#ensureOutboundAlarm();
    return deliveries;
  }

  /**
   * Return at most one bounded, server-ranked delivery highlight for each
   * represented thread. Failure states rank ahead of routine sent history so
   * an older bounce cannot disappear behind the thread's latest row.
   */
  async listOutboundDeliveryHighlights(
    emailIds: string[],
    threadIds: string[],
  ) {
    const uniqueEmailIds = [...new Set(emailIds.filter(Boolean))].slice(0, 100);
    const uniqueThreadIds = [...new Set(threadIds.filter(Boolean))].slice(
      0,
      100,
    );
    if (uniqueEmailIds.length === 0 && uniqueThreadIds.length === 0) return [];

    const params = [...uniqueEmailIds, ...uniqueThreadIds];
    const emailPlaceholders = uniqueEmailIds.map((_, index) => `?${index + 1}`);
    const threadPlaceholders = uniqueThreadIds.map(
      (_, index) => `?${uniqueEmailIds.length + index + 1}`,
    );
    const scope = [
      emailPlaceholders.length
        ? `e.id IN (${emailPlaceholders.join(",")})`
        : "",
      threadPlaceholders.length
        ? `e.thread_id IN (${threadPlaceholders.join(",")})`
        : "",
    ]
      .filter(Boolean)
      .join(" OR ");
    const rows = [
      ...this.ctx.storage.sql.exec(
        `WITH ranked AS (
				SELECT od.id, e.thread_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(e.thread_id, e.id)
						ORDER BY CASE od.status
							WHEN 'bounced' THEN 0
							WHEN 'failed' THEN 1
							WHEN 'unknown' THEN 2
							WHEN 'retrying' THEN 3
							WHEN 'sending' THEN 4
							WHEN 'queued' THEN 5
							WHEN 'sent' THEN 6
							WHEN 'cancelled' THEN 7
							ELSE 8
						END,
						od.updated_at DESC
					) AS rank
				FROM outbound_deliveries od
				JOIN emails e ON e.id = od.email_id
				WHERE ${scope}
			)
			SELECT id, thread_id FROM ranked WHERE rank = 1 LIMIT 100`,
        ...params,
      ),
    ] as Array<{ id: string; thread_id: string | null }>;
    const service = this.#outboxService();
    const deliveries = rows.flatMap((row) => {
      const delivery = service.get(row.id);
      return delivery
        ? [
            {
              ...delivery,
              ...(row.thread_id ? { threadId: row.thread_id } : {}),
            },
          ]
        : [];
    });
    await this.#ensureOutboundAlarm();
    return deliveries;
  }

  async getOutboundDelivery(deliveryId: string) {
    const delivery = this.#outboxService().get(deliveryId);
    await this.#ensureOutboundAlarm();
    return delivery;
  }

  async getOutboundDeliveryByIdempotencyKey(idempotencyKey: string) {
    const delivery = this.#outboxService().getByIdempotencyKey(idempotencyKey);
    await this.#ensureOutboundAlarm();
    return delivery;
  }

  async resolveOutboundReplay(input: {
    idempotencyKey: string;
    commandFingerprint: string;
    sourceDraft?: { draftId: string; draftVersion: number };
  }) {
    assertOutboundCommandFingerprint(input.commandFingerprint);
    const service = this.#outboxService();
    const delivery =
      service.getByIdempotencyKey(input.idempotencyKey) ??
      (input.sourceDraft
        ? service.getBySourceDraft(
            input.sourceDraft.draftId,
            input.sourceDraft.draftVersion,
          )
        : null);
    const resolution = classifyOutboundReplay(
      delivery,
      input.commandFingerprint,
    );
	try {
		await this.#ensureOutboundAlarm();
	} catch (error) {
		console.error("Outbound replay truth returned while alarm recovery is pending", error);
	}
    return resolution;
  }

  async cancelOutboundDelivery(
    deliveryId: string,
    actor: OutboundDeliveryActor,
  ) {
    const at = new Date().toISOString();
    const service = this.#outboxService();
    const existing = service.get(deliveryId);
    if (existing?.status === "cancelled") {
	  this.ctx.storage.transactionSync(() => {
		const recorded = this.db
		  .select({ id: schema.activityEvents.id })
		  .from(schema.activityEvents)
		  .where(eq(schema.activityEvents.id, `outbound_cancelled:${deliveryId}`))
		  .get();
		if (recorded) return;
		this.#recordActivityOnce(
		  `outbound_cancelled:${deliveryId}`,
		  { kind: "system" },
		  "outbound_cancelled",
		  "outbound_delivery",
		  deliveryId,
		  { originalActorUnavailable: true },
		  existing.cancelledAt ?? existing.updatedAt,
		);
	  });
	  const recoveryActor = this.#cancelledOutboundRecoveryActor(deliveryId);
	  let recoveredDraftId: string | undefined;
	  let recoveryPending = false;
	  try {
		await this.#scheduleAlarmAt(Date.now() + 100);
	  } catch (error) {
		recoveryPending = true;
		console.error("Cancelled outbound cleanup wake is pending", error);
	  }
	  if (!recoveryPending) try {
		recoveredDraftId = await this.#recoverCancelledOutboundSnapshot(
			existing,
			recoveryActor,
			at,
		);
		this.#completeCancelledOutboundRecovery(deliveryId);
	  } catch (error) {
		recoveryPending = true;
		await this.#deferCancelledOutboundRecovery(deliveryId, error);
		console.error("Cancelled outbound draft recovery remains pending", error);
	  }
      const recoveredDelivery = service.get(deliveryId) ?? existing;
      return {
        delivery: recoveredDelivery,
        actor,
        sourceDraftAction: existing.draftId
          ? ("retain" as const)
          : ("none" as const),
        ...(recoveredDraftId ? { recoveredDraftId } : {}),
		...(recoveryPending ? { recoveryPending: true as const } : {}),
      };
    }
	await this.#scheduleAlarmAt(Date.now() + 100);
	const result = service.cancel(deliveryId, actor, at, (cancelled, outcome) => {
	  if (outcome === "retry_restored") {
		this.#recordActivity(
		  cancelled.actor,
		  "outbound_retry_cancelled",
		  "outbound_delivery",
		  deliveryId,
		  { restoredStatus: cancelled.status },
		  at,
		);
		return;
	  }
	  this.#recordActivityOnce(
		`outbound_cancelled:${deliveryId}`,
		cancelled.actor,
		"outbound_cancelled",
		"outbound_delivery",
		deliveryId,
		{},
		at,
	  );
	});
	if (result.retryCancellationRestored) {
		return {
			...result,
			recoveredDraftId: undefined,
			recoveryPending: false as const,
		};
	}
	let recoveredDraftId: string | undefined;
	let recoveryPending = false;
	try {
		recoveredDraftId = await this.#recoverCancelledOutboundSnapshot(
			result.delivery,
			result.delivery.actor,
			at,
		);
		this.#completeCancelledOutboundRecovery(deliveryId);
	} catch (error) {
		recoveryPending = true;
		await this.#deferCancelledOutboundRecovery(deliveryId, error);
		console.error("Cancelled outbound draft recovery remains pending", error);
	}
	const authoritativeDelivery = service.get(deliveryId) ?? result.delivery;
    return {
		...result,
		delivery: authoritativeDelivery,
		...(recoveredDraftId ? { recoveredDraftId } : {}),
		...(recoveryPending ? { recoveryPending: true as const } : {}),
	};
  }

  #cancelledOutboundRecoveryActor(deliveryId: string): OutboundDeliveryActor {
	const event = this.db
	  .select({
		actorKind: schema.activityEvents.actor_kind,
		actorId: schema.activityEvents.actor_id,
	  })
	  .from(schema.activityEvents)
	  .where(eq(schema.activityEvents.id, `outbound_cancelled:${deliveryId}`))
	  .get();
	if (!event) return { kind: "system" };
	return {
	  kind: event.actorKind as OutboundDeliveryActor["kind"],
	  ...(event.actorId ? { id: event.actorId } : {}),
	};
  }

  #completeCancelledOutboundRecovery(deliveryId: string) {
	this.db
	  .update(schema.outboundDeliveries)
	  .set({
		next_attempt_at: null,
		cancellation_recovery_attempt_count: 0,
		last_error_code: sql`CASE
		  WHEN ${schema.outboundDeliveries.last_error_code} IN (
			'outbound_cancellation_recovery_deferred',
			'outbound_cancellation_recovery_parked'
		  )
		  THEN NULL ELSE ${schema.outboundDeliveries.last_error_code} END`,
		last_error_message: sql`CASE
		  WHEN ${schema.outboundDeliveries.last_error_code} IN (
			'outbound_cancellation_recovery_deferred',
			'outbound_cancellation_recovery_parked'
		  )
		  THEN NULL ELSE ${schema.outboundDeliveries.last_error_message} END`,
	  })
	  .where(eq(schema.outboundDeliveries.id, deliveryId))
	  .run();
  }

  async #deferCancelledOutboundRecovery(deliveryId: string, error: unknown) {
	const current = this.db
	  .select({ attempts: schema.outboundDeliveries.cancellation_recovery_attempt_count })
	  .from(schema.outboundDeliveries)
	  .where(eq(schema.outboundDeliveries.id, deliveryId))
	  .get();
	const attempts = Math.max(0, current?.attempts ?? 0) + 1;
	if (attempts >= 6) {
	  const parkedAt = new Date().toISOString();
	  this.ctx.storage.transactionSync(() => {
		this.db
		  .update(schema.outboundDeliveries)
		  .set({
			next_attempt_at: null,
			cancellation_recovery_attempt_count: attempts,
			last_error_code: "outbound_cancellation_recovery_parked",
			last_error_message:
			  "Cancellation is committed, but draft recovery requires explicit repair.",
		  })
		  .where(eq(schema.outboundDeliveries.id, deliveryId))
		  .run();
		this.#recordActivityOnce(
		  `outbound_cancellation_recovery_parked:${deliveryId}`,
		  { kind: "system" },
		  "outbound_cancellation_recovery_parked",
		  "outbound_delivery",
		  deliveryId,
		  { attempts },
		  parkedAt,
		);
	  });
	  return;
	}
	const retryDelayMs = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 7));
	const retryAt = new Date(Date.now() + retryDelayMs).toISOString();
	this.db
	  .update(schema.outboundDeliveries)
	  .set({
		next_attempt_at: retryAt,
		cancellation_recovery_attempt_count: attempts,
		last_error_code: "outbound_cancellation_recovery_deferred",
		last_error_message:
		  "Cancellation is committed. Draft recovery remains safely pending.",
	  })
	  .where(
		and(
		  eq(schema.outboundDeliveries.id, deliveryId),
		  eq(schema.outboundDeliveries.status, "cancelled"),
		),
	  )
	  .run();
	console.error("Deferred cancelled outbound recovery", {
	  deliveryId,
	  error: error instanceof Error ? error.message : String(error),
	});
	await this.#scheduleAlarmAt(Date.parse(retryAt)).catch((alarmError) =>
	  console.error("Cancelled outbound recovery alarm rearm remains pending", {
		deliveryId,
		error:
		  alarmError instanceof Error ? alarmError.message : String(alarmError),
	  }),
	);
  }

  async #recoverCancelledOutboundSnapshot(
    delivery: {
	  emailId: string;
	  draftId?: string;
	  cancellationRecoveryAttemptCount?: number;
	},
    actor: OutboundDeliveryActor,
    at: string,
  ) {
    const snapshot = this.db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.id, delivery.emailId))
      .get();
    if (!snapshot) {
      throw new Error(
        `Missing cancelled outbound snapshot ${delivery.emailId}`,
      );
    }
    const immutableSnapshot = deserializeOutboundSnapshot(snapshot.raw_headers);
    if (!immutableSnapshot) {
      throw new Error(
        `Invalid cancelled outbound snapshot ${delivery.emailId}`,
      );
    }
    const sourceDraft = delivery.draftId
      ? this.db
          .select()
          .from(schema.emails)
          .where(eq(schema.emails.id, delivery.draftId))
          .get()
      : null;
    const sourceDraftWithAttachments = sourceDraft
      ? {
          ...sourceDraft,
          attachments: this.db
            .select({ id: schema.attachments.id })
            .from(schema.attachments)
            .where(eq(schema.attachments.email_id, sourceDraft.id))
            .all(),
        }
      : null;
    const sourceDraftEquivalent = sourceDraftMatchesSnapshot(
      sourceDraftWithAttachments,
      immutableSnapshot,
    );
    const plan = planCancelledOutboundRecovery({ sourceDraftEquivalent });
    if (!cancellationRecoveryPending("cancelled", snapshot.folder_id)) {
      if (!plan.createRecoveredDraft) return undefined;
      const recoveredId = recoveredDraftId(delivery.emailId);
      const recovered = this.db
        .select({ id: schema.emails.id })
        .from(schema.emails)
        .where(
          and(
            eq(schema.emails.id, recoveredId),
            eq(schema.emails.folder_id, Folders.DRAFT),
          ),
        )
        .get();
      return recovered ? recoveredId : undefined;
    }

    const recoveredDraftIdValue = plan.createRecoveredDraft
      ? recoveredDraftId(delivery.emailId)
      : undefined;
    const recoveredExists = recoveredDraftIdValue
      ? Boolean(
          this.db
            .select({ id: schema.emails.id })
            .from(schema.emails)
            .where(
              and(
                eq(schema.emails.id, recoveredDraftIdValue),
                eq(schema.emails.folder_id, Folders.DRAFT),
              ),
            )
            .get(),
        )
      : false;
    const snapshotAttachments = this.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.email_id, delivery.emailId))
      .all();
    const recoveredAttachments =
      recoveredDraftIdValue && !recoveredExists
        ? (
            await prepareRecoveredDraftAttachments(
              this.env.BUCKET,
              delivery.emailId,
              snapshotAttachments,
			  {
				recordDestinationIntent: (draftId, keys) =>
				  this.recordOutboundPromotionIntent(draftId, keys).then(() => undefined),
				recoveryGeneration:
				  delivery.cancellationRecoveryAttemptCount ?? 0,
			  },
            )
          ).attachments
        : [];
    const recoveryCommitted = this.ctx.storage.transactionSync(() => {
      const currentSnapshot = this.db
        .select({ folderId: schema.emails.folder_id })
        .from(schema.emails)
        .where(eq(schema.emails.id, delivery.emailId))
        .get();
      if (
        !cancellationRecoveryPending("cancelled", currentSnapshot?.folderId)
      ) {
        return false;
      }
      if (recoveredDraftIdValue && !recoveredExists) {
		if (
		  !this.#adoptR2OwnershipSync(
			recoveredAttachments.map((attachment) => ({
			  r2Key: storedAttachmentKey(attachment),
			  projectionAttemptId: null,
			})),
		  )
		) {
		  throw new Error("Recovered draft attachment ownership was already retired");
		}
        this.db
          .insert(schema.emails)
          .values({
            ...snapshot,
            id: recoveredDraftIdValue,
            folder_id: Folders.DRAFT,
            date: at,
            message_id: null,
            raw_headers: null,
            previous_folder_id: null,
            trashed_at: null,
            draft_version: 1,
          })
          .run();
        if (recoveredAttachments.length > 0) {
          insertSqliteRowsBounded(recoveredAttachments, 10, (chunk) => {
            this.db.insert(schema.attachments).values(chunk).run();
          });
        }
        this.#recordActivity(
          actor,
          "outbound_cancelled_recovered_as_draft",
          "email",
          recoveredDraftIdValue,
          { sourceSnapshotId: delivery.emailId },
          at,
        );
      }
      this.db
        .update(schema.emails)
        .set({
          folder_id: plan.folderId,
          previous_folder_id: null,
          trashed_at: null,
        })
        .where(eq(schema.emails.id, delivery.emailId))
        .run();
      if (plan.deleteSnapshotAttachments) {
		for (const attachment of snapshotAttachments) {
			this.#enqueueR2DeletionSync({
				r2Key: storedAttachmentKey(attachment),
				emailId: delivery.emailId,
				projectionAttemptId: null,
				createdAt: at,
			});
		}
        this.db
          .delete(schema.attachments)
          .where(eq(schema.attachments.email_id, delivery.emailId))
          .run();
      }
      this.#recordActivity(
        actor,
        "outbound_cancelled_snapshot_retired",
        "email",
        delivery.emailId,
        {},
        at,
      );
      return true;
    });
    if (!recoveryCommitted) return recoveredDraftIdValue;

    return recoveredDraftIdValue;
  }

  async retryOutboundDelivery(
    deliveryId: string,
    actor: OutboundDeliveryActor,
    acknowledgeDuplicateRisk = false,
  ) {
    const at = new Date().toISOString();
    const existing = this.#outboxService().get(deliveryId);
    if (!existing)
      throw new Error(`Outbound delivery ${deliveryId} was not found`);
	const authorizeRetry = (delivery: StoredOutboundDelivery) => {
		this.#assertBulkRetryCapacitySync(delivery);
		this.#recordActivity(
			actor,
			"outbound_retry_requested",
			"outbound_delivery",
			deliveryId,
			{ acknowledgedDuplicateRisk: acknowledgeDuplicateRisk },
			at,
		);
	};
    const result =
      existing.status === "unknown"
        ? this.#outboxService().retryUnknown(
            deliveryId,
            actor,
            acknowledgeDuplicateRisk as true,
            at,
			authorizeRetry,
          )
        : this.#outboxService().retryFailed(
			deliveryId,
			actor,
			at,
			authorizeRetry,
		  );
	try {
		await this.#ensureOutboundAlarm();
		return { ...result, alarmRecoveryPending: false as const };
	} catch (error) {
		console.error(
			"[outbound] retry committed but immediate alarm recovery is pending",
			error,
		);
		return { ...result, alarmRecoveryPending: true as const };
	}
  }

	#acceptedOutboundProviderEvidence(deliveryId: string) {
		const attempts = this.db
			.select()
			.from(schema.outboundDeliveryAttempts)
			.where(
				and(
					eq(schema.outboundDeliveryAttempts.delivery_id, deliveryId),
					eq(schema.outboundDeliveryAttempts.status, "accepted"),
				),
			)
			.orderBy(desc(schema.outboundDeliveryAttempts.attempt_number))
			.all();
		if (attempts.length === 0) {
			return {
				status: "missing" as const,
				acceptedAttemptCount: 0,
				distinctProviderIdentityCount: 0,
			};
		}
		const attemptIds = attempts.map((attempt) => attempt.id);
		const events = this.db
			.select()
			.from(schema.outboundProviderEvents)
			.where(inArray(schema.outboundProviderEvents.attempt_id, attemptIds))
			.all();
		const valid = attempts.every((attempt) => {
			const providerEvent = attempt.provider_event_id
				? events.find((event) => event.id === attempt.provider_event_id)
				: null;
			const providerEvidenceValid = attempt.provider_state === "none"
				? attempt.provider_event_at === null && attempt.provider_event_id === null
				: Boolean(
						providerEvent &&
						isCanonicalUtcTimestamp(attempt.provider_event_at) &&
						providerEvent.attempt_id === attempt.id &&
						providerEvent.ses_message_id === attempt.ses_message_id &&
						providerEvent.occurred_at === attempt.provider_event_at &&
						(attempt.provider_state === "complained"
							? providerEvent.event_class === "complaint"
							: attempt.provider_state === "delivered"
								? providerEvent.event_class === "delivery" ||
									providerEvent.event_class === "bounce"
								: providerEvent.event_class === "bounce"),
					);
			return (
				Boolean(attempt.id) &&
				attempt.delivery_id === deliveryId &&
				attempt.status === "accepted" &&
				Number.isInteger(attempt.attempt_number) &&
				attempt.attempt_number >= 1 &&
				Boolean(attempt.lease_token) &&
				Boolean(attempt.ses_message_id?.trim()) &&
				isCanonicalUtcTimestamp(attempt.started_at) &&
				isCanonicalUtcTimestamp(attempt.finished_at) &&
				(attempt.http_status === null ||
					(Number.isInteger(attempt.http_status) &&
						attempt.http_status >= 100 &&
						attempt.http_status <= 599)) &&
				[
					"none",
					"delivered",
					"bounced",
					"complained",
					"bounce_scope_unknown",
				].includes(attempt.provider_state) &&
				providerEvidenceValid
			);
		});
		const distinctProviderIdentityCount = new Set(
			attempts.map((attempt) => attempt.ses_message_id),
		).size;
		if (!valid) {
			return {
				status: "invalid" as const,
				acceptedAttemptCount: attempts.length,
				distinctProviderIdentityCount,
			};
		}
		const truth = aggregateAcceptedAttemptProviderTruth(
			attempts.map((attempt) => attempt.provider_state),
		);
		const authoritativeAttempt =
			attempts.find((attempt) =>
				truth === "sent"
					? ["none", "delivered", "complained"].includes(
							attempt.provider_state,
						)
					: truth === "unknown"
						? attempt.provider_state === "bounce_scope_unknown"
						: attempt.provider_state === "bounced",
			) ?? attempts[0]!;
		return {
			status: "valid" as const,
			attempts,
			events,
			truth,
			authoritativeAttempt,
			acceptedAttemptCount: attempts.length,
			distinctProviderIdentityCount,
		};
	}

  async recoverParkedOutboundAcceptance(
	deliveryId: string,
	input: {
	  operationKey: string;
	  expectedGeneration: number;
	  action: "reconcile_from_ledger" | "retry_projection";
	},
	actor: OutboundDeliveryActor,
  ) {
	const at = new Date().toISOString();
	const auditId = `outbound_acceptance_recovery_operator:${deliveryId}:${input.operationKey}`;
	const result = this.ctx.storage.transactionSync(() => {
	  const row = this.db
		.select()
		.from(schema.outboundAcceptanceRecovery)
		.where(eq(schema.outboundAcceptanceRecovery.delivery_id, deliveryId))
		.get();
	  if (!row) return { status: "not_found" as const };
	  const replay = this.db
		.select({ id: schema.activityEvents.id })
		.from(schema.activityEvents)
		.where(eq(schema.activityEvents.id, auditId))
		.get();
	  if (replay) return { status: "replayed" as const, generation: row.generation };
	  if (row.state !== "parked") {
		return { status: "not_parked" as const, state: row.state };
	  }
	  if (row.generation !== input.expectedGeneration) {
		return { status: "generation_conflict" as const, generation: row.generation };
	  }

	  const deliveryEvidence = this.db
		.select()
		.from(schema.outboundDeliveries)
		.where(eq(schema.outboundDeliveries.id, deliveryId))
		.get();
	  if (!deliveryEvidence) return { status: "evidence_conflict" as const };
	  const acceptedEvidence = this.#acceptedOutboundProviderEvidence(deliveryId);
	  if (acceptedEvidence.status !== "valid") {
		return { status: "evidence_conflict" as const };
	  }
	  const attemptId = acceptedEvidence.authoritativeAttempt.id;
	  const sesMessageId = acceptedEvidence.authoritativeAttempt.ses_message_id;
	  const acceptedAt = acceptedEvidence.authoritativeAttempt.finished_at;
	  const generation = row.generation + 1;
	  this.db
		.update(schema.outboundAcceptanceRecovery)
		.set({
		  email_id: deliveryEvidence.email_id,
		  attempt_id: attemptId,
		  ses_message_id: sesMessageId,
		  accepted_at: acceptedAt,
		  source_draft_id: deliveryEvidence.source_draft_id,
		  source_draft_version: deliveryEvidence.source_draft_version,
		  actor_kind: ["user", "mcp", "agent", "rule", "system"].includes(
			deliveryEvidence.actor_kind,
		  )
			? deliveryEvidence.actor_kind
			: "system",
		  actor_id: ["user", "mcp", "agent", "rule", "system"].includes(
			deliveryEvidence.actor_kind,
		  )
			? deliveryEvidence.actor_id
			: null,
		  state: "pending",
		  generation,
		  attempt_count: 0,
		  next_attempt_at: at,
		  last_error_code: null,
		  updated_at: at,
		  completed_at: null,
		})
		.where(eq(schema.outboundAcceptanceRecovery.delivery_id, deliveryId))
		.run();
	  this.#recordActivityOnce(
		auditId,
		actor,
		"outbound_acceptance_recovery_requested",
		"outbound_delivery",
		deliveryId,
		{
		  action: input.action,
		  generation,
		  acceptedAttemptCount: acceptedEvidence.acceptedAttemptCount,
		  distinctProviderIdentityCount:
			acceptedEvidence.distinctProviderIdentityCount,
		  duplicateAcceptanceRisk:
			acceptedEvidence.distinctProviderIdentityCount > 1,
		},
		at,
	  );
	  return { status: "committed" as const, generation };
	});
	if (result.status !== "committed" && result.status !== "replayed") return result;
	try {
	  await this.#scheduleAlarmAt(Date.now() + 100);
	  return { ...result, recoveryPending: false as const };
	} catch (error) {
	  console.error("Outbound acceptance repair committed while alarm recovery is pending", {
		deliveryId,
		errorName: error instanceof Error ? error.name : "UnknownError",
	  });
	  return { ...result, recoveryPending: true as const };
	}
  }

	listParkedOutboundAcceptanceRecoveries(
		afterDeliveryId: string | undefined,
		limit: number,
	) {
		const pageSize = Math.max(1, Math.min(100, Math.trunc(limit)));
		const rows = this.db
			.select()
			.from(schema.outboundAcceptanceRecovery)
			.where(
				afterDeliveryId
					? and(
							eq(schema.outboundAcceptanceRecovery.state, "parked"),
							gt(
								schema.outboundAcceptanceRecovery.delivery_id,
								afterDeliveryId,
							),
						)
					: eq(schema.outboundAcceptanceRecovery.state, "parked"),
			)
			.orderBy(asc(schema.outboundAcceptanceRecovery.delivery_id))
			.limit(pageSize + 1)
			.all();
		const page = rows.slice(0, pageSize);
		const recoveries = page.map((row) => {
			const evidence = this.#acceptedOutboundProviderEvidence(row.delivery_id);
			return {
				deliveryId: row.delivery_id,
				emailId: row.email_id,
				generation: row.generation,
				attemptCount: row.attempt_count,
				lastErrorCode: row.last_error_code,
				updatedAt: row.updated_at,
				evidence: {
					acceptedAttemptCount: evidence.acceptedAttemptCount,
					distinctProviderIdentityCount:
						evidence.distinctProviderIdentityCount,
					status:
						evidence.status === "missing"
							? ("missing" as const)
							: evidence.status === "invalid"
								? ("invalid" as const)
								: evidence.distinctProviderIdentityCount === 1
								? ("unique" as const)
								: ("duplicate_acceptance" as const),
				},
			};
		});
		return {
			recoveries,
			nextCursor:
				rows.length > pageSize ? page[page.length - 1]?.delivery_id ?? null : null,
		};
	}

  async recordSesProviderEvent(input: {
	eventId: string;
	deliveryId: string;
	attemptId: string;
    sesMessageId: string;
	eventType: "delivery" | "bounce" | "complaint";
	recipientHashes: string[];
	occurredAt: string;
	receivedAt: string;
  }) {
	const correlation = this.db
	  .select({ rawHeaders: schema.emails.raw_headers })
	  .from(schema.outboundDeliveries)
	  .innerJoin(
		schema.emails,
		eq(schema.emails.id, schema.outboundDeliveries.email_id),
	  )
	  .where(eq(schema.outboundDeliveries.id, input.deliveryId))
	  .get();
	const snapshot = deserializeOutboundSnapshot(correlation?.rawHeaders ?? null);
	const intendedRecipientHashes = new Set(
	  snapshot
		? await Promise.all(
			[...snapshot.to, ...snapshot.cc, ...snapshot.bcc].map(
			  privacySafeRecipientHash,
			),
		  )
		: [],
	);
	const normalizedRecipientHashes = [...new Set(input.recipientHashes)].sort();
	if (
		normalizedRecipientHashes.length !== input.recipientHashes.length ||
		normalizedRecipientHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash))
	) {
		return { status: "invalid_correlation" as const };
	}
	const recorded = this.ctx.storage.transactionSync(() => {
		const deliveryRow = this.db
			.select()
			.from(schema.outboundDeliveries)
			.where(eq(schema.outboundDeliveries.id, input.deliveryId))
			.get();
		const attemptRow = this.db
			.select()
			.from(schema.outboundDeliveryAttempts)
			.where(
				and(
					eq(schema.outboundDeliveryAttempts.id, input.attemptId),
					eq(schema.outboundDeliveryAttempts.delivery_id, input.deliveryId),
				),
			)
			.get();
		if (!deliveryRow || !attemptRow) return { status: "not_found" as const };
		if (
			attemptRow.ses_message_id !== null &&
			attemptRow.ses_message_id !== input.sesMessageId
		) {
			return { status: "invalid_correlation" as const };
		}
		const priorEvent = this.db
			.select()
			.from(schema.outboundProviderEvents)
			.where(eq(schema.outboundProviderEvents.id, input.eventId))
			.get();
		if (priorEvent) {
			return priorEvent.attempt_id === input.attemptId &&
				priorEvent.ses_message_id === input.sesMessageId &&
				priorEvent.event_class === input.eventType &&
				priorEvent.recipient_hashes_json === JSON.stringify(normalizedRecipientHashes)
				? { status: "already_recorded" as const }
				: { status: "invalid_correlation" as const };
		}

		this.db.insert(schema.outboundProviderEvents).values({
			id: input.eventId,
			attempt_id: input.attemptId,
			ses_message_id: input.sesMessageId,
			event_class: input.eventType,
			recipient_hashes_json: JSON.stringify(normalizedRecipientHashes),
			occurred_at: input.occurredAt,
			received_at: input.receivedAt,
		}).run();
		const attemptEvents = this.db
			.select()
			.from(schema.outboundProviderEvents)
			.where(eq(schema.outboundProviderEvents.attempt_id, input.attemptId))
			.orderBy(desc(schema.outboundProviderEvents.occurred_at))
			.all();
		const hashesFor = (event: (typeof attemptEvents)[number]) => {
			try {
				const parsed: unknown = JSON.parse(event.recipient_hashes_json);
				return Array.isArray(parsed)
					? parsed.filter(
							(hash): hash is string =>
								typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash),
						)
					: [];
			} catch {
				return [];
			}
		};
		const attemptOutcome = (
			events: typeof attemptEvents,
		): "successful" | "bounced" | "unknown" => {
			if (
				events.length === 0 ||
				events.some(
					(event) =>
						event.event_class === "delivery" ||
						event.event_class === "complaint",
				)
			) {
				return "successful";
			}
			const bounced = new Set(
				events
					.filter((event) => event.event_class === "bounce")
					.flatMap(hashesFor),
			);
			if (bounced.size === 0 || intendedRecipientHashes.size === 0) {
				return "unknown";
			}
			return [...intendedRecipientHashes].every((hash) => bounced.has(hash))
				? "bounced"
				: "successful";
		};
		const currentAttemptOutcome = attemptOutcome(attemptEvents);
		const authoritativeEvent =
			attemptEvents.find((event) => event.event_class === "complaint") ??
			attemptEvents.find((event) => event.event_class === "delivery") ??
			attemptEvents.find((event) => event.event_class === "bounce")!;
		const providerState =
			attemptEvents.some((event) => event.event_class === "complaint")
				? "complained"
				: currentAttemptOutcome === "successful"
					? "delivered"
					: currentAttemptOutcome === "bounced"
						? "bounced"
						: "bounce_scope_unknown";
		this.db
			.update(schema.outboundDeliveryAttempts)
			.set({
				status: "accepted",
				finished_at: attemptRow.finished_at ?? input.occurredAt,
				ses_message_id: input.sesMessageId,
				provider_state: providerState,
				provider_event_at: authoritativeEvent.occurred_at,
				provider_event_id: authoritativeEvent.id,
			})
			.where(eq(schema.outboundDeliveryAttempts.id, input.attemptId))
			.run();

		const attempts = this.db
			.select()
			.from(schema.outboundDeliveryAttempts)
			.where(eq(schema.outboundDeliveryAttempts.delivery_id, input.deliveryId))
			.orderBy(desc(schema.outboundDeliveryAttempts.attempt_number))
			.all();
		const accepted = attempts.filter((attempt) => attempt.status === "accepted");
		const acceptedIds = accepted.map((attempt) => attempt.id);
		const acceptedEvents = acceptedIds.length > 0
			? this.db
					.select()
					.from(schema.outboundProviderEvents)
					.where(inArray(schema.outboundProviderEvents.attempt_id, acceptedIds))
					.all()
			: [];
		const eventsForAttempt = (attemptId: string) =>
			acceptedEvents.filter((event) => event.attempt_id === attemptId);
		const outcomes = accepted.map((attempt) => ({
			attempt,
			outcome: attemptOutcome(eventsForAttempt(attempt.id)),
		}));
		const successful = outcomes.filter(({ outcome }) => outcome === "successful");
		const ambiguous = outcomes.filter(({ outcome }) => outcome === "unknown");
		const aggregateStatus = aggregateAcceptedAttemptProviderTruth(
			outcomes.map(({ outcome }) =>
				outcome === "successful"
					? "delivered"
					: outcome === "unknown"
						? "bounce_scope_unknown"
						: "bounced",
			),
		);
		const authoritativeAttempt =
			successful[0]?.attempt ??
			ambiguous[0]?.attempt ??
			accepted[0] ??
			attemptRow;
		const hasComplaint = acceptedEvents.some(
			(event) => event.event_class === "complaint",
		);
		const hasBounce = acceptedEvents.some(
			(event) => event.event_class === "bounce",
		);
		this.db
			.update(schema.outboundDeliveries)
			.set({
				status: aggregateStatus,
				retry_origin_status: null,
				dispatch_phase: null,
				active_attempt_id: null,
				lease_token: null,
				lease_expires_at: null,
				next_attempt_at: null,
				ses_message_id:
					authoritativeAttempt.ses_message_id ?? input.sesMessageId,
				sent_at: authoritativeAttempt.finished_at ?? input.occurredAt,
				failed_at: null,
				unknown_at: aggregateStatus === "unknown" ? input.receivedAt : null,
				accepted_attempt_count: accepted.length,
				duplicate_acceptance_at:
					accepted.length > 1
						? deliveryRow.duplicate_acceptance_at ?? input.occurredAt
						: deliveryRow.duplicate_acceptance_at,
				last_error_code: hasComplaint
					? "ses_complaint"
					: aggregateStatus === "unknown"
						? "ses_bounce_scope_unknown"
					: aggregateStatus === "bounced"
						? "ses_bounce"
						: hasBounce
							? "ses_partial_bounce"
							: null,
				last_error_message: null,
				updated_at: input.receivedAt,
			})
			.where(eq(schema.outboundDeliveries.id, input.deliveryId))
			.run();
		this.db
			.insert(schema.outboundAcceptanceRecovery)
			.values({
				delivery_id: input.deliveryId,
				email_id: deliveryRow.email_id,
				attempt_id: authoritativeAttempt.id,
				ses_message_id:
					authoritativeAttempt.ses_message_id ?? input.sesMessageId,
				accepted_at: authoritativeAttempt.finished_at ?? input.occurredAt,
				source_draft_id: deliveryRow.source_draft_id,
				source_draft_version: deliveryRow.source_draft_version,
				actor_kind: deliveryRow.actor_kind,
				actor_id: deliveryRow.actor_id,
				state: "pending",
				generation: 0,
				attempt_count: 0,
				next_attempt_at: input.receivedAt,
				created_at: input.receivedAt,
				updated_at: input.receivedAt,
			})
			.onConflictDoUpdate({
				target: schema.outboundAcceptanceRecovery.delivery_id,
				set: {
					attempt_id: authoritativeAttempt.id,
					ses_message_id:
						authoritativeAttempt.ses_message_id ?? input.sesMessageId,
					accepted_at:
						authoritativeAttempt.finished_at ?? input.occurredAt,
					state: "pending",
					generation: sql`${schema.outboundAcceptanceRecovery.generation} + 1`,
					attempt_count: 0,
					next_attempt_at: input.receivedAt,
					message_projected_at: null,
					last_error_code: null,
					updated_at: input.receivedAt,
					completed_at: null,
				},
			})
			.run();
		this.#recordActivity(
			{ kind: "system" },
			`outbound_${input.eventType}_recorded`,
			"outbound_delivery_attempt",
			input.attemptId,
			{ deliveryId: input.deliveryId, sesMessageId: input.sesMessageId },
			input.receivedAt,
		);
		return { status: "recorded" as const };
	});
	if (recorded.status !== "recorded" && recorded.status !== "already_recorded") {
		return recorded;
	}
	const delivery = this.#outboxService().get(input.deliveryId);
	if (!delivery) return { status: "not_found" as const };
	try {
		await this.#scheduleAlarmAt(Date.now() + 100);
	} catch (error) {
		console.error("SES event committed while projection recovery is pending", error);
		return { ...recorded, delivery, recoveryPending: true as const };
	}
		const projection = await this.#moveAcceptedOutboundToSent(
			delivery.emailId,
			delivery.sesMessageId ?? input.sesMessageId,
			delivery.actor,
			delivery.sentAt ?? input.occurredAt,
		);
		if (projection.status !== "projected") {
			this.#parkOutboundAcceptanceRecovery(
				delivery.id,
				projection.status,
				input.receivedAt,
			);
			return { ...recorded, delivery, recoveryPending: true as const };
		}
    await this.#consumeAcceptedSourceDraft(
	  delivery.draftId,
	  delivery.draftVersion,
	  delivery.actor,
    );
	this.#outboxService().completeAcceptedReconciliation(delivery.id);
	return { ...recorded, delivery };
  }

  #recordConcurrentAcceptedProviderOutcome(input: {
	deliveryId: string;
	attemptId: string;
	leaseToken: string;
	sesMessageId: string;
	acceptedAt: string;
  }): boolean {
	return this.ctx.storage.transactionSync(() => {
	  const delivery = this.db
		.select()
		.from(schema.outboundDeliveries)
		.where(eq(schema.outboundDeliveries.id, input.deliveryId))
		.get();
	  const attempt = this.db
		.select()
		.from(schema.outboundDeliveryAttempts)
		.where(
		  and(
			eq(schema.outboundDeliveryAttempts.id, input.attemptId),
			eq(schema.outboundDeliveryAttempts.delivery_id, input.deliveryId),
		  ),
		)
		.get();
	  if (!delivery || !attempt) return false;
	  if (attempt.status === "accepted") {
		return attempt.ses_message_id === input.sesMessageId;
	  }
	  if (attempt.status !== "sending" || attempt.lease_token !== input.leaseToken) {
		return false;
	  }
	  this.db
		.update(schema.outboundDeliveryAttempts)
		.set({
		  status: "accepted",
		  finished_at: input.acceptedAt,
		  ses_message_id: input.sesMessageId,
		})
		.where(eq(schema.outboundDeliveryAttempts.id, input.attemptId))
		.run();
	  const accepted = this.db
		.select()
		.from(schema.outboundDeliveryAttempts)
		.where(
		  and(
			eq(schema.outboundDeliveryAttempts.delivery_id, input.deliveryId),
			eq(schema.outboundDeliveryAttempts.status, "accepted"),
		  ),
		)
		.all();
	  const hasPartialFailure = accepted.some(
		(candidate) =>
		  candidate.provider_state === "bounced" ||
		  candidate.provider_state === "complained" ||
		  candidate.provider_state === "bounce_scope_unknown",
	  );
	  const aggregateStatus = aggregateAcceptedAttemptProviderTruth(
		accepted.map((candidate) => candidate.provider_state),
	  );
	  this.db
		.update(schema.outboundDeliveries)
			.set({
			  status: aggregateStatus,
			  retry_origin_status: null,
		  dispatch_phase: null,
		  active_attempt_id: null,
		  lease_token: null,
		  lease_expires_at: null,
		  next_attempt_at: null,
		  ses_message_id: input.sesMessageId,
		  sent_at: input.acceptedAt,
		  failed_at: null,
		  unknown_at: aggregateStatus === "unknown" ? input.acceptedAt : null,
		  accepted_attempt_count: accepted.length,
		  duplicate_acceptance_at:
			accepted.length > 1
			  ? delivery.duplicate_acceptance_at ?? input.acceptedAt
			  : delivery.duplicate_acceptance_at,
		  last_error_code: hasPartialFailure
			? "ses_duplicate_attempt_partial_failure"
			: null,
		  last_error_message: null,
		  updated_at: input.acceptedAt,
		})
		.where(eq(schema.outboundDeliveries.id, input.deliveryId))
		.run();
	  this.db
		.insert(schema.outboundAcceptanceRecovery)
		.values({
		  delivery_id: input.deliveryId,
		  email_id: delivery.email_id,
		  attempt_id: input.attemptId,
		  ses_message_id: input.sesMessageId,
		  accepted_at: input.acceptedAt,
		  source_draft_id: delivery.source_draft_id,
		  source_draft_version: delivery.source_draft_version,
		  actor_kind: delivery.actor_kind,
		  actor_id: delivery.actor_id,
		  state: "pending",
		  generation: 0,
		  attempt_count: 0,
		  next_attempt_at: input.acceptedAt,
		  created_at: input.acceptedAt,
		  updated_at: input.acceptedAt,
		})
		.onConflictDoUpdate({
		  target: schema.outboundAcceptanceRecovery.delivery_id,
		  set: {
			attempt_id: input.attemptId,
			ses_message_id: input.sesMessageId,
			accepted_at: input.acceptedAt,
			state: "pending",
			generation: sql`${schema.outboundAcceptanceRecovery.generation} + 1`,
			attempt_count: 0,
			next_attempt_at: input.acceptedAt,
			message_projected_at: null,
			last_error_code: null,
			updated_at: input.acceptedAt,
			completed_at: null,
		  },
		})
		.run();
	  this.#recordActivityOnce(
		`outbound_duplicate_acceptance:${input.attemptId}`,
		{ kind: "system" },
		"outbound_duplicate_acceptance_recorded",
		"outbound_delivery_attempt",
		input.attemptId,
		{ deliveryId: input.deliveryId },
		input.acceptedAt,
	  );
	  return true;
	});
  }

  #recordConcurrentNonAcceptedProviderOutcome(input: {
	deliveryId: string;
	attemptId: string;
	leaseToken: string;
	at: string;
	outcome:
	  | { kind: "unknown"; code: string }
	  | {
		  kind: "rejected";
		  code: string;
		  automaticRetry: boolean;
		  httpStatus?: number;
		};
  }): boolean {
	return this.ctx.storage.transactionSync(() => {
	  const delivery = this.db
		.select()
		.from(schema.outboundDeliveries)
		.where(eq(schema.outboundDeliveries.id, input.deliveryId))
		.get();
	  const attempt = this.db
		.select()
		.from(schema.outboundDeliveryAttempts)
		.where(
		  and(
			eq(schema.outboundDeliveryAttempts.id, input.attemptId),
			eq(schema.outboundDeliveryAttempts.delivery_id, input.deliveryId),
		  ),
		)
		.get();
	  if (!delivery || !attempt) return false;
	  if (attempt.status !== "sending" || attempt.lease_token !== input.leaseToken) {
		return attempt.status !== "sending";
	  }
	  const attemptStatus =
		input.outcome.kind === "unknown"
		  ? "unknown"
		  : input.outcome.automaticRetry
			? "rejected_retryable"
			: "rejected_permanent";
	  this.db
		.update(schema.outboundDeliveryAttempts)
		.set({
		  status: attemptStatus,
		  finished_at: input.at,
		  error_code: input.outcome.code,
		  http_status:
			input.outcome.kind === "rejected"
			  ? input.outcome.httpStatus ?? null
			  : null,
		})
		.where(eq(schema.outboundDeliveryAttempts.id, input.attemptId))
		.run();
	  const accepted = this.db
		.select()
		.from(schema.outboundDeliveryAttempts)
		.where(
		  and(
			eq(schema.outboundDeliveryAttempts.delivery_id, input.deliveryId),
			eq(schema.outboundDeliveryAttempts.status, "accepted"),
		  ),
		)
		.all();
	  const acceptedTruth = accepted.length > 0
		? aggregateAcceptedAttemptProviderTruth(
			accepted.map((candidate) => candidate.provider_state),
		  )
		: null;
	  const nextStatus =
		acceptedTruth === "sent"
		  ? "sent"
		  : acceptedTruth === "unknown" || input.outcome.kind === "unknown"
			? "unknown"
			: acceptedTruth === "bounced"
			  ? "bounced"
			  : delivery.status;
	  this.db
		.update(schema.outboundDeliveries)
			.set({
			  status: nextStatus,
			  retry_origin_status: ["queued", "retrying", "sending"].includes(nextStatus)
				? delivery.retry_origin_status
				: null,
		  dispatch_phase: null,
		  active_attempt_id: null,
		  lease_token: null,
		  lease_expires_at: null,
		  next_attempt_at: null,
		  failed_at: null,
		  unknown_at: nextStatus === "unknown" ? input.at : null,
		  last_error_code:
			input.outcome.kind === "unknown" && acceptedTruth === "sent"
			  ? "ses_duplicate_attempt_outcome_unknown"
			  : acceptedTruth === "unknown"
				? "ses_bounce_scope_unknown"
			  : input.outcome.code,
		  last_error_message: null,
		  updated_at: input.at,
		})
		.where(eq(schema.outboundDeliveries.id, input.deliveryId))
		.run();
	  this.#recordActivityOnce(
		`outbound_concurrent_attempt_terminal:${input.attemptId}`,
		{ kind: "system" },
		"outbound_concurrent_attempt_terminal_recorded",
		"outbound_delivery_attempt",
		input.attemptId,
		{ outcome: attemptStatus },
		input.at,
	  );
	  return true;
	});
  }

  async #scheduleAlarmAt(timestamp: number) {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || timestamp < existing) {
      await this.ctx.storage.setAlarm(timestamp);
    }
  }

  async #scheduleBulkAlarmAt(
    timestamp: number,
    input: {
      stage: "throttle_schedule" | "next_job_schedule";
      startedAt: number;
      jobId: string;
      job?: BulkJob;
    },
  ): Promise<void> {
    try {
      await this.#scheduleAlarmAt(timestamp);
    } catch (error) {
      console.error("[bulk-send] alarm pass failed", {
        operation: "bulk_alarm_pass",
        stage: input.stage,
        mailboxId: input.job?.fromEmail,
        operationId: input.job?.operationId,
        jobId: input.jobId,
        result: "failure",
        errorName: error instanceof Error ? error.name : "UnknownError",
        retryDecision: "retry_alarm",
        durationMs: Date.now() - input.startedAt,
      });
      throw error;
    }
  }

  async #ensureBulkMaintenanceAlarmForJob(input: {
    startedAt: number;
    jobId: string;
    job?: BulkJob;
  }): Promise<void> {
    try {
      await this.#ensureBulkMaintenanceAlarm();
    } catch (error) {
      console.error("[bulk-send] alarm pass failed", {
        operation: "bulk_alarm_pass",
        stage: "terminal_maintenance_schedule",
        mailboxId: input.job?.fromEmail,
        operationId: input.job?.operationId,
        jobId: input.jobId,
        result: "failure",
        errorName: error instanceof Error ? error.name : "UnknownError",
        retryDecision: "retry_alarm",
        durationMs: Date.now() - input.startedAt,
      });
      throw error;
    }
  }

  async #processSemanticIndexAlarm(alarmNow: number): Promise<number | null> {
    const mailboxId = await this.ctx.storage.get<string>(
      SEMANTIC_SCHEDULER_MAILBOX_KEY,
    );
    if (!mailboxId) return null;
    const brand = resolveBrand(this.env.BRAND);
    if (
      !isSemanticSearchEnabled(this.env.FEATURES, brand.id) ||
      !this.env.SEMANTIC_INDEX
    ) {
      await this.ctx.storage.delete(SEMANTIC_SCHEDULER_MAILBOX_KEY);
      await this.ctx.storage.delete(SEMANTIC_SCHEDULER_FAILURES_KEY);
      return null;
    }

    try {
      await advanceSemanticMailboxIndex({
        mailbox: this,
        bucket: {
          head: (key) => this.env.BUCKET.head(key),
          get: async (key, etag) => {
            const object = await this.env.BUCKET.get(key, {
              onlyIf: { etagMatches: etag },
            });
            return object && "body" in object ? object : null;
          },
        },
        converter: createWorkersAiSemanticRichDocumentConverter(this.env),
        provider: createSemanticIndexProvider(this.env, mailboxId),
        namespace: await semanticMailboxNamespace(brand.id, mailboxId),
        onObservationError: (error) => {
          console.error("[semantic-index] visibility observation failed", {
            errorCode: semanticSchedulerErrorCode(error),
          });
        },
      });
      await this.ctx.storage.delete(SEMANTIC_SCHEDULER_FAILURES_KEY);
      const next = createSemanticIndex({
        store: this.ctx.storage,
      }).nextAdvanceAt(Date.now());
      if (next === null) {
        await this.ctx.storage.delete(SEMANTIC_SCHEDULER_MAILBOX_KEY);
        return null;
      }
      return Math.max(Date.now() + 100, next);
    } catch (error) {
      const failures =
        ((await this.ctx.storage.get<number>(
          SEMANTIC_SCHEDULER_FAILURES_KEY,
        )) ?? 0) + 1;
      console.error("[semantic-index] alarm turn failed", {
        errorCode: semanticSchedulerErrorCode(error),
        attempt: failures,
      });
      if (failures >= SEMANTIC_SCHEDULER_MAX_FAILURES) {
        createSemanticIndex({ store: this.ctx.storage }).failProjection(
          "scheduler_exhausted",
        );
        await this.ctx.storage.delete(SEMANTIC_SCHEDULER_MAILBOX_KEY);
        await this.ctx.storage.delete(SEMANTIC_SCHEDULER_FAILURES_KEY);
        return null;
      }
      await this.ctx.storage.put(SEMANTIC_SCHEDULER_FAILURES_KEY, failures);
      return alarmNow + Math.min(30_000 * 2 ** (failures - 1), 15 * 60_000);
    }
  }

  #nextAutomationAlarmAt(): number | null {
    const row = [
      ...this.ctx.storage.sql.exec<{ dueAt: string | null }>(
        `SELECT MIN(due_at) AS dueAt FROM (
			 SELECT next_attempt_at AS due_at FROM automation_runs
			 WHERE state = 'pending' AND next_attempt_at IS NOT NULL
			 UNION ALL
			 SELECT lease_expires_at AS due_at FROM automation_runs
			 WHERE state = 'processing' AND lease_expires_at IS NOT NULL
			)`,
      ),
    ][0];
    if (!row?.dueAt) return null;
    const timestamp = Date.parse(row.dueAt);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  #processAutomationRulesAlarm(): number | null {
    const automation = this.#automationRules();
    for (let processed = 0; processed < 2; processed += 1) {
      let claim;
      try {
        claim = automation.claimNextRun();
      } catch (error) {
        console.error("[automation-rules] could not claim due work", {
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
      if (!claim) break;
      try {
        const context = readAutomationPlanningContext(
          this.ctx.storage.sql,
          claim.triggerMessageId,
        );
        if (!context) {
          automation.failClaim(claim, "message_unavailable", false);
          continue;
        }
        const plan = automation.planRun(claim.rules, context);
        const finalized = automation.finalizeClaim(claim, plan, (ownedPlan) => {
          applyAutomationActionPlan(
            this.ctx.storage.sql,
            claim,
            context,
            ownedPlan,
            (activity) =>
              this.#recordActivity(
                activity.actor,
                activity.action,
                activity.entityType,
                activity.entityId,
                activity.metadata,
              ),
          );
        });
        if (!finalized) {
          console.warn("[automation-rules] lease expired before finalization", {
            runId: claim.id,
          });
        }
      } catch (error) {
        let recorded = false;
        try {
          recorded = automation.failClaim(claim, "runtime_failure", true);
        } catch (failureError) {
          console.error(
            "[automation-rules] could not persist execution failure",
            {
              runId: claim.id,
              error:
                failureError instanceof Error
                  ? failureError.message
                  : String(failureError),
            },
          );
        }
        console.error("[automation-rules] execution failed", {
          runId: claim.id,
          retryScheduled: recorded,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.#nextAutomationAlarmAt();
  }

  #processDueSnoozeBatch(now = Date.now()): number | null {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT id,
			        snooze_source_folder_id AS sourceFolderId,
			        snoozed_until AS wakeAt
			 FROM emails
			 WHERE folder_id = ?1
			 ORDER BY snoozed_until ASC, id ASC
			 LIMIT 101`,
        Folders.SNOOZED,
      ),
    ] as Array<{ id: string; sourceFolderId: string | null; wakeAt: string }>;
    const visibleFolders = new Set(
      this.db
        .select({ id: schema.folders.id })
        .from(schema.folders)
        .all()
        .map((folder) => folder.id),
    );
    const plan = planDueSnoozeWake(rows, now, (folderId) =>
      visibleFolders.has(folderId),
    );
    if (plan.wake.length > 0) {
      const occurredAt = new Date(now).toISOString();
      this.ctx.storage.transactionSync(() => {
        for (const target of plan.wake) {
          this.db
            .update(schema.emails)
            .set({
              folder_id: target.folderId,
              snooze_source_folder_id: null,
              snoozed_until: null,
            })
            .where(
              and(
                eq(schema.emails.id, target.id),
                eq(schema.emails.folder_id, Folders.SNOOZED),
              ),
            )
            .run();
        }
        this.#recordActivity(
          { kind: "system" },
          "snooze_due_wake_batch",
          "folder",
          Folders.SNOOZED,
          { affectedCount: plan.wake.length },
          occurredAt,
        );
      });
    }
    return plan.nextWakeAt;
  }

  #processReplyWakeBatch(): boolean {
    const queued = this.db
      .select()
      .from(schema.snoozeReplyWakeQueue)
      .orderBy(
        asc(schema.snoozeReplyWakeQueue.requested_at),
        asc(schema.snoozeReplyWakeQueue.thread_id),
      )
      .limit(1)
      .get();
    if (!queued) return false;
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT id FROM emails
			 WHERE folder_id = ?1 AND thread_id = ?2
			 ORDER BY date ASC, id ASC
			 LIMIT 100`,
        Folders.SNOOZED,
        queued.thread_id,
      ),
    ] as Array<{ id: string }>;
    const occurredAt = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      if (rows.length > 0) {
        this.db
          .update(schema.emails)
          .set({
            folder_id: Folders.INBOX,
            snooze_source_folder_id: null,
            snoozed_until: null,
          })
          .where(
            inArray(
              schema.emails.id,
              rows.map((row) => row.id),
            ),
          )
          .run();
        this.#recordActivity(
          { kind: "system" },
          "conversation_woken_by_reply",
          "conversation",
          queued.thread_id,
          { affectedCount: rows.length },
          occurredAt,
        );
      }
      const remaining = this.db
        .select({ id: schema.emails.id })
        .from(schema.emails)
        .where(
          and(
            eq(schema.emails.folder_id, Folders.SNOOZED),
            eq(schema.emails.thread_id, queued.thread_id),
          ),
        )
        .limit(1)
        .get();
      if (!remaining) {
        this.db
          .delete(schema.snoozeReplyWakeQueue)
          .where(eq(schema.snoozeReplyWakeQueue.thread_id, queued.thread_id))
          .run();
      }
    });
    return Boolean(
      this.db
        .select({ threadId: schema.snoozeReplyWakeQueue.thread_id })
        .from(schema.snoozeReplyWakeQueue)
        .limit(1)
        .get(),
    );
  }

  async #processFollowUpReplyCompletionQueue(
    now: number,
  ): Promise<number | null> {
    const repository: FollowUpReplyQueueRepository = {
      nextDue: async (dueAt) => {
        const row = this.db
          .select()
          .from(schema.followUpReplyCompletionQueue)
          .where(
            lte(schema.followUpReplyCompletionQueue.next_attempt_at, dueAt),
          )
          .orderBy(
            asc(schema.followUpReplyCompletionQueue.next_attempt_at),
            asc(schema.followUpReplyCompletionQueue.inbound_message_id),
          )
          .limit(1)
          .get();
        return row
          ? {
              inboundMessageId: row.inbound_message_id,
              mailboxAddress: row.mailbox_address,
              conversationKey: row.conversation_key,
              inboundMessageDate: row.inbound_message_date,
              attempts: row.attempts,
            }
          : null;
      },
      remove: async (inboundMessageId) => {
        this.db
          .delete(schema.followUpReplyCompletionQueue)
          .where(
            eq(
              schema.followUpReplyCompletionQueue.inbound_message_id,
              inboundMessageId,
            ),
          )
          .run();
      },
      retry: async (input) => {
        this.db
          .update(schema.followUpReplyCompletionQueue)
          .set({
            attempts: input.attempts,
            next_attempt_at: input.nextAttemptAt,
            last_error: input.lastError,
          })
          .where(
            eq(
              schema.followUpReplyCompletionQueue.inbound_message_id,
              input.inboundMessageId,
            ),
          )
          .run();
      },
      nextAttemptAt: async () =>
        this.db
          .select({
            nextAttemptAt: schema.followUpReplyCompletionQueue.next_attempt_at,
          })
          .from(schema.followUpReplyCompletionQueue)
          .orderBy(
            asc(schema.followUpReplyCompletionQueue.next_attempt_at),
            asc(schema.followUpReplyCompletionQueue.inbound_message_id),
          )
          .limit(1)
          .get()?.nextAttemptAt ?? null,
    };
    return processOneFollowUpReplyCompletion({
      repository,
      now,
      complete: (item) =>
        followUpReminderD1Store(this.env).completeForInboundReply({
          mailboxAddress: item.mailboxAddress,
          conversationKey: item.conversationKey,
          inboundMessageId: item.inboundMessageId,
          inboundMessageDate: item.inboundMessageDate,
          occurredAt: Date.now(),
        }),
    });
  }

  async #selfHealSnoozes(now = Date.now()) {
    const replyWakePending = this.#processReplyWakeBatch();
    const nextDueAt = this.#processDueSnoozeBatch(now);
    const nextFollowUpAt = await this.#processFollowUpReplyCompletionQueue(now);
    const next = earliestMailboxAlarm([
      replyWakePending ? now + 100 : null,
      nextDueAt,
      nextFollowUpAt,
    ]);
    if (next !== null) {
      await finalizeCommittedSnooze({
        ensureAlarm: () => this.#scheduleAlarmAt(Math.max(now, next)),
        logFailure: (error) =>
          console.error("failed to re-arm Snooze during read self-heal", {
            error: error instanceof Error ? error.message : String(error),
          }),
      });
    }
  }

  async #selfHealCleanupAlarm(now = Date.now()) {
    const nextPending = this.db
      .select({ nextAttemptAt: schema.r2DeletionOutbox.next_attempt_at })
	      .from(schema.r2DeletionOutbox)
	      .where(
		and(
		  eq(schema.r2DeletionOutbox.state, "pending"),
		  isNull(schema.r2DeletionOutbox.parked_at),
		),
	  )
      .orderBy(
        asc(schema.r2DeletionOutbox.next_attempt_at),
        asc(schema.r2DeletionOutbox.r2_key),
      )
      .limit(1)
      .get();
    const nextDeleting = this.db
      .select({ leaseExpiresAt: schema.r2DeletionOutbox.lease_expires_at })
      .from(schema.r2DeletionOutbox)
	      .where(
		and(
		  eq(schema.r2DeletionOutbox.state, "deleting"),
		  isNull(schema.r2DeletionOutbox.parked_at),
		),
	  )
      .orderBy(
        asc(schema.r2DeletionOutbox.lease_expires_at),
        asc(schema.r2DeletionOutbox.r2_key),
      )
      .limit(1)
      .get();
	let attachmentCleanupNextAt: number | null = null;
	try {
	  attachmentCleanupNextAt = this.#nextAttachmentCleanupAt(
		this.#normalizeAttachmentCleanupQueue(
		  (await this.ctx.storage.get<AttachmentCleanupJob[]>(
			ATTACHMENT_CLEANUP_QUEUE_KEY,
		  )) ?? [],
		  now,
		),
	  );
	} catch (error) {
	  console.error("failed to inspect attachment cleanup during mailbox read", {
		operation: "attachment_cleanup_queue",
		status: "unknown",
		errorName: error instanceof Error ? error.name : "UnknownError",
	  });
    }
    const nextDraftSaveCleanupAt = this.#nextDraftSaveCleanupAt();
    const nextDraftSaveClaimExpiryAt = this.#nextDraftSaveClaimExpiryAt();
    const candidates = [
      nextPending?.nextAttemptAt,
      nextDeleting?.leaseExpiresAt,
      nextDraftSaveCleanupAt,
	  nextDraftSaveClaimExpiryAt,
	  attachmentCleanupNextAt,
    ].flatMap((value) => {
      if (!value) return [];
      if (typeof value === "number") {
        return [Number.isFinite(value) ? value : now];
      }
      const parsed = Date.parse(value);
      return [Number.isFinite(parsed) ? parsed : now];
    });
    if (candidates.length === 0) return;
    try {
      await this.#scheduleAlarmAt(Math.max(now, Math.min(...candidates)));
    } catch (error) {
      console.error("failed to re-arm mailbox cleanup during mailbox read", {
        operation: "mailbox_cleanup_alarm",
        status: "pending",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  async #ensureOutboundAlarm() {
    const nextActionAt = this.#outboxService().nextActionAt();
	const recoveryNext = this.db
	  .select({
		next: sql<string | null>`MIN(CASE
		  WHEN ${schema.outboundAcceptanceRecovery.next_attempt_at} IS NULL
			OR strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundAcceptanceRecovery.next_attempt_at}) IS NULL
			OR strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundAcceptanceRecovery.next_attempt_at}) <> ${schema.outboundAcceptanceRecovery.next_attempt_at}
		  THEN '1970-01-01T00:00:00.000Z'
		  ELSE ${schema.outboundAcceptanceRecovery.next_attempt_at} END)`,
	  })
	  .from(schema.outboundAcceptanceRecovery)
	  .where(
		inArray(schema.outboundAcceptanceRecovery.state, ["pending", "retrying"]),
	  )
	  .get()?.next;
	const next = [nextActionAt, recoveryNext]
	  .flatMap((value) => (value ? [Date.parse(value)] : []))
	  .filter(Number.isFinite)
	  .sort((a, b) => a - b)[0];
	if (next !== undefined) await this.#scheduleAlarmAt(Math.max(Date.now(), next));
  }

	  async #moveAcceptedOutboundToSent(
    emailId: string,
    sesMessageId: string,
    actor: OutboundDeliveryActor,
    at: string,
  ) {
	    return this.ctx.storage.transactionSync(() => {
		  const current = this.db
			.select({
			  folderId: schema.emails.folder_id,
			  previousFolderId: schema.emails.previous_folder_id,
			  rawHeaders: schema.emails.raw_headers,
			})
			.from(schema.emails)
			.where(eq(schema.emails.id, emailId))
			.get();
		  if (!current || current.rawHeaders === null) {
			return { status: "snapshot_missing" as const };
		  }
		  const snapshot = deserializeOutboundSnapshot(current.rawHeaders);
		  if (!snapshot) {
			return { status: "outbound_snapshot_invalid" as const };
		  }
	  if (current.folderId !== Folders.OUTBOX) {
		this.db
		  .update(schema.emails)
		  .set({
			message_id: sesMessageId,
			date: at,
			recipient_memory_origin: RecipientMemoryOrigins.ACCEPTED_OUTBOUND,
			...(current.previousFolderId === Folders.OUTBOX
			  ? { previous_folder_id: Folders.SENT }
			  : {}),
		  })
		  .where(eq(schema.emails.id, emailId))
		  .run();
	  } else {
        this.db
        .update(schema.emails)
        .set({
          folder_id: Folders.SENT,
          date: at,
          message_id: sesMessageId,
          read: 1,
          recipient_memory_origin: RecipientMemoryOrigins.ACCEPTED_OUTBOUND,
        })
		.where(
		  and(
			eq(schema.emails.id, emailId),
			eq(schema.emails.folder_id, Folders.OUTBOX),
		  ),
		)
        .run();
	  }
	      recordRecipientInteractions(this.ctx.storage.sql, {
	          sourceEmailId: emailId,
	          direction: "sent",
	          occurredAt: at,
	          mailboxAddress: snapshot.mailboxId,
	          addresses: [...snapshot.to, ...snapshot.cc, ...snapshot.bcc],
	        });
	        createMailPeopleProjector({
	          store: this.ctx.storage,
	          mailboxAddress: snapshot.mailboxId,
	        }).projectMessage(emailId);
	  this.#recordActivityOnce(
		`outbound_provider_accepted:${emailId}`,
        actor,
        "outbound_provider_accepted",
        "email",
        emailId,
	        { sesMessageId },
	        at,
	      );
		  return { status: "projected" as const };
	    });
	  }

  async getRecipientSuggestions(
    mailboxAddress: string,
    query: string,
    limit: number,
  ) {
    this.ctx.storage.transactionSync(() => {
      seedRecipientInteractions(this.ctx.storage.sql, mailboxAddress);
    });
    return readRecipientSuggestions(
      this.ctx.storage.sql,
      mailboxAddress,
      query,
      limit,
    );
  }

  async listMailPeople(
    mailboxAddress: string,
    query: NormalizedMailPeopleListQuery,
  ) {
    const normalizedMailbox = normalizeMailAddress(mailboxAddress);
    if (!normalizedMailbox || normalizedMailbox !== mailboxAddress) {
      throw new Error("Mailbox address is invalid");
    }
    return createMailPeopleProjector({
      store: this.ctx.storage,
      mailboxAddress: normalizedMailbox,
    }).listPeople(validateNormalizedMailPeopleListQuery(query));
  }

  async getMailPerson(mailboxAddress: string, personId: string) {
    const normalizedMailbox = normalizeMailAddress(mailboxAddress);
    if (!normalizedMailbox || normalizedMailbox !== mailboxAddress) {
      throw new Error("Mailbox address is invalid");
    }
    return createMailPeopleProjector({
      store: this.ctx.storage,
      mailboxAddress: normalizedMailbox,
    }).getPerson(validateMailPersonId(personId));
  }

  async listMailPersonTimeline(
    mailboxAddress: string,
    personId: string,
    query: NormalizedMailPersonTimelineQuery,
  ) {
    const normalizedMailbox = normalizeMailAddress(mailboxAddress);
    if (!normalizedMailbox || normalizedMailbox !== mailboxAddress) {
      throw new Error("Mailbox address is invalid");
    }
    const id = validateMailPersonId(personId);
    return createMailPeopleProjector({
      store: this.ctx.storage,
      mailboxAddress: normalizedMailbox,
    }).listPersonTimeline(
      id,
      validateNormalizedMailPersonTimelineQuery(query, id),
    );
  }

  async getRelationshipBriefEvidence(mailboxAddress: string, personId: string) {
    const normalizedMailbox = normalizeMailAddress(mailboxAddress);
    if (!normalizedMailbox || normalizedMailbox !== mailboxAddress) {
      throw new Error("Mailbox address is invalid");
    }
    const id = validateMailPersonId(personId);
    const projector = createMailPeopleProjector({
      store: this.ctx.storage,
      mailboxAddress: normalizedMailbox,
    });
    const prepared = projector.getPerson(id);
    if (prepared.status === "building") {
      return {
        state: "building" as const,
        processedMessages: prepared.processedMessages,
        retryAfterMs: prepared.retryAfterMs,
      };
    }
    if (prepared.person === null) return { state: "not_found" as const };
    return readRelationshipBriefEvidence(this.ctx.storage.sql, id);
  }

  async claimRelationshipBriefGeneration(
    cacheKey: string,
    ownerUserId: string,
    claimToken: string,
    expiresAt: number,
  ) {
    return this.claimTodayBriefGeneration(
      cacheKey,
      ownerUserId,
      claimToken,
      expiresAt,
    );
  }

  async releaseRelationshipBriefGeneration(
    cacheKey: string,
    ownerUserId: string,
    claimToken: string,
  ) {
    return this.releaseTodayBriefGeneration(cacheKey, ownerUserId, claimToken);
  }

  async #consumeAcceptedSourceDraft(
    draftId: string | undefined,
    draftVersion: number | undefined,
    actor: OutboundDeliveryActor,
  ) {
    if (!draftId || draftVersion === undefined) return;
    const consumed = await this.consumeDraftVersion(
      draftId,
      draftVersion,
      actor,
    );
    if (consumed.status !== "consumed") return;
	// Exact R2 deletion intents were committed in the same transaction that
	// consumed the draft and retired its attachment ownership rows.
  }

  async #loadOutboundAttachments(
    emailId: string,
    expectedAttachmentIds: readonly string[],
    byteIdentities: readonly OutboundAttachmentByteIdentity[] | undefined,
  ) {
    const email = this.db
      .select({ id: schema.emails.id })
      .from(schema.emails)
      .where(eq(schema.emails.id, emailId))
      .get();
    if (!email) throw new OutboundAttachmentIntegrityError("snapshot_missing");
    const attachments = this.db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.email_id, emailId))
      .all();
    const storedAttachmentIds = attachments
      .map((attachment) => attachment.id)
      .sort();
    const expectedIds = [...expectedAttachmentIds].sort();
    if (expectedIds.length > 0 && byteIdentities === undefined) {
      throw new OutboundAttachmentIntegrityError(
        "attachment_integrity_unverifiable",
      );
    }
    const identityById = new Map(
      (byteIdentities ?? []).map((identity) => [identity.id, identity]),
    );
    if (
      storedAttachmentIds.length !== expectedIds.length ||
      storedAttachmentIds.some((id, index) => id !== expectedIds[index]) ||
      identityById.size !== expectedIds.length ||
      expectedIds.some((id) => !identityById.has(id))
    ) {
      throw new OutboundAttachmentIntegrityError(
        "attachment_metadata_mismatch",
      );
    }
    return Promise.all(
      attachments.map(async (attachment) => {
        const identity = identityById.get(attachment.id);
        if (!identity) {
          throw new OutboundAttachmentIntegrityError(
            "attachment_integrity_unverifiable",
          );
        }
        const object = await this.env.BUCKET.get(
          storedAttachmentKey(attachment),
        );
        if (!object) {
          throw new OutboundAttachmentIntegrityError("attachment_missing");
        }
        if (
          object.size !== attachment.size ||
          identity.byteLength !== attachment.size
        ) {
          throw new OutboundAttachmentIntegrityError(
            "attachment_size_mismatch",
          );
        }
        const bytes = await object.arrayBuffer();
        if (bytes.byteLength !== attachment.size) {
          throw new OutboundAttachmentIntegrityError(
            "attachment_size_mismatch",
          );
        }
        if (!(await outboundAttachmentBytesMatch(bytes, identity))) {
          throw new OutboundAttachmentIntegrityError(
            "attachment_content_mismatch",
          );
        }
		if (
			identity.filename !== attachment.filename ||
			identity.mimetype !== attachment.mimetype ||
			identity.disposition !== attachment.disposition ||
			(identity.contentId ?? null) !== (attachment.content_id ?? null)
		) {
			throw new OutboundAttachmentIntegrityError(
				"attachment_metadata_mismatch",
			);
		}
        return {
          content: arrayBufferToBase64(bytes),
          filename: identity.filename,
          type: identity.mimetype,
          disposition: identity.disposition,
          ...(identity.disposition === "inline" && identity.contentId
            ? { contentId: identity.contentId }
            : {}),
        };
      }),
    );
  }

  async #outboundActorStillAuthorized(
    actor: OutboundDeliveryActor,
    mailboxId: string,
  ): Promise<boolean> {
    if (!actor.id) return false;
    return mailboxAccess(this.env).canAccessMailbox(actor.id, mailboxId);
  }

  #dispatchQuotaPlan(now: string) {
    const hourStart = new Date(Date.parse(now) - 60 * 60_000).toISOString();
    const dayStart = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString();
    const sentHour = [
      ...this.ctx.storage.sql.exec(
        `SELECT COUNT(*) AS count, MIN(date) AS oldest
			 FROM emails
			 WHERE folder_id = ?1 AND date >= ?2`,
        Folders.SENT,
        hourStart,
      ),
    ][0] as { count: number; oldest: string | null } | undefined;
    const sentDay = [
      ...this.ctx.storage.sql.exec(
        `SELECT COUNT(*) AS count, MIN(date) AS oldest
			 FROM emails
			 WHERE folder_id = ?1 AND date >= ?2`,
        Folders.SENT,
        dayStart,
      ),
    ][0] as { count: number; oldest: string | null } | undefined;
    const active = [
      ...this.ctx.storage.sql.exec(
        `SELECT COUNT(*) AS count
			 FROM outbound_deliveries
			 WHERE status = 'sending'`,
      ),
    ][0] as { count: number } | undefined;

    return planDispatchQuota({
      sentLastHour: Number(sentHour?.count ?? 0),
      sentLastDay: Number(sentDay?.count ?? 0),
      activeReservations: Number(active?.count ?? 0),
      ...(sentHour?.oldest ? { oldestSentInHour: sentHour.oldest } : {}),
      ...(sentDay?.oldest ? { oldestSentInDay: sentDay.oldest } : {}),
      now,
    });
  }

  #parkOutboundAcceptanceRecovery(
	deliveryId: string,
	code: string,
	at: string,
  ) {
	this.ctx.storage.transactionSync(() => {
	  const current = this.db
		.select({ generation: schema.outboundAcceptanceRecovery.generation })
		.from(schema.outboundAcceptanceRecovery)
		.where(eq(schema.outboundAcceptanceRecovery.delivery_id, deliveryId))
		.get();
	  if (!current) return;
	  const generation = current.generation + 1;
	  this.db
		.update(schema.outboundAcceptanceRecovery)
		.set({
		  state: "parked",
		  generation,
		  next_attempt_at: null,
		  last_error_code: code,
		  updated_at: at,
		})
		.where(eq(schema.outboundAcceptanceRecovery.delivery_id, deliveryId))
		.run();
	  this.#recordActivityOnce(
		`outbound_acceptance_recovery_parked:${deliveryId}:${generation}`,
		{ kind: "system" },
		"outbound_acceptance_recovery_parked",
		"outbound_delivery",
		deliveryId,
		{ code, generation },
		at,
	  );
	});
  }

  #deferOutboundAcceptanceRecovery(
	row: typeof schema.outboundAcceptanceRecovery.$inferSelect,
	at: string,
  ) {
	const attempts = row.attempt_count + 1;
	if (attempts >= 6) {
	  this.#parkOutboundAcceptanceRecovery(
		row.delivery_id,
		"outbound_projection_retry_exhausted",
		at,
	  );
	  return;
	}
	const delays = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
	this.db
	  .update(schema.outboundAcceptanceRecovery)
	  .set({
		state: "retrying",
		attempt_count: attempts,
		next_attempt_at: new Date(Date.parse(at) + delays[attempts - 1]!).toISOString(),
		last_error_code: "outbound_projection_deferred",
		updated_at: at,
	  })
	  .where(eq(schema.outboundAcceptanceRecovery.delivery_id, row.delivery_id))
	  .run();
  }

  async #processOutboundAcceptanceRecovery(now: string) {
	const rows = this.db
	  .select()
	  .from(schema.outboundAcceptanceRecovery)
	  .where(
		and(
		  inArray(schema.outboundAcceptanceRecovery.state, ["pending", "retrying"]),
		  or(
			isNull(schema.outboundAcceptanceRecovery.next_attempt_at),
			lte(schema.outboundAcceptanceRecovery.next_attempt_at, now),
			sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundAcceptanceRecovery.next_attempt_at}) IS NULL`,
			sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.outboundAcceptanceRecovery.next_attempt_at}) <> ${schema.outboundAcceptanceRecovery.next_attempt_at}`,
		  ),
		),
	  )
	  .orderBy(
		asc(schema.outboundAcceptanceRecovery.next_attempt_at),
		asc(schema.outboundAcceptanceRecovery.delivery_id),
	  )
	  .limit(10)
	  .all();
	const actorKinds = new Set(["user", "mcp", "agent", "rule", "system"]);
	for (const row of rows) {
	  const acceptedAt = row.accepted_at;
	  const acceptedAtMs = acceptedAt ? Date.parse(acceptedAt) : Number.NaN;
	  const acceptedAtValid =
		acceptedAt !== null &&
		Number.isFinite(acceptedAtMs) &&
		new Date(acceptedAtMs).toISOString() === acceptedAt;
	  const sourcePairValid =
		(row.source_draft_id === null && row.source_draft_version === null) ||
		(Boolean(row.source_draft_id) &&
		  Number.isInteger(row.source_draft_version) &&
		  (row.source_draft_version ?? 0) >= 1);
	  const deliveryEvidence = this.db
		.select()
		.from(schema.outboundDeliveries)
		.where(eq(schema.outboundDeliveries.id, row.delivery_id))
		.get();
	  const attemptEvidence = row.attempt_id
		? this.db
			.select()
			.from(schema.outboundDeliveryAttempts)
			.where(eq(schema.outboundDeliveryAttempts.id, row.attempt_id))
			.get()
		: null;
	  const recoveryIdentityMatchesDelivery =
		Boolean(deliveryEvidence) &&
		deliveryEvidence!.email_id === row.email_id &&
		deliveryEvidence!.source_draft_id === row.source_draft_id &&
		deliveryEvidence!.source_draft_version === row.source_draft_version &&
		deliveryEvidence!.actor_kind === row.actor_kind &&
		(deliveryEvidence!.actor_id ?? null) === (row.actor_id ?? null);
	  const acceptedEvidence = this.#acceptedOutboundProviderEvidence(row.delivery_id);
	  const acceptedAttemptEvidenceValid =
		acceptedEvidence.status === "valid" &&
		attemptEvidence?.delivery_id === row.delivery_id &&
		attemptEvidence.status === "accepted" &&
		acceptedEvidence.attempts.some(
		  (attempt) => attempt.id === attemptEvidence.id,
		);
	  if (
		!deliveryEvidence ||
		!recoveryIdentityMatchesDelivery ||
		!acceptedAttemptEvidenceValid ||
		!actorKinds.has(row.actor_kind) ||
		!sourcePairValid
	  ) {
		this.#parkOutboundAcceptanceRecovery(
		  row.delivery_id,
		  "outbound_repair_evidence_mismatch",
		  now,
		);
		continue;
	  }
	  if (acceptedEvidence.status !== "valid") {
		this.#parkOutboundAcceptanceRecovery(
		  row.delivery_id,
		  "outbound_repair_evidence_mismatch",
		  now,
		);
		continue;
	  }
	  const acceptedAttempts = acceptedEvidence.attempts;
	  const acceptedEvents = acceptedEvidence.events;
	  const acceptedTruth = acceptedEvidence.truth;
	  const authoritativeAttempt = acceptedEvidence.authoritativeAttempt;
	  const newerAmbiguousAttempt = this.db
		.select({ id: schema.outboundDeliveryAttempts.id })
		.from(schema.outboundDeliveryAttempts)
		.where(
		  and(
			eq(schema.outboundDeliveryAttempts.delivery_id, row.delivery_id),
			eq(schema.outboundDeliveryAttempts.status, "unknown"),
			sql`${schema.outboundDeliveryAttempts.attempt_number} > ${authoritativeAttempt.attempt_number}`,
		  ),
		)
		.get();
	  const aggregateStatus =
		acceptedTruth === "sent"
		  ? "sent"
		  : acceptedTruth === "unknown" || newerAmbiguousAttempt
			? "unknown"
			: "bounced";
	  const aggregateErrorCode = acceptedEvents.some(
		(event) => event.event_class === "complaint",
	  )
		? "ses_complaint"
		: aggregateStatus === "unknown" && acceptedTruth === "unknown"
		  ? "ses_bounce_scope_unknown"
		  : aggregateStatus === "bounced"
			? "ses_bounce"
			: aggregateStatus === "sent" && acceptedEvents.some(
				(event) => event.event_class === "bounce",
			  )
			  ? "ses_partial_bounce"
			  : aggregateStatus === "sent" && acceptedAttempts.some(
				  (attempt) =>
					attempt.provider_state === "bounced" ||
					attempt.provider_state === "bounce_scope_unknown",
				)
				? "ses_duplicate_attempt_partial_failure"
				: aggregateStatus === "unknown"
				  ? newerAmbiguousAttempt
					? "ses_duplicate_attempt_outcome_unknown"
					: deliveryEvidence.last_error_code ?? "ses_duplicate_attempt_outcome_unknown"
				  : null;
	  const duplicateAcceptanceAt = acceptedAttempts.length > 1
		? isCanonicalUtcTimestamp(deliveryEvidence.duplicate_acceptance_at)
		  ? deliveryEvidence.duplicate_acceptance_at
		  : acceptedAttempts[acceptedAttempts.length - 2]!.finished_at
		: null;
	  const deliveryPreservesAcceptedTruth =
		deliveryEvidence.status === aggregateStatus &&
		deliveryEvidence.retry_origin_status === null &&
		deliveryEvidence.dispatch_phase === null &&
		deliveryEvidence.active_attempt_id === null &&
		deliveryEvidence.lease_token === null &&
		deliveryEvidence.lease_expires_at === null &&
		deliveryEvidence.next_attempt_at === null &&
		deliveryEvidence.accepted_attempt_count === acceptedAttempts.length &&
		deliveryEvidence.duplicate_acceptance_at === duplicateAcceptanceAt &&
		deliveryEvidence.ses_message_id === authoritativeAttempt.ses_message_id &&
		deliveryEvidence.sent_at === authoritativeAttempt.finished_at &&
		deliveryEvidence.failed_at === null &&
		deliveryEvidence.cancelled_at === null &&
		deliveryEvidence.last_error_code === aggregateErrorCode &&
		deliveryEvidence.last_error_message === null &&
		(aggregateStatus === "unknown"
		  ? isCanonicalUtcTimestamp(deliveryEvidence.unknown_at)
		  : deliveryEvidence.unknown_at === null);
	  if (
		!deliveryPreservesAcceptedTruth ||
		row.attempt_id !== authoritativeAttempt.id ||
		row.accepted_at !== authoritativeAttempt.finished_at ||
		row.ses_message_id !== authoritativeAttempt.ses_message_id
	  ) {
		this.ctx.storage.transactionSync(() => {
		  this.db
			.update(schema.outboundDeliveries)
			.set({
			  status: aggregateStatus,
			  retry_origin_status: null,
			  dispatch_phase: null,
			  active_attempt_id: null,
			  lease_token: null,
			  lease_expires_at: null,
			  next_attempt_at: null,
			  ses_message_id: authoritativeAttempt.ses_message_id,
			  sent_at: authoritativeAttempt.finished_at,
			  failed_at: null,
			  unknown_at: aggregateStatus === "unknown" ? now : null,
			  cancelled_at: null,
			  duplicate_acceptance_at: duplicateAcceptanceAt,
			  last_error_code: aggregateErrorCode,
			  last_error_message: null,
			  accepted_attempt_count: acceptedAttempts.length,
			  updated_at: now,
			})
			.where(eq(schema.outboundDeliveries.id, row.delivery_id))
			.run();
		  this.db
			.update(schema.outboundAcceptanceRecovery)
			.set({
			  attempt_id: authoritativeAttempt.id,
			  ses_message_id: authoritativeAttempt.ses_message_id,
			  accepted_at: authoritativeAttempt.finished_at,
			  next_attempt_at: now,
			  last_error_code: null,
			  updated_at: now,
			})
			.where(eq(schema.outboundAcceptanceRecovery.delivery_id, row.delivery_id))
			.run();
		});
		continue;
	  }
	  const structuralEvidenceValid =
		deliveryEvidence !== undefined &&
		deliveryPreservesAcceptedTruth &&
		recoveryIdentityMatchesDelivery &&
		attemptEvidence.id === authoritativeAttempt.id &&
		attemptEvidence.ses_message_id === row.ses_message_id &&
		attemptEvidence.finished_at === row.accepted_at;
	  if (
		!row.ses_message_id?.trim() ||
		!acceptedAtValid ||
		!actorKinds.has(row.actor_kind) ||
		!sourcePairValid ||
		!structuralEvidenceValid
	  ) {
		this.#parkOutboundAcceptanceRecovery(
		  row.delivery_id,
		  structuralEvidenceValid
			? "outbound_repair_evidence_insufficient"
			: "outbound_repair_evidence_mismatch",
		  now,
		);
		continue;
	  }
	  const actor: OutboundDeliveryActor = {
		kind: row.actor_kind as OutboundDeliveryActor["kind"],
		...(row.actor_id ? { id: row.actor_id } : {}),
	  };
	  try {
			if (!row.message_projected_at) {
			  const projection = await this.#moveAcceptedOutboundToSent(
				row.email_id,
				row.ses_message_id,
				actor,
				acceptedAt,
			  );
			  if (projection.status !== "projected") {
				this.#parkOutboundAcceptanceRecovery(
					row.delivery_id,
					projection.status,
					now,
				);
				continue;
			  }
		  this.db
			.update(schema.outboundAcceptanceRecovery)
			.set({ message_projected_at: now, updated_at: now })
			.where(eq(schema.outboundAcceptanceRecovery.delivery_id, row.delivery_id))
			.run();
		}
		if (!row.draft_consumed_at) {
		  await this.#consumeAcceptedSourceDraft(
			row.source_draft_id ?? undefined,
			row.source_draft_version ?? undefined,
			actor,
		  );
		  this.db
			.update(schema.outboundAcceptanceRecovery)
			.set({ draft_consumed_at: now, updated_at: now })
			.where(eq(schema.outboundAcceptanceRecovery.delivery_id, row.delivery_id))
			.run();
		}
		this.db
		  .update(schema.outboundAcceptanceRecovery)
		  .set({
			state: "completed",
			next_attempt_at: null,
			last_error_code: null,
			updated_at: now,
			completed_at: now,
		  })
		  .where(eq(schema.outboundAcceptanceRecovery.delivery_id, row.delivery_id))
		  .run();
	  } catch {
		this.#deferOutboundAcceptanceRecovery(row, now);
	  }
	}
  }

  async #processOutboundAlarm(): Promise<void> {
    const service = this.#outboxService();
    const now = new Date().toISOString();
    service.recoverExpiredLeases(now);
	await this.#processOutboundAcceptanceRecovery(now);

	for (const delivery of service.listPendingCancellationRecovery(now, 10)) {
	  try {
		await this.#recoverCancelledOutboundSnapshot(
		  delivery,
		  this.#cancelledOutboundRecoveryActor(delivery.id),
		  delivery.cancelledAt ?? delivery.updatedAt,
		);
		this.#completeCancelledOutboundRecovery(delivery.id);
	  } catch (error) {
		await this.#deferCancelledOutboundRecovery(delivery.id, error);
	  }
	}

    // Reconcile both the Sent move and exact draft-version consumption. The
    // latter also runs after the email already moved, covering a crash between
    // those two idempotent steps.
    for (const delivery of service.listUnreconciledAccepted(now, 10)) {
		try {
			if (!delivery.sesMessageId?.trim()) {
				service.deferAcceptedReconciliation(
					delivery.id,
					new Date(Date.parse(now) + 5 * 60_000).toISOString(),
					"outbound_acceptance_identity_missing",
					"Provider acceptance is preserved, but its local message identity requires audited repair.",
				);
				continue;
			}
			const projection = await this.#moveAcceptedOutboundToSent(
	            delivery.emailId,
	            delivery.sesMessageId,
	            delivery.actor,
	            delivery.sentAt ?? now,
			);
			if (projection.status !== "projected") {
				const evidence = this.#acceptedOutboundProviderEvidence(delivery.id);
				if (evidence.status === "valid") {
					const attempt = evidence.authoritativeAttempt;
					this.db
						.insert(schema.outboundAcceptanceRecovery)
						.values({
							delivery_id: delivery.id,
							email_id: delivery.emailId,
							attempt_id: attempt.id,
							ses_message_id: attempt.ses_message_id,
							accepted_at: attempt.finished_at,
							source_draft_id: delivery.draftId ?? null,
							source_draft_version: delivery.draftVersion ?? null,
							actor_kind: delivery.actor.kind,
							actor_id: delivery.actor.id ?? null,
							state: "pending",
							generation: 0,
							attempt_count: 0,
							next_attempt_at: now,
							created_at: now,
							updated_at: now,
						})
						.onConflictDoNothing()
						.run();
					this.#parkOutboundAcceptanceRecovery(
						delivery.id,
						projection.status,
						now,
					);
				} else {
					service.deferAcceptedReconciliation(
						delivery.id,
						new Date(Date.parse(now) + 5 * 60_000).toISOString(),
						"outbound_reconciliation_record_invalid",
						"Provider acceptance is preserved, but its local recovery evidence requires audited repair.",
					);
				}
				continue;
			}
        await this.#consumeAcceptedSourceDraft(
          delivery.draftId,
          delivery.draftVersion,
          delivery.actor,
        );
		service.completeAcceptedReconciliation(delivery.id);
		} catch {
			service.deferAcceptedReconciliation(
				delivery.id,
				new Date(Date.parse(now) + 60_000).toISOString(),
				"outbound_reconciliation_deferred",
				"The accepted message remains safe while local reconciliation retries.",
			);
		}
    }

    const preflight = service.claimNextForPreflight(now, 60_000);
    if (!preflight) {
      return;
    }
    // Per Cloudflare Durable Objects alarm docs, alarms run at least once and
    // only one alarm is scheduled per object. Persist and schedule the local
    // lease before any external preflight I/O so a restart has a recovery wake.
    await this.#scheduleAlarmAt(Date.parse(preflight.delivery.leaseExpiresAt!));

    const leaseToken = preflight.delivery.leaseToken!;
    const snapshot = preflight.snapshot;
      let actorAuthorized: boolean;
      try {
        actorAuthorized = await this.#outboundActorStillAuthorized(
        preflight.delivery.actor,
        preflight.delivery.mailboxId,
        );
    } catch {
        const failedAt = new Date().toISOString();
      service.deferPreflight(preflight.delivery.id, leaseToken, {
            at: failedAt,
            retryAt: new Date(Date.parse(failedAt) + 60_000).toISOString(),
            code: "authority_check_unavailable",
        message: "Mailbox authorization could not be verified.",
      });
        return;
      }
      if (!actorAuthorized) {
        const failedAt = new Date().toISOString();
      service.failPreflight(preflight.delivery.id, leaseToken, {
            at: failedAt,
            code: "authorization_revoked",
        message: "The initiating actor no longer has access to this mailbox.",
      });
        this.#recordActivity(
          { kind: "system" },
          "outbound_authorization_revoked",
          "outbound_delivery",
        preflight.delivery.id,
          {
          actorKind: preflight.delivery.actor.kind,
          actorId: preflight.delivery.actor.id,
          },
          failedAt,
        );
        return;
      }

      const quota = this.#dispatchQuotaPlan(new Date().toISOString());
      if (!quota.allowed) {
        const failedAt = new Date().toISOString();
      service.deferPreflight(preflight.delivery.id, leaseToken, {
            at: failedAt,
            retryAt: quota.retryAt,
            code: quota.code,
            message:
              "Mailbox send capacity is reserved until the current window advances.",
      });
        this.#recordActivity(
          { kind: "system" },
          "outbound_quota_deferred",
          "outbound_delivery",
        preflight.delivery.id,
          { code: quota.code, retryAt: quota.retryAt },
          failedAt,
        );
        return;
      }

    let attachments;
    try {
      attachments = await this.#loadOutboundAttachments(
        preflight.delivery.emailId,
        snapshot.attachmentIds,
        snapshot.attachmentByteIdentities,
      );
    } catch (error) {
      const failedAt = new Date().toISOString();
      if (error instanceof OutboundAttachmentIntegrityError) {
        service.failPreflight(preflight.delivery.id, leaseToken, {
          at: failedAt,
          code: error.code,
          message:
            error.code === "attachment_integrity_unverifiable"
              ? "This queued message predates exact attachment verification. Re-attach the files and send again."
              : "The immutable outbound snapshot is incomplete or corrupt.",
        });
      } else {
        service.deferPreflight(preflight.delivery.id, leaseToken, {
          at: failedAt,
          retryAt: new Date(Date.parse(failedAt) + 60_000).toISOString(),
          code: "attachment_store_unavailable",
          message: "Attachment storage could not be read.",
        });
      }
      return;
    }

    const fromDomain = snapshot.from.split("@")[1] ?? "";
    const attemptId = `attempt_${crypto.randomUUID()}`;
    const preparation = await prepareSesSend(this.env, {
        to: snapshot.to,
        cc: snapshot.cc,
        bcc: snapshot.bcc,
        from: snapshot.from,
        subject: snapshot.subject,
        html: snapshot.html,
        text: snapshot.text,
        attachments,
        headers: buildThreadingHeaders(
          snapshot.inReplyTo ?? null,
          snapshot.references ?? [],
          buildThreadToken(snapshot.threadId, fromDomain),
        ),
        tracking: {
          mailboxId: snapshot.mailboxId,
        deliveryId: preflight.delivery.id,
        attemptId,
        },
      });
    if (!preparation.ok) {
      const failedAt = new Date().toISOString();
      if (preparation.stage === "request") {
        service.failPreflight(preflight.delivery.id, leaseToken, {
          at: failedAt,
          code: "ses_request_invalid",
          message:
            "The immutable outbound snapshot cannot form a valid request.",
        });
      } else {
        service.deferPreflight(preflight.delivery.id, leaseToken, {
          at: failedAt,
          retryAt: new Date(Date.parse(failedAt) + 60_000).toISOString(),
          code: "ses_signing_unavailable",
          message: "The provider request could not be prepared.",
        });
      }
      return;
    }

	// Attachment reads, hashing, and signing can be slow. Revalidate access and
	// capacity at the final pre-provider boundary so revoked actors and expired
	// reservations cannot cross into an external send.
	let stillAuthorized: boolean;
	try {
		stillAuthorized = await this.#outboundActorStillAuthorized(
			preflight.delivery.actor,
			preflight.delivery.mailboxId,
		);
	} catch {
		const deferredAt = new Date().toISOString();
		service.deferPreflight(preflight.delivery.id, leaseToken, {
			at: deferredAt,
			retryAt: new Date(Date.parse(deferredAt) + 60_000).toISOString(),
			code: "authority_check_unavailable",
			message: "Mailbox authorization could not be verified.",
		});
		return;
	}
	if (!stillAuthorized) {
		const failedAt = new Date().toISOString();
		service.failPreflight(preflight.delivery.id, leaseToken, {
			at: failedAt,
			code: "authorization_revoked",
			message: "The initiating actor no longer has access to this mailbox.",
		});
		return;
	}
	const finalQuota = this.#dispatchQuotaPlan(new Date().toISOString());
	if (!finalQuota.allowed) {
		const deferredAt = new Date().toISOString();
		service.deferPreflight(preflight.delivery.id, leaseToken, {
			at: deferredAt,
			retryAt: finalQuota.retryAt,
			code: finalQuota.code,
			message:
				"Mailbox send capacity is reserved until the current window advances.",
		});
		return;
	}

    // Keep the durable provider begin and single-use fetch adjacent. Once the
    // attempt begins, a missing response is ambiguous and must not auto-retry.
    const claimed = service.beginProviderAttempt(
      preflight.delivery.id,
      leaseToken,
      attemptId,
      new Date().toISOString(),
      5 * 60_000,
    );
    const observed = await dispatchPreparedSesSend(preparation.prepared);

    const classified = classifySesOutcome(observed);
    const finishedAt = new Date().toISOString();
	try {
	if (classified.kind === "sent") {
      const finalized = service.finalizeAccepted(
        claimed.delivery.id,
        claimed.attempt.leaseToken,
        classified.sesMessageId,
        finishedAt,
      );
	      const projection = await this.#moveAcceptedOutboundToSent(
	        finalized.delivery.emailId,
	        classified.sesMessageId,
	        finalized.delivery.actor,
	        finishedAt,
	      );
	      if (projection.status !== "projected") {
			this.#parkOutboundAcceptanceRecovery(
				finalized.delivery.id,
				projection.status,
				finishedAt,
			);
			return;
	      }
      await this.#consumeAcceptedSourceDraft(
        finalized.delivery.draftId,
        finalized.delivery.draftVersion,
        finalized.delivery.actor,
      );
    } else if (classified.kind === "unknown") {
      service.finalizeUnknown(claimed.delivery.id, claimed.attempt.leaseToken, {
        at: finishedAt,
        code: classified.code,
      });
    } else if (classified.automaticRetry) {
      const backoffMs = Math.min(
        30 * 60_000,
        30_000 * 2 ** Math.max(0, claimed.delivery.attemptCount - 1),
      );
      service.finalizeRetryableFailure(
        claimed.delivery.id,
        claimed.attempt.leaseToken,
        {
          at: finishedAt,
          retryAt: new Date(Date.now() + backoffMs).toISOString(),
          code: classified.code,
          ...(observed.kind === "http_error"
            ? { httpStatus: observed.status }
            : {}),
        },
      );
    } else {
      service.finalizeDefinitiveFailure(
        claimed.delivery.id,
        claimed.attempt.leaseToken,
        {
          at: finishedAt,
          code: classified.code,
          ...(observed.kind === "http_error"
            ? { httpStatus: observed.status }
            : {}),
        },
      );
	}
	} catch (error) {
		const eventReconciled = service.get(claimed.delivery.id);
		if (canReconcileConcurrentProviderTerminal(eventReconciled?.status)) {
			const terminalized = classified.kind === "sent"
			  ? this.#recordConcurrentAcceptedProviderOutcome({
				deliveryId: claimed.delivery.id,
				attemptId: claimed.attempt.id,
				leaseToken: claimed.attempt.leaseToken,
				sesMessageId: classified.sesMessageId,
				acceptedAt: finishedAt,
			  })
			  : this.#recordConcurrentNonAcceptedProviderOutcome({
				deliveryId: claimed.delivery.id,
				attemptId: claimed.attempt.id,
				leaseToken: claimed.attempt.leaseToken,
				at: finishedAt,
				outcome:
				  classified.kind === "unknown"
					? { kind: "unknown", code: classified.code }
					: {
						kind: "rejected",
						code: classified.code,
						automaticRetry: classified.automaticRetry,
						...(observed.kind === "http_error"
						  ? { httpStatus: observed.status }
						  : {}),
					  },
			  });
			if (!terminalized) {
			  throw error;
			}
			return;
		}
		throw error;
	}
  }

  // ── Bulk send (mail merge) — alarm-scheduled, throttled (F-06) ──

  /** Extract {{placeholder}} variable names from a template string. */
  #extractVars(tpl: string): string[] {
    const out = new Set<string>();
    for (const m of tpl.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) out.add(m[1]);
    return [...out];
  }

  #removeBulkActiveSync(jobId: string): void {
    const active =
      this.ctx.storage.kv.get<BulkActiveEntry[]>(BULK_ACTIVE_KEY) ?? [];
    this.ctx.storage.kv.put(
      BULK_ACTIVE_KEY,
      active.filter((entry) => entry.jobId !== jobId),
    );
  }

  #recordBulkTerminalSync(
    jobId: string,
    admissionKey: string,
    completedAt: number,
  ): void {
    const prior =
      this.ctx.storage.kv.get<BulkTerminalEntry[]>(BULK_TERMINAL_HISTORY_KEY) ??
      [];
    const existing = prior.find((entry) => entry.jobId === jobId);
    this.ctx.storage.kv.put(BULK_TERMINAL_HISTORY_KEY, [
      ...prior.filter((entry) => entry.jobId !== jobId),
      {
        jobId,
        admissionKey,
        completedAt: existing?.completedAt ?? completedAt,
      },
    ]);
  }

  #bulkCleanupEntriesSync(): Array<[string, BulkCleanupIntent]> {
    return [
      ...this.ctx.storage.kv.list<BulkCleanupIntent>({
        prefix: BULK_ATTACHMENT_CLEANUP_PREFIX,
      }),
    ];
  }

  #bulkReservationEntriesSync(): Array<[string, BulkAdmissionReservation]> {
    return [
      ...this.ctx.storage.kv.list<BulkAdmissionReservation>({
        prefix: BULK_RESERVATION_PREFIX,
      }),
    ];
  }

  #pruneBulkReservationsSync(now: number): void {
    for (const [key, reservation] of this.#bulkReservationEntriesSync()) {
      if (reservation.expiresAt <= now) {
        this.ctx.storage.kv.delete(key);
      }
    }
  }

  #createBulkCleanupIntentSync(input: {
    ownerId: string;
    keys: string[];
    dueAt: number;
    verifyAt?: number;
    protectAdmissionKey?: string;
    protectGeneration?: number;
    protectDeliveryKey?: string;
    protectEmailId?: string;
    protectPreparationKey?: string;
  }): string | null {
    const keys = [...new Set(input.keys)].slice(0, ATTACHMENT_LIMITS.maxFiles);
    if (keys.length === 0) return null;
    const id = crypto.randomUUID();
    const intent: BulkCleanupIntent = {
      id,
      ownerId: input.ownerId,
      keys,
      dueAt: input.dueAt,
      leaseToken: null,
      leaseExpiresAt: null,
      attempts: 0,
      createdAt: Date.now(),
      ...(input.verifyAt ? { verifyAt: input.verifyAt } : {}),
      ...(input.protectAdmissionKey
        ? { protectAdmissionKey: input.protectAdmissionKey }
        : {}),
      ...(input.protectGeneration !== undefined
        ? { protectGeneration: input.protectGeneration }
        : {}),
      ...(input.protectDeliveryKey
        ? { protectDeliveryKey: input.protectDeliveryKey }
        : {}),
      ...(input.protectEmailId ? { protectEmailId: input.protectEmailId } : {}),
      ...(input.protectPreparationKey
        ? { protectPreparationKey: input.protectPreparationKey }
        : {}),
    };
    this.ctx.storage.kv.put(`${BULK_ATTACHMENT_CLEANUP_PREFIX}${id}`, intent);
    return id;
  }

  #markBulkCleanupDueSync(id: string, dueAt: number): void {
    const key = `${BULK_ATTACHMENT_CLEANUP_PREFIX}${id}`;
    const intent = this.ctx.storage.kv.get<BulkCleanupIntent>(key);
    if (!intent) return;
    const next: BulkCleanupIntent = {
      ...intent,
      dueAt,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    delete next.deleteConfirmedAt;
    this.ctx.storage.kv.put(key, next);
  }

  #markBulkGenerationCleanupDueSync(jobId: string, dueAt: number): void {
    for (const [, intent] of this.#bulkCleanupEntriesSync()) {
      if (!intent.ownerId.startsWith(`${jobId}:generation-`)) continue;
      this.#markBulkCleanupDueSync(intent.id, dueAt);
    }
  }

  #bulkOutstandingRecipientCountSync(): number {
    const active =
      this.ctx.storage.kv.get<BulkActiveEntry[]>(BULK_ACTIVE_KEY) ?? [];
    const countedJobIds = new Set<string>();
    let unfinishedRecipients = 0;
    for (const entry of active) {
      const job = this.ctx.storage.kv.get<BulkJob>(`bulk:job:${entry.jobId}`);
      if (!job) continue;
      countedJobIds.add(entry.jobId);
      unfinishedRecipients += Math.max(0, job.total - job.cursor);
    }
    const legacyQueue = this.ctx.storage.kv.get<string[]>(BULK_QUEUE_KEY) ?? [];
    for (const jobId of new Set(legacyQueue)) {
      if (countedJobIds.has(jobId)) continue;
      const job = this.ctx.storage.kv.get<BulkJob>(`bulk:job:${jobId}`);
      if (
        !job ||
        job.status === "done" ||
        job.status === "cancelled" ||
        job.status === "failed"
      ) {
        continue;
      }
      unfinishedRecipients += Math.max(0, job.total - job.cursor);
    }
    const outboxRow = [
      ...this.ctx.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM outbound_deliveries
         WHERE source = 'bulk' AND status IN ('queued', 'sending', 'retrying')`,
      ),
    ][0];
    return unfinishedRecipients + Number(outboxRow?.count ?? 0);
  }

  #assertBulkRetryCapacitySync(delivery: StoredOutboundDelivery): void {
    if (delivery.source !== "bulk") return;
    if (
      this.#bulkOutstandingRecipientCountSync() >=
      BULK_LIMITS.maxOutstandingRecipients
    ) {
      throw new OutboundRetryCapacityError();
    }
  }

  #abandonBulkRecipientPreparationSync(
    jobId: string,
    cursor: number,
    now: number,
  ): void {
    const key = `${BULK_RECIPIENT_PREPARATION_PREFIX}${jobId}:${cursor}`;
    const preparation = this.ctx.storage.kv.get<BulkRecipientPreparation>(key);
    if (!preparation) return;
    this.#markBulkCleanupDueSync(preparation.cleanupIntentId, now);
    this.ctx.storage.kv.delete(key);
  }

  #pruneBulkTerminalSync(now: number): void {
    const history =
      this.ctx.storage.kv.get<BulkTerminalEntry[]>(BULK_TERMINAL_HISTORY_KEY) ??
      [];
    const retained: BulkTerminalEntry[] = [];
    for (const entry of history) {
      if (entry.completedAt + BULK_LIMITS.terminalRetentionMs > now) {
        retained.push(entry);
        continue;
      }
      this.ctx.storage.kv.delete(`bulk:job:${entry.jobId}`);
      this.ctx.storage.kv.delete(`bulk:rows:${entry.jobId}`);
      this.ctx.storage.kv.delete(entry.admissionKey);
    }
    this.ctx.storage.kv.put(BULK_TERMINAL_HISTORY_KEY, retained);
  }

  #expireBulkPreparationsSync(now: number): void {
    const prior =
      this.ctx.storage.kv.get<BulkActiveEntry[]>(BULK_ACTIVE_KEY) ?? [];
    const active: BulkActiveEntry[] = [];
    for (const entry of prior) {
      const job = this.ctx.storage.kv.get<BulkJob>(`bulk:job:${entry.jobId}`);
      if (
        !job ||
        job.status === "done" ||
        job.status === "failed" ||
        job.status === "cancelled"
      ) {
        continue;
      }
      if (
        job.status !== "preparing" ||
        now < job.createdAt + BULK_PREPARATION_MAX_AGE_MS
      ) {
        active.push(entry);
        continue;
      }
      const admission = this.ctx.storage.kv.get<BulkAdmissionRecord>(
        entry.admissionKey,
      );
      if (admission?.status === "preparing") {
        const failed = failBulkAdmission(
          admission,
          admission.generation,
          "Bulk job preparation expired. Start a new submission.",
          now,
        );
        if (failed) this.ctx.storage.kv.put(entry.admissionKey, failed);
      }
      const failedJob: BulkJob = {
        ...job,
        status: "failed",
        errors: [
          {
            email: "",
            error: "Bulk job preparation expired. Start a new submission.",
          },
        ],
        updatedAt: now,
      };
      this.ctx.storage.kv.put(`bulk:job:${entry.jobId}`, failedJob);
      this.ctx.storage.kv.delete(`bulk:rows:${entry.jobId}`);
      this.#createBulkCleanupIntentSync({
        ownerId: `${entry.jobId}:expired-preparation`,
        keys: job.preparationAttachmentKeys ?? [],
        dueAt: now,
      });
      this.#markBulkGenerationCleanupDueSync(entry.jobId, now);
      this.#recordBulkTerminalSync(entry.jobId, entry.admissionKey, now);
      console.error("[bulk-send] admission preparation completed", {
        operation: "bulk_admission_prepare",
        mailboxId: job.fromEmail,
        operationId: job.operationId,
        jobId: job.id,
        stage: "preparation_deadline",
        result: "expired",
        errorCode: "preparation_expired",
        retryDecision: "terminal",
        durationMs: now - job.createdAt,
      });
    }
    this.ctx.storage.kv.put(BULK_ACTIVE_KEY, active);
  }

  #bulkMaintenanceAtSync(): number | null {
    const candidates: number[] = [];
    for (const [, reservation] of this.#bulkReservationEntriesSync()) {
      candidates.push(reservation.expiresAt);
    }
    const cleanupAt = bulkCleanupNextAt(
      this.#bulkCleanupEntriesSync().map(([, intent]) => intent),
    );
    if (cleanupAt !== null) candidates.push(cleanupAt);
    const active =
      this.ctx.storage.kv.get<BulkActiveEntry[]>(BULK_ACTIVE_KEY) ?? [];
    for (const entry of active) {
      const job = this.ctx.storage.kv.get<BulkJob>(`bulk:job:${entry.jobId}`);
      if (job?.status === "preparing") {
        candidates.push(job.createdAt + BULK_PREPARATION_MAX_AGE_MS);
      }
    }
    const queue = this.ctx.storage.kv.get<string[]>(BULK_QUEUE_KEY) ?? [];
    const head = queue[0]
      ? this.ctx.storage.kv.get<BulkJob>(`bulk:job:${queue[0]}`)
      : null;
    if (head?.status === "queued" || head?.status === "running") {
      candidates.push(head.nextEnqueueAt ?? head.createdAt);
    }
    const history =
      this.ctx.storage.kv.get<BulkTerminalEntry[]>(BULK_TERMINAL_HISTORY_KEY) ??
      [];
    for (const entry of history) {
      candidates.push(entry.completedAt + BULK_LIMITS.terminalRetentionMs);
    }
    return candidates.length > 0 ? Math.min(...candidates) : null;
  }

  async #ensureBulkMaintenanceAlarm(): Promise<void> {
    const next = this.ctx.storage.transactionSync(() =>
      this.#bulkMaintenanceAtSync(),
    );
    if (next !== null) await this.#scheduleAlarmAt(Math.max(Date.now(), next));
  }

  async #processBulkAdmissionPreparation(): Promise<boolean> {
    const preparation = this.ctx.storage.transactionSync(() => {
      const active =
        this.ctx.storage.kv.get<BulkActiveEntry[]>(BULK_ACTIVE_KEY) ?? [];
      for (const entry of active) {
        const job = this.ctx.storage.kv.get<BulkJob>(`bulk:job:${entry.jobId}`);
        const admission = this.ctx.storage.kv.get<BulkAdmissionRecord>(
          entry.admissionKey,
        );
        if (
          job?.status === "preparing" &&
          admission?.status === "preparing" &&
          job.preparationGeneration === admission.generation
        ) {
          return { entry, job, admission };
        }
      }
      return null;
    });
    if (!preparation) return false;

    const startedAt = Date.now();
    const { entry, job, admission } = preparation;
    const attachments: BulkAttachment[] = [];
    try {
      const staged: Array<{
        bytes: ArrayBuffer;
        filename: string;
        type: string;
        size: number;
		acceptedContentSha256: string;
      }> = [];
      for (const sourceKey of job.preparationAttachmentKeys ?? []) {
        const object = await this.env.BUCKET.get(sourceKey);
        if (!object) {
          throw new Error("missing_bulk_upload");
        }
        const metadata = object.customMetadata ?? {};
		if (!/^[a-f0-9]{64}$/.test(metadata.contentSha256 ?? "")) {
			throw new Error("invalid_bulk_attachment_identity");
		}
        staged.push({
          bytes: await object.arrayBuffer(),
          filename: (metadata.filename || "untitled").replace(
            /[\/\\:*?"<>|\x00-\x1f]/g,
            "_",
          ),
          type:
            metadata.type ||
            object.httpMetadata?.contentType ||
            "application/octet-stream",
          size: object.size,
		  acceptedContentSha256: metadata.contentSha256!,
        });
      }
      const setError = validateAttachmentSet(
        staged.map((attachment) => ({
          filename: attachment.filename,
          size: attachment.size,
        })),
      );
      if (setError) throw new Error("invalid_bulk_attachment_set");

      // This is the sole R2 writer for admission copies. Durable Object alarm
      // invocations have a 15-minute hard wall-time limit, so the later
      // 20-minute deletion verification cannot race an unbounded HTTP writer.
      // https://developers.cloudflare.com/workers/platform/limits/#wall-time-limits-by-invocation-type
      for (const [index, attachment] of staged.entries()) {
        const key = bulkAttachmentPreparationKey(
          job.id,
          admission.generation,
          index,
        );
        const digest = await attachmentSha256(attachment.bytes);
		if (digest.hex !== attachment.acceptedContentSha256) {
			throw new Error("bulk_attachment_content_changed");
		}
        await this.env.BUCKET.put(key, attachment.bytes, {
          httpMetadata: { contentType: attachment.type },
          customMetadata: { contentSha256: digest.hex },
          sha256: digest.binary,
        });
        attachments.push({
          key,
          filename: attachment.filename,
          type: attachment.type,
          size: attachment.size,
          contentSha256: digest.hex,
        });
      }
    } catch (error) {
      const failedAt = Date.now();
      const missing =
        error instanceof Error && error.message === "missing_bulk_upload";
      const publicError = missing
        ? "An attachment upload was not found or has expired. Re-attach and try again."
        : "Bulk attachments could not be prepared. Re-attach them and try again.";
      const committed = this.ctx.storage.transactionSync(() => {
        const current = this.ctx.storage.kv.get<BulkAdmissionRecord>(
          entry.admissionKey,
        );
        if (!current) return false;
        const failed = failBulkAdmission(
          current,
          admission.generation,
          publicError,
          failedAt,
        );
        if (!failed) return false;
        this.ctx.storage.kv.put(entry.admissionKey, failed);
        this.ctx.storage.kv.put(`bulk:job:${job.id}`, {
          ...job,
          status: "failed",
          errors: [{ email: "", error: publicError }],
          updatedAt: failedAt,
        });
        this.ctx.storage.kv.delete(`bulk:rows:${job.id}`);
        this.#createBulkCleanupIntentSync({
          ownerId: `${job.id}:failed-preparation`,
          keys: job.preparationAttachmentKeys ?? [],
          dueAt: failedAt + BULK_PREPARATION_MAX_AGE_MS,
        });
        if (job.preparationCleanupIntentId) {
          this.#markBulkCleanupDueSync(
            job.preparationCleanupIntentId,
            failedAt,
          );
        }
        this.#removeBulkActiveSync(job.id);
        this.#recordBulkTerminalSync(job.id, entry.admissionKey, failedAt);
        return true;
      });
      console.error("[bulk-send] admission preparation completed", {
        operation: "bulk_admission_prepare",
        mailboxId: job.fromEmail,
        operationId: job.operationId,
        jobId: job.id,
        stage: "r2_generation_copy",
        result: committed ? "failed" : "fence_lost",
        errorCode: missing ? "missing_upload" : "r2_or_validation_failure",
        errorName: error instanceof Error ? error.name : "UnknownError",
        durationMs: failedAt - startedAt,
        retryDecision: "terminal",
      });
      await this.#ensureBulkMaintenanceAlarm();
      await this.#scheduleAlarmAt(Date.now() + 100);
      return true;
    }

    const committedAt = Date.now();
    const committed = this.ctx.storage.transactionSync(() => {
      const currentAdmission = this.ctx.storage.kv.get<BulkAdmissionRecord>(
        entry.admissionKey,
      );
      const currentJob = this.ctx.storage.kv.get<BulkJob>(`bulk:job:${job.id}`);
      if (!currentAdmission || !currentJob) return false;
      const nextAdmission = completeBulkAdmission(
        currentAdmission,
        admission.generation,
        committedAt,
      );
      if (!nextAdmission || currentJob.status !== "preparing") return false;
      const queuedJob: BulkJob = {
        ...currentJob,
        status: "queued",
        updatedAt: committedAt,
        nextEnqueueAt: committedAt + 100,
        attachments: attachments.length > 0 ? attachments : undefined,
      };
      delete queuedJob.preparationCleanupIntentId;
      delete queuedJob.preparationGeneration;
      const queue = this.ctx.storage.kv.get<string[]>(BULK_QUEUE_KEY) ?? [];
      this.ctx.storage.kv.put(`bulk:job:${job.id}`, queuedJob);
      this.ctx.storage.kv.put(
        BULK_QUEUE_KEY,
        ensureBulkQueueMembership(queue, job.id),
      );
      this.ctx.storage.kv.put(entry.admissionKey, nextAdmission);
      this.#createBulkCleanupIntentSync({
        ownerId: `${job.id}:staging`,
        keys: currentJob.preparationAttachmentKeys ?? [],
        dueAt: committedAt + BULK_PREPARATION_MAX_AGE_MS,
      });
      return true;
    });
    if (!committed && job.preparationCleanupIntentId) {
      this.ctx.storage.transactionSync(() =>
        this.#markBulkCleanupDueSync(
          job.preparationCleanupIntentId!,
          committedAt,
        ),
      );
    }
    console.info("[bulk-send] admission preparation completed", {
      operation: "bulk_admission_prepare",
      mailboxId: job.fromEmail,
      operationId: job.operationId,
      jobId: job.id,
      stage: "r2_generation_copy",
      result: committed ? "success" : "fence_lost",
      durationMs: committedAt - startedAt,
      retryDecision: committed ? "queue" : "cleanup",
    });
    await this.#ensureBulkMaintenanceAlarm();
    await this.#scheduleAlarmAt(Date.now() + 100);
    return true;
  }

  /**
   * Enqueue a bulk-send job: validate the template against the CSV columns,
   * persist recipients + template, and kick the alarm. The alarm sends one
   * message per tick with a randomized throttle, so even a 200-recipient job
   * stays well within per-invocation Worker limits and survives restarts.
   */
  async reserveBulkOperation(input: {
    operationId: string;
    actorUserId: string;
    fingerprint: string;
    total: number;
  }): Promise<BulkReservationResult> {
    if (
      !BULK_OPERATION_ID_PATTERN.test(input.operationId) ||
      typeof input.actorUserId !== "string" ||
      input.actorUserId.length === 0 ||
      input.actorUserId.length > BULK_LIMITS.actorIdChars ||
      !/^[0-9a-f]{64}$/.test(input.fingerprint) ||
      !Number.isInteger(input.total) ||
      input.total < 1 ||
      input.total > BULK_LIMITS.maxRecipients
    ) {
      return { status: "forbidden" };
    }

    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      this.#pruneBulkReservationsSync(now);
      const reservationKey = `${BULK_RESERVATION_PREFIX}${input.operationId}`;
      const existingReservation =
        this.ctx.storage.kv.get<BulkAdmissionReservation>(reservationKey) ??
        null;
      const existingAdmission =
        this.ctx.storage.kv.get<BulkAdmissionRecord>(
          `bulk:admission:${input.operationId}`,
        ) ?? null;
      const planned = planBulkAdmissionReservation({
        existingReservation,
        existingAdmission,
        ...input,
        now,
      });
      if (planned.status !== "reserved" || planned.replayed) return planned;
      const mailboxDailyPlan = planBulkDailyReservation(
        this.ctx.storage.kv.get<BulkDailyReservationRecord>(
          BULK_DAILY_RESERVATION_KEY,
        ) ?? null,
        now,
      );
      const actorDailyKey = `${BULK_DAILY_RESERVATION_ACTOR_PREFIX}${encodeURIComponent(input.actorUserId)}`;
      const actorDailyPlan = planBulkDailyReservation(
        this.ctx.storage.kv.get<BulkDailyReservationRecord>(actorDailyKey) ??
          null,
        now,
        BULK_LIMITS.maxReservationsPerActorPerUtcDay,
      );
      if (
        mailboxDailyPlan.status === "capacity" ||
        actorDailyPlan.status === "capacity"
      ) {
        return {
          status: "capacity" as const,
          retryAt: bulkNextUtcDayAt(now),
        };
      }

      const reservations = this.#bulkReservationEntriesSync();
      const activeReservations = reservations.filter(
        ([, reservation]) => reservation.expiresAt > now,
      );
      const actorActiveReservations = activeReservations.filter(
        ([, reservation]) => reservation.actorUserId === input.actorUserId,
      );
      if (reservations.length >= BULK_LIMITS.maxReservationRecords) {
        const retryAt = Math.min(
          ...reservations.map(([, reservation]) => reservation.expiresAt),
        );
        return {
          status: "capacity" as const,
          retryAt: Number.isFinite(retryAt) ? retryAt : now + 60_000,
        };
      }
      if (activeReservations.length >= BULK_LIMITS.maxPendingReservations) {
        const retryAt = Math.min(
          ...activeReservations.map(([, reservation]) => reservation.expiresAt),
        );
        return {
          status: "capacity" as const,
          retryAt: Number.isFinite(retryAt) ? retryAt : now + 60_000,
        };
      }
      if (
        actorActiveReservations.length >=
        BULK_LIMITS.maxPendingReservationsPerActor
      ) {
        const retryAt = Math.min(
          ...actorActiveReservations.map(
            ([, reservation]) => reservation.expiresAt,
          ),
        );
        return {
          status: "capacity" as const,
          retryAt: Number.isFinite(retryAt) ? retryAt : now + 60_000,
        };
      }
      this.ctx.storage.kv.put(reservationKey, planned.record);
      this.ctx.storage.kv.put(
        BULK_DAILY_RESERVATION_KEY,
        mailboxDailyPlan.record,
      );
      this.ctx.storage.kv.put(actorDailyKey, actorDailyPlan.record);
      return planned;
    });
    await this.#ensureBulkMaintenanceAlarm();
    return result;
  }

  async cancelBulkReservation(operationId: string, actorUserId: string) {
    if (
      !BULK_OPERATION_ID_PATTERN.test(operationId) ||
      typeof actorUserId !== "string" ||
      actorUserId.length === 0 ||
      actorUserId.length > BULK_LIMITS.actorIdChars
    ) {
      return { status: "forbidden" as const };
    }
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() => {
      const admission = this.ctx.storage.kv.get<BulkAdmissionRecord>(
        `bulk:admission:${operationId}`,
      );
      if (admission) {
        if (admission.actorUserId !== actorUserId) {
          return { status: "forbidden" as const };
        }
        return {
          status: "admitted" as const,
          jobId: admission.jobId,
          total: admission.total,
          admissionStatus: admission.status,
        };
      }
      const key = `${BULK_RESERVATION_PREFIX}${operationId}`;
      const reservation =
        this.ctx.storage.kv.get<BulkAdmissionReservation>(key);
      if (!reservation) return { status: "missing" as const };
      if (reservation.actorUserId !== actorUserId) {
        return { status: "forbidden" as const };
      }
      if (reservation.expiresAt <= now) {
        return { status: "expired" as const };
      }
      this.ctx.storage.kv.delete(key);
      return { status: "cancelled" as const };
    });
    await this.#ensureBulkMaintenanceAlarm();
    return result;
  }

  async enqueueBulkJob(input: {
    operationId: string;
    actorUserId: string;
    fromEmail: string;
    fromName: string;
    subject: string;
    html?: string;
    text?: string;
    recipients: BulkRecipient[];
    attachmentUploadIds?: string[];
  }): Promise<BulkEnqueueResult> {
    if (
      typeof input.operationId !== "string" ||
      typeof input.actorUserId !== "string" ||
      typeof input.fromEmail !== "string" ||
      typeof input.fromName !== "string" ||
      typeof input.subject !== "string" ||
      (input.html !== undefined && typeof input.html !== "string") ||
      (input.text !== undefined && typeof input.text !== "string") ||
      !Array.isArray(input.recipients) ||
      (input.attachmentUploadIds !== undefined &&
        !Array.isArray(input.attachmentUploadIds))
    ) {
      return {
        status: "rejected",
        code: "invalid_bulk_request",
        error: "Bulk request is invalid.",
      };
    }
    const recipients = input.recipients;
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (
      input.actorUserId.length === 0 ||
      input.actorUserId.length > BULK_LIMITS.actorIdChars ||
      input.fromEmail.length === 0 ||
      input.fromEmail.length > BULK_LIMITS.emailChars ||
      input.fromName.length > BULK_LIMITS.fromNameChars
    ) {
      return {
        status: "rejected",
        code: "invalid_bulk_request",
        error: "Bulk sender context is invalid.",
      };
    }
    if (!uuid.test(input.operationId)) {
      return {
        status: "rejected",
        code: "invalid_bulk_request",
        error: "Bulk operation identity is invalid.",
      };
    }
    if (recipients.length === 0) {
      return {
        status: "rejected",
        code: "invalid_bulk_request",
        error: "No recipients provided.",
      };
    }
    if (recipients.length > BULK_LIMITS.maxRecipients) {
      return {
        status: "rejected",
        code: "invalid_bulk_request",
        error: `Too many recipients: max ${BULK_LIMITS.maxRecipients} per job.`,
      };
    }
    if (
      !input.subject.trim() ||
      input.subject.length > BULK_LIMITS.subjectChars
    ) {
      return {
        status: "rejected",
        code: "invalid_bulk_request",
        error: "Subject is required.",
      };
    }
    if (
      (!input.html && !input.text) ||
      (input.html?.length ?? 0) > BULK_LIMITS.bodyChars ||
      (input.text?.length ?? 0) > BULK_LIMITS.bodyChars
    ) {
      return {
        status: "rejected",
        code: "invalid_bulk_request",
        error: "Email body is required.",
      };
    }
    const htmlError = bulkPersonalizedHtmlValidationError(
      input.html,
      recipients,
    );
    if (htmlError) {
      return {
        status: "rejected",
        code: "invalid_bulk_request",
        error: htmlError,
      };
    }
    if ((input.attachmentUploadIds?.length ?? 0) > ATTACHMENT_LIMITS.maxFiles) {
      return {
        status: "rejected",
        code: "invalid_bulk_request",
        error: `Too many attachments: max ${ATTACHMENT_LIMITS.maxFiles}.`,
      };
    }
    if (
      (input.attachmentUploadIds ?? []).some(
        (uploadId) =>
          typeof uploadId !== "string" ||
          !isCanonicalAttachmentUploadId(uploadId),
      )
    ) {
      return {
        status: "rejected",
        code: "invalid_bulk_request",
        error: "Attachment upload identity is invalid.",
      };
    }

    for (const r of recipients) {
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        return {
          status: "rejected",
          code: "invalid_bulk_request",
          error: "Recipient rows are invalid.",
        };
      }
      const entries = Object.entries(r);
      if (
        entries.length === 0 ||
        entries.length > BULK_LIMITS.maxColumns ||
        entries.some(
          ([key, value]) =>
            key.length === 0 ||
            key.length > BULK_LIMITS.columnNameChars ||
            typeof value !== "string" ||
            value.length > BULK_LIMITS.recipientValueChars,
        )
      ) {
        return {
          status: "rejected",
          code: "invalid_bulk_request",
          error: "Recipient columns exceed the bulk request limits.",
        };
      }
      if (
        !r.email ||
        r.email.length > BULK_LIMITS.emailChars ||
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)
      ) {
        return {
          status: "rejected",
          code: "invalid_bulk_request",
          error: "Every recipient row needs a valid 'email' column.",
        };
      }
    }
    const canonicalPayload = JSON.stringify({
      subject: input.subject,
      html: input.html,
      text: input.text,
      recipients,
      attachmentUploadIds: input.attachmentUploadIds ?? [],
    });
    if (
      new TextEncoder().encode(canonicalPayload).byteLength >
      BULK_LIMITS.requestBytes
    ) {
      return {
        status: "rejected",
        code: "invalid_bulk_request",
        error: `Bulk request exceeds the ${BULK_LIMITS.requestBytes / 1_024} KB limit.`,
      };
    }

    // Every {{var}} in the template must exist as a column in the CSV.
    const vars = new Set<string>([
      ...this.#extractVars(input.subject),
      ...this.#extractVars(input.html ?? ""),
      ...this.#extractVars(input.text ?? ""),
    ]);
    const columns = new Set(Object.keys(recipients[0]));
    const missing = [...vars].filter((v) => !columns.has(v));
    if (missing.length > 0) {
      return {
        status: "rejected",
        code: "invalid_bulk_request",
        error: `Template uses columns not in the CSV: ${missing.join(", ")}`,
      };
    }

    const fingerprint = await bulkAdmissionFingerprint({
      actorUserId: input.actorUserId,
      subject: input.subject,
      html: input.html,
      text: input.text,
      recipients,
      attachmentUploadIds: input.attachmentUploadIds,
    });
    const admissionKey = `bulk:admission:${input.operationId}`;
    const now = Date.now();
    // Cloudflare's Durable Objects rules warn that input gates do not protect
    // across R2 I/O. Claim in one local storage transaction before touching R2,
    // then fence the later commit by generation.
    // https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
    const claimResult = this.ctx.storage.transactionSync(() => {
      const active =
        this.ctx.storage.kv.get<BulkActiveEntry[]>(BULK_ACTIVE_KEY) ?? [];
      const existingAdmission =
        this.ctx.storage.kv.get<BulkAdmissionRecord>(admissionKey) ?? null;
      let dailyPlan: ReturnType<typeof planBulkDailyAdmission> | null = null;
      if (!existingAdmission) {
        const reservation = this.ctx.storage.kv.get<BulkAdmissionReservation>(
          `${BULK_RESERVATION_PREFIX}${input.operationId}`,
        );
        if (
          !reservation ||
          reservation.actorUserId !== input.actorUserId ||
          reservation.fingerprint !== fingerprint ||
          reservation.total !== recipients.length ||
          reservation.expiresAt <= now
        ) {
          return { status: "reservation_invalid" as const };
        }
        const rejectCapacity = (
          reason: "active_backlog" | "cleanup_backlog" | "daily_limit",
          retryAt: number,
        ) => {
          this.ctx.storage.kv.delete(
            `${BULK_RESERVATION_PREFIX}${input.operationId}`,
          );
          return { status: "capacity" as const, reason, retryAt };
        };
        const activeJobIds = new Set(active.map((entry) => entry.jobId));
        let outstandingJobs = 0;
        for (const entry of active) {
          const job = this.ctx.storage.kv.get<BulkJob>(
            `bulk:job:${entry.jobId}`,
          );
          if (!job) continue;
          outstandingJobs += 1;
        }
        const legacyQueue =
          this.ctx.storage.kv.get<string[]>(BULK_QUEUE_KEY) ?? [];
        for (const queuedJobId of new Set(legacyQueue)) {
          if (activeJobIds.has(queuedJobId)) continue;
          const queuedJob = this.ctx.storage.kv.get<BulkJob>(
            `bulk:job:${queuedJobId}`,
          );
          if (
            !queuedJob ||
            queuedJob.status === "done" ||
            queuedJob.status === "cancelled" ||
            queuedJob.status === "failed"
          )
            continue;
          outstandingJobs += 1;
        }
        const outstandingRecipients = this.#bulkOutstandingRecipientCountSync();
        const cleanupBacklog = bulkCleanupBacklogCount(
          this.#bulkCleanupEntriesSync().map(([, intent]) => intent),
          now,
          60_000,
        );
        dailyPlan = planBulkDailyAdmission(
          this.ctx.storage.kv.get<BulkDailyAdmissionRecord>(
            BULK_DAILY_ADMISSION_KEY,
          ) ?? null,
          now,
          recipients.length,
        );
        if (dailyPlan.status === "capacity") {
          return rejectCapacity("daily_limit", bulkNextUtcDayAt(now));
        }
        if (cleanupBacklog >= BULK_LIMITS.maxCleanupJobs) {
          return rejectCapacity("cleanup_backlog", now + 60_000);
        }
        if (
          outstandingJobs >= BULK_LIMITS.maxActiveJobs ||
          outstandingRecipients + recipients.length >
            BULK_LIMITS.maxOutstandingRecipients
        ) {
          return rejectCapacity("active_backlog", now + 60_000);
        }
      }

      const planned = planBulkAdmissionClaim({
        existing: existingAdmission,
        operationId: input.operationId,
        actorUserId: input.actorUserId,
        fingerprint,
        total: recipients.length,
        now,
        createJobId: () => `job_${crypto.randomUUID()}`,
      });
      let generationCleanupIntentId: string | null = null;
      if (planned.status === "claimed") {
        this.#markBulkGenerationCleanupDueSync(planned.record.jobId, now);
        this.ctx.storage.kv.put(admissionKey, planned.record);
        this.ctx.storage.kv.delete(
          `${BULK_RESERVATION_PREFIX}${input.operationId}`,
        );
        if (!existingAdmission && dailyPlan?.status === "accepted") {
          this.ctx.storage.kv.put(BULK_DAILY_ADMISSION_KEY, dailyPlan.record);
        }
        const existingJob = this.ctx.storage.kv.get<BulkJob>(
          `bulk:job:${planned.record.jobId}`,
        );
        this.ctx.storage.kv.put(`bulk:job:${planned.record.jobId}`, {
          ...(existingJob ?? {
            id: planned.record.jobId,
            operationId: input.operationId,
            actorUserId: input.actorUserId,
            fromEmail: input.fromEmail.toLowerCase(),
            fromName: input.fromName,
            subject: input.subject,
            html: input.html,
            text: input.text,
            total: recipients.length,
            enqueued: 0,
            failed: 0,
            cursor: 0,
            errors: [],
            createdAt: planned.record.createdAt,
          }),
          status: "preparing",
          preparationAttachmentKeys: (input.attachmentUploadIds ?? []).map(
            (uploadId) => uploadKey(input.fromEmail, uploadId),
          ),
          updatedAt: now,
        } satisfies BulkJob);
        const generationKeys = (input.attachmentUploadIds ?? []).map(
          (_uploadId, index) =>
            bulkAttachmentPreparationKey(
              planned.record.jobId,
              planned.record.generation,
              index,
            ),
        );
        generationCleanupIntentId = this.#createBulkCleanupIntentSync({
          ownerId: `${planned.record.jobId}:generation-${planned.record.generation}`,
          keys: generationKeys,
          dueAt: planned.record.createdAt + BULK_PREPARATION_MAX_AGE_MS,
          verifyAt: planned.record.createdAt + BULK_STALE_WRITER_VERIFY_MS,
          protectAdmissionKey: admissionKey,
          protectGeneration: planned.record.generation,
        });
        const preparingJob = this.ctx.storage.kv.get<BulkJob>(
          `bulk:job:${planned.record.jobId}`,
        );
        if (preparingJob) {
          this.ctx.storage.kv.put(`bulk:job:${planned.record.jobId}`, {
            ...preparingJob,
            preparationCleanupIntentId: generationCleanupIntentId,
            preparationGeneration: planned.record.generation,
          });
        }
        this.ctx.storage.kv.put(
          `bulk:rows:${planned.record.jobId}`,
          recipients,
        );
        if (!active.some((entry) => entry.jobId === planned.record.jobId)) {
          active.push({
            jobId: planned.record.jobId,
            admissionKey,
            total: recipients.length,
            createdAt: planned.record.createdAt,
          });
        }
      }
      this.ctx.storage.kv.put(BULK_ACTIVE_KEY, active);
      return {
        status: "claim" as const,
        claim: planned,
      };
    });
    await this.#ensureBulkMaintenanceAlarm();
    if (claimResult.status === "reservation_invalid") {
      return {
        status: "rejected",
        code: "bulk_reservation_expired",
        error:
          "This bulk operation reservation is unavailable or expired. Start a new submission.",
      };
    }
    if (claimResult.status === "capacity") {
      const messages = {
        active_backlog:
          "This Mailbox has the maximum safe bulk backlog. Wait for current jobs to progress.",
        cleanup_backlog:
          "This Mailbox is finishing attachment cleanup. Retry shortly.",
        daily_limit:
          "This Mailbox reached today's safe bulk sending limit. Retry after the next UTC day begins.",
      } as const;
      return {
        status: "capacity",
        code: "bulk_capacity_reached",
        error: messages[claimResult.reason],
        reason: claimResult.reason,
        retryAt: claimResult.retryAt,
      };
    }
    const claim = claimResult.claim;
    if (claim.status === "forbidden") {
      return {
        status: "rejected",
        code: "invalid_bulk_request",
        error: "Bulk operation identity is unavailable.",
      };
    }

    if (claim.status === "conflict") {
      return {
        status: "conflict",
        jobId: claim.record.jobId,
        total: claim.record.total,
      };
    }
    if (claim.status === "failed") {
      return {
        status: "rejected",
        code: "bulk_admission_failed",
        error: claim.record.error ?? "Bulk job could not be prepared.",
        jobId: claim.record.jobId,
      };
    }
    if (claim.status === "preparing") {
      await this.#scheduleAlarmAt(Date.now() + 100);
      return {
        status: "accepted",
        jobId: claim.record.jobId,
        total: claim.record.total,
        replayed: true,
        admissionStatus: "preparing",
      };
    }
    if (claim.status === "replay") {
      if (this.#repairBulkQueueMembership(claim.record.jobId)) {
        await this.#scheduleAlarmAt(Date.now() + 100);
      }
      return {
        status: "accepted",
        jobId: claim.record.jobId,
        total: claim.record.total,
        replayed: true,
        admissionStatus: "queued",
      };
    }
    await this.#scheduleAlarmAt(Date.now() + 100);
    return {
      status: "accepted",
      jobId: claim.record.jobId,
      total: recipients.length,
      replayed: false,
      admissionStatus: "preparing",
    };
  }

  async getBulkJob(jobId: string): Promise<BulkJobProgress | null> {
    if (!BULK_JOB_ID_PATTERN.test(jobId)) return null;
    const job = await this.ctx.storage.get<BulkJob>(`bulk:job:${jobId}`);
    if (!job) return null;
    return {
      id: job.id,
      status: job.status,
      total: job.total,
      enqueued: job.enqueued,
      failed: job.failed,
      cursor: job.cursor,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      errorCount: job.errors.length,
      errorsTruncated: job.errors.length > BULK_LIMITS.maxRecipients + 1,
      errors: job.errors
        .slice(0, BULK_LIMITS.maxRecipients + 1)
        .map((error) => ({
          email: error.email.slice(0, BULK_LIMITS.emailChars),
          error: SAFE_BULK_ERRORS.has(error.error)
            ? error.error
            : "Recipient could not be queued.",
        })),
    };
  }

  async getBulkJobByOperation(operationId: string, actorUserId: string) {
    if (
      !BULK_OPERATION_ID_PATTERN.test(operationId) ||
      typeof actorUserId !== "string" ||
      actorUserId.length === 0 ||
      actorUserId.length > BULK_LIMITS.actorIdChars
    ) {
      return null;
    }
    const recovered = this.ctx.storage.transactionSync(() => {
      const admission = this.ctx.storage.kv.get<BulkAdmissionRecord>(
        `bulk:admission:${operationId}`,
      );
      if (admission) {
        if (admission.actorUserId !== actorUserId) return null;
        const job = this.ctx.storage.kv.get<BulkJob>(
          `bulk:job:${admission.jobId}`,
        );
        if (job && job.actorUserId !== actorUserId) return null;
        return {
          state: "admitted" as const,
          jobId: admission.jobId,
          total: admission.total,
          admissionStatus: admission.status,
          jobStatus: job?.status ?? null,
        };
      }
      const reservation = this.ctx.storage.kv.get<BulkAdmissionReservation>(
        `${BULK_RESERVATION_PREFIX}${operationId}`,
      );
      if (!reservation || reservation.actorUserId !== actorUserId) return null;
      if (reservation.expiresAt <= Date.now()) {
        return { state: "expired" as const };
      }
      return {
        state: "reserved" as const,
        expiresAt: reservation.expiresAt,
      };
    });
    if (!recovered) return null;
    await this.#ensureBulkMaintenanceAlarm();
    if (recovered.state === "admitted") {
      if (
        recovered.jobStatus === "queued" ||
        recovered.jobStatus === "running"
      ) {
        this.#repairBulkQueueMembership(recovered.jobId);
        await this.#scheduleAlarmAt(Date.now() + 100);
      } else if (recovered.jobStatus === "preparing") {
        await this.#scheduleAlarmAt(Date.now() + 100);
      }
      const { jobStatus: _jobStatus, ...projection } = recovered;
      return projection;
    }
    return recovered;
  }

  #repairBulkQueueMembership(jobId: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      const job = this.ctx.storage.kv.get<BulkJob>(`bulk:job:${jobId}`);
      if (!job || (job.status !== "queued" && job.status !== "running")) {
        return false;
      }
      const queue = this.ctx.storage.kv.get<string[]>(BULK_QUEUE_KEY) ?? [];
      this.ctx.storage.kv.put(
        BULK_QUEUE_KEY,
        ensureBulkQueueMembership(queue, jobId),
      );
      return true;
    });
  }

  #bulkRecipientPreparationKey(jobId: string, cursor: number): string {
    return `${BULK_RECIPIENT_PREPARATION_PREFIX}${jobId}:${cursor}`;
  }

  #createBulkRecipientPreparationSync(
    job: BulkJob,
    messageId: string,
  ): BulkRecipientPreparation | null {
    if (!job.attachments?.length) return null;
    const key = this.#bulkRecipientPreparationKey(job.id, job.cursor);
    const existing = this.ctx.storage.kv.get<BulkRecipientPreparation>(key);
    if (existing) return existing;
    const attachments = job.attachments.map((attachment, index) => {
      const id = `bulk_attachment_${index}_${crypto.randomUUID()}`;
      return {
        id,
        email_id: messageId,
        filename: safeAttachmentStorageFilename(
          attachment.filename,
          attachmentKeyPrefix(messageId, id),
        ),
        mimetype: attachment.type,
        size: attachment.size,
        disposition: "attachment",
        content_sha256: attachment.contentSha256,
      } satisfies PendingOutboundAttachment;
    });
    const keys = attachments.map((attachment) =>
      attachmentKey(messageId, attachment.id, attachment.filename),
    );
    const idempotencyKey = `bulk:${job.id}:${job.cursor}`;
    const cleanupIntentId = this.#createBulkCleanupIntentSync({
      ownerId: `${job.id}:recipient-${job.cursor}`,
      keys,
      dueAt: Date.now() + BULK_LIMITS.recipientCleanupDelayMs,
      protectDeliveryKey: idempotencyKey,
      protectEmailId: messageId,
      protectPreparationKey: key,
    });
    if (!cleanupIntentId) return null;
    const preparation: BulkRecipientPreparation = {
      jobId: job.id,
      cursor: job.cursor,
      idempotencyKey,
      messageId,
      attachments,
      keys,
      cleanupIntentId,
      createdAt: Date.now(),
    };
    this.ctx.storage.kv.put(key, preparation);
    return preparation;
  }

  #finishBulkRecipientPreparationSync(
    preparation: BulkRecipientPreparation,
    committedToEmailId: string | null,
  ): void {
    const preparationKey = this.#bulkRecipientPreparationKey(
      preparation.jobId,
      preparation.cursor,
    );
    if (committedToEmailId === preparation.messageId) {
      this.ctx.storage.kv.delete(
        `${BULK_ATTACHMENT_CLEANUP_PREFIX}${preparation.cleanupIntentId}`,
      );
    } else {
      this.#markBulkCleanupDueSync(preparation.cleanupIntentId, Date.now());
    }
    this.ctx.storage.kv.delete(preparationKey);
  }

  async #processBulkAttachmentCleanup(): Promise<void> {
    const claim = this.ctx.storage.transactionSync(() => {
      const planned = planBulkCleanupClaim(
        this.#bulkCleanupEntriesSync(),
        Date.now(),
        crypto.randomUUID(),
        BULK_LIMITS.cleanupLeaseMs,
      );
      if (!planned) return null;
      this.ctx.storage.kv.put(planned.key, planned.intent);
      return planned;
    });
    if (!claim) return;
    const cleanupStartedAt = Date.now();

    const retry = () => {
      this.ctx.storage.transactionSync(() => {
        const current = this.ctx.storage.kv.get<BulkCleanupIntent>(claim.key);
        if (!current) return;
        const next = retryBulkCleanupClaim(
          current,
          claim.intent.leaseToken!,
          Date.now(),
          60_000,
        );
        if (next) this.ctx.storage.kv.put(claim.key, next);
      });
    };
    const complete = () => {
      this.ctx.storage.transactionSync(() => {
        const current = this.ctx.storage.kv.get<BulkCleanupIntent>(claim.key);
        if (
          current &&
          completeBulkCleanupClaim(current, claim.intent.leaseToken!)
        ) {
          this.ctx.storage.kv.delete(claim.key);
        }
      });
    };

    if (claim.intent.protectAdmissionKey) {
      const protectedByGeneration = this.ctx.storage.transactionSync(() => {
        const admission = this.ctx.storage.kv.get<BulkAdmissionRecord>(
          claim.intent.protectAdmissionKey!,
        );
        const job = admission
          ? this.ctx.storage.kv.get<BulkJob>(`bulk:job:${admission.jobId}`)
          : null;
        const preparing =
          admission?.status === "preparing" &&
          admission.generation === claim.intent.protectGeneration;
        const jobOwnsKeys =
          admission?.generation === claim.intent.protectGeneration &&
          (job?.status === "queued" || job?.status === "running") &&
          claim.intent.keys.every((key) =>
            job.attachments?.some((attachment) => attachment.key === key),
          );
        if (!preparing && !jobOwnsKeys) return false;
        const current = this.ctx.storage.kv.get<BulkCleanupIntent>(claim.key);
        if (current) {
          const next = retryBulkCleanupClaim(
            current,
            claim.intent.leaseToken!,
            Date.now(),
            BULK_LIMITS.recipientCleanupDelayMs,
          );
          if (next) this.ctx.storage.kv.put(claim.key, next);
        }
        return true;
      });
      if (protectedByGeneration) {
        console.info("[bulk-send] attachment cleanup completed", {
          operation: "bulk_attachment_cleanup",
          cleanupId: claim.intent.id,
          ownerId: claim.intent.ownerId,
          result: "deferred_for_generation",
          retryDecision: "retry",
          durationMs: Date.now() - cleanupStartedAt,
        });
        await this.#ensureBulkMaintenanceAlarm();
        return;
      }
    }

    if (claim.intent.protectDeliveryKey) {
      let delivery;
      try {
        delivery = await this.getOutboundDeliveryByIdempotencyKey(
          claim.intent.protectDeliveryKey,
        );
      } catch (error) {
        retry();
        console.error("[bulk-send] attachment cleanup completed", {
          operation: "bulk_attachment_cleanup",
          cleanupId: claim.intent.id,
          ownerId: claim.intent.ownerId,
          result: "ownership_check_failure",
          target: "outbound_delivery_store",
          errorName: error instanceof Error ? error.name : "UnknownError",
          retryDecision: "retry",
          durationMs: Date.now() - cleanupStartedAt,
        });
        await this.#ensureBulkMaintenanceAlarm();
        return;
      }
      if (delivery?.emailId === claim.intent.protectEmailId) {
        complete();
        console.info("[bulk-send] attachment cleanup completed", {
          operation: "bulk_attachment_cleanup",
          cleanupId: claim.intent.id,
          ownerId: claim.intent.ownerId,
          result: "transferred_to_delivery",
          retryDecision: "complete",
          durationMs: Date.now() - cleanupStartedAt,
        });
        await this.#ensureBulkMaintenanceAlarm();
        return;
      }
    }

    if (claim.intent.protectPreparationKey) {
      const protectedByPreparation = this.ctx.storage.transactionSync(() => {
        const preparation = this.ctx.storage.kv.get<BulkRecipientPreparation>(
          claim.intent.protectPreparationKey!,
        );
        if (!preparation) return false;
        const job = this.ctx.storage.kv.get<BulkJob>(
          `bulk:job:${preparation.jobId}`,
        );
        if (
          job &&
          (job.status === "queued" || job.status === "running") &&
          job.cursor === preparation.cursor
        ) {
          const current = this.ctx.storage.kv.get<BulkCleanupIntent>(claim.key);
          if (current) {
            const next = retryBulkCleanupClaim(
              current,
              claim.intent.leaseToken!,
              Date.now(),
              BULK_LIMITS.recipientCleanupDelayMs,
            );
            if (next) this.ctx.storage.kv.put(claim.key, next);
          }
          return true;
        }
        this.ctx.storage.kv.delete(claim.intent.protectPreparationKey!);
        return false;
      });
      if (protectedByPreparation) {
        console.info("[bulk-send] attachment cleanup completed", {
          operation: "bulk_attachment_cleanup",
          cleanupId: claim.intent.id,
          ownerId: claim.intent.ownerId,
          result: "deferred_for_recipient",
          retryDecision: "retry",
          durationMs: Date.now() - cleanupStartedAt,
        });
        await this.#ensureBulkMaintenanceAlarm();
        return;
      }
    }

    try {
      await this.env.BUCKET.delete(claim.intent.keys);
      const deletedAt = Date.now();
      if (claim.intent.verifyAt && claim.intent.verifyAt > deletedAt) {
        this.ctx.storage.transactionSync(() => {
          const current = this.ctx.storage.kv.get<BulkCleanupIntent>(claim.key);
          if (current?.leaseToken !== claim.intent.leaseToken) return;
          this.ctx.storage.kv.put(claim.key, {
            ...current,
            dueAt: claim.intent.verifyAt!,
            leaseToken: null,
            leaseExpiresAt: null,
            deleteConfirmedAt: deletedAt,
          });
        });
      } else {
        complete();
      }
      console.info("[bulk-send] attachment cleanup completed", {
        operation: "bulk_attachment_cleanup",
        cleanupId: claim.intent.id,
        ownerId: claim.intent.ownerId,
        result:
          claim.intent.verifyAt && claim.intent.verifyAt > deletedAt
            ? "verification_scheduled"
            : "deleted",
        target: "r2",
        keyCount: claim.intent.keys.length,
        retryDecision:
          claim.intent.verifyAt && claim.intent.verifyAt > deletedAt
            ? "verify"
            : "complete",
        durationMs: Date.now() - cleanupStartedAt,
      });
    } catch (error) {
      retry();
      console.error("[bulk-send] attachment cleanup completed", {
        operation: "bulk_attachment_cleanup",
        cleanupId: claim.intent.id,
        ownerId: claim.intent.ownerId,
        result: "failure",
        target: "r2",
        keyCount: claim.intent.keys.length,
        errorName: error instanceof Error ? error.name : "UnknownError",
        retryDecision: "retry",
        durationMs: Date.now() - cleanupStartedAt,
      });
    }
    await this.#ensureBulkMaintenanceAlarm();
  }

  #commitBulkTerminalSync(jobId: string, job?: BulkJob): number {
    return this.ctx.storage.transactionSync(() => {
      const completedAt = Date.now();
      if (job) {
        this.ctx.storage.kv.put(`bulk:job:${jobId}`, job);
        this.#createBulkCleanupIntentSync({
          ownerId: `${jobId}:terminal`,
          keys: [
            ...(job.attachments?.map((attachment) => attachment.key) ?? []),
          ],
          dueAt: completedAt,
        });
        this.#markBulkGenerationCleanupDueSync(jobId, completedAt);
        this.#abandonBulkRecipientPreparationSync(
          jobId,
          job.cursor,
          completedAt,
        );
      }
      this.ctx.storage.kv.delete(`bulk:rows:${jobId}`);
      const queue = this.ctx.storage.kv.get<string[]>(BULK_QUEUE_KEY) ?? [];
      const remaining = removeBulkQueueMembership(queue, jobId);
      this.ctx.storage.kv.put(BULK_QUEUE_KEY, remaining);
      const active =
        this.ctx.storage.kv.get<BulkActiveEntry[]>(BULK_ACTIVE_KEY) ?? [];
      const activeEntry = active.find((entry) => entry.jobId === jobId);
      this.#removeBulkActiveSync(jobId);
      const admissionKey = job?.operationId
        ? `bulk:admission:${job.operationId}`
        : activeEntry?.admissionKey;
      if (admissionKey) {
        this.#recordBulkTerminalSync(jobId, admissionKey, completedAt);
      }
      return remaining.length;
    });
  }

  async #processR2DeletionOutbox(now: number): Promise<number | null> {
    const nowIso = new Date(now).toISOString();
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(now + R2_DELETION_LEASE_MS).toISOString();
    const fenceExpiresAt = new Date(
      now + RETIRED_PROJECTION_ATTEMPT_RETENTION_MS,
    ).toISOString();
    const claimed = this.ctx.storage.transactionSync(() => {
      const expiredAttemptFences = this.db
        .select({
          attemptId: schema.inboundDerivedContentRetiredAttempts.attempt_id,
        })
        .from(schema.inboundDerivedContentRetiredAttempts)
        .where(
		  or(
			lte(schema.inboundDerivedContentRetiredAttempts.expires_at, nowIso),
			sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.inboundDerivedContentRetiredAttempts.expires_at}) IS NULL`,
			sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.inboundDerivedContentRetiredAttempts.expires_at}) <> ${schema.inboundDerivedContentRetiredAttempts.expires_at}`,
		  ),
        )
        .orderBy(
          asc(schema.inboundDerivedContentRetiredAttempts.expires_at),
          asc(schema.inboundDerivedContentRetiredAttempts.attempt_id),
        )
        .limit(R2_DELETION_BATCH_SIZE)
        .all();
      if (expiredAttemptFences.length > 0) {
        this.db
          .delete(schema.inboundDerivedContentRetiredAttempts)
          .where(
            inArray(
              schema.inboundDerivedContentRetiredAttempts.attempt_id,
              expiredAttemptFences.map(({ attemptId }) => attemptId),
            ),
          )
          .run();
      }

      const dueCandidates = this.db
        .select()
        .from(schema.r2DeletionOutbox)
	        .where(
		  and(
			isNull(schema.r2DeletionOutbox.parked_at),
	          or(
	            and(
              eq(schema.r2DeletionOutbox.state, "pending"),
			  or(
				lte(schema.r2DeletionOutbox.next_attempt_at, nowIso),
				sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.r2DeletionOutbox.next_attempt_at}) IS NULL`,
				sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.r2DeletionOutbox.next_attempt_at}) <> ${schema.r2DeletionOutbox.next_attempt_at}`,
			  ),
            ),
            and(
              eq(schema.r2DeletionOutbox.state, "deleting"),
			  or(
				lte(schema.r2DeletionOutbox.lease_expires_at, nowIso),
				sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.r2DeletionOutbox.lease_expires_at}) IS NULL`,
				sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${schema.r2DeletionOutbox.lease_expires_at}) <> ${schema.r2DeletionOutbox.lease_expires_at}`,
			  ),
            ),
	          )),
	        )
        .orderBy(
          asc(schema.r2DeletionOutbox.next_attempt_at),
          asc(schema.r2DeletionOutbox.r2_key),
        )
        .limit(R2_DELETION_BATCH_SIZE)
        .all();
      if (dueCandidates.length === 0) return [];

      const ownedKeys = this.#authoritativelyOwnedR2KeysSync(
        dueCandidates.map(({ r2_key }) => r2_key),
      );
      if (ownedKeys.size > 0) {
        for (const keyChunk of sqlParameterChunks(
          [...ownedKeys],
          R2_CLAIM_KEY_CHUNK_SIZE,
        )) {
          this.db
            .delete(schema.r2DeletionOutbox)
            .where(inArray(schema.r2DeletionOutbox.r2_key, keyChunk))
            .run();
        }
      }
      const due = dueCandidates.filter((row) => !ownedKeys.has(row.r2_key));
      if (due.length === 0) return [];

      for (const keyChunk of sqlParameterChunks(
        due.map(({ r2_key }) => r2_key),
        R2_CLAIM_KEY_CHUNK_SIZE,
      )) {
        this.db
          .update(schema.r2DeletionOutbox)
          .set({
            state: "deleting",
            claim_generation: sql`${schema.r2DeletionOutbox.claim_generation} + 1`,
            lease_token: leaseToken,
            lease_expires_at: leaseExpiresAt,
            attempts: sql`${schema.r2DeletionOutbox.attempts} + 1`,
            last_error: null,
          })
          .where(inArray(schema.r2DeletionOutbox.r2_key, keyChunk))
          .run();
      }

      const attemptFences = [
        ...new Map(
          due.flatMap((row) =>
            row.projection_attempt_id
              ? [[row.projection_attempt_id, row] as const]
              : [],
          ),
        ).values(),
      ].map((row) => ({
        attempt_id: row.projection_attempt_id!,
        email_id: row.email_id,
        retired_at: nowIso,
        expires_at: fenceExpiresAt,
        reason: "r2_deletion_started" as const,
      }));
      for (const fenceChunk of sqlParameterChunks(
        attemptFences,
        R2_ATTEMPT_FENCE_INSERT_CHUNK_SIZE,
      )) {
        this.db
          .insert(schema.inboundDerivedContentRetiredAttempts)
          .values(fenceChunk)
          .onConflictDoUpdate({
            target: schema.inboundDerivedContentRetiredAttempts.attempt_id,
            set: { expires_at: fenceExpiresAt },
          })
          .run();
      }

      const legacyFences = due
        .filter((row) => row.projection_attempt_id === null)
        .map((row) => ({
          r2_key: row.r2_key,
          email_id: row.email_id,
          retired_at: nowIso,
          reason: "r2_deletion_started" as const,
        }));
      for (const fenceChunk of sqlParameterChunks(
        legacyFences,
        R2_LEGACY_FENCE_INSERT_CHUNK_SIZE,
      )) {
        this.db
          .insert(schema.r2RetiredKeyFences)
          .values(fenceChunk)
          .onConflictDoNothing()
          .run();
      }

	      return due.map((row) => ({
	        r2Key: row.r2_key,
	        claimGeneration: row.claim_generation + 1,
	        attempts: row.attempts + 1,
			recoveryRef: crypto.randomUUID(),
	      }));
	    });
	    if (claimed.length > 0) {
	  const outcomes: Array<{
		row: (typeof claimed)[number];
		succeeded: boolean;
	  }> = [];
	  // Isolate each key so one R2-specific failure cannot retain valid siblings.
	  for (const row of claimed) {
		try {
		  await this.env.BUCKET.delete(row.r2Key);
		  outcomes.push({ row, succeeded: true });
		} catch {
		  outcomes.push({ row, succeeded: false });
		}
	  }
	  this.ctx.storage.transactionSync(() => {
		for (const outcome of outcomes) {
		  const fence = and(
			eq(schema.r2DeletionOutbox.r2_key, outcome.row.r2Key),
			eq(schema.r2DeletionOutbox.state, "deleting"),
			eq(schema.r2DeletionOutbox.lease_token, leaseToken),
			eq(
			  schema.r2DeletionOutbox.claim_generation,
			  outcome.row.claimGeneration,
			),
		  );
		  if (outcome.succeeded) {
			this.db.delete(schema.r2DeletionOutbox).where(fence).run();
			continue;
		  }
		  const parked = outcome.row.attempts >= 6;
		  const delayMs = Math.min(
			3_600_000,
			2 ** Math.min(outcome.row.attempts, 10) * 1_000,
		  );
		  this.db
			.update(schema.r2DeletionOutbox)
			.set({
			  lease_expires_at: new Date(now + delayMs).toISOString(),
			  last_error: "R2_DELETION_FAILED",
			  parked_at: parked ? nowIso : null,
			  recovery_ref: parked ? outcome.row.recoveryRef : null,
			})
			.where(fence)
			.run();
		}
	  });
	  const succeeded = outcomes.filter((outcome) => outcome.succeeded).length;
	  const parked = outcomes.filter(
		(outcome) => !outcome.succeeded && outcome.row.attempts >= 6,
	  ).length;
	  console.info("[mail-cleanup] R2 deletion batch completed", {
		count: claimed.length,
		failed: claimed.length - succeeded,
		pendingReview: parked,
		operation: "r2_deletion_outbox",
		status: succeeded === claimed.length ? "succeeded" : "partial",
	  });
	  if (succeeded !== claimed.length) {
		console.error("[mail-cleanup] R2 deletion items require recovery", {
		  failed: claimed.length - succeeded,
		  pendingReview: parked,
		  operation: "r2_deletion_outbox",
		  recoveryAction: parked > 0 ? "operator_repair" : "retry",
		  errorCode: "R2_DELETION_OUTBOX_FAILED",
		});
	  }
	    }
    const nextPending = this.db
      .select({ nextAttemptAt: schema.r2DeletionOutbox.next_attempt_at })
      .from(schema.r2DeletionOutbox)
	      .where(and(
		  eq(schema.r2DeletionOutbox.state, "pending"),
		  isNull(schema.r2DeletionOutbox.parked_at),
		))
      .orderBy(
        asc(schema.r2DeletionOutbox.next_attempt_at),
        asc(schema.r2DeletionOutbox.r2_key),
      )
      .limit(1)
      .get();
    const nextDeleting = this.db
      .select({ leaseExpiresAt: schema.r2DeletionOutbox.lease_expires_at })
      .from(schema.r2DeletionOutbox)
	      .where(and(
		  eq(schema.r2DeletionOutbox.state, "deleting"),
		  isNull(schema.r2DeletionOutbox.parked_at),
		))
      .orderBy(
        asc(schema.r2DeletionOutbox.lease_expires_at),
        asc(schema.r2DeletionOutbox.r2_key),
      )
      .limit(1)
      .get();
    const nextFenceExpiry = this.db
      .select({
        expiresAt: schema.inboundDerivedContentRetiredAttempts.expires_at,
      })
      .from(schema.inboundDerivedContentRetiredAttempts)
      .orderBy(
        asc(schema.inboundDerivedContentRetiredAttempts.expires_at),
        asc(schema.inboundDerivedContentRetiredAttempts.attempt_id),
      )
      .limit(1)
      .get();
    const candidates = [
      nextPending ? Date.parse(nextPending.nextAttemptAt) : null,
      nextDeleting?.leaseExpiresAt
        ? Date.parse(nextDeleting.leaseExpiresAt)
        : null,
      nextFenceExpiry ? Date.parse(nextFenceExpiry.expiresAt) : null,
	].filter(
	  (candidate): candidate is number =>
		candidate !== null && Number.isFinite(candidate),
	);
	    return candidates.length > 0 ? Math.min(...candidates) : null;
	  }

	listParkedR2DeletionRecoveries(
	  afterRecoveryRef: string | undefined,
	  limit: number,
	) {
	  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
	  const rows = this.db
		.select({
		  recoveryRef: schema.r2DeletionOutbox.recovery_ref,
		  emailId: schema.r2DeletionOutbox.email_id,
		  generation: schema.r2DeletionOutbox.claim_generation,
		  attempts: schema.r2DeletionOutbox.attempts,
		  lastErrorCode: schema.r2DeletionOutbox.last_error,
		  parkedAt: schema.r2DeletionOutbox.parked_at,
		})
		.from(schema.r2DeletionOutbox)
		.where(and(
		  isNotNull(schema.r2DeletionOutbox.parked_at),
		  isNotNull(schema.r2DeletionOutbox.recovery_ref),
		  ...(afterRecoveryRef
			? [gt(schema.r2DeletionOutbox.recovery_ref, afterRecoveryRef)]
			: []),
		))
		.orderBy(asc(schema.r2DeletionOutbox.recovery_ref))
		.limit(boundedLimit + 1)
		.all();
	  const hasMore = rows.length > boundedLimit;
	  const items = rows.slice(0, boundedLimit);
	  return {
		items,
		...(hasMore ? { next: items.at(-1)?.recoveryRef ?? undefined } : {}),
	  };
	}

	async repairParkedR2Deletion(
	  recoveryRef: string,
	  input: { operationKey: string; expectedGeneration: number },
	  actor: ActivityActor,
	) {
	  const auditId = `r2_deletion_repaired:${recoveryRef}:${input.operationKey}`;
	  const at = new Date().toISOString();
	  const result = this.ctx.storage.transactionSync(() => {
		const replay = this.db
		  .select({ id: schema.activityEvents.id })
		  .from(schema.activityEvents)
		  .where(eq(schema.activityEvents.id, auditId))
		  .get();
		if (replay) return { status: "replayed" as const };
		const current = this.db
		  .select()
		  .from(schema.r2DeletionOutbox)
		  .where(eq(schema.r2DeletionOutbox.recovery_ref, recoveryRef))
		  .get();
		if (!current) return { status: "not_found" as const };
		if (current.parked_at === null) return { status: "not_parked" as const };
		if (current.claim_generation !== input.expectedGeneration) {
		  return {
			status: "generation_conflict" as const,
			generation: current.claim_generation,
		  };
		}
		const generation = current.claim_generation + 1;
		this.db
		  .update(schema.r2DeletionOutbox)
		  .set({
			state: "pending",
			claim_generation: generation,
			lease_token: null,
			lease_expires_at: null,
			attempts: 0,
			next_attempt_at: at,
			last_error: null,
			parked_at: null,
			recovery_ref: null,
		  })
		  .where(and(
			eq(schema.r2DeletionOutbox.r2_key, current.r2_key),
			eq(schema.r2DeletionOutbox.recovery_ref, recoveryRef),
			eq(schema.r2DeletionOutbox.claim_generation, current.claim_generation),
		  ))
		  .run();
		this.#recordActivityOnce(
		  auditId,
		  actor,
		  "r2_deletion_repaired",
		  "email",
		  current.email_id,
		  { generation },
		  at,
		);
		return { status: "repaired" as const, generation };
	  });
	  if (result.status === "repaired") {
		try {
		  await this.#scheduleAlarmAt(Date.now() + 100);
		} catch {
		  console.error("R2 deletion repair remains durably pending", {
			recoveryRef,
		  });
		}
	  }
	  return result;
	}

	  /** Enqueue the next recipient of the head job, persist progress, reschedule. */
  async alarm(): Promise<void> {
    const alarmNow = Date.now();
    await runOutboundAlarmLane({
      process: () => this.#processOutboundAlarm(),
      ensureAlarm: () => this.#ensureOutboundAlarm(),
      logFailure: ({ stage, error }) =>
        console.error("[outbound] alarm lane failed", {
          operation: "outbound_alarm_lane",
          stage,
          status: "failure",
          errorName: error instanceof Error ? error.name : "UnknownError",
          retryDecision:
            stage === "rearm" ? "cloudflare_alarm_retry" : "durable_rearm",
        }),
    });
	try {
		await this.#processImportPromotionIntents(alarmNow);
	} catch (error) {
		console.error("[import-promotion] alarm lane failed", {
			operation: "import_promotion_alarm_lane",
			status: "failure",
			errorName: error instanceof Error ? error.name : "UnknownError",
			retryDecision: "durable_rearm",
		});
		await this.#scheduleAlarmAt(Date.now() + 1_000);
	}
    const nextR2DeletionAt = await this.#processR2DeletionOutbox(Date.now());
    if (nextR2DeletionAt !== null) {
      // Durable Object alarms are at-least-once and automatic retries stop after
      // six attempts, so every handled pass explicitly schedules durable follow-up.
      // https://developers.cloudflare.com/durable-objects/api/alarms/
      await this.#scheduleAlarmAt(Math.max(Date.now() + 100, nextR2DeletionAt));
    }
    this.ctx.storage.transactionSync(() => {
      this.#expireBulkPreparationsSync(alarmNow);
      this.#pruneBulkTerminalSync(alarmNow);
      this.#pruneBulkReservationsSync(alarmNow);
    });
    await this.#ensureBulkMaintenanceAlarm();
    await this.#processBulkAdmissionPreparation();
    const nextSemanticAt = await this.#processSemanticIndexAlarm(alarmNow);
    if (nextSemanticAt !== null) await this.#scheduleAlarmAt(nextSemanticAt);
    try {
      const nextAutomationAt = this.#processAutomationRulesAlarm();
      if (nextAutomationAt !== null) {
        await this.#scheduleAlarmAt(
          Math.max(Date.now() + 100, nextAutomationAt),
        );
      }
    } catch (error) {
      console.error("[automation-rules] alarm pass failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const pushVapid = vapidConfig(this.env);
    const nextPushAt = await processPushOutbox({
      storage: {
        sql: this.ctx.storage.sql,
        transactionSync: (run) => this.ctx.storage.transactionSync(run),
      },
      vapidConfigured: pushVapid !== null,
      createToken: () => crypto.randomUUID(),
      canAccess: (userId, mailboxId) =>
        mailboxAccess(this.env).canAccessMailbox(userId, mailboxId),
      send: (subscription, payload, options) => {
        if (!pushVapid) {
          return Promise.resolve({
            ok: false as const,
            reason: "CONFIG_ERROR" as const,
            shouldDelete: false,
            statusCode: null,
          });
        }
        return sendWebPush(subscription, payload, pushVapid, {
          signal: options.signal,
          timeoutMs: Math.max(1, options.deadlineMs - Date.now()),
        });
      },
      scheduleAlarmAt: (timestamp) => this.#scheduleAlarmAt(timestamp),
    });
    if (nextPushAt !== null) await this.#scheduleAlarmAt(nextPushAt);
    const replyWakePending = this.#processReplyWakeBatch();
    const nextSnoozeAt = this.#processDueSnoozeBatch(alarmNow);
    const nextFollowUpAt =
      await this.#processFollowUpReplyCompletionQueue(alarmNow);
    const nextSnoozeAlarm = earliestMailboxAlarm([
      replyWakePending ? alarmNow + 100 : null,
      nextSnoozeAt,
      nextFollowUpAt,
    ]);
    if (nextSnoozeAlarm !== null) {
      await this.#scheduleAlarmAt(Math.max(alarmNow, nextSnoozeAlarm));
    }
    const draftSaveNow = Date.now();
    const expiredDraftSaveClaims =
      this.#promoteExpiredDraftSaveClaimsToCleanup(draftSaveNow);
    if (expiredDraftSaveClaims.integrityFailures > 0) {
	      console.error("[draft-save-cleanup] invalid plans are durably parked", {
        code: "draft_save_destination_plan_invalid",
        operationCount: expiredDraftSaveClaims.integrityFailures,
      });
    }
    const nextDraftSaveCleanupAt =
      await this.#processDraftSaveCleanup(draftSaveNow);
    const nextDraftSaveAlarm = earliestMailboxAlarm([
      expiredDraftSaveClaims.moreDue ? Date.now() + 100 : null,
      nextDraftSaveCleanupAt,
      this.#nextDraftSaveClaimExpiryAt(),
    ]);
    if (nextDraftSaveAlarm !== null) {
      await this.#scheduleAlarmAt(
        Math.max(Date.now() + 100, nextDraftSaveAlarm),
      );
    }
	    const nextAttachmentCleanupAt = await this.#processAttachmentCleanup();
	    await this.#processBulkAttachmentCleanup();
	    if (nextAttachmentCleanupAt !== null) {
	      await this.#scheduleAlarmAt(
			Math.max(Date.now() + 100, nextAttachmentCleanupAt),
		  );
	    }
    let queue: string[];
    try {
      queue = (await this.ctx.storage.get<string[]>(BULK_QUEUE_KEY)) ?? [];
    } catch (error) {
      console.error("[bulk-send] alarm pass failed", {
        operation: "bulk_alarm_pass",
        stage: "queue_read",
        result: "failure",
        errorName: error instanceof Error ? error.name : "UnknownError",
        retryDecision: "retry_alarm",
        durationMs: Date.now() - alarmNow,
      });
      throw error;
    }
    if (queue.length === 0) {
      await this.#ensureBulkMaintenanceAlarm();
      return;
    }

    const jobId = queue[0];
    let job: BulkJob | undefined;
    try {
      job = await this.ctx.storage.get<BulkJob>(`bulk:job:${jobId}`);
    } catch (error) {
      console.error("[bulk-send] alarm pass failed", {
        operation: "bulk_alarm_pass",
        stage: "job_read",
        jobId,
        result: "failure",
        errorName: error instanceof Error ? error.name : "UnknownError",
        retryDecision: "retry_alarm",
        durationMs: Date.now() - alarmNow,
      });
      throw error;
    }
    let rows: BulkRecipient[];
    try {
      rows =
        (await this.ctx.storage.get<BulkRecipient[]>(`bulk:rows:${jobId}`)) ??
        [];
    } catch (error) {
      console.error("[bulk-send] alarm pass failed", {
        operation: "bulk_alarm_pass",
        stage: "rows_read",
        mailboxId: job?.fromEmail,
        operationId: job?.operationId,
        jobId,
        result: "failure",
        errorName: error instanceof Error ? error.name : "UnknownError",
        retryDecision: "retry_alarm",
        durationMs: Date.now() - alarmNow,
      });
      throw error;
    }
    if (job) job.enqueued ??= job.sent ?? 0;

    // Drop a finished/missing job and move on.
    if (
      !job ||
      job.status === "done" ||
      job.status === "cancelled" ||
      job.cursor >= rows.length
    ) {
      if (job && job.cursor >= rows.length) {
        job.status = "done";
        job.updatedAt = Date.now();
      }
      const remainingJobs = this.#commitBulkTerminalSync(
        jobId,
        job ?? undefined,
      );
      if (job) {
        console.info("[bulk-send] job reached terminal state", {
          operation: "bulk_job_terminal",
          mailboxId: job.fromEmail,
          actorUserId: job.actorUserId,
          operationId: job.operationId,
          jobId,
          status: job.status,
          result: "reconciled_terminal",
          terminalReason:
            job.cursor >= rows.length ? "cursor_exhausted" : "already_terminal",
          total: job.total,
          cursor: job.cursor,
          enqueued: job.enqueued,
          failed: job.failed,
          remainingJobs,
          retryDecision: remainingJobs > 0 ? "next_job" : "maintenance_only",
          durationMs: Date.now() - job.createdAt,
        });
      } else {
        console.error("[bulk-send] job reached terminal state", {
          operation: "bulk_job_terminal",
          jobId,
          result: "missing_job",
          terminalReason: "queue_entry_without_job",
          action: "removed_from_queue",
          remainingJobs,
          retryDecision: remainingJobs > 0 ? "next_job" : "maintenance_only",
          durationMs: Date.now() - alarmNow,
        });
      }
      await this.#ensureBulkMaintenanceAlarmForJob({
        startedAt: alarmNow,
        jobId,
        ...(job ? { job } : {}),
      });
      if (remainingJobs > 0) {
        await this.#scheduleBulkAlarmAt(Date.now() + 100, {
          stage: "next_job_schedule",
          startedAt: alarmNow,
          jobId,
          ...(job ? { job } : {}),
        });
      }
      return;
    }

    let canAccess = false;
    if (job.actorUserId) {
      const authorizationStartedAt = Date.now();
      try {
        canAccess = await mailboxAccess(this.env).canAccessMailbox(
          job.actorUserId,
          job.fromEmail,
        );
      } catch (error) {
        console.error("[bulk-send] job authorization failed", {
          operation: "bulk_job_authorization",
          mailboxId: job.fromEmail,
          actorUserId: job.actorUserId,
          operationId: job.operationId,
          jobId,
          result: "failure",
          target: "mailbox_access",
          errorName: error instanceof Error ? error.name : "UnknownError",
          retryDecision: "retry_alarm",
          durationMs: Date.now() - authorizationStartedAt,
        });
        throw error;
      }
    }
    if (!job.actorUserId || !canAccess) {
      job.status = "cancelled";
      job.updatedAt = Date.now();
      job.errors.push({
        email: "",
        error:
          "Job cancelled because the initiating user's mailbox access ended.",
      });
      const remainingJobs = this.#commitBulkTerminalSync(jobId, job);
      console.warn("[bulk-send] job reached terminal state", {
        operation: "bulk_job_terminal",
        mailboxId: job.fromEmail,
        actorUserId: job.actorUserId || undefined,
        operationId: job.operationId,
        jobId,
        status: job.status,
        result: "cancelled",
        terminalReason: job.actorUserId ? "access_revoked" : "missing_actor",
        total: job.total,
        cursor: job.cursor,
        enqueued: job.enqueued,
        failed: job.failed,
        remainingJobs,
        retryDecision: remainingJobs > 0 ? "next_job" : "maintenance_only",
        durationMs: Date.now() - job.createdAt,
      });
      await this.#ensureBulkMaintenanceAlarmForJob({
        startedAt: alarmNow,
        jobId,
        job,
      });
      if (remainingJobs > 0) {
        await this.#scheduleBulkAlarmAt(Date.now() + 100, {
          stage: "next_job_schedule",
          startedAt: alarmNow,
          jobId,
          job,
        });
      }
      return;
    }

    const currentTime = Date.now();
    const nextEnqueueAt = job.nextEnqueueAt ?? job.createdAt;
    if (nextEnqueueAt > currentTime) {
      await this.#scheduleBulkAlarmAt(nextEnqueueAt, {
        stage: "throttle_schedule",
        startedAt: alarmNow,
        jobId,
        job,
      });
      return;
    }

    if (job.status === "queued") job.status = "running";

    const row = rows[job.cursor];
    const to = row.email;
    const subject = renderBulkTemplate(job.subject, row, false)
      .replace(/[\r\n]+/g, " ")
      .trim();
    const html = job.html ? renderBulkTemplate(job.html, row, true) : undefined;
    const text = job.text
      ? renderBulkTemplate(job.text, row, false)
      : undefined;

    const idempotencyKey = `bulk:${job.id}:${job.cursor}`;
	const replayCommand = await withOutboundCommandFingerprint(
	  {
		idempotencyKey,
		source: "bulk",
		actor: { kind: "user", id: job.actorUserId },
		snapshot: {
		  mailboxId: job.fromEmail,
		  kind: "bulk",
		  to: [to.toLowerCase()],
		  cc: [],
		  bcc: [],
		  from: job.fromEmail,
		  subject,
		  ...(html !== undefined ? { html } : {}),
		  ...(text !== undefined ? { text } : {}),
		  threadId: "generated",
		  attachmentIds: [],
          attachmentByteIdentities: [],
		},
		requestedAt: "1970-01-01T00:00:00.000Z",
		undoUntil: "1970-01-01T00:00:00.000Z",
	  },
	  (job.attachments ?? []).map((attachment) => attachment.key),
	);
    const recipientStartedAt = Date.now();
    let authoritative: StoredOutboundDelivery | null;
    try {
      authoritative =
        await this.getOutboundDeliveryByIdempotencyKey(idempotencyKey);
    } catch (error) {
      console.error("[bulk-send] recipient enqueue completed", {
        operation: "bulk_recipient_enqueue",
        mailboxId: job.fromEmail,
        operationId: job.operationId,
        jobId: job.id,
        cursor: job.cursor,
        stage: "idempotency_lookup",
        result: "failure",
        target: "outbound_delivery_store",
        errorName: error instanceof Error ? error.name : "UnknownError",
        retryDecision: "retry_alarm",
        durationMs: Date.now() - recipientStartedAt,
      });
      throw error;
    }
    let preparation: BulkRecipientPreparation | null = null;
    let messageId = authoritative?.emailId ?? "";
    const replayResolution = classifyOutboundReplay(
      authoritative,
      replayCommand.commandFingerprint,
    );
    const replayConflict =
      replayResolution.status === "conflict"
        ? new OutboundIdempotencyConflictError(replayResolution.reason)
        : null;
    if (authoritative) {
      try {
        this.ctx.storage.transactionSync(() => {
          const stalePreparation =
            this.ctx.storage.kv.get<BulkRecipientPreparation>(
              this.#bulkRecipientPreparationKey(job.id, job.cursor),
            );
          if (stalePreparation) {
            this.#finishBulkRecipientPreparationSync(
              stalePreparation,
			  replayConflict ? null : authoritative!.emailId,
            );
          }
        });
      } catch (error) {
        console.error("[bulk-send] recipient enqueue completed", {
          operation: "bulk_recipient_enqueue",
          mailboxId: job.fromEmail,
          operationId: job.operationId,
          jobId: job.id,
          cursor: job.cursor,
          stage: "replay_cleanup",
          result: "failure",
          target: "durable_storage",
          errorName: error instanceof Error ? error.name : "UnknownError",
          retryDecision: "retry_alarm",
          durationMs: Date.now() - recipientStartedAt,
        });
        throw error;
      }
    }

    try {
	  if (replayConflict) throw replayConflict;
      if (!authoritative) {
        const fromDomain = job.fromEmail.split("@")[1] || "";
        const generated = generateMessageId(fromDomain).messageId;
        preparation = this.ctx.storage.transactionSync(() =>
          this.#createBulkRecipientPreparationSync(job, generated),
        );
        messageId = preparation?.messageId ?? generated;
        if (preparation) {
          const activePreparation = preparation;
          // Cloudflare alarms are at-least-once but have a bounded automatic
          // retry count. Persist and schedule cleanup before external R2 I/O.
          // https://developers.cloudflare.com/durable-objects/api/alarms/
          await this.#ensureBulkMaintenanceAlarm();
          for (const [index, attachment] of (job.attachments ?? []).entries()) {
            const source = await this.env.BUCKET.get(attachment.key);
            if (!source) {
              throw new BulkRecipientAttachmentUnavailableError(
                attachment.filename,
              );
            }
            const sourceBytes = await source.arrayBuffer();
            const sourceDigest = await attachmentSha256(sourceBytes);
            if (sourceDigest.hex !== attachment.contentSha256) {
              throw new BulkRecipientAttachmentUnavailableError(
                attachment.filename,
              );
            }
            await this.env.BUCKET.put(
              activePreparation.keys[index],
              sourceBytes,
              {
                httpMetadata: { contentType: attachment.type },
                customMetadata: { contentSha256: sourceDigest.hex },
                sha256: sourceDigest.binary,
              },
            );
          }
        }
        const pendingAttachments = preparation?.attachments ?? [];
        const activePreparation = preparation;
        const requestedAt = new Date().toISOString();
        await this.#enqueueOutboundInternal(
		  {
			...replayCommand,
            snapshot: {
			  ...replayCommand.snapshot,
              threadId: messageId,
              attachmentIds: pendingAttachments.map(
                (attachment) => attachment.id,
              ),
              attachmentByteIdentities:
                outboundAttachmentByteIdentities(pendingAttachments),
            },
            requestedAt,
            undoUntil: requestedAt,
		  },
          pendingAttachments,
          messageId,
          activePreparation
            ? (result) =>
                this.#finishBulkRecipientPreparationSync(
                  activePreparation,
                  result.delivery.emailId,
                )
            : undefined,
        );
      }
      // This counter now records rows durably accepted into the truthful outbox.
      // Provider acceptance remains visible on each outbound delivery record.
      job.enqueued += 1;
      console.info("[bulk-send] recipient enqueue completed", {
        operation: "bulk_recipient_enqueue",
        mailboxId: job.fromEmail,
        operationId: job.operationId,
        jobId: job.id,
        cursor: job.cursor,
        result: authoritative ? "replay" : "committed",
        target: "outbound_delivery_store",
        durationMs: Date.now() - recipientStartedAt,
      });
    } catch (e) {
      try {
        authoritative =
          await this.getOutboundDeliveryByIdempotencyKey(idempotencyKey);
      } catch (reconciliationError) {
        // The alarm must retry while commit state is indeterminate. Deleting
        // bytes or advancing the cursor could corrupt an accepted snapshot.
        console.error("[bulk-send] recipient enqueue completed", {
          operation: "bulk_recipient_enqueue",
          mailboxId: job.fromEmail,
          operationId: job.operationId,
          jobId: job.id,
          cursor: job.cursor,
          result: "commit_state_unknown",
          target: "outbound_delivery_store",
          errorName:
            reconciliationError instanceof Error
              ? reconciliationError.name
              : "UnknownError",
          retryDecision: "retry_alarm",
          durationMs: Date.now() - recipientStartedAt,
        });
        throw e;
      }
      const reconciliation = planBulkEnqueueReconciliation(
        authoritative,
        messageId,
		replayCommand.commandFingerprint,
      );
      const disposition = planBulkRecipientEnqueueDisposition(
        reconciliation.status,
        e,
      );
      if (disposition === "retry") {
        console.error("[bulk-send] recipient enqueue completed", {
          operation: "bulk_recipient_enqueue",
          mailboxId: job.fromEmail,
          operationId: job.operationId,
          jobId: job.id,
          cursor: job.cursor,
          result: "transient_failure",
          target: "outbound_delivery_store",
          errorName: e instanceof Error ? e.name : "UnknownError",
          retryDecision: "retry_alarm",
          durationMs: Date.now() - recipientStartedAt,
        });
        throw e;
      }
      if (preparation) {
        const activePreparation = preparation;
        this.ctx.storage.transactionSync(() =>
          this.#finishBulkRecipientPreparationSync(
            activePreparation,
            disposition === "committed"
              ? (authoritative?.emailId ?? null)
              : null,
          ),
        );
      }
      if (disposition === "committed") {
        job.enqueued += 1;
        console.info("[bulk-send] recipient enqueue completed", {
          operation: "bulk_recipient_enqueue",
          mailboxId: job.fromEmail,
          operationId: job.operationId,
          jobId: job.id,
          cursor: job.cursor,
          result: "recovered_commit",
          target: "outbound_delivery_store",
          retryDecision: "continue",
          durationMs: Date.now() - recipientStartedAt,
        });
        await this.#ensureOutboundAlarm();
      } else {
        job.failed += 1;
        job.errors.push({ email: to, error: "Recipient could not be queued." });
        console.error("[bulk-send] recipient enqueue completed", {
          operation: "bulk_recipient_enqueue",
          mailboxId: job.fromEmail,
          operationId: job.operationId,
          jobId: job.id,
          cursor: job.cursor,
          result: "failed",
          target: "outbound_delivery_store",
          errorName: e instanceof Error ? e.name : "UnknownError",
          retryDecision: "terminal_for_recipient",
          durationMs: Date.now() - recipientStartedAt,
        });
      }
    }

    job.cursor += 1;
    job.updatedAt = Date.now();
    job.nextEnqueueAt = nextBulkEnqueueAt(job.updatedAt, Math.random());
    if (job.cursor >= rows.length) {
      job.status = "done";
      const remainingJobs = this.#commitBulkTerminalSync(jobId, job);
      console.info("[bulk-send] job reached terminal state", {
        operation: "bulk_job_terminal",
        mailboxId: job.fromEmail,
        actorUserId: job.actorUserId,
        operationId: job.operationId,
        jobId,
        status: job.status,
        result: "completed",
        terminalReason: "all_recipients_processed",
        total: job.total,
        cursor: job.cursor,
        enqueued: job.enqueued,
        failed: job.failed,
        remainingJobs,
        retryDecision: remainingJobs > 0 ? "next_job" : "maintenance_only",
        durationMs: Date.now() - job.createdAt,
      });
      await this.#ensureBulkMaintenanceAlarmForJob({
        startedAt: alarmNow,
        jobId,
        job,
      });
      if (remainingJobs > 0) {
        await this.#scheduleBulkAlarmAt(Date.now() + 100, {
          stage: "next_job_schedule",
          startedAt: alarmNow,
          jobId,
          job,
        });
      }
      return;
    }
    try {
      await this.ctx.storage.put(`bulk:job:${jobId}`, job);
    } catch (error) {
      console.error("[bulk-send] alarm pass failed", {
        operation: "bulk_alarm_pass",
        stage: "progress_persist",
        mailboxId: job.fromEmail,
        operationId: job.operationId,
        jobId,
        result: "failure",
        errorName: error instanceof Error ? error.name : "UnknownError",
        retryDecision: "retry_alarm",
        durationMs: Date.now() - alarmNow,
      });
      throw error;
    }
    await this.#scheduleBulkAlarmAt(job.nextEnqueueAt, {
      stage: "next_job_schedule",
      startedAt: alarmNow,
      jobId,
      job,
    });
  }

  // ── Deterministic inbound Automation Rules ─────────────────────

  #automationTargetSets() {
    return {
      labels: new Set(
        [
          ...this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM labels"),
        ].map((row) => row.id),
      ),
      folders: new Set(
        [
          ...this.ctx.storage.sql.exec<{ id: string }>(
            `SELECT id FROM folders
					 WHERE id = ? OR (is_deletable = 1 AND id <> ?)`,
            Folders.ARCHIVE,
            InternalFolders.RETIRED_OUTBOUND,
          ),
        ].map((row) => row.id),
      ),
    };
  }

  #automationRuleHistory() {
    return new Map(
      [
        ...this.ctx.storage.sql.exec<{
          ruleId: string;
          lastRunAt: string;
          lastMatchedAt: string | null;
        }>(
          `SELECT rule_id AS ruleId, MAX(created_at) AS lastRunAt,
				        MAX(CASE WHEN outcome NOT IN ('not_matched', 'stopped')
				                 THEN created_at ELSE NULL END) AS lastMatchedAt
				 FROM automation_run_results GROUP BY rule_id`,
        ),
      ].map((row) => [row.ruleId, row]),
    );
  }

  #automationTargetUsage(target: { labelId?: string; folderId?: string }) {
    const current = this.#automationRules().rulesUsingTarget(target);
    const referenceTable = target.labelId
      ? "automation_run_label_refs"
      : "automation_run_folder_refs";
    const referenceColumn = target.labelId ? "label_id" : "folder_id";
    const targetId = target.labelId ?? target.folderId;
    if (!targetId)
      throw new AutomationRuleError(
        "INVALID",
        "Automation Rule target is invalid",
      );
    const pending = [
      ...this.ctx.storage.sql.exec<{ id: string; name: string }>(
        `SELECT DISTINCT rr.rule_id AS id, rr.rule_name AS name
			 FROM ${referenceTable} ref
			 JOIN automation_runs run ON run.id = ref.run_id
			 JOIN automation_run_rules rr ON rr.run_id = run.id
			 WHERE ref.${referenceColumn} = ? AND run.state IN ('pending', 'processing')
			 ORDER BY rr.ordinal ASC, rr.rule_id ASC LIMIT 20`,
        targetId,
      ),
    ];
    return [
      ...new Set([...current, ...pending].map((rule) => rule.name)),
    ].slice(0, 5);
  }

  #assertAutomationTargetUnused(target: {
    labelId?: string;
    folderId?: string;
  }) {
    const names = this.#automationTargetUsage(target);
    if (names.length > 0) {
      throw new AutomationRuleError(
        "RULE_TARGET_IN_USE",
        `Target is used by Automation ${names.length === 1 ? "Rule" : "Rules"}: ${names.join(", ")}`,
      );
    }
  }

  #automationRuleView(
    rule: AutomationRuleRecord,
    versions: AutomationRuleVersionRecord[],
    targets = this.#automationTargetSets(),
    history = this.#automationRuleHistory(),
  ) {
    const active =
      versions.find((version) => version.version === rule.activeVersion) ??
      null;
    const draft =
      versions.find((version) => version.version === rule.draftVersion) ?? null;
    let targetHealth: "ready" | "needs_attention" = "ready";
    for (const version of [active, draft]) {
      if (!version) continue;
      for (const action of version.definition.actions) {
        if (
          action.kind === "apply_labels" &&
          action.labelIds.some((labelId) => !targets.labels.has(labelId))
        )
          targetHealth = "needs_attention";
        if (
          action.kind === "move_to_folder" &&
          !targets.folders.has(action.folderId)
        )
          targetHealth = "needs_attention";
      }
    }
    return {
      id: rule.id,
      name: rule.name,
      state:
        targetHealth === "needs_attention" && rule.state !== "archived"
          ? ("needs_attention" as const)
          : rule.state,
      position: rule.position,
      revision: rule.revision,
      activeVersion: rule.activeVersion,
      draftVersion: rule.draftVersion,
      activeDefinition: active?.definition ?? null,
      draftDefinition: draft?.definition ?? null,
      createdBy: rule.createdBy,
      createdAt: rule.createdAt,
      updatedBy: rule.updatedBy,
      updatedAt: rule.updatedAt,
      archivedBy: rule.archivedBy,
      archivedAt: rule.archivedAt,
      targetHealth,
      lastRunAt: history.get(rule.id)?.lastRunAt ?? null,
      lastMatchedAt: history.get(rule.id)?.lastMatchedAt ?? null,
    };
  }

  async listAutomationRules(includeArchived = true) {
    const automation = this.#automationRules();
    const targets = this.#automationTargetSets();
    const history = this.#automationRuleHistory();
    const rules = automation.listRules(includeArchived).map((rule) => {
      try {
        return this.#automationRuleView(
          rule,
          automation.listVersions(rule.id),
          targets,
          history,
        );
      } catch {
        return {
          ...this.#automationRuleView(rule, [], targets, history),
          state:
            rule.state === "archived"
              ? rule.state
              : ("needs_attention" as const),
          targetHealth: "needs_attention" as const,
        };
      }
    });
    return { rules, ...automation.state() };
  }

  async getAutomationRule(ruleId: string) {
    const automation = this.#automationRules();
    const rule = automation
      .listRules(true)
      .find((candidate) => candidate.id === ruleId);
    if (!rule) return null;
    const versions = automation.listVersions(ruleId);
    return {
      rule: this.#automationRuleView(rule, versions),
      versions: versions.map((version) => ({
        ...version,
        isActive: version.version === rule.activeVersion,
        isDraft: version.version === rule.draftVersion,
      })),
    };
  }

  async #automationMutationResult(rule: AutomationRuleRecord) {
    const automation = this.#automationRules();
    return {
      rule: this.#automationRuleView(rule, automation.listVersions(rule.id)),
      ...automation.state(),
    };
  }

  async createAutomationRuleDraft(input: {
    definition: unknown;
    actorId: string;
    expectedOrderRevision: number;
  }) {
    const rule = await this.#automationRules().createDraft(input);
    return this.#automationMutationResult(rule);
  }

  async updateAutomationRuleDraft(input: {
    ruleId: string;
    definition: unknown;
    actorId: string;
    expectedRevision: number;
  }) {
    const rule = await this.#automationRules().updateDraft(input);
    return this.#automationMutationResult(rule);
  }

  async setAutomationRuleEnabled(input: {
    ruleId: string;
    enabled: boolean;
    actorId: string;
    expectedRevision: number;
  }) {
    const automation = this.#automationRules();
    const rule = input.enabled
      ? (() => {
          const current = automation
            .listRules(true)
            .find((item) => item.id === input.ruleId);
          if (!current)
            throw new AutomationRuleError(
              "NOT_FOUND",
              "Automation Rule was not found",
            );
          return current.draftVersion === null
            ? automation.setEnabled(input)
            : automation.enable(input);
        })()
      : automation.setEnabled(input);
    return this.#automationMutationResult(rule);
  }

  async archiveAutomationRule(input: {
    ruleId: string;
    actorId: string;
    expectedRevision: number;
  }) {
    return this.#automationMutationResult(
      this.#automationRules().archive(input),
    );
  }

  async reorderAutomationRules(input: {
    orderedRuleIds: string[];
    expectedOrderRevision: number;
    actorId: string;
  }) {
    this.#automationRules().reorder(input);
    return this.listAutomationRules(true);
  }

  async restoreAutomationRuleVersion(input: {
    ruleId: string;
    version: number;
    actorId: string;
    expectedRevision: number;
  }) {
    const rule = await this.#automationRules().restoreVersion(input);
    return this.#automationMutationResult(rule);
  }

  async dryRunAutomationRule(input: {
    testId: string;
    definition: unknown;
    actorId: string;
    ruleId: string;
    ruleVersion: number;
    acknowledgedZero: boolean;
  }) {
    const automation = this.#automationRules();
    // Non-storage awaits can interleave Durable Object events. Keep replay selection,
    // current-draft validation, evaluation, and commit synchronous after preparation.
    // https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#understand-how-input-and-output-gates-work
    const prepared = await automation.prepareDryRun(input.definition);
    const replay = automation.replayPreparedDryRun(input, prepared);
    if (replay) return this.#automationTestView(replay);
    const currentRules = automation.listRules(false);
    const requestedRule = currentRules.find((rule) => rule.id === input.ruleId);
    if (!requestedRule) {
      throw new AutomationRuleError(
        "NOT_FOUND",
        "Automation Rule was not found",
      );
    }
    if (
      requestedRule &&
      (input.ruleVersion !== requestedRule.draftVersion ||
        requestedRule.draftVersion === null)
    ) {
      throw new AutomationRuleError(
        "CONFLICT",
        "Automation Rule draft changed; refresh and try again",
      );
    }
    const enabled = currentRules.filter(
      (rule) => rule.state === "enabled" && rule.activeVersion !== null,
    );
    const orderedRules = enabled.map((rule, ordinal) => {
      const version = automation
        .listVersions(rule.id)
        .find((candidate) => candidate.version === rule.activeVersion);
      if (!version) {
        throw new AutomationRuleError(
          "INVALID",
          "An active Automation Rule version is unavailable",
        );
      }
      return {
        ordinal,
        ruleId: rule.id,
        ruleName: rule.name,
        version: version.version,
        definition: version.definition,
        definitionFingerprint: version.definitionFingerprint,
      };
    });
    const proposedOrdinal = enabled.filter(
      (rule) =>
        rule.id !== requestedRule.id && rule.position < requestedRule.position,
    ).length;
    return this.#automationTestView(
      automation.dryRunPrepared({
        ...input,
        prepared,
        contexts: readAutomationDryRunContexts(
          this.ctx.storage.sql,
          Date.now(),
        ),
        orderedRules,
        proposedOrdinal,
      }),
    );
  }

  async automationRulesUsingTarget(target: {
    labelId?: string;
    folderId?: string;
  }) {
    return this.#automationRules().rulesUsingTarget(target);
  }

  async getAutomationTargetUsage(target: {
    labelId?: string;
    folderId?: string;
  }) {
    return this.#automationTargetUsage(target);
  }

  #automationMessageView(messageId: string) {
    if (!messageId || messageId.length > 300) return null;
    const row = [
      ...this.ctx.storage.sql.exec<{
        emailId: string;
        folderId: string;
        threadId: string | null;
        sender: string | null;
        subject: string | null;
        date: string | null;
      }>(
        `SELECT id AS emailId, folder_id AS folderId, thread_id AS threadId,
			        sender, subject, date
			 FROM emails WHERE id = ? AND folder_id <> ? LIMIT 1`,
        messageId,
        InternalFolders.RETIRED_OUTBOUND,
      ),
    ][0];
    if (!row || !row.date || !Number.isFinite(Date.parse(row.date)))
      return null;
    return {
      emailId: row.emailId,
      folderId: row.folderId,
      conversationId: row.threadId ?? row.emailId,
      sender: (row.sender ?? "").slice(0, 320),
      subject: (row.subject ?? "").slice(0, 998),
      date: new Date(row.date).toISOString(),
    };
  }

  #automationRunView(run: AutomationRunRecord, includeResults = false) {
    return {
      ...run,
      message: this.#automationMessageView(run.triggerMessageId),
      results: includeResults
        ? this.#automationRules().listRunResults(run.id)
        : undefined,
    };
  }

  async listAutomationRuns(input: {
    state: string | null;
    beforeCreatedAt: string | null;
    beforeId: string | null;
    limit: number;
  }) {
    const beforeTime =
      input.beforeCreatedAt === null ? null : Date.parse(input.beforeCreatedAt);
    if (
      (input.state !== null &&
        !AUTOMATION_RUN_STATES.includes(
          input.state as (typeof AUTOMATION_RUN_STATES)[number],
        )) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (input.beforeCreatedAt === null) !== (input.beforeId === null) ||
      (input.beforeCreatedAt !== null &&
        (!Number.isFinite(beforeTime) ||
          new Date(beforeTime!).toISOString() !== input.beforeCreatedAt)) ||
      (input.beforeId !== null &&
        (!input.beforeId || input.beforeId.length > 300))
    )
      throw new AutomationRuleError(
        "INVALID",
        "Automation Run query is invalid",
      );
    const rows = [
      ...this.ctx.storage.sql.exec<AutomationRunRecord>(
        `SELECT id, trigger_message_id AS triggerMessageId,
			        ruleset_generation AS rulesetGeneration, state,
			        attempt_count AS attemptCount, started_at AS startedAt,
			        completed_at AS completedAt, evaluated_count AS evaluatedCount,
			        matched_count AS matchedCount, applied_count AS appliedCount,
			        stopped_by_rule_id AS stoppedByRuleId,
			        failure_category AS failureCategory,
			        created_at AS createdAt, updated_at AS updatedAt
			 FROM automation_runs
			 WHERE (? IS NULL OR state = ?)
			   AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
			 ORDER BY created_at DESC, id DESC LIMIT ?`,
        input.state,
        input.state,
        input.beforeCreatedAt,
        input.beforeCreatedAt,
        input.beforeCreatedAt,
        input.beforeId,
        input.limit + 1,
      ),
    ];
    const page = rows.slice(0, input.limit);
    const last = rows.length > input.limit ? (page.at(-1) ?? null) : null;
    return {
      runs: page.map((run) => this.#automationRunView(run)),
      next: last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  async getAutomationRun(runId: string) {
    try {
      return this.#automationRunView(
        this.#automationRules().getRun(runId),
        true,
      );
    } catch (error) {
      if (error instanceof AutomationRuleError && error.code === "NOT_FOUND")
        return null;
      throw error;
    }
  }

  #automationTestView<T extends AutomationDryRunRecord>(test: T) {
    return {
      ...test,
      result: {
        ...test.result,
        samples: test.result.samples.map((sample) => ({
          ...sample,
          location: this.#automationMessageView(sample.messageId),
        })),
      },
    };
  }

  async listAutomationRuleTests(input: {
    ruleId: string | null;
    beforeCreatedAt: string | null;
    beforeId: string | null;
    limit: number;
  }) {
    const beforeTime =
      input.beforeCreatedAt === null ? null : Date.parse(input.beforeCreatedAt);
    if (
      (input.ruleId !== null && (!input.ruleId || input.ruleId.length > 300)) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      (input.beforeCreatedAt === null) !== (input.beforeId === null) ||
      (input.beforeCreatedAt !== null &&
        (!Number.isFinite(beforeTime) ||
          new Date(beforeTime!).toISOString() !== input.beforeCreatedAt)) ||
      (input.beforeId !== null &&
        (!input.beforeId || input.beforeId.length > 300))
    )
      throw new AutomationRuleError(
        "INVALID",
        "Automation Rule test query is invalid",
      );
    const rows = [
      ...this.ctx.storage.sql.exec<{
        id: string;
        createdAt: string;
      }>(
        `SELECT id, created_at AS createdAt FROM automation_rule_tests
			 WHERE (? IS NULL OR rule_id = ?)
			   AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
			 ORDER BY created_at DESC, id DESC LIMIT ?`,
        input.ruleId,
        input.ruleId,
        input.beforeCreatedAt,
        input.beforeCreatedAt,
        input.beforeCreatedAt,
        input.beforeId,
        input.limit + 1,
      ),
    ];
    const page = rows.slice(0, input.limit);
    const automation = this.#automationRules();
    const tests = page.map((row) => automation.getTest(row.id));
    const last = rows.length > input.limit ? (page.at(-1) ?? null) : null;
    return {
      tests: tests.map((test) => this.#automationTestView(test)),
      next: last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  // ── Push subscriptions (WISER-240) ─────────────────────────────
  // Per-device capabilities for this mailbox. Live inbound writes snapshot their
  // opaque IDs into the durable outbox; alarm dispatch rechecks actor access and
  // the current capability generation before using any endpoint or key material.

  async upsertPushSubscription(input: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string | null;
    deviceLabel: string;
  }): Promise<{ id: string; deviceLabel: string; generation: number }> {
    // Re-subscribing the same device yields the same endpoint, but every
    // accepted rebind advances its capability generation so an older in-flight
    // provider response can never act on the rebound record. Health is retained
    // only when the actor and key material are unchanged.
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, device_label)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(endpoint) DO UPDATE SET
				   user_id = excluded.user_id,
				   p256dh = excluded.p256dh,
				   auth = excluded.auth,
				   generation = push_subscriptions.generation + 1,
				   last_push_attempt_at = CASE WHEN
				     push_subscriptions.user_id IS NOT excluded.user_id OR
				     push_subscriptions.p256dh <> excluded.p256dh OR
				     push_subscriptions.auth <> excluded.auth
				   THEN NULL ELSE push_subscriptions.last_push_attempt_at END,
				   last_push_accepted_at = CASE WHEN
				     push_subscriptions.user_id IS NOT excluded.user_id OR
				     push_subscriptions.p256dh <> excluded.p256dh OR
				     push_subscriptions.auth <> excluded.auth
				   THEN NULL ELSE push_subscriptions.last_push_accepted_at END,
				   last_push_failure_at = CASE WHEN
				     push_subscriptions.user_id IS NOT excluded.user_id OR
				     push_subscriptions.p256dh <> excluded.p256dh OR
				     push_subscriptions.auth <> excluded.auth
				   THEN NULL ELSE push_subscriptions.last_push_failure_at END,
				   last_push_failure_reason = CASE WHEN
				     push_subscriptions.user_id IS NOT excluded.user_id OR
				     push_subscriptions.p256dh <> excluded.p256dh OR
				     push_subscriptions.auth <> excluded.auth
				   THEN NULL ELSE push_subscriptions.last_push_failure_reason END,
				   consecutive_push_failures = CASE WHEN
				     push_subscriptions.user_id IS NOT excluded.user_id OR
				     push_subscriptions.p256dh <> excluded.p256dh OR
				     push_subscriptions.auth <> excluded.auth
				   THEN 0 ELSE push_subscriptions.consecutive_push_failures END,
				   last_seen_at = datetime('now')`,
      id,
      input.userId,
      input.endpoint,
      input.p256dh,
      input.auth,
      input.userAgent,
      input.deviceLabel,
    );
    const [row] = this.ctx.storage.sql.exec<{
      id: string;
      device_label: string;
      generation: number;
    }>(
      `SELECT id, device_label, generation FROM push_subscriptions WHERE endpoint = ?`,
      input.endpoint,
    );
    if (!row) throw new Error("Push subscription was not stored");
    await this.ensurePushAlarm();
    return {
      id: row.id,
      deviceLabel: row.device_label,
      generation: row.generation,
    };
  }

  async deletePushSubscription(
    id: string,
    userId: string,
    expectedGeneration?: number,
  ): Promise<boolean> {
    const generationClause =
      expectedGeneration === undefined ? "" : " AND generation = ?";
    const bindings =
      expectedGeneration === undefined
        ? [id, userId]
        : [id, userId, expectedGeneration];
    const existing = [
      ...this.ctx.storage.sql.exec(
        `SELECT id FROM push_subscriptions WHERE id = ? AND user_id = ?${generationClause}`,
        ...bindings,
      ),
    ];
    if (existing.length === 0) return false;
    this.ctx.storage.sql.exec(
      `DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?${generationClause}`,
      ...bindings,
    );
    return true;
  }

  async removePushSubscriptionsForUser(userId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `DELETE FROM push_subscriptions WHERE user_id = ?`,
      userId,
    );
  }

  async ensurePushAlarm(): Promise<void> {
    const row = [
      ...this.ctx.storage.sql.exec<{ due_at: string | null }>(
        `SELECT MIN(due_at) AS due_at FROM (
			 SELECT next_attempt_at AS due_at FROM automation_runs
			 WHERE state = 'pending' AND next_attempt_at IS NOT NULL
			 UNION ALL
			 SELECT lease_expires_at AS due_at FROM automation_runs
			 WHERE state = 'processing' AND lease_expires_at IS NOT NULL
			 UNION ALL
			 SELECT next_attempt_at AS due_at FROM push_notification_deliveries
			 WHERE status IN ('pending', 'retrying')
			 UNION ALL
			 SELECT lease_expires_at AS due_at FROM push_notification_deliveries
			 WHERE status = 'sending' AND lease_expires_at IS NOT NULL
			 UNION ALL
			 SELECT strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(completed_at, created_at), '+7 days') AS due_at
			 FROM push_notifications
			 WHERE state IN ('completed', 'no_targets', 'expired')
			)`,
      ),
    ][0];
    if (row?.due_at) await this.#scheduleAlarmAt(Date.parse(row.due_at));
  }

  async getPushHealth(userId: string) {
    await this.ensurePushAlarm();
    return readPushHealth(this.ctx.storage.sql, {
      userId,
      configured: vapidConfig(this.env) !== null,
      now: new Date().toISOString(),
    });
  }
}
