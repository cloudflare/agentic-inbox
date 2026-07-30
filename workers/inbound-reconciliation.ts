// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
  INBOUND_RECEIPT_SCHEMA_VERSION,
  projectInboundArchivePointer,
  type InboundArchivePointer,
} from "./inbound-email.ts";
import { isSha256Hex } from "./lib/checksum.ts";
import { inboundRawArchiveMatchesPointer } from "./lib/inbound-raw-integrity.ts";
import {
  INBOUND_DERIVED_CONTENT_ANOMALY_SCHEMA_VERSION,
  inboundDerivedContentAnomalyKey,
} from "./lib/inbound-derived-content-anomaly.ts";
import {
  projectInboundDerivedContentManifest,
  type InboundDerivedContentManifest,
  type InboundDerivedContentRepairAttemptIdentity,
  type InboundDerivedContentRepairAttemptTerminal,
} from "./lib/inbound-projection-contract.ts";
import { reconcilePendingInboundRepairAttempts } from "./lib/inbound-derived-content-repair-attempt.ts";
import { reconcileInboundCleanupIntents } from "./lib/inbound-derived-content-cleanup-intent.ts";
import type { InboundDerivedContentCleanupInput } from "./lib/inbound-derived-content-cleanup.ts";
import {
  isAddressInConfiguredMailDomains,
  normalizeMailAddress,
} from "./lib/mail-address.ts";
import { mailTelemetryLogRef } from "./lib/mail-telemetry.ts";
import { safeErrorCode } from "./lib/safe-error-code.ts";
import {
  INBOUND_ACTIVE_RECONCILIATION_BATCH_SIZE,
  INBOUND_RECENT_RAW_MAX_PREFIX_LIST_CALLS,
  INBOUND_RECENT_RAW_RECONCILIATION_BATCH_SIZE,
  INBOUND_RAW_BACKSTOP_RECONCILIATION_BATCH_SIZE,
} from "./lib/inbound-reconciliation-budget.ts";
import {
  INBOUND_ACTIVE_INDEX_CURSOR_KEY,
  INBOUND_ACTIVE_INDEX_PREFIX,
  inboundActiveMarkerKey,
  persistInboundActiveMarkerForRawKey,
  rawKeyFromInboundActiveMarkerKey,
} from "./lib/inbound-active-index.ts";
import {
  inboundIngressIdFromRawKey,
  inboundRawMinutePrefix,
  isInboundRawKeyForIngress,
} from "./lib/inbound-raw-key.ts";
import {
  inboundReconciliationAnomalyKey,
  isStoredPendingReconciliationAnomaly,
  type PendingReconciliationAnomaly,
  type StoredPendingReconciliationAnomaly,
} from "./lib/inbound-reconciliation-anomaly.ts";
import { MAX_EMAIL_SIZE } from "./lib/store-email.ts";
import {
  beginEmergencyForward,
  isEmergencyForwardPointer,
  type EmergencyForwardEnvelope,
} from "./lib/emergency-forward.ts";
import { hasExactInboundSmtpRejectionAuthority } from "./lib/inbound-smtp-rejection.ts";
import { inboundTerminalAuthorityRequirement } from "./lib/inbound-terminal-authority.ts";

const RAW_PREFIX = "raw/";
const SWEEP_CURSOR_KEY = "system/reconciliation-cursor.json";
const RECENT_SWEEP_CURSOR_KEY = "system/inbound-recent-cursor.json";
const RECENT_BACKSTOP_SWEEP_CURSOR_KEY =
  "system/inbound-recent-backstop-cursor.json";
const FAILURE_LEDGER_PREFIX = "system/reconciliation-failures/";
const STALE_HANDOFF_MS = 15 * 60 * 1000;
// Cloudflare documents at most 15 minutes for Cron Trigger propagation. The
// deployed trigger runs every five minutes, so this one-hour first-run window
// covers that contract in one sweep with forty minutes of operational margin.
// https://developers.cloudflare.com/workers/configuration/cron-triggers/
const RECENT_SWEEP_INITIAL_LOOKBACK_MINUTES = 60;
// The priority cursor above removes calendar-delay latency. This independent
// fixed floor guarantees eventual discovery if marker writes stay unavailable
// long enough for an archive to age out of the priority window.
const RECENT_BACKSTOP_INTRODUCTION_MINUTE_MS = Date.parse(
  "2026-07-16T00:00:00.000Z",
);
const MAX_DERIVED_OBJECTS_PER_PROJECTION = 512;
const DERIVED_HEAD_CONCURRENCY = 16;

async function bestEffortMailTelemetryLogRef(
  kind: "ingress" | "object",
  value: string,
): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      mailTelemetryLogRef(kind, value),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve("unavailable"), 25);
      }),
    ]);
  } catch {
    return "unavailable";
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

type ArchiveMetadata = {
  key: string;
  size: number;
  etag: string;
  version: string;
  customMetadata?: Record<string, string>;
  checksums?: { sha256?: ArrayBuffer };
};

type ReceiptObject = {
  etag?: string;
  key?: string;
  version?: string;
  size?: number;
  body?: ReadableStream;
  customMetadata?: Record<string, string>;
  checksums?: { sha256?: ArrayBuffer };
  text(): Promise<string>;
};

type ReconciliationBucket = {
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  head(key: string): Promise<ArchiveMetadata | null>;
  get(key: string): Promise<ReceiptObject | null>;
  put(
    key: string,
    value: string,
    options?: {
      customMetadata?: Record<string, string>;
      httpMetadata?: { contentType?: string };
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    },
  ): Promise<{ etag?: string } | null>;
  delete(key: string): Promise<unknown>;
};

type ReconciliationEnvironment = {
  DOMAINS: string;
  EMAIL_ADDRESSES?: string[];
  DB: Pick<D1Database, "prepare">;
  BUCKET: Pick<R2Bucket, "head" | "list">;
  RAW_MAIL_BUCKET: ReconciliationBucket;
  INBOUND_QUEUE: Pick<Queue<InboundArchivePointer>, "send">;
  EMERGENCY_FORWARD_QUEUE: Pick<Queue<EmergencyForwardEnvelope>, "send">;
  MAILBOX: {
    idFromName(mailboxId: string): unknown;
    get(id: unknown): {
      getEmail(ingressId: string): Promise<unknown | null>;
      hasEmail?(ingressId: string): Promise<boolean>;
      isEmailDeleted?(ingressId: string): Promise<boolean>;
      getInboundDeletionAuthority?(
        authority: InboundArchivePointer & { rawSha256: string },
      ): Promise<{ generation: number; deletedAt: string } | null>;
      getInboundTerminalFailure?(ingressId: string): Promise<{
        queueRef: string;
        attempts: number;
        errorCode: "QUEUE_RETRY_EXHAUSTED";
        recordedAt: string;
      } | null>;
      getInboundDerivedContentManifest?(
        ingressId: string,
      ): Promise<unknown>;
      finalizeInboundDerivedContentRepairAttempt?(
        identity: InboundDerivedContentRepairAttemptIdentity,
      ): Promise<InboundDerivedContentRepairAttemptTerminal>;
      enqueueUnownedInboundDerivedContentCleanup?(
        input: InboundDerivedContentCleanupInput,
      ): Promise<{ queued: number; retained: number; absent: number }>;
    };
  };
};

type ReconciliationRuntime = {
  now(): Date;
  infrastructureTimeoutMs?: number;
  bestEffortTimeoutMs?: number;
};

const RECEIPT_STATES = [
  "admitted",
  "archived",
  "dead_letter_pending",
  "dead_lettered",
  "deleted",
  "enqueued",
  "forward_pending",
  "forwarded",
  "quarantined",
  "rejected",
  "retrying",
  "stored",
] as const;

type ReceiptState = (typeof RECEIPT_STATES)[number];

type Receipt = {
  etag: string;
  state: ReceiptState;
  updatedAt: string;
  errorCode?: string;
  rejectionOrigin?: "smtp_ingress";
};

type ReceiptReadResult =
  | { status: "absent" }
  | { status: "invalid_present" }
  | { status: "valid"; receipt: Receipt };

type InboundTerminalFailure = {
  queueRef: string;
  attempts: number;
  errorCode: "QUEUE_RETRY_EXHAUSTED";
  recordedAt: string;
};

type ReconciliationAnomalyResolution =
  | "admission_rejected"
  | "mailbox_projection_deleted"
  | "mailbox_projection_stored"
  | "terminal_failure_ledger_recovered"
  | "terminal_receipt_persisted";

type ArchivedAdmissionErrorCode =
  | "RECIPIENT_NOT_ALLOWED"
  | "MAILBOX_UNAVAILABLE"
  | "MAILBOX_INACTIVE"
  | "RAW_SIZE_INVALID";

type MissingReceiptReconstruction =
  | {
      state: "deleted";
      errorCode: "MAILBOX_PROJECTION_DELETED";
      resolution: "mailbox_projection_deleted";
    }
  | {
      state: "stored";
      errorCode: "MAILBOX_PROJECTION_RECOVERED";
      resolution: "mailbox_projection_stored";
    }
  | {
      state: "dead_lettered";
      errorCode: "DLQ_TERMINAL_LEDGER_RECOVERED";
      resolution: "terminal_failure_ledger_recovered";
      terminalFailure: InboundTerminalFailure;
    };

type ReconciliationSubSweepStatus = "succeeded" | "degraded";
type ReconciliationSweepStatus = "succeeded" | "partial" | "failed";

export type ReconciliationResult = {
  scanned: number;
  reenqueued: number;
  skipped: number;
  invalid: number;
  failed: number;
  projectionMissing: number;
  pendingReview: number;
  terminalized: number;
  failureLedgered: number;
};

const defaultRuntime: ReconciliationRuntime = {
  now: () => new Date(),
};

function boundedInfrastructureWork<T>(
  work: Promise<T>,
  runtime: ReconciliationRuntime,
  label: string,
): Promise<T> {
  const timeoutMs = runtime.infrastructureTimeoutMs ?? 5_000;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

async function settleBestEffort(
  work: Promise<unknown>,
  runtime: ReconciliationRuntime,
): Promise<void> {
  const timeoutMs = runtime.bestEffortTimeoutMs ?? 100;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // Delivery authority is already durable. Diagnostics must never gate it.
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function durationMs(runtime: ReconciliationRuntime, startedAt: number): number {
  return Math.max(0, runtime.now().getTime() - startedAt);
}

async function hasExactInboundDeletionAuthority(
  mailbox: ReturnType<ReconciliationEnvironment["MAILBOX"]["get"]>,
  pointer: InboundArchivePointer,
  runtime: ReconciliationRuntime,
  label: string,
): Promise<boolean> {
  if (pointer.rawSha256 === undefined || !mailbox.getInboundDeletionAuthority) {
    return false;
  }
  const value = await boundedInfrastructureWork(
    mailbox.getInboundDeletionAuthority({
      ...projectInboundArchivePointer(pointer),
      rawSha256: pointer.rawSha256,
    }),
    runtime,
    label,
  );
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join("\0") ===
        ["deletedAt", "generation"].sort().join("\0") &&
      Number.isSafeInteger(value.generation) &&
      value.generation >= 2 &&
      isIsoTimestamp(value.deletedAt),
  );
}

// The single delivery truth every recovery path shares with the emergency
// consumer (finalMailboxTruth in lib/emergency-forward.ts): a live mailbox row
// for the ingress id means the recipient already holds the mail. Demanding an
// exact archive-authority match on top of it made drifted-but-delivered mail
// look undelivered, so reconciliation kept resurrecting forwards the consumer
// had just suppressed.
async function hasLiveInboundProjection(
  mailbox: ReturnType<ReconciliationEnvironment["MAILBOX"]["get"]>,
  ingressId: string,
  runtime: ReconciliationRuntime,
  label: string,
): Promise<boolean> {
  return mailbox.hasEmail
    ? await boundedInfrastructureWork(
        mailbox.hasEmail(ingressId),
        runtime,
        label,
      )
    : Boolean(
        await boundedInfrastructureWork(
          mailbox.getEmail(ingressId),
          runtime,
          label,
        ),
      );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function receiptPointerMatches(
  value: Record<string, unknown>,
  pointer: InboundArchivePointer,
): boolean {
  return (
    value.schemaVersion === pointer.schemaVersion &&
    value.ingressId === pointer.ingressId &&
    value.rawKey === pointer.rawKey &&
    value.mailboxId === pointer.mailboxId &&
    value.rawSize === pointer.rawSize &&
    value.rawSha256 === pointer.rawSha256 &&
    value.archivedAt === pointer.archivedAt &&
    value.etag === pointer.etag &&
    value.version === pointer.version
  );
}

const RECEIPT_POINTER_FIELDS = [
  "schemaVersion",
  "ingressId",
  "rawKey",
  "mailboxId",
  "rawSize",
  "rawSha256",
  "archivedAt",
  "etag",
  "version",
] as const;

const RETRY_RECEIPT_ERROR_CODES = new Set([
  "IDEMPOTENCY_CHECK_FAILED",
  "MAILBOX_ACTIVE_CHECK_FAILED",
  "MAILBOX_ACTIVE_RECHECK_FAILED",
  "MAILBOX_MARKER_READ_FAILED",
  "MAILBOX_PROJECTION_FAILED",
  "RAW_ARCHIVE_READ_FAILED",
]);

const QUARANTINED_RECEIPT_ERROR_CODES = new Set([
  "EMAXLEN",
  "INGRESS_RECOVERY_REQUIRED",
  "MAILBOX_UNAVAILABLE",
  "MIME_CHARSET_UNSUPPORTED",
  "MIME_HEADER_SIZE_EXCEEDED",
  "MIME_MULTIPART_BOUNDARY_INVALID",
  "MIME_MULTIPART_BOUNDARY_MISSING",
  "MIME_PARSE_FAILED",
  "MIME_ROOT_HEADER_MISSING",
  "RAW_ARCHIVE_INTEGRITY_MISMATCH",
]);

function hasOnlyReceiptFields(
  value: Record<string, unknown>,
  stateFields: readonly string[] = [],
): boolean {
  const allowed = new Set([
    ...RECEIPT_POINTER_FIELDS,
    "state",
    "updatedAt",
    ...stateFields,
  ]);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isReceiptState(value: unknown): value is ReceiptState {
  return (
    typeof value === "string" &&
    RECEIPT_STATES.some((state) => state === value)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function receiptStateDetailsAreValid(
  value: Record<string, unknown>,
  state: ReceiptState,
): boolean {
  switch (state) {
    case "archived":
      return hasOnlyReceiptFields(value);
    case "admitted":
    case "enqueued":
      return (
        hasOnlyReceiptFields(value, ["reconciled"]) &&
        (value.reconciled === undefined || value.reconciled === true)
      );
    case "stored":
      if (!hasOnlyReceiptFields(value, ["errorCode", "reconciled"])) {
        return false;
      }
      if (value.reconciled === true) {
        return value.errorCode === "MAILBOX_PROJECTION_RECOVERED";
      }
      return (
        value.reconciled === undefined &&
        (value.errorCode === undefined ||
          value.errorCode === "MAILBOX_PROJECTION_STORED")
      );
    case "deleted":
      return (
        hasOnlyReceiptFields(value, ["errorCode", "reconciled"]) &&
        value.errorCode === "MAILBOX_PROJECTION_DELETED" &&
        (value.reconciled === undefined || value.reconciled === true)
      );
    case "retrying":
    case "dead_letter_pending":
      return (
        hasOnlyReceiptFields(value, [
          "attempt",
          "delaySeconds",
          "errorCode",
        ]) &&
        isNonNegativeInteger(value.attempt) &&
        isNonNegativeInteger(value.delaySeconds) &&
        typeof value.errorCode === "string" &&
        RETRY_RECEIPT_ERROR_CODES.has(value.errorCode)
      );
    case "dead_lettered":
      if (
        !hasOnlyReceiptFields(value, [
          "attempt",
          "errorCode",
          "queueRef",
          "reconciled",
          "terminalFailure",
        ])
      ) {
        return false;
      }
      if (value.reconciled === true) {
        return (
          value.attempt === undefined &&
          value.queueRef === undefined &&
          value.errorCode === "DLQ_TERMINAL_LEDGER_RECOVERED" &&
          projectInboundTerminalFailure(value.terminalFailure) !== null
        );
      }
      if (
        value.reconciled !== undefined ||
        value.terminalFailure !== undefined ||
        value.errorCode !== "QUEUE_RETRY_EXHAUSTED"
      ) {
        return false;
      }
      if (value.attempt === undefined && value.queueRef === undefined) {
        return true;
      }
      return (
        isNonNegativeInteger(value.attempt) &&
        typeof value.queueRef === "string" &&
        /^[a-f0-9]{16}$/.test(value.queueRef)
      );
    case "forward_pending":
      return (
        hasOnlyReceiptFields(value, ["errorCode"]) &&
        typeof value.errorCode === "string" &&
        (value.errorCode === "QUEUE_RETRY_EXHAUSTED" ||
          QUARANTINED_RECEIPT_ERROR_CODES.has(value.errorCode)) &&
        value.errorCode !== "RAW_ARCHIVE_INTEGRITY_MISMATCH"
      );
    case "forwarded":
      return (
        hasOnlyReceiptFields(value, ["providerAccepted", "providerRef"]) &&
        value.providerAccepted === true &&
        (value.providerRef === undefined ||
          (typeof value.providerRef === "string" &&
            /^[a-f0-9]{16}$/.test(value.providerRef)))
      );
    case "quarantined":
      return (
        hasOnlyReceiptFields(value, ["errorCode"]) &&
        typeof value.errorCode === "string" &&
        QUARANTINED_RECEIPT_ERROR_CODES.has(value.errorCode)
      );
    case "rejected":
      return (
        hasOnlyReceiptFields(value, ["errorCode", "rejectionOrigin"]) &&
        hasExactInboundSmtpRejectionAuthority(value)
      );
  }
}

function projectInboundTerminalFailure(
  value: unknown,
): InboundTerminalFailure | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.queueRef !== "string" ||
    !/^[a-f0-9]{16}$/.test(value.queueRef) ||
    !Number.isSafeInteger(value.attempts) ||
    (value.attempts as number) < 0 ||
    value.errorCode !== "QUEUE_RETRY_EXHAUSTED" ||
    typeof value.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(value.recordedAt)) ||
    new Date(value.recordedAt).toISOString() !== value.recordedAt
  ) {
    return null;
  }
  return {
    queueRef: value.queueRef,
    attempts: value.attempts as number,
    errorCode: value.errorCode,
    recordedAt: value.recordedAt,
  };
}

function failureLedgerKey(rawKey: string): string {
  return `${FAILURE_LEDGER_PREFIX}${encodeURIComponent(rawKey)}.json`;
}

async function persistAnomaly(
  bucket: ReconciliationBucket,
  rawKey: string,
  anomaly: PendingReconciliationAnomaly,
  runtime: ReconciliationRuntime,
): Promise<void> {
  await settleBestEffort((async () => {
    const record: StoredPendingReconciliationAnomaly = {
    detectedAt: runtime.now().toISOString(),
    errorCode: anomaly.errorCode,
    ...(anomaly.errorCode === "RAW_ARCHIVE_METADATA_INVALID"
      ? {}
      : { ingressId: anomaly.ingressId, mailboxId: anomaly.mailboxId }),
    rawKey,
    status: "pending_operator_review",
  };
    const key = inboundReconciliationAnomalyKey(rawKey);
    const written = await bucket.put(
    key,
    JSON.stringify(record),
    {
      customMetadata: {
        errorCode: anomaly.errorCode,
        status: "pending_operator_review",
      },
      onlyIf: { etagDoesNotMatch: "*" },
    },
  );
    if (written) return;

    const existing = await bucket.get(key);
    if (!existing) return;
    let existingValue: unknown;
    try {
      existingValue = JSON.parse(await existing.text());
    } catch {
      return;
    }
    if (
      !isStoredPendingReconciliationAnomaly(existingValue) ||
      existingValue.errorCode !== record.errorCode ||
      existingValue.ingressId !== record.ingressId ||
      existingValue.mailboxId !== record.mailboxId ||
      existingValue.rawKey !== record.rawKey
    ) {
      return;
    }
  })(), runtime);
}

async function persistReceiptStateUnknown(
  bucket: ReconciliationBucket,
  pointer: InboundArchivePointer,
  runtime: ReconciliationRuntime,
): Promise<void> {
  await persistAnomaly(
    bucket,
    pointer.rawKey,
    {
      errorCode: "RECEIPT_STATE_UNKNOWN",
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
    },
    runtime,
  );
  const [ingressRef, objectRef] = await Promise.all([
    bestEffortMailTelemetryLogRef("ingress", pointer.ingressId),
    bestEffortMailTelemetryLogRef("object", pointer.rawKey),
  ]);
  console.error("[mail-reconciliation] receipt state unknown", {
    errorCode: "RECEIPT_STATE_UNKNOWN",
    ingressRef,
    objectRef,
    operation: "archive_reconcile",
    status: "pending_operator_review",
  });
}

async function resolveAnomaly(
  bucket: ReconciliationBucket,
  rawKey: string,
  resolution: ReconciliationAnomalyResolution,
  runtime: ReconciliationRuntime,
): Promise<void> {
  await settleBestEffort((async () => {
    const key = inboundReconciliationAnomalyKey(rawKey);
    const object = await bucket.get(key);
    if (!object) return;
    let value: unknown;
    try {
      value = JSON.parse(await object.text());
    } catch {
      return;
    }
    if (
      !isStoredPendingReconciliationAnomaly(value) ||
      value.rawKey !== rawKey
    ) {
      return;
    }
    const resolved = await bucket.put(
    key,
    JSON.stringify({
      detectedAt: value.detectedAt,
      errorCode: value.errorCode,
      ...(value.ingressId === undefined
        ? {}
        : { ingressId: value.ingressId, mailboxId: value.mailboxId }),
      rawKey: value.rawKey,
      resolution,
      resolvedAt: runtime.now().toISOString(),
      status: "resolved",
    }),
    {
      customMetadata: {
        errorCode: value.errorCode,
        status: "resolved",
      },
      ...(object.etag ? { onlyIf: { etagMatches: object.etag } } : {}),
    },
  );
    if (!resolved) {
      const objectRef = await bestEffortMailTelemetryLogRef("object", rawKey);
      console.log("[mail-reconciliation] anomaly resolution superseded", {
        objectRef,
        operation: "reconciliation_anomaly_resolve",
        status: "superseded",
      });
    }
  })(), runtime);
}

function isStale(updatedAt: unknown, now: Date): boolean {
  if (typeof updatedAt !== "string") return true;
  const timestamp = Date.parse(updatedAt);
  return (
    !Number.isFinite(timestamp) || now.getTime() - timestamp >= STALE_HANDOFF_MS
  );
}

async function readSweepCursor(
  bucket: ReconciliationBucket,
  key: string,
): Promise<{ cursor?: string; etag?: string }> {
  const object = await bucket.get(key);
  if (!object) return {};
  try {
    const value: unknown = JSON.parse(await object.text());
    return {
      ...(isRecord(value) && typeof value.cursor === "string"
        ? { cursor: value.cursor }
        : {}),
      ...(object.etag ? { etag: object.etag } : {}),
    };
  } catch {
    return { ...(object.etag ? { etag: object.etag } : {}) };
  }
}

function pointerFromArchive(
  archive: ArchiveMetadata,
): InboundArchivePointer | null {
  const metadata = archive.customMetadata;
  if (!metadata) return null;
  const {
    archivedAt,
    ingressId,
    mailboxId,
    rawSize,
    rawSha256,
    schemaVersion,
  } = metadata;
  const parsedSize = Number(rawSize);
  if (
    schemaVersion !== String(INBOUND_RECEIPT_SCHEMA_VERSION) ||
    !ingressId ||
    !mailboxId ||
    !archivedAt ||
    !Number.isFinite(Date.parse(archivedAt)) ||
    !Number.isSafeInteger(parsedSize) ||
    parsedSize <= 0 ||
    parsedSize > MAX_EMAIL_SIZE ||
    parsedSize !== archive.size ||
    (rawSha256 !== undefined && !isSha256Hex(rawSha256)) ||
    !isInboundRawKeyForIngress(archive.key, ingressId) ||
    !archive.etag ||
    !archive.version
  ) {
    return null;
  }

  return {
    schemaVersion: INBOUND_RECEIPT_SCHEMA_VERSION,
    ingressId,
    rawKey: archive.key,
    mailboxId,
    rawSize: parsedSize,
    ...(rawSha256 ? { rawSha256 } : {}),
    archivedAt,
    etag: archive.etag,
    version: archive.version,
  };
}

async function readReceipt(
  bucket: ReconciliationBucket,
  pointer: InboundArchivePointer,
  runtime: ReconciliationRuntime,
): Promise<ReceiptReadResult> {
  let object: ReceiptObject | null;
  try {
    object = await boundedInfrastructureWork(
      bucket.get(`receipts/${pointer.ingressId}.json`),
      runtime,
      "exact inbound receipt read",
    );
  } catch {
    return { status: "invalid_present" };
  }
  if (!object) return { status: "absent" };
  if (typeof object.etag !== "string" || object.etag.trim().length === 0) {
    return { status: "invalid_present" };
  }
  try {
    const value: unknown = JSON.parse(await boundedInfrastructureWork(
      object.text(),
      runtime,
      "exact inbound receipt body read",
    ));
    if (
      !isRecord(value) ||
      !receiptPointerMatches(value, pointer) ||
      !isReceiptState(value.state) ||
      !isIsoTimestamp(value.updatedAt) ||
      !receiptStateDetailsAreValid(value, value.state)
    ) {
      return { status: "invalid_present" };
    }
    return {
      status: "valid",
      receipt: {
        etag: object.etag,
        state: value.state,
        updatedAt: value.updatedAt,
        ...(typeof value.errorCode === "string"
          ? { errorCode: value.errorCode }
          : {}),
        ...(value.rejectionOrigin === "smtp_ingress"
          ? { rejectionOrigin: "smtp_ingress" as const }
          : {}),
      },
    };
  } catch {
    return { status: "invalid_present" };
  }
}

async function establishEmergencyForward(
  env: Pick<
    ReconciliationEnvironment,
    "RAW_MAIL_BUCKET" | "EMERGENCY_FORWARD_QUEUE"
  >,
  pointer: InboundArchivePointer,
  reason: Parameters<typeof beginEmergencyForward>[2],
  runtime: ReconciliationRuntime,
  label: string,
): Promise<void> {
  await boundedInfrastructureWork(
    beginEmergencyForward(env, pointer, reason, runtime),
    runtime,
    label,
  );
}

async function preserveExactConcurrentReceiptWinner(
  env: ReconciliationEnvironment,
  pointer: InboundArchivePointer,
  expectedState: ReceiptState,
  runtime: ReconciliationRuntime,
): Promise<"skipped" | "pendingReview"> {
  const winner = await readReceipt(env.RAW_MAIL_BUCKET, pointer, runtime);
  if (winner.status === "valid" && winner.receipt.state === expectedState) {
    return "skipped";
  }
  await establishEmergencyForward(
    env,
    pointer,
    "QUEUE_RETRY_EXHAUSTED",
    runtime,
    "concurrent receipt winner emergency handoff",
  );
  await persistReceiptStateUnknown(env.RAW_MAIL_BUCKET, pointer, runtime);
  return "pendingReview";
}

function shouldEnqueue(receipt: Receipt | null, now: Date): boolean {
  if (!receipt) return false;
  if (
    receipt.state === "stored" ||
    receipt.state === "deleted" ||
    receipt.state === "quarantined" ||
    receipt.state === "rejected" ||
    receipt.state === "dead_lettered" ||
    receipt.state === "forward_pending" ||
    receipt.state === "forwarded"
  ) {
    return false;
  }
  if (receipt.state === "archived" || receipt.state === "admitted") return true;
  if (receipt.state === "dead_letter_pending") return false;
  if (receipt.state !== "enqueued" && receipt.state !== "retrying") {
    return false;
  }
  return isStale(receipt.updatedAt, now);
}

function isForwardEligibleTerminalReceipt(receipt: Receipt): boolean {
  return (
    receipt.state === "dead_lettered" ||
    (receipt.state === "quarantined" &&
      typeof receipt.errorCode === "string" &&
      receipt.errorCode !== "RAW_ARCHIVE_INTEGRITY_MISMATCH" &&
      QUARANTINED_RECEIPT_ERROR_CODES.has(receipt.errorCode))
  );
}

function emergencyReasonForReceipt(
  receipt: Receipt,
): Parameters<typeof beginEmergencyForward>[2] {
  if (
    receipt.errorCode === "EMAXLEN" ||
    receipt.errorCode === "MIME_CHARSET_UNSUPPORTED" ||
    receipt.errorCode === "MIME_HEADER_SIZE_EXCEEDED" ||
    receipt.errorCode === "MIME_MULTIPART_BOUNDARY_INVALID" ||
    receipt.errorCode === "MIME_MULTIPART_BOUNDARY_MISSING" ||
    receipt.errorCode === "MIME_PARSE_FAILED" ||
    receipt.errorCode === "MIME_ROOT_HEADER_MISSING"
  ) {
    return receipt.errorCode;
  }
  return "QUEUE_RETRY_EXHAUSTED";
}

async function archivedAdmission(
  env: ReconciliationEnvironment,
  pointer: InboundArchivePointer,
  archive: ArchiveMetadata,
  runtime: ReconciliationRuntime,
): Promise<
  { admitted: true } | { admitted: false; errorCode: ArchivedAdmissionErrorCode }
> {
  const declaredRawSize = archive.customMetadata?.declaredRawSize;
  if (declaredRawSize !== undefined) {
    const parsedDeclaredRawSize = Number(declaredRawSize);
    if (
      !Number.isSafeInteger(parsedDeclaredRawSize) ||
      parsedDeclaredRawSize <= 0 ||
      parsedDeclaredRawSize > MAX_EMAIL_SIZE ||
      parsedDeclaredRawSize !== pointer.rawSize
    ) {
      return { admitted: false, errorCode: "RAW_SIZE_INVALID" };
    }
  }
  const mailboxId = normalizeMailAddress(pointer.mailboxId);
  const allowed = (env.EMAIL_ADDRESSES ?? []).map((address) => address.toLowerCase());
  if (
    !mailboxId ||
    !isAddressInConfiguredMailDomains(mailboxId, env.DOMAINS) ||
    (allowed.length > 0 && !allowed.includes(mailboxId))
  ) {
    return { admitted: false, errorCode: "RECIPIENT_NOT_ALLOWED" };
  }
  if (!(await boundedInfrastructureWork(
    env.BUCKET.head(`mailboxes/${mailboxId}.json`),
    runtime,
    "archived admission mailbox marker read",
  ))) {
    return { admitted: false, errorCode: "MAILBOX_UNAVAILABLE" };
  }
  const active = await boundedInfrastructureWork(
    env.DB.prepare(
      "SELECT id FROM mailboxes WHERE id = ?1 AND is_active = 1 LIMIT 1",
    )
      .bind(mailboxId)
      .first<{ id: string }>(),
    runtime,
    "archived admission active mailbox read",
  );
  return active
    ? { admitted: true }
    : { admitted: false, errorCode: "MAILBOX_INACTIVE" };
}

async function reconstructMissingReceipt(
  env: ReconciliationEnvironment,
  pointer: InboundArchivePointer,
  reconstruction: MissingReceiptReconstruction,
  updatedAt: string,
  runtime: ReconciliationRuntime,
): Promise<"terminalized" | "skipped" | "pendingReview"> {
  const receipt = await boundedInfrastructureWork(
    env.RAW_MAIL_BUCKET.put(
      `receipts/${pointer.ingressId}.json`,
      JSON.stringify({
        ...projectInboundArchivePointer(pointer),
        state: reconstruction.state,
        updatedAt,
        reconciled: true,
        errorCode: reconstruction.errorCode,
        ...(reconstruction.state === "dead_lettered"
          ? { terminalFailure: reconstruction.terminalFailure }
          : {}),
      }),
      {
        customMetadata: { state: reconstruction.state },
        onlyIf: { etagDoesNotMatch: "*" },
      },
    ),
    runtime,
    "missing receipt terminal reconstruction",
  );
  const [ingressRef, objectRef] = await Promise.all([
    bestEffortMailTelemetryLogRef("ingress", pointer.ingressId),
    bestEffortMailTelemetryLogRef("object", pointer.rawKey),
  ]);
  if (!receipt) {
    const winner = await readReceipt(env.RAW_MAIL_BUCKET, pointer, runtime);
    // Mailbox truth is authoritative for reconstruction. A concurrent receipt
    // winner is compatible only when it records that exact terminal state.
    if (
      winner.status !== "valid" ||
      winner.receipt.state !== reconstruction.state
    ) {
      await establishEmergencyForward(
        env,
        pointer,
        "QUEUE_RETRY_EXHAUSTED",
        runtime,
        "missing receipt CAS-loss emergency handoff",
      );
      await persistReceiptStateUnknown(env.RAW_MAIL_BUCKET, pointer, runtime);
      return "pendingReview";
    }
    console.log("[mail-reconciliation] missing receipt reconstruction superseded", {
      ingressRef,
      objectRef,
      operation: "missing_receipt_reconstruct",
      status: "superseded",
    });
    return "skipped";
  }
  await resolveAnomaly(
    env.RAW_MAIL_BUCKET,
    pointer.rawKey,
    reconstruction.resolution,
    runtime,
  );
  console.log("[mail-reconciliation] missing receipt reconstructed", {
    ingressRef,
    objectRef,
    operation: "missing_receipt_reconstruct",
    state:
      reconstruction.state === "deleted"
        ? "deleted"
        : reconstruction.state === "stored"
          ? "stored"
          : "dead_lettered",
    status: "terminalized",
  });
  return "terminalized";
}

async function inspectStoredDerivedContent(
  env: ReconciliationEnvironment,
  pointer: InboundArchivePointer,
  mailbox: ReturnType<ReconciliationEnvironment["MAILBOX"]["get"]>,
  runtime: ReconciliationRuntime,
): Promise<boolean> {
  if (!mailbox.getInboundDerivedContentManifest) return false;
  const manifestValue = await boundedInfrastructureWork(
    mailbox.getInboundDerivedContentManifest(pointer.ingressId),
    runtime,
    "stored projection derived-content manifest read",
  );
  const manifest = projectInboundDerivedContentManifest(
    manifestValue,
    pointer.ingressId,
  );
  if (!manifest) {
    throw new Error("Mailbox derived-content manifest is invalid");
  }
  if (manifest.status !== "live_inbound") return false;
  const objects = [
    ...manifest.attachments.map((attachment) => ({
      objectType: "attachment" as const,
      objectId: attachment.id,
      r2Key: attachment.r2Key,
      expectedBytes: attachment.byteLength,
    })),
    ...manifest.bodyObjects.map((bodyObject) => ({
      objectType: "body" as const,
      objectId: bodyObject.id,
      r2Key: bodyObject.r2Key,
      expectedBytes: bodyObject.byteLength,
    })),
  ];
  if (objects.length > MAX_DERIVED_OBJECTS_PER_PROJECTION) {
    throw new Error("Inbound derived-content manifest exceeds the bounded scan limit");
  }
  const failures: Array<{
    objectType: "attachment" | "body";
    objectId: string;
    expectedBytes: number;
    actualBytes: number | null;
    reason: "missing" | "size_mismatch";
  }> = [];
  for (let offset = 0; offset < objects.length; offset += DERIVED_HEAD_CONCURRENCY) {
    const batch = objects.slice(offset, offset + DERIVED_HEAD_CONCURRENCY);
    const heads = await boundedInfrastructureWork(
      Promise.all(batch.map((object) => env.BUCKET.head(object.r2Key))),
      runtime,
      "stored projection derived-content object reads",
    );
    for (const [index, object] of batch.entries()) {
      const head = heads[index];
      if (!head) {
        failures.push({
          objectType: object.objectType,
          objectId: object.objectId,
          expectedBytes: object.expectedBytes,
          actualBytes: null,
          reason: "missing",
        });
      } else if (head.size !== object.expectedBytes) {
        failures.push({
          objectType: object.objectType,
          objectId: object.objectId,
          expectedBytes: object.expectedBytes,
          actualBytes: head.size,
          reason: "size_mismatch",
        });
      }
    }
  }
  if (failures.length === 0) return false;
  const markerId = crypto.randomUUID();
  const detectedAt = runtime.now().toISOString();
  const marker = await boundedInfrastructureWork(
    env.RAW_MAIL_BUCKET.put(
      inboundDerivedContentAnomalyKey(pointer.ingressId, manifest.generation),
      JSON.stringify({
        schemaVersion: INBOUND_DERIVED_CONTENT_ANOMALY_SCHEMA_VERSION,
        kind: "inbound_derived_content_anomaly",
        status: "pending",
        markerId,
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        generation: manifest.generation,
        detectedAt,
        failures,
      }),
      {
        customMetadata: {
          generation: String(manifest.generation),
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
          status: "pending",
        },
        onlyIf: { etagDoesNotMatch: "*" },
      },
    ),
    runtime,
    "derived-content anomaly marker write",
  );
  const ingressRef = await bestEffortMailTelemetryLogRef(
    "ingress",
    pointer.ingressId,
  );
  console.error("[mail-reconciliation] derived content anomaly detected", {
    anomalyCount: failures.length,
    errorCode: "INBOUND_DERIVED_CONTENT_ANOMALY",
    generation: manifest.generation,
    ingressRef,
    operation: "derived_content_integrity_scan",
    status: marker ? "pending" : "already_pending",
  });
  return true;
}

async function reconcileArchive(
  rawKey: string,
  env: ReconciliationEnvironment,
  runtime: ReconciliationRuntime,
): Promise<
  | "reenqueued"
  | "skipped"
  | "invalid"
  | "projectionMissing"
  | "pendingReview"
  | "terminalized"
> {
  const startedAt = runtime.now().getTime();
  const objectRef = await bestEffortMailTelemetryLogRef("object", rawKey);
  const archive = await boundedInfrastructureWork(
    env.RAW_MAIL_BUCKET.head(rawKey),
    runtime,
    "raw archive authority read",
  );
  const pointer = archive ? pointerFromArchive(archive) : null;
  if (!archive || !pointer) {
    await persistAnomaly(
      env.RAW_MAIL_BUCKET,
      rawKey,
      { errorCode: "RAW_ARCHIVE_METADATA_INVALID" },
      runtime,
    );
    console.error("[mail-reconciliation] archive metadata invalid", {
      durationMs: durationMs(runtime, startedAt),
      errorCode: "RAW_ARCHIVE_METADATA_INVALID",
      objectRef,
      operation: "archive_reconcile",
      status: "invalid",
    });
    return "invalid";
  }

  const ingressRef = await bestEffortMailTelemetryLogRef(
    "ingress",
    pointer.ingressId,
  );

  const now = runtime.now();
  const receiptRead = await readReceipt(
    env.RAW_MAIL_BUCKET,
    pointer,
    runtime,
  );
  if (receiptRead.status === "invalid_present") {
    await establishEmergencyForward(
      env,
      pointer,
      "QUEUE_RETRY_EXHAUSTED",
      runtime,
      "invalid receipt emergency handoff",
    );
    await persistReceiptStateUnknown(
      env.RAW_MAIL_BUCKET,
      pointer,
      runtime,
    );
    return "pendingReview";
  }
  let receipt =
    receiptRead.status === "valid" ? receiptRead.receipt : null;
  if (!receipt) {
    const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(pointer.mailboxId));
    let deleted = false;
    let projectionExists = false;
    try {
      deleted = await hasExactInboundDeletionAuthority(
        mailbox,
        pointer,
        runtime,
        "missing receipt deletion truth",
      );
      if (!deleted) {
        projectionExists = await hasLiveInboundProjection(
          mailbox,
          pointer.ingressId,
          runtime,
          "missing receipt projection truth",
        );
      }
    } catch {
      // Indeterminate mailbox truth must converge to emergency delivery.
    }
    if (deleted) {
      return reconstructMissingReceipt(
        env,
        pointer,
        {
          state: "deleted",
          errorCode: "MAILBOX_PROJECTION_DELETED",
          resolution: "mailbox_projection_deleted",
        },
        now.toISOString(),
        runtime,
      );
    }
    if (projectionExists) {
      return reconstructMissingReceipt(
        env,
        pointer,
        {
          state: "stored",
          errorCode: "MAILBOX_PROJECTION_RECOVERED",
          resolution: "mailbox_projection_stored",
        },
        now.toISOString(),
        runtime,
      );
    }
    await establishEmergencyForward(
      env,
      pointer,
      "QUEUE_RETRY_EXHAUSTED",
      runtime,
      "missing receipt emergency handoff",
    );
    await settleBestEffort(env.RAW_MAIL_BUCKET.put(
      `system/inbound-recovery-pointers/${pointer.ingressId}.json`,
      JSON.stringify(projectInboundArchivePointer(pointer)),
      {
        customMetadata: {
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
          status: "pending_operator_review",
        },
        onlyIf: { etagDoesNotMatch: "*" },
      },
    ), runtime);
    await persistAnomaly(
      env.RAW_MAIL_BUCKET,
      rawKey,
      {
        errorCode: "ADMISSION_DECISION_MISSING",
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
      },
      runtime,
    );
    console.error("[mail-reconciliation] admission decision missing", {
      durationMs: durationMs(runtime, startedAt),
      errorCode: "ADMISSION_DECISION_MISSING",
      ingressRef,
      objectRef,
      operation: "archive_reconcile",
      recoveryAction: "emergency_forward",
      status: "forward_pending",
    });
    return "pendingReview";
  }
  if (receipt.state === "archived") {
    let admission:
      | { admitted: true }
      | { admitted: false; errorCode: ArchivedAdmissionErrorCode };
    try {
      admission = await archivedAdmission(env, pointer, archive, runtime);
    } catch {
      admission = { admitted: false, errorCode: "MAILBOX_UNAVAILABLE" };
    }
    if (!admission.admitted) {
      // Reconciliation cannot reconstruct the exact policy decision that was
      // made at SMTP ingress. Current ownership or mailbox state is not proof
      // that an already archived message was rejected then, so never convert
      // this uncertainty into terminal rejection after acceptance.
      await establishEmergencyForward(
        env,
        pointer,
        "QUEUE_RETRY_EXHAUSTED",
        runtime,
        "archived admission uncertainty emergency handoff",
      );
      await persistAnomaly(
        env.RAW_MAIL_BUCKET,
        pointer.rawKey,
        {
          errorCode: "ADMISSION_DECISION_MISSING",
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
        },
        runtime,
      );
      console.error("[mail-reconciliation] archived admission unresolved", {
        durationMs: durationMs(runtime, startedAt),
        errorCode: admission.errorCode,
        ingressRef,
        objectRef,
        operation: "archive_admission",
        recoveryAction: "emergency_forward",
        status: "forward_pending",
      });
      return "pendingReview";
    }
    await boundedInfrastructureWork(
      env.RAW_MAIL_BUCKET.put(
        `receipts/${pointer.ingressId}.json`,
        JSON.stringify({
          ...projectInboundArchivePointer(pointer),
          state: "admitted",
          updatedAt: now.toISOString(),
          reconciled: true,
        }),
        {
          customMetadata: { state: "admitted" },
          onlyIf: receipt.etag
            ? { etagMatches: receipt.etag }
            : { etagDoesNotMatch: "*" },
        },
      ),
      runtime,
      "archived receipt admission transition",
    );
    const refreshedRead = await readReceipt(
      env.RAW_MAIL_BUCKET,
      pointer,
      runtime,
    );
    if (
      refreshedRead.status !== "valid" ||
      refreshedRead.receipt.state === "archived"
    ) {
      await establishEmergencyForward(
        env,
        pointer,
        "QUEUE_RETRY_EXHAUSTED",
        runtime,
        "post-admission receipt uncertainty emergency handoff",
      );
      await persistReceiptStateUnknown(
        env.RAW_MAIL_BUCKET,
        pointer,
        runtime,
      );
      return "pendingReview";
    }
    if (refreshedRead.receipt.state !== "admitted") return "skipped";
    receipt = refreshedRead.receipt;
  }
  const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(pointer.mailboxId));
  const receiptNeedsMailboxTruthRepair =
    receipt.state === "forward_pending" ||
    receipt.state === "dead_lettered" ||
    receipt.state === "quarantined" ||
    receipt.state === "dead_letter_pending";
  if (
    receiptNeedsMailboxTruthRepair &&
    (await hasExactInboundDeletionAuthority(
      mailbox,
      pointer,
      runtime,
      "repairable receipt deletion truth",
    ))
  ) {
    const deletedReceipt = await boundedInfrastructureWork(
      env.RAW_MAIL_BUCKET.put(
        `receipts/${pointer.ingressId}.json`,
        JSON.stringify({
          ...projectInboundArchivePointer(pointer),
          state: "deleted",
          updatedAt: now.toISOString(),
          reconciled: true,
          errorCode: "MAILBOX_PROJECTION_DELETED",
        }),
        {
          customMetadata: { state: "deleted" },
          onlyIf: receipt.etag
            ? { etagMatches: receipt.etag }
            : { etagDoesNotMatch: "*" },
        },
      ),
      runtime,
      "deleted projection receipt repair",
    );
    if (!deletedReceipt) {
      return preserveExactConcurrentReceiptWinner(
        env,
        pointer,
        "deleted",
        runtime,
      );
    }
    console.log("[mail-reconciliation] deleted projection terminalized", {
      durationMs: durationMs(runtime, startedAt),
      ingressRef,
      objectRef,
      operation: "deleted_projection_terminalize",
      status: "deleted",
    });
    await resolveAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      "mailbox_projection_deleted",
      runtime,
    );
    return "terminalized";
  }
  if (receiptNeedsMailboxTruthRepair) {
    const projectionExists = await hasLiveInboundProjection(
      mailbox,
      pointer.ingressId,
      runtime,
      "repairable receipt projection truth",
    );
    if (projectionExists) {
      const storedReceipt = await boundedInfrastructureWork(
        env.RAW_MAIL_BUCKET.put(
          `receipts/${pointer.ingressId}.json`,
          JSON.stringify({
            ...projectInboundArchivePointer(pointer),
            state: "stored",
            updatedAt: now.toISOString(),
            reconciled: true,
            errorCode: "MAILBOX_PROJECTION_RECOVERED",
          }),
          {
            customMetadata: { state: "stored" },
            onlyIf: receipt.etag
              ? { etagMatches: receipt.etag }
              : { etagDoesNotMatch: "*" },
          },
        ),
        runtime,
        "stored projection receipt repair",
      );
      if (!storedReceipt) {
        return preserveExactConcurrentReceiptWinner(
          env,
          pointer,
          "stored",
          runtime,
        );
      }
      console.log("[mail-reconciliation] stored projection recovered", {
        durationMs: durationMs(runtime, startedAt),
        ingressRef,
        objectRef,
        operation: "stored_projection_recover",
        status: "stored",
      });
      await resolveAnomaly(
        env.RAW_MAIL_BUCKET,
        pointer.rawKey,
        "mailbox_projection_stored",
        runtime,
      );
      return "terminalized";
    }
  }
  if (receipt.state === "forward_pending") {
    await establishEmergencyForward(
      env,
      pointer,
      emergencyReasonForReceipt(receipt),
      runtime,
      "forward-pending authority repair",
    );
    return "pendingReview";
  }
  if (
    receipt.state === "dead_letter_pending" &&
    isStale(receipt.updatedAt, now)
  ) {
    await establishEmergencyForward(
      env,
      pointer,
      "QUEUE_RETRY_EXHAUSTED",
      runtime,
      "stale dead-letter intent emergency handoff",
    );
    await persistAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      {
        errorCode: "DLQ_TERMINAL_LEDGER_MISSING",
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
      },
      runtime,
    );
    return "pendingReview";
  }
  if (receipt.state === "dead_lettered") {
    await establishEmergencyForward(
      env,
      pointer,
      "QUEUE_RETRY_EXHAUSTED",
      runtime,
      "dead-lettered receipt emergency handoff",
    );
    await resolveAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      "terminal_receipt_persisted",
      runtime,
    );
    return "terminalized";
  }
  if (isForwardEligibleTerminalReceipt(receipt)) {
    await establishEmergencyForward(
      env,
      pointer,
      emergencyReasonForReceipt(receipt),
      runtime,
      "terminal quarantine emergency handoff",
    );
    return "terminalized";
  }
  if (
    receipt.state === "quarantined" &&
    receipt.errorCode === "RAW_ARCHIVE_INTEGRITY_MISMATCH"
  ) {
    let liveArchive: ArchiveMetadata | null | undefined;
    try {
      liveArchive = await boundedInfrastructureWork(
        env.RAW_MAIL_BUCKET.head(pointer.rawKey),
        runtime,
        "integrity quarantine live raw verification",
      );
    } catch {
      // An unreadable live archive is not proof of an integrity mismatch.
    }
    if (
      liveArchive === null ||
      (liveArchive &&
        !inboundRawArchiveMatchesPointer(liveArchive, pointer))
    ) {
      return "skipped";
    }
    try {
      await establishEmergencyForward(
        env,
        pointer,
        "QUEUE_RETRY_EXHAUSTED",
        runtime,
        "unproven integrity quarantine emergency handoff",
      );
    } catch {
      // The active archive marker remains authoritative for the next sweep.
    }
    return "pendingReview";
  }
  const staleHandoff =
    receipt.state === "archived" ||
    receipt.state === "admitted" ||
    ((receipt.state === "enqueued" ||
      receipt.state === "retrying" ||
      receipt.state === "dead_letter_pending") &&
      isStale(receipt.updatedAt, now));
  let terminalFailureValue: unknown = null;
  if (staleHandoff && mailbox.getInboundTerminalFailure) {
    try {
      terminalFailureValue = await boundedInfrastructureWork(
        mailbox.getInboundTerminalFailure(pointer.ingressId),
        runtime,
        "terminal failure ledger read",
      );
    } catch {
      terminalFailureValue = null;
    }
  }
  const terminalFailure = projectInboundTerminalFailure(terminalFailureValue);
  if (terminalFailureValue && !terminalFailure) {
    await persistAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      {
        errorCode: "DLQ_TERMINAL_LEDGER_MISSING",
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
      },
      runtime,
    );
  }
  if (terminalFailure) {
    await establishEmergencyForward(
      env,
      pointer,
      "QUEUE_RETRY_EXHAUSTED",
      runtime,
      "terminal-ledger emergency handoff",
    );
    console.error("[mail-reconciliation] stale dead-letter terminalized", {
      durationMs: durationMs(runtime, startedAt),
      errorCode: "DLQ_TERMINAL_LEDGER_RECOVERED",
      ingressRef,
      objectRef,
      operation: "dead_letter_terminalize",
      status: "dead_lettered",
    });
    await resolveAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      "terminal_failure_ledger_recovered",
      runtime,
    );
    return "pendingReview";
  }
  if (
    (receipt?.state === "stored" || shouldEnqueue(receipt, now)) &&
    (await hasExactInboundDeletionAuthority(
      mailbox,
      pointer,
      runtime,
      "stale handoff deletion truth",
    ))
  ) {
    const deletedReceipt = await boundedInfrastructureWork(
      env.RAW_MAIL_BUCKET.put(
        `receipts/${pointer.ingressId}.json`,
        JSON.stringify({
          ...projectInboundArchivePointer(pointer),
          state: "deleted",
          updatedAt: now.toISOString(),
          reconciled: true,
          errorCode: "MAILBOX_PROJECTION_DELETED",
        }),
        {
          customMetadata: { state: "deleted" },
          onlyIf: receipt?.etag
            ? { etagMatches: receipt.etag }
            : { etagDoesNotMatch: "*" },
        },
      ),
      runtime,
      "deleted projection terminal receipt write",
    );
    if (!deletedReceipt) {
      return preserveExactConcurrentReceiptWinner(
        env,
        pointer,
        "deleted",
        runtime,
      );
    }
    console.log("[mail-reconciliation] deleted projection terminalized", {
      durationMs: durationMs(runtime, startedAt),
      ingressRef,
      objectRef,
      operation: "deleted_projection_terminalize",
      status: "deleted",
    });
    await resolveAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      "mailbox_projection_deleted",
      runtime,
    );
    return "terminalized";
  }
  if (receipt?.state === "stored") {
    let projectionExists = false;
    try {
      projectionExists = await hasLiveInboundProjection(
        mailbox,
        pointer.ingressId,
        runtime,
        "stored projection truth",
      );
    } catch {
      projectionExists = false;
    }
    if (!projectionExists) {
      await establishEmergencyForward(
        env,
        pointer,
        "QUEUE_RETRY_EXHAUSTED",
        runtime,
        "missing stored projection emergency handoff",
      );
      await persistAnomaly(
        env.RAW_MAIL_BUCKET,
        pointer.rawKey,
        {
          errorCode: "STORED_PROJECTION_MISSING",
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
        },
        runtime,
      );
      console.error("[mail-reconciliation] stored projection is missing", {
        durationMs: durationMs(runtime, startedAt),
        errorCode: "STORED_PROJECTION_MISSING",
        ingressRef,
        objectRef,
        operation: "archive_reconcile",
        status: "projection_missing",
      });
      return "projectionMissing";
    }
    await resolveAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      "mailbox_projection_stored",
      runtime,
    );
    if (await inspectStoredDerivedContent(env, pointer, mailbox, runtime)) {
      return "pendingReview";
    }
  }
  if (receipt?.state === "deleted") {
    let exactDeletion = false;
    try {
      exactDeletion = await hasExactInboundDeletionAuthority(
        mailbox,
        pointer,
        runtime,
        "deleted receipt tombstone truth",
      );
    } catch {
      // Unreadable live deletion truth is not terminal authority.
    }
    if (!exactDeletion) {
      await establishEmergencyForward(
        env,
        pointer,
        "QUEUE_RETRY_EXHAUSTED",
        runtime,
        "unproven deleted receipt emergency handoff",
      );
      await persistAnomaly(
        env.RAW_MAIL_BUCKET,
        pointer.rawKey,
        {
          errorCode: "RECEIPT_STATE_UNKNOWN",
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
        },
        runtime,
      );
      return "pendingReview";
    }
    await resolveAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      "mailbox_projection_deleted",
      runtime,
    );
  }
  if (!shouldEnqueue(receipt, now)) {
    console.log("[mail-reconciliation] archive skipped", {
      durationMs: durationMs(runtime, startedAt),
      ingressRef,
      objectRef,
      operation: "archive_reconcile",
      status: "skipped",
    });
    return "skipped";
  }

  const enqueueStartedAt = runtime.now().getTime();
  await boundedInfrastructureWork(
    env.INBOUND_QUEUE.send(projectInboundArchivePointer(pointer)),
    runtime,
    "normal projection Queue handoff",
  );
  const receiptWrite = await boundedInfrastructureWork(
    env.RAW_MAIL_BUCKET.put(
      `receipts/${pointer.ingressId}.json`,
      JSON.stringify({
        ...projectInboundArchivePointer(pointer),
        state: "enqueued",
        updatedAt: now.toISOString(),
        reconciled: true,
      }),
      {
        customMetadata: { state: "enqueued" },
        onlyIf: receipt?.etag
          ? { etagMatches: receipt.etag }
          : { etagDoesNotMatch: "*" },
      },
    ),
    runtime,
    "post-Queue receipt advancement",
  );
  if (!receiptWrite) {
    console.log("[mail-reconciliation] receipt state superseded", {
      ingressRef,
      objectRef,
      operation: "receipt_write",
      status: "superseded",
    });
  }
  console.log("[mail-reconciliation] archive re-enqueued", {
    durationMs: durationMs(runtime, enqueueStartedAt),
    ingressRef,
    objectRef,
    operation: "archive_reconcile",
    status: "reenqueued",
    target: "cloudflare_queue",
  });
  return "reenqueued";
}

type ReconcileOneDisposition =
  | "completed"
  | "retained"
  | "ledgered"
  | "unledgered";

async function reconcileOneArchive(
  rawKey: string,
  env: ReconciliationEnvironment,
  runtime: ReconciliationRuntime,
  result: ReconciliationResult,
): Promise<ReconcileOneDisposition> {
  result.scanned += 1;
  const objectRef = await bestEffortMailTelemetryLogRef("object", rawKey);
  try {
    const outcome = await reconcileArchive(rawKey, env, runtime);
    result[outcome] += 1;
    await settleBestEffort(
      env.RAW_MAIL_BUCKET.delete(failureLedgerKey(rawKey)),
      runtime,
    );
    return outcome === "invalid" ||
      outcome === "pendingReview" ||
      outcome === "projectionMissing"
      ? "retained"
      : "completed";
  } catch (error) {
    result.failed += 1;
    const failureCode = safeErrorCode(error, "ARCHIVE_RECONCILIATION_FAILED");
    console.error("[mail-reconciliation] archive reconciliation failed", {
      errorCode: failureCode,
      objectRef,
      operation: "archive_reconcile",
      status: "failed",
    });
    try {
      const ledgered = await boundedInfrastructureWork(
        env.RAW_MAIL_BUCKET.put(
          failureLedgerKey(rawKey),
          JSON.stringify({
            rawKey,
            failedAt: runtime.now().toISOString(),
            errorCode: failureCode,
          }),
          { customMetadata: { status: "pending" } },
        ),
        runtime,
        "reconciliation failure ledger write",
      );
      if (!ledgered) throw new Error("R2 rejected failure ledger write");
      result.failureLedgered += 1;
      console.error("[mail-reconciliation] failure durably ledgered", {
        errorCode: "ARCHIVE_RECONCILIATION_LEDGERED",
        objectRef,
        operation: "reconciliation_failure_ledger_write",
        status: "pending",
      });
      return "ledgered";
    } catch (ledgerError) {
      console.error("[mail-reconciliation] failure ledger write failed", {
        errorCode: safeErrorCode(
          ledgerError,
          "RECONCILIATION_LEDGER_WRITE_FAILED",
        ),
        objectRef,
        operation: "reconciliation_failure_ledger_write",
        status: "failed",
      });
      return "unledgered";
    }
  }
}

async function recentQuarantineNeedsActiveRecovery(
  bucket: ReconciliationBucket,
  rawKey: string,
  ingressId: string,
): Promise<boolean> {
  const key = `receipts/${ingressId}.json`;
  const object = await bucket.get(key);
  if (
    !object ||
    object.key !== key ||
    typeof object.etag !== "string" ||
    object.etag.length === 0 ||
    object.customMetadata?.state !== "quarantined"
  ) {
    return true;
  }
  try {
    const value: unknown = JSON.parse(await object.text());
    const receiptValue = isRecord(value) ? value : null;
    if (
      !receiptValue ||
      receiptValue.state !== "quarantined" ||
      receiptValue.rawKey !== rawKey ||
      receiptValue.ingressId !== ingressId ||
      !isEmergencyForwardPointer(receiptValue) ||
      !isIsoTimestamp(receiptValue["updatedAt"]) ||
      !receiptStateDetailsAreValid(receiptValue, "quarantined")
    ) {
      return true;
    }
    return (
      receiptValue["errorCode"] !== "RAW_ARCHIVE_INTEGRITY_MISMATCH"
    );
  } catch {
    return true;
  }
}

async function clearTerminalActiveMarker(
  rawKey: string,
  env: ReconciliationEnvironment,
  runtime: ReconciliationRuntime,
): Promise<void> {
  const ingressId = inboundIngressIdFromRawKey(rawKey);
  if (!ingressId) return;
  const key = `receipts/${ingressId}.json`;
  const receipt = await boundedInfrastructureWork(
    env.RAW_MAIL_BUCKET.get(key),
    runtime,
    "terminal active marker receipt read",
  );
  if (!receipt) return;
  let value: unknown;
  try {
    value = JSON.parse(await boundedInfrastructureWork(
      receipt.text(),
      runtime,
      "terminal active marker receipt body read",
    ));
  } catch {
    return;
  }
  if (
    !isRecord(value) ||
    (receipt.key !== undefined && receipt.key !== key) ||
    value.rawKey !== rawKey ||
    value.ingressId !== ingressId ||
    !isIsoTimestamp(value.updatedAt) ||
    !RECEIPT_STATES.includes(value.state as ReceiptState) ||
    !receiptStateDetailsAreValid(value, value.state as ReceiptState) ||
    (receipt.customMetadata?.state !== undefined &&
      receipt.customMetadata.state !== value.state) ||
    inboundTerminalAuthorityRequirement(value) === null ||
    !isEmergencyForwardPointer(value)
  ) {
    return;
  }
  const authorityRequirement = inboundTerminalAuthorityRequirement(
    value as unknown as Record<string, unknown>,
  );
  if (authorityRequirement === "deleted_projection") {
    const mailbox = env.MAILBOX.get(
      env.MAILBOX.idFromName(value.mailboxId),
    );
    try {
      if (
        !(await hasExactInboundDeletionAuthority(
          mailbox,
          value,
          runtime,
          "terminal active marker deletion authority",
        ))
      ) {
        return;
      }
    } catch {
      return;
    }
  }
  if (authorityRequirement === "stored_projection") {
    const mailbox = env.MAILBOX.get(
      env.MAILBOX.idFromName(value.mailboxId),
    );
    try {
      const stored = await hasLiveInboundProjection(
        mailbox,
        value.ingressId,
        runtime,
        "terminal active marker projection authority",
      );
      if (!stored) return;
    } catch {
      return;
    }
  }
  if (authorityRequirement === "raw_integrity_mismatch") {
    try {
      const raw = await boundedInfrastructureWork(
        env.RAW_MAIL_BUCKET.get(value.rawKey),
        runtime,
        "terminal active marker raw integrity authority",
      );
      if (
        !raw ||
        typeof raw.key !== "string" ||
        typeof raw.version !== "string" ||
        typeof raw.size !== "number" ||
        typeof raw.etag !== "string" ||
        !raw.checksums?.sha256 ||
        inboundRawArchiveMatchesPointer(
          raw as ReceiptObject & {
            key: string;
            version: string;
            size: number;
            etag: string;
          },
          value,
        )
      ) {
        return;
      }
    } catch {
      return;
    }
  }
  await settleBestEffort(
    env.RAW_MAIL_BUCKET.delete(inboundActiveMarkerKey(rawKey)),
    runtime,
  );
}

function startOfUtcMinute(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 60_000) * 60_000);
}

function addUtcMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60_000);
}

function canonicalUtcMinute(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== value ||
    startOfUtcMinute(parsed).getTime() !== parsed.getTime()
  ) {
    return null;
  }
  return parsed;
}

async function readRecentSweepCursor(
  bucket: ReconciliationBucket,
  runtime: ReconciliationRuntime,
  key: string,
  initialMinute: Date,
): Promise<{ minute: Date; cursor?: string; etag?: string }> {
  const object = await bucket.get(key);
  if (!object) {
    return { minute: initialMinute };
  }
  const value: unknown = JSON.parse(await object.text());
  if (!isRecord(value)) {
    throw new Error("Recent inbound sweep cursor is invalid");
  }
  const minute = canonicalUtcMinute(value.minute);
  const cursor = value.cursor;
  if (
    !minute ||
    minute.getTime() > startOfUtcMinute(runtime.now()).getTime() ||
    (cursor !== null &&
      cursor !== undefined &&
      (typeof cursor !== "string" || cursor.length === 0)) ||
    !object.etag
  ) {
    throw new Error("Recent inbound sweep cursor is invalid");
  }
  return {
    minute,
    ...(typeof cursor === "string" ? { cursor } : {}),
    etag: object.etag,
  };
}

async function persistRecentSweepCursor(
  bucket: ReconciliationBucket,
  key: string,
  previous: { etag?: string },
  next: { minute: Date; cursor?: string },
  runtime: ReconciliationRuntime,
): Promise<boolean> {
  return Boolean(
    await bucket.put(
      key,
      JSON.stringify({
        minute: next.minute.toISOString(),
        cursor: next.cursor ?? null,
        updatedAt: runtime.now().toISOString(),
      }),
      {
        customMetadata: { status: "active" },
        onlyIf: previous.etag
          ? { etagMatches: previous.etag }
          : { etagDoesNotMatch: "*" },
      },
    ),
  );
}

type RecentSweepSharedBudget = {
  discovered: number;
  listCalls: number;
  scanned: number;
};

async function scanRecentRawArchiveLane(
  env: ReconciliationEnvironment,
  previous: { minute: Date; cursor?: string },
  lastClosedMinute: Date,
  budget: RecentSweepSharedBudget,
): Promise<{ minute: Date; cursor?: string }> {
  let minute = previous.minute;
  let cursor = previous.cursor;

  // R2 lists lexicographically and continuation cursors are opaque. Restricting
  // each page to a closed minute keeps later writes out of an already checkpointed
  // prefix. https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#bucket-method-definitions
  while (
    minute.getTime() <= lastClosedMinute.getTime() &&
    budget.scanned < INBOUND_RECENT_RAW_RECONCILIATION_BATCH_SIZE &&
    budget.listCalls < INBOUND_RECENT_RAW_MAX_PREFIX_LIST_CALLS
  ) {
    const remaining =
      INBOUND_RECENT_RAW_RECONCILIATION_BATCH_SIZE - budget.scanned;
    budget.listCalls += 1;
    const page = await env.RAW_MAIL_BUCKET.list({
      prefix: inboundRawMinutePrefix(minute),
      limit: remaining,
      ...(cursor ? { cursor } : {}),
    });
    if (page.objects.length > remaining) {
      throw new Error("R2 recent inbound page exceeded its requested limit");
    }

    for (const object of page.objects) {
      budget.scanned += 1;
      const ingressId = inboundIngressIdFromRawKey(object.key);
      if (!ingressId) continue;
      const receipt = await env.RAW_MAIL_BUCKET.head(
        `receipts/${ingressId}.json`,
      );
      const receiptState = receipt?.customMetadata?.state;
      if (receiptState === "stored" || receiptState === "deleted") {
        await persistInboundActiveMarkerForRawKey(
          env.RAW_MAIL_BUCKET,
          object.key,
          ingressId,
        );
        budget.discovered += 1;
        continue;
      }
      if (
        receiptState === "quarantined" &&
        (await recentQuarantineNeedsActiveRecovery(
          env.RAW_MAIL_BUCKET,
          object.key,
          ingressId,
        ))
      ) {
        await persistInboundActiveMarkerForRawKey(
          env.RAW_MAIL_BUCKET,
          object.key,
          ingressId,
        );
        budget.discovered += 1;
        continue;
      }
      await persistInboundActiveMarkerForRawKey(
        env.RAW_MAIL_BUCKET,
        object.key,
        ingressId,
      );
      budget.discovered += 1;
    }

    if (page.truncated) {
      if (!page.cursor) {
        throw new Error(
          "R2 returned a truncated recent inbound page without a continuation cursor",
        );
      }
      cursor = page.cursor;
      break;
    }
    minute = addUtcMinutes(minute, 1);
    cursor = undefined;
  }

  return { minute, ...(cursor ? { cursor } : {}) };
}

async function discoverRecentRawArchives(
  env: ReconciliationEnvironment,
  runtime: ReconciliationRuntime,
): Promise<{ discovered: number; scanned: number; cursorWritten: boolean }> {
  const currentMinute = startOfUtcMinute(runtime.now());
  const budget: RecentSweepSharedBudget = {
    discovered: 0,
    listCalls: 0,
    scanned: 0,
  };
  let cursorWritten = true;
  const lanes = [
    {
      key: RECENT_SWEEP_CURSOR_KEY,
      initialMinute: addUtcMinutes(
        currentMinute,
        -RECENT_SWEEP_INITIAL_LOOKBACK_MINUTES,
      ),
      lastClosedMinute: addUtcMinutes(currentMinute, -1),
    },
    {
      key: RECENT_BACKSTOP_SWEEP_CURSOR_KEY,
      initialMinute: new Date(
        Math.min(
          RECENT_BACKSTOP_INTRODUCTION_MINUTE_MS,
          currentMinute.getTime(),
        ),
      ),
      lastClosedMinute: addUtcMinutes(
        currentMinute,
        -(RECENT_SWEEP_INITIAL_LOOKBACK_MINUTES + 1),
      ),
    },
  ];

  for (const lane of lanes) {
    try {
      const previous = await readRecentSweepCursor(
        env.RAW_MAIL_BUCKET,
        runtime,
        lane.key,
        lane.initialMinute,
      );
      const next = await scanRecentRawArchiveLane(
        env,
        previous,
        lane.lastClosedMinute,
        budget,
      );
      const written = await persistRecentSweepCursor(
        env.RAW_MAIL_BUCKET,
        lane.key,
        previous,
        next,
        runtime,
      );
      if (!written) cursorWritten = false;
    } catch {
      cursorWritten = false;
    }
  }

  return {
    discovered: budget.discovered,
    scanned: budget.scanned,
    cursorWritten,
  };
}

async function persistSweepCursor(
  bucket: ReconciliationBucket,
  key: string,
  cursorState: { cursor?: string; etag?: string },
  page: { truncated: boolean; cursor?: string },
  runtime: ReconciliationRuntime,
): Promise<boolean> {
  return Boolean(
    await bucket.put(
      key,
      JSON.stringify({
        cursor: page.truncated ? page.cursor : null,
        updatedAt: runtime.now().toISOString(),
      }),
      {
        onlyIf: cursorState.etag
          ? { etagMatches: cursorState.etag }
          : { etagDoesNotMatch: "*" },
      },
    ),
  );
}

export async function reconcileInboundArchives(
  env: ReconciliationEnvironment,
  runtime: ReconciliationRuntime = defaultRuntime,
): Promise<ReconciliationResult> {
  const sweepStartedAt = runtime.now().getTime();
  const result: ReconciliationResult = {
    scanned: 0,
    reenqueued: 0,
    skipped: 0,
    invalid: 0,
    failed: 0,
    projectionMissing: 0,
    pendingReview: 0,
    terminalized: 0,
    failureLedgered: 0,
  };
  let repairScanned = 0;
  let repairResolved = 0;
  let repairSweepStatus: ReconciliationSubSweepStatus = "succeeded";
  let cleanupScanned = 0;
  let cleanupAccepted = 0;
  let cleanupSweepStatus: ReconciliationSubSweepStatus = "succeeded";
  let recentDiscovered = 0;
  let recentScanned = 0;
  let recentSweepStatus: ReconciliationSubSweepStatus = "succeeded";
  let terminalSummaryEmitted = false;
  const emitTerminalSummary = (status: ReconciliationSweepStatus): void => {
    if (terminalSummaryEmitted) return;
    terminalSummaryEmitted = true;
    if (status === "failed") {
      console.error("[mail-reconciliation] sweep completed", {
        cleanupAccepted,
        cleanupScanned,
        cleanupSweepStatus,
        durationMs: durationMs(runtime, sweepStartedAt),
        errorCode: "RECONCILIATION_SWEEP_FAILED",
        failed: result.failed,
        failureLedgered: result.failureLedgered,
        invalid: result.invalid,
        operation: "archive_reconcile_sweep",
        pendingReview: result.pendingReview,
        projectionMissing: result.projectionMissing,
        reenqueued: result.reenqueued,
        recentDiscovered,
        recentScanned,
        recentSweepStatus,
        repairResolved,
        repairScanned,
        repairSweepStatus,
        scanned: result.scanned,
        skipped: result.skipped,
        status,
        terminalized: result.terminalized,
      });
      return;
    }
    console.log("[mail-reconciliation] sweep completed", {
      cleanupAccepted,
      cleanupScanned,
      cleanupSweepStatus,
      durationMs: durationMs(runtime, sweepStartedAt),
      failed: result.failed,
      failureLedgered: result.failureLedgered,
      invalid: result.invalid,
      operation: "archive_reconcile_sweep",
      pendingReview: result.pendingReview,
      projectionMissing: result.projectionMissing,
      reenqueued: result.reenqueued,
      recentDiscovered,
      recentScanned,
      recentSweepStatus,
      repairResolved,
      repairScanned,
      repairSweepStatus,
      scanned: result.scanned,
      skipped: result.skipped,
      status,
      terminalized: result.terminalized,
    });
  };

  console.log("[mail-reconciliation] sweep started", {
    operation: "archive_reconcile_sweep",
    status: "started",
  });

  try {
    try {
      const repairResult = await reconcilePendingInboundRepairAttempts(
        {
          RAW_MAIL_BUCKET: env.RAW_MAIL_BUCKET,
          MAILBOX: env.MAILBOX,
        },
        runtime,
      );
      repairScanned = repairResult.scanned;
      repairResolved = repairResult.resolved;
    } catch {
      repairSweepStatus = "degraded";
      console.error("[mail-reconciliation] repair-attempt sweep degraded", {
        errorCode: "INBOUND_REPAIR_ATTEMPT_SWEEP_FAILED",
        operation: "repair_attempt_reconcile",
        status: "degraded",
      });
    }
    try {
      const cleanupResult = await reconcileInboundCleanupIntents(
        {
          RAW_MAIL_BUCKET: env.RAW_MAIL_BUCKET,
          BUCKET: env.BUCKET,
          MAILBOX: env.MAILBOX,
        },
        runtime.now(),
      );
      cleanupScanned = cleanupResult.scanned;
      cleanupAccepted = cleanupResult.accepted;
    } catch {
      cleanupSweepStatus = "degraded";
      console.error("[mail-reconciliation] cleanup-intent sweep degraded", {
        errorCode: "INBOUND_CLEANUP_INTENT_SWEEP_FAILED",
        operation: "cleanup_intent_reconcile",
        status: "degraded",
      });
    }
    try {
      const recentResult = await discoverRecentRawArchives(env, runtime);
      recentDiscovered = recentResult.discovered;
      recentScanned = recentResult.scanned;
      if (!recentResult.cursorWritten) {
        recentSweepStatus = "degraded";
        console.error("[mail-reconciliation] recent raw sweep degraded", {
          errorCode: "RECENT_RAW_SWEEP_FAILED",
          operation: "recent_raw_reconcile",
          status: "degraded",
        });
      }
    } catch {
      recentSweepStatus = "degraded";
      console.error("[mail-reconciliation] recent raw sweep degraded", {
        errorCode: "RECENT_RAW_SWEEP_FAILED",
        operation: "recent_raw_reconcile",
        status: "degraded",
      });
    }
    let activeSweepStatus: ReconciliationSubSweepStatus = "succeeded";
    const activeRawKeys = new Set<string>();
    try {
      const activeCursorState = await readSweepCursor(
        env.RAW_MAIL_BUCKET,
        INBOUND_ACTIVE_INDEX_CURSOR_KEY,
      );
      const activePage = await env.RAW_MAIL_BUCKET.list({
        prefix: INBOUND_ACTIVE_INDEX_PREFIX,
        limit: INBOUND_ACTIVE_RECONCILIATION_BATCH_SIZE,
        ...(activeCursorState.cursor
          ? { cursor: activeCursorState.cursor }
          : {}),
      });
      let activePageComplete = true;
      for (const marker of activePage.objects) {
        const rawKey = rawKeyFromInboundActiveMarkerKey(marker.key);
        if (!rawKey) continue;
        activeRawKeys.add(rawKey);
        const disposition = await reconcileOneArchive(
          rawKey,
          env,
          runtime,
          result,
        );
        if (disposition === "unledgered") activePageComplete = false;
        if (disposition === "completed") {
          try {
            await clearTerminalActiveMarker(rawKey, env, runtime);
          } catch (error) {
            const objectRef = await bestEffortMailTelemetryLogRef(
              "object",
              rawKey,
            );
            console.error(
              "[mail-reconciliation] active marker cleanup degraded",
              {
                errorCode: safeErrorCode(
                  error,
                  "ACTIVE_RECOVERY_INDEX_DELETE_FAILED",
                ),
                objectRef,
                operation: "active_recovery_index_delete",
                status: "degraded",
              },
            );
          }
        }
      }
      if (activePage.truncated && !activePage.cursor) {
        throw new Error(
          "R2 returned a truncated active-index page without a continuation cursor",
        );
      }
      if (activePageComplete) {
        const cursorWritten = await persistSweepCursor(
          env.RAW_MAIL_BUCKET,
          INBOUND_ACTIVE_INDEX_CURSOR_KEY,
          activeCursorState,
          activePage,
          runtime,
        );
        if (!cursorWritten) activeSweepStatus = "degraded";
      } else {
        activeSweepStatus = "degraded";
      }
    } catch {
      activeSweepStatus = "degraded";
      console.error("[mail-reconciliation] active recovery sweep degraded", {
        errorCode: "ACTIVE_RECOVERY_INDEX_SWEEP_FAILED",
        operation: "active_recovery_index_reconcile",
        status: "degraded",
      });
    }

    const cursorState = await readSweepCursor(
      env.RAW_MAIL_BUCKET,
      SWEEP_CURSOR_KEY,
    );
    const listStartedAt = runtime.now().getTime();
    const page = await env.RAW_MAIL_BUCKET.list({
      prefix: RAW_PREFIX,
      limit: INBOUND_RAW_BACKSTOP_RECONCILIATION_BATCH_SIZE,
      ...(cursorState.cursor ? { cursor: cursorState.cursor } : {}),
    });
    console.log("[mail-reconciliation] archive page listed", {
      count: page.objects.length,
      durationMs: durationMs(runtime, listStartedAt),
      operation: "archive_list",
      status: "succeeded",
      target: "r2",
      truncated: page.truncated,
    });
    let rawPageComplete = true;
    for (const object of page.objects) {
      if (activeRawKeys.has(object.key)) continue;
      const disposition = await reconcileOneArchive(
        object.key,
        env,
        runtime,
        result,
      );
      if (disposition === "unledgered") rawPageComplete = false;
    }
    if (page.truncated && !page.cursor) {
      throw new Error(
        "R2 returned a truncated archive page without a continuation cursor",
      );
    }
    if (!rawPageComplete) {
      console.error("[mail-reconciliation] sweep cursor held for retry", {
        errorCode: "RECONCILIATION_PAGE_INCOMPLETE",
        failed: 1,
        operation: "reconciliation_cursor_write",
        status: "deferred",
      });
      emitTerminalSummary("partial");
      return result;
    }

    const cursorWriteStartedAt = runtime.now().getTime();
    const cursorWritten = await persistSweepCursor(
      env.RAW_MAIL_BUCKET,
      SWEEP_CURSOR_KEY,
      cursorState,
      page,
      runtime,
    );
    if (!cursorWritten) {
      console.log("[mail-reconciliation] sweep cursor update superseded", {
        operation: "reconciliation_cursor_write",
        status: "superseded",
      });
      emitTerminalSummary("partial");
      return result;
    }
    const truncated = Boolean(page.truncated);
    console.log("[mail-reconciliation] sweep cursor persisted", {
      durationMs: durationMs(runtime, cursorWriteStartedAt),
      operation: "reconciliation_cursor_write",
      status: "succeeded",
      target: "r2",
      truncated,
    });

    const status: ReconciliationSweepStatus =
      repairSweepStatus === "degraded" ||
      cleanupSweepStatus === "degraded" ||
      recentSweepStatus === "degraded" ||
      activeSweepStatus === "degraded" ||
      result.failed > 0
        ? "partial"
        : "succeeded";
    emitTerminalSummary(status);
    return result;
  } catch (error) {
    emitTerminalSummary("failed");
    throw error;
  }
}
