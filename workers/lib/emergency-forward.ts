import {
  INBOUND_RECEIPT_SCHEMA_VERSION,
  projectInboundArchivePointer,
  type InboundArchivePointer,
} from "../inbound-email.ts";
import { isSha256Hex } from "./checksum.ts";
import { inboundRawArchiveMatchesPointer } from "./inbound-raw-integrity.ts";
import {
  inboundIngressIdFromRawKey,
  isInboundRawKeyForIngress,
} from "./inbound-raw-key.ts";
import { mailTelemetryLogRef } from "./mail-telemetry.ts";
import {
  EMERGENCY_FORWARD_RECONCILIATION_BATCH_SIZE as BUDGETED_EMERGENCY_FORWARD_RECONCILIATION_BATCH_SIZE,
} from "./inbound-reconciliation-budget.ts";
import { MAX_EMAIL_SIZE } from "./store-email.ts";
import { hasExactInboundSmtpRejectionAuthority } from "./inbound-smtp-rejection.ts";
import { inboundTerminalAuthorityRequirement } from "./inbound-terminal-authority.ts";
import {
  createQueueDisposition,
  runInboundWorkWithDeadline,
  type InboundDeadlineScheduler,
} from "./inbound-work-deadline.ts";

export const EMERGENCY_FORWARD_ACTIVE_PREFIX =
  "system/emergency-forward/active/";
export const EMERGENCY_FORWARD_RECONCILIATION_BATCH_SIZE =
  BUDGETED_EMERGENCY_FORWARD_RECONCILIATION_BATCH_SIZE;
export const EMERGENCY_FORWARD_RECONCILIATION_CURSOR_KEY =
  "system/emergency-forward/reconciliation-cursor.json";
export const EMERGENCY_FORWARD_ANOMALY_PREFIX =
  "system/emergency-forward/anomalies/";
export const EMERGENCY_FORWARD_LEASE_SECONDS = 180;
export const EMERGENCY_FORWARD_ITEM_TIMEOUT_MS = 75_000;
export const EMERGENCY_FORWARD_PROVIDER_TIMEOUT_MS = 60_000;
export const EMERGENCY_FORWARD_INFRASTRUCTURE_TIMEOUT_MS = 5_000;
// A lease-blocked attempt still counts against max_retries, so a redelivery must
// land after the lease this attempt leaves behind has expired. A shorter delay
// spends the whole retry budget on attempts that bail on their own live lease.
export const EMERGENCY_FORWARD_RETRY_SECONDS =
  EMERGENCY_FORWARD_LEASE_SECONDS + 30;
// An explicit per-message delay overrides the consumer's queue-level
// retry_delay, so the parking lane has to restate its own hourly cadence or it
// would burn its whole retry budget at the primary lane's pace.
export const EMERGENCY_FORWARD_PARKING_RETRY_SECONDS = 3_600;
// Inbound accepts 25 MiB of raw MIME, and an outbound send to a verified
// destination is capped at 25 MiB after base64 expands the attachment by a
// third. 16 MiB of original therefore leaves headroom, and anything larger is
// announced without the attachment instead of failing every attempt forever.
export const EMERGENCY_FORWARD_MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

export type EmergencyForwardReason =
  | "EMAXLEN"
  | "INGRESS_RECOVERY_REQUIRED"
  | "MIME_CHARSET_UNSUPPORTED"
  | "MIME_HEADER_SIZE_EXCEEDED"
  | "MIME_MULTIPART_BOUNDARY_INVALID"
  | "MIME_MULTIPART_BOUNDARY_MISSING"
  | "MIME_PARSE_FAILED"
  | "MIME_ROOT_HEADER_MISSING"
  | "QUEUE_RETRY_EXHAUSTED";

export type EmergencyForwardEnvelope = {
  schemaVersion: 1;
  pointer: InboundArchivePointer;
  generation: number;
};

type R2Object = {
  key: string;
  version: string;
  size: number;
  etag: string;
  body: ReadableStream;
  text(): Promise<string>;
  customMetadata?: Record<string, string>;
  checksums?: { sha256?: ArrayBuffer };
};

type EmergencySidecarObject = Pick<R2Object, "text"> &
  Partial<Omit<R2Object, "text">>;

type EmergencyBucket = {
  get(key: string): Promise<R2Object | null>;
  head(key: string): Promise<{
    etag: string;
    customMetadata?: Record<string, string>;
  } | null>;
  put(
    key: string,
    value: string,
    options?: {
      customMetadata?: Record<string, string>;
      httpMetadata?: { contentType?: string };
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    },
  ): Promise<unknown | null>;
  delete(key: string): Promise<unknown>;
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
};

type EmergencyEnvironment = {
  DB: Pick<D1Database, "prepare">;
  BUCKET: Pick<R2Bucket, "head">;
  RAW_MAIL_BUCKET: EmergencyBucket;
  EMERGENCY_FORWARD_QUEUE: Pick<Queue<EmergencyForwardEnvelope>, "send">;
  EMERGENCY_EMAIL: Pick<SendEmail, "send">;
  EMERGENCY_FORWARD_FROM: string;
  EMERGENCY_FORWARD_DESTINATION: string;
  MAILBOX: {
    idFromName(mailboxId: string): unknown;
    get(id: unknown): {
      getEmail(ingressId: string): Promise<unknown | null>;
      isEmailDeleted(ingressId: string): Promise<boolean>;
      getInboundDeletionAuthority?(
        authority: InboundArchivePointer & { rawSha256: string },
      ): Promise<{ generation: number; deletedAt: string } | null>;
    };
  };
};

type EmergencyQueueMessage = Pick<
  Message<unknown>,
  "id" | "body" | "attempts" | "ack" | "retry"
>;

type EmergencyRuntime = {
  now(): Date;
  retryDelaySeconds?: number;
  providerLogRef?(messageId: string): Promise<string>;
  bestEffortTimeoutMs?: number;
  infrastructureTimeoutMs?: number;
  itemTimeoutMs?: number;
  providerTimeoutMs?: number;
  deadlineScheduler?: InboundDeadlineScheduler;
};

const defaultRuntime: Pick<EmergencyRuntime, "now"> = {
  now: () => new Date(),
};

const receiptKey = (ingressId: string) => `receipts/${ingressId}.json`;

export function emergencyForwardMarkerKey(rawKey: string): string {
  return `${EMERGENCY_FORWARD_ACTIVE_PREFIX}${encodeURIComponent(rawKey)}.json`;
}

function rawKeyFromEmergencyForwardMarkerKey(key: string): string | null {
  if (
    !key.startsWith(EMERGENCY_FORWARD_ACTIVE_PREFIX) ||
    !key.endsWith(".json")
  ) {
    return null;
  }
  try {
    const rawKey = decodeURIComponent(
      key.slice(EMERGENCY_FORWARD_ACTIVE_PREFIX.length, -".json".length),
    );
    const ingressId = inboundIngressIdFromRawKey(rawKey);
    return ingressId && isInboundRawKeyForIngress(rawKey, ingressId)
      ? rawKey
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isEmergencyForwardPointer(
  value: unknown,
): value is InboundArchivePointer {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === INBOUND_RECEIPT_SCHEMA_VERSION &&
    typeof value.ingressId === "string" &&
    /^[A-Za-z0-9_-]+$/.test(value.ingressId) &&
    typeof value.rawKey === "string" &&
    isInboundRawKeyForIngress(value.rawKey, value.ingressId) &&
    typeof value.mailboxId === "string" &&
    value.mailboxId.length > 2 &&
    value.mailboxId.includes("@") &&
    typeof value.rawSize === "number" &&
    Number.isSafeInteger(value.rawSize) &&
    value.rawSize > 0 &&
    value.rawSize <= MAX_EMAIL_SIZE &&
    isSha256Hex(value.rawSha256) &&
    typeof value.archivedAt === "string" &&
    Number.isFinite(Date.parse(value.archivedAt)) &&
    typeof value.etag === "string" &&
    value.etag.length > 0 &&
    typeof value.version === "string" &&
    value.version.length > 0
  );
}

function isEmergencyForwardReason(value: unknown): value is EmergencyForwardReason {
  return (
    value === "EMAXLEN" ||
    value === "INGRESS_RECOVERY_REQUIRED" ||
    value === "MIME_CHARSET_UNSUPPORTED" ||
    value === "MIME_HEADER_SIZE_EXCEEDED" ||
    value === "MIME_MULTIPART_BOUNDARY_INVALID" ||
    value === "MIME_MULTIPART_BOUNDARY_MISSING" ||
    value === "MIME_PARSE_FAILED" ||
    value === "MIME_ROOT_HEADER_MISSING" ||
    value === "QUEUE_RETRY_EXHAUSTED"
  );
}

function isEmergencyForwardMarker(
  value: unknown,
): value is InboundArchivePointer &
  Record<string, unknown> & {
    reason: EmergencyForwardReason;
    createdAt: string;
    generation: number;
    enqueuedAt: string | null;
    leaseExpiresAt: string | null;
    lastAttemptAt: string | null;
    providerAcceptedAt: string | null;
    providerRef: string | null;
  } {
  if (!isRecord(value)) return false;
  const record = value;
  if (!isEmergencyForwardPointer(value)) return false;
  const allowed = new Set([
    "schemaVersion",
    "ingressId",
    "rawKey",
    "mailboxId",
    "rawSize",
    "rawSha256",
    "archivedAt",
    "etag",
    "version",
    "reason",
    "createdAt",
    "generation",
    "enqueuedAt",
    "leaseExpiresAt",
    "lastAttemptAt",
    "providerAcceptedAt",
    "providerRef",
  ]);
  return (
    Object.keys(record).every((key) => allowed.has(key)) &&
    isEmergencyForwardReason(record.reason) &&
    typeof record.createdAt === "string" &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    new Date(record.createdAt).toISOString() === record.createdAt &&
    typeof record.generation === "number" &&
    Number.isSafeInteger(record.generation) &&
    record.generation >= 0 &&
    (record.enqueuedAt === null || isIsoTimestamp(record.enqueuedAt)) &&
    (record.leaseExpiresAt === null || isIsoTimestamp(record.leaseExpiresAt)) &&
    (record.lastAttemptAt === null || isIsoTimestamp(record.lastAttemptAt)) &&
    (record.providerAcceptedAt === null ||
      isIsoTimestamp(record.providerAcceptedAt)) &&
    (record.providerRef === null ||
      (typeof record.providerRef === "string" &&
        /^[a-f0-9]{16}$/.test(record.providerRef))) &&
    (record.generation === 0
      ? record.enqueuedAt === null &&
        record.leaseExpiresAt === null &&
        record.lastAttemptAt === null
      : record.enqueuedAt !== null && record.leaseExpiresAt !== null) &&
    (record.providerAcceptedAt === null || record.generation > 0)
  );
}

function pointerMatches(
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

type EmergencyReceiptState =
  | "deleted"
  | "forward_pending"
  | "forwarded"
  | "quarantined"
  | "rejected"
  | "stored";

type ValidEmergencyReceipt = InboundArchivePointer & {
  state: EmergencyReceiptState;
  updatedAt: string;
  errorCode?: string;
  providerAccepted?: true;
  providerRef?: string;
  reconciled?: true;
  rejectionOrigin?: "smtp_ingress";
};

type EmergencyReceiptRead =
  | { kind: "absent" }
  | { kind: "invalid"; object: R2Object }
  | { kind: "valid"; object: R2Object; value: ValidEmergencyReceipt };

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

const QUARANTINE_ERROR_CODES = new Set([
  "EMAXLEN",
  "MAILBOX_UNAVAILABLE",
  "MIME_CHARSET_UNSUPPORTED",
  "MIME_HEADER_SIZE_EXCEEDED",
  "MIME_MULTIPART_BOUNDARY_INVALID",
  "MIME_MULTIPART_BOUNDARY_MISSING",
  "MIME_PARSE_FAILED",
  "MIME_ROOT_HEADER_MISSING",
  "RAW_ARCHIVE_INTEGRITY_MISMATCH",
]);

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function hasOnlyFields(
  value: Record<string, unknown>,
  additional: readonly string[],
): boolean {
  const allowed = new Set([
    ...RECEIPT_POINTER_FIELDS,
    "state",
    "updatedAt",
    ...additional,
  ]);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isValidReceiptDetails(
  value: Record<string, unknown>,
  state: EmergencyReceiptState,
): boolean {
  switch (state) {
    case "forward_pending":
      return (
        hasOnlyFields(value, ["errorCode"]) &&
        isEmergencyForwardReason(value.errorCode)
      );
    case "forwarded":
      return (
        hasOnlyFields(value, ["providerAccepted", "providerRef"]) &&
        value.providerAccepted === true &&
        (value.providerRef === undefined ||
          (typeof value.providerRef === "string" &&
            /^[a-f0-9]{16}$/.test(value.providerRef)))
      );
    case "stored":
      return (
        hasOnlyFields(value, ["errorCode", "reconciled"]) &&
        ((value.reconciled === true &&
          value.errorCode === "MAILBOX_PROJECTION_RECOVERED") ||
          (value.reconciled === undefined &&
            (value.errorCode === undefined ||
              value.errorCode === "MAILBOX_PROJECTION_STORED")))
      );
    case "deleted":
      return (
        hasOnlyFields(value, ["errorCode", "reconciled"]) &&
        value.errorCode === "MAILBOX_PROJECTION_DELETED" &&
        (value.reconciled === undefined || value.reconciled === true)
      );
    case "quarantined":
      return (
        hasOnlyFields(value, ["errorCode"]) &&
        typeof value.errorCode === "string" &&
        QUARANTINE_ERROR_CODES.has(value.errorCode)
      );
    case "rejected":
      return (
        hasOnlyFields(value, ["errorCode", "rejectionOrigin"]) &&
        hasExactInboundSmtpRejectionAuthority(value)
      );
  }
}

function isEmergencyReceiptState(value: unknown): value is EmergencyReceiptState {
  return (
    value === "deleted" ||
    value === "forward_pending" ||
    value === "forwarded" ||
    value === "quarantined" ||
    value === "rejected" ||
    value === "stored"
  );
}

async function readEmergencyReceipt(
  bucket: Pick<EmergencyBucket, "get">,
  pointer: InboundArchivePointer,
): Promise<EmergencyReceiptRead> {
  const key = receiptKey(pointer.ingressId);
  const object = await bucket.get(key);
  if (!object) return { kind: "absent" };
  let value: unknown;
  try {
    value = JSON.parse(await object.text());
  } catch {
    return { kind: "invalid", object };
  }
  if (
    !isRecord(value) ||
    object.key !== key ||
    !pointerMatches(value, pointer) ||
    !isEmergencyReceiptState(value.state) ||
    !isIsoTimestamp(value.updatedAt) ||
    object.customMetadata?.state !== value.state ||
    !isValidReceiptDetails(value, value.state)
  ) {
    return { kind: "invalid", object };
  }
  return { kind: "valid", object, value: value as ValidEmergencyReceipt };
}

type EmergencyMarkerValue = InboundArchivePointer & {
  reason: EmergencyForwardReason;
  createdAt: string;
  generation: number;
  enqueuedAt: string | null;
  leaseExpiresAt: string | null;
  lastAttemptAt: string | null;
  providerAcceptedAt: string | null;
  providerRef: string | null;
};

type EmergencyMarkerRead =
  | { kind: "absent" }
  | { kind: "invalid"; object: R2Object }
  | {
      kind: "valid";
      object: R2Object;
      value: EmergencyMarkerValue;
    };

async function readEmergencyMarker(
  bucket: Pick<EmergencyBucket, "get">,
  key: string,
  expectedPointer?: InboundArchivePointer,
): Promise<EmergencyMarkerRead> {
  const object = await bucket.get(key);
  if (!object) return { kind: "absent" };
  let value: unknown;
  try {
    value = JSON.parse(await object.text());
  } catch {
    return { kind: "invalid", object };
  }
  if (
    !isEmergencyForwardMarker(value) ||
    object.key !== key ||
    key !== emergencyForwardMarkerKey(value.rawKey) ||
    !isRecord(object.customMetadata) ||
    Object.keys(object.customMetadata).some(
      (metadataKey) => !["ingressId", "status"].includes(metadataKey),
    ) ||
    object.customMetadata.ingressId !== value.ingressId ||
    object.customMetadata.status !== "forward_pending" ||
    (expectedPointer !== undefined && !pointerMatches(value, expectedPointer))
  ) {
    return { kind: "invalid", object };
  }
  return { kind: "valid", object, value };
}

function isEmergencyForwardEnvelope(
  value: unknown,
): value is EmergencyForwardEnvelope {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ["schemaVersion", "pointer", "generation"].includes(key),
    ) &&
    value.schemaVersion === 1 &&
    isEmergencyForwardPointer(value.pointer) &&
    typeof value.generation === "number" &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0
  );
}

function isForwardEligibleQuarantine(receipt: ValidEmergencyReceipt): boolean {
  return (
    receipt.state === "quarantined" &&
    typeof receipt.errorCode === "string" &&
    receipt.errorCode !== "MAILBOX_UNAVAILABLE" &&
    receipt.errorCode !== "RAW_ARCHIVE_INTEGRITY_MISMATCH" &&
    isEmergencyForwardReason(receipt.errorCode)
  );
}

function isDurablePolicySuppressionReceipt(
  receipt: ValidEmergencyReceipt,
): boolean {
  return (
    inboundTerminalAuthorityRequirement(receipt) === "smtp_rejected"
  );
}

function receiptNeedsMailboxTruth(receipt: ValidEmergencyReceipt): boolean {
  const requirement = inboundTerminalAuthorityRequirement(receipt);
  return (
    requirement === "stored_projection" ||
    requirement === "deleted_projection" ||
    requirement === "raw_integrity_mismatch" ||
    (receipt.state === "quarantined" &&
      receipt.errorCode === "MAILBOX_UNAVAILABLE")
  );
}

function markerLeaseIsLive(
  marker: Extract<EmergencyMarkerRead, { kind: "valid" }>,
  now: Date,
): boolean {
  return (
    marker.value.generation > 0 &&
    marker.value.leaseExpiresAt !== null &&
    Date.parse(marker.value.leaseExpiresAt) > now.getTime()
  );
}

function emergencyForwardAnomalyKey(rawKey: string): string {
  return `${EMERGENCY_FORWARD_ANOMALY_PREFIX}${encodeURIComponent(rawKey)}.json`;
}

async function settleBestEffort(
  work: () => Promise<unknown>,
  timeoutMs?: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(work),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs ?? 100);
      }),
    ]);
  } catch {
    // Diagnostic work never owns delivery or reconciliation progress.
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function persistEmergencyForwardAnomaly(
  bucket: Pick<EmergencyBucket, "put">,
  pointer: Pick<InboundArchivePointer, "ingressId" | "mailboxId" | "rawKey">,
  errorCode: string,
  runtime: Pick<EmergencyRuntime, "now" | "bestEffortTimeoutMs">,
): Promise<void> {
  await settleBestEffort(
    () =>
      bucket.put(
        emergencyForwardAnomalyKey(pointer.rawKey),
        JSON.stringify({
          schemaVersion: 1,
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
          rawKey: pointer.rawKey,
          errorCode,
          status: "pending_operator_review",
          detectedAt: runtime.now().toISOString(),
        }),
        {
          customMetadata: { errorCode, status: "pending_operator_review" },
          httpMetadata: { contentType: "application/json" },
        },
      ),
    runtime.bestEffortTimeoutMs,
  );
}

function createInitialMarker(
  pointer: InboundArchivePointer,
  reason: EmergencyForwardReason,
  runtime: Pick<EmergencyRuntime, "now" | "bestEffortTimeoutMs">,
): EmergencyMarkerValue {
  return {
    ...projectInboundArchivePointer(pointer),
    reason,
    createdAt: runtime.now().toISOString(),
    generation: 0,
    enqueuedAt: null,
    leaseExpiresAt: null,
    lastAttemptAt: null,
    providerAcceptedAt: null,
    providerRef: null,
  };
}

async function putMarker(
  bucket: Pick<EmergencyBucket, "put">,
  marker: EmergencyMarkerValue,
  condition: { etagMatches?: string; etagDoesNotMatch?: string },
): Promise<boolean> {
  return Boolean(
    await bucket.put(
      emergencyForwardMarkerKey(marker.rawKey),
      JSON.stringify(marker),
      {
        customMetadata: {
          ingressId: marker.ingressId,
          status: "forward_pending",
        },
        httpMetadata: { contentType: "application/json" },
        onlyIf: condition,
      },
    ),
  );
}

async function putReceiptState(
  bucket: Pick<EmergencyBucket, "put">,
  pointer: InboundArchivePointer,
  state: EmergencyReceiptState,
  runtime: Pick<EmergencyRuntime, "now">,
  details: Record<string, boolean | string | number>,
  condition: { etagMatches?: string; etagDoesNotMatch?: string },
): Promise<boolean> {
  return Boolean(
    await bucket.put(
      receiptKey(pointer.ingressId),
      JSON.stringify({
        ...projectInboundArchivePointer(pointer),
        state,
        updatedAt: runtime.now().toISOString(),
        ...details,
      }),
      {
        customMetadata: { state },
        httpMetadata: { contentType: "application/json" },
        onlyIf: condition,
      },
    ),
  );
}

function leaseExpiry(runtime: Pick<EmergencyRuntime, "now">): string {
  return new Date(
    runtime.now().getTime() + EMERGENCY_FORWARD_LEASE_SECONDS * 1_000,
  ).toISOString();
}

async function claimAndEnqueue(
  env: {
    RAW_MAIL_BUCKET: Pick<EmergencyBucket, "get" | "put">;
    EMERGENCY_FORWARD_QUEUE: Pick<Queue<EmergencyForwardEnvelope>, "send">;
  },
  marker: Extract<EmergencyMarkerRead, { kind: "valid" }>,
  runtime: Pick<EmergencyRuntime, "now">,
): Promise<boolean> {
  if (markerLeaseIsLive(marker, runtime.now())) return false;
  const now = runtime.now().toISOString();
  const claimed: EmergencyMarkerValue = {
    ...marker.value,
    generation: marker.value.generation + 1,
    enqueuedAt: now,
    leaseExpiresAt: leaseExpiry(runtime),
    lastAttemptAt: null,
  };
  // Cloudflare Queues can redeliver explicit retries, while R2 conditional puts
  // return null on CAS loss. The durable generation therefore selects one live
  // Queue delivery and fences every older copy before Email Service is called.
  const claimedWrite = await putMarker(
    env.RAW_MAIL_BUCKET,
    claimed,
    { etagMatches: marker.object.etag },
  );
  if (!claimedWrite) return false;
  try {
    await env.EMERGENCY_FORWARD_QUEUE.send({
      schemaVersion: 1,
      pointer: projectInboundArchivePointer(claimed),
      generation: claimed.generation,
    });
    return true;
  } catch (error) {
    const current = await readEmergencyMarker(
      env.RAW_MAIL_BUCKET,
      emergencyForwardMarkerKey(claimed.rawKey),
      claimed,
    );
    if (
      current.kind === "valid" &&
      current.value.generation === claimed.generation
    ) {
      await putMarker(
        env.RAW_MAIL_BUCKET,
        {
          ...current.value,
          leaseExpiresAt: runtime.now().toISOString(),
        },
        { etagMatches: current.object.etag },
      );
    }
    throw error;
  }
}

export async function beginEmergencyForward(
  env: {
    RAW_MAIL_BUCKET: Pick<EmergencyBucket, "put"> &
      Partial<Pick<EmergencyBucket, "delete" | "head">> & {
        get?(key: string): Promise<EmergencySidecarObject | null>;
      };
    EMERGENCY_FORWARD_QUEUE: Pick<Queue<EmergencyForwardEnvelope>, "send">;
  },
  pointer: InboundArchivePointer,
  reason: EmergencyForwardReason,
  runtime: Pick<EmergencyRuntime, "now" | "bestEffortTimeoutMs">,
): Promise<void> {
  if (!isEmergencyForwardPointer(pointer)) {
    await persistEmergencyForwardAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer,
      "EMERGENCY_FORWARD_POINTER_INTEGRITY_INVALID",
      runtime,
    );
    throw new Error("Emergency forward requires an exact SHA-256 pointer");
  }
  if (!env.RAW_MAIL_BUCKET.get || !env.RAW_MAIL_BUCKET.head) {
    throw new Error("Emergency forward authority requires R2 get and head support");
  }
  const bucket: Pick<EmergencyBucket, "get" | "head" | "put"> = {
    get: async (key) =>
      (await env.RAW_MAIL_BUCKET.get!(key)) as R2Object | null,
    head: env.RAW_MAIL_BUCKET.head.bind(env.RAW_MAIL_BUCKET),
    put: env.RAW_MAIL_BUCKET.put.bind(env.RAW_MAIL_BUCKET),
  };
  const markerKey = emergencyForwardMarkerKey(pointer.rawKey);
  let marker = await readEmergencyMarker(bucket, markerKey, pointer);
  let receipt = await readEmergencyReceipt(bucket, pointer);
  if (marker.kind === "absent") {
    await putMarker(
      bucket,
      createInitialMarker(pointer, reason, runtime),
      { etagDoesNotMatch: "*" },
    );
    marker = await readEmergencyMarker(bucket, markerKey, pointer);
  } else if (marker.kind === "invalid") {
    const receiptCanRepairMarker =
      receipt.kind === "valid" &&
      (receipt.value.state === "forward_pending" ||
        isForwardEligibleQuarantine(receipt.value));
    if (!receiptCanRepairMarker) {
      const raw = await bucket.get(pointer.rawKey);
      if (!raw || !inboundRawArchiveMatchesPointer(raw, pointer)) {
        await persistEmergencyForwardAnomaly(
          bucket,
          pointer,
          "EMERGENCY_FORWARD_DUAL_AUTHORITY_INVALID",
          runtime,
        );
        throw new Error(
          "Emergency forward marker and receipt authority are invalid",
        );
      }
    }
    await putMarker(
      bucket,
      createInitialMarker(pointer, reason, runtime),
      { etagMatches: marker.object.etag },
    );
    marker = await readEmergencyMarker(bucket, markerKey, pointer);
    if (marker.kind === "valid") {
      await persistEmergencyForwardAnomaly(
        bucket,
        pointer,
        "EMERGENCY_FORWARD_MARKER_REPAIRED",
        runtime,
      );
    }
  }
  if (marker.kind !== "valid") {
    throw new Error("Emergency forward marker was not durably committed");
  }

  receipt = await readEmergencyReceipt(bucket, pointer);
  if (marker.value.providerAcceptedAt !== null) {
    const hadConflict =
      receipt.kind !== "valid" || receipt.value.state !== "forwarded";
    const committed = await commitForwardedReceipt(
      bucket,
      pointer,
      receipt,
      marker.value.providerRef,
      runtime,
    );
    if (!committed) {
      throw new Error("Accepted emergency forward receipt could not converge");
    }
    if (hadConflict) {
      await persistEmergencyForwardAnomaly(
        bucket,
        pointer,
        "EMERGENCY_FORWARD_ACCEPTED_RECEIPT_CONFLICT",
        runtime,
      );
    }
    if (env.RAW_MAIL_BUCKET.delete) {
      await settleBestEffort(
        () => env.RAW_MAIL_BUCKET.delete!(markerKey),
        runtime.bestEffortTimeoutMs,
      );
    }
    return;
  }
  if (
    receipt.kind === "valid" &&
    (receipt.value.state === "forwarded" ||
      isDurablePolicySuppressionReceipt(receipt.value))
  ) {
    if (env.RAW_MAIL_BUCKET.delete) {
      await settleBestEffort(
        () => env.RAW_MAIL_BUCKET.delete!(markerKey),
        runtime.bestEffortTimeoutMs,
      );
    }
    return;
  }
  if (
    receipt.kind !== "valid" ||
    receipt.value.state !== "forward_pending"
  ) {
    const repairedExistingReceipt = receipt.kind !== "absent";
    const receiptWritten = await putReceiptState(
      bucket,
      pointer,
      "forward_pending",
      runtime,
      { errorCode: reason },
      receipt.kind === "absent"
        ? { etagDoesNotMatch: "*" }
        : { etagMatches: receipt.object.etag },
    );
    if (!receiptWritten) {
      receipt = await readEmergencyReceipt(bucket, pointer);
      if (
        receipt.kind !== "valid" ||
        receipt.value.state !== "forward_pending"
      ) {
        throw new Error("Emergency forward receipt transition lost its race");
      }
    }
    if (repairedExistingReceipt) {
      await persistEmergencyForwardAnomaly(
        bucket,
        pointer,
        "EMERGENCY_FORWARD_RECEIPT_REPAIRED",
        runtime,
      );
    }
  }
  const currentMarker = await readEmergencyMarker(bucket, markerKey, pointer);
  if (currentMarker.kind !== "valid") {
    throw new Error("Emergency forward marker authority was lost");
  }
  const enqueued = await claimAndEnqueue(
    {
      RAW_MAIL_BUCKET: bucket,
      EMERGENCY_FORWARD_QUEUE: env.EMERGENCY_FORWARD_QUEUE,
    },
    currentMarker,
    runtime,
  );
  if (!enqueued) {
    const winner = await readEmergencyMarker(bucket, markerKey, pointer);
    if (winner.kind !== "valid" || winner.value.generation <= 0) {
      throw new Error("Emergency forward Queue authority could not converge");
    }
    await env.EMERGENCY_FORWARD_QUEUE.send({
      schemaVersion: 1,
      pointer: projectInboundArchivePointer(winner.value),
      generation: winner.value.generation,
    });
  }
}

type FinalMailboxTruth =
  | "active"
  | "deleted"
  | "indeterminate"
  | "stored";

async function boundedInfrastructureRead<T>(
  work: () => Promise<T>,
  runtime: Pick<EmergencyRuntime, "infrastructureTimeoutMs">,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Emergency truth read timed out")),
          runtime.infrastructureTimeoutMs ??
            EMERGENCY_FORWARD_INFRASTRUCTURE_TIMEOUT_MS,
        );
      }),
    ]);
    return { ok: true, value };
  } catch {
    return { ok: false };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function requireBoundedInfrastructureOperation<T>(
  work: () => Promise<T>,
  runtime: Pick<EmergencyRuntime, "infrastructureTimeoutMs">,
): Promise<T> {
  const result = await boundedInfrastructureRead(work, runtime);
  if (!result.ok) {
    throw new Error("Emergency infrastructure operation timed out");
  }
  return result.value;
}

function boundedEmergencyBucket(
  bucket: EmergencyBucket,
  runtime: Pick<EmergencyRuntime, "infrastructureTimeoutMs">,
): EmergencyBucket {
  return {
    async get(key) {
      const object = await requireBoundedInfrastructureOperation(
        () => bucket.get(key),
        runtime,
      );
      if (!object) return null;
      return {
        key: object.key,
        version: object.version,
        size: object.size,
        etag: object.etag,
        body: object.body,
        customMetadata: object.customMetadata,
        checksums: object.checksums,
        text: () =>
          requireBoundedInfrastructureOperation(
            () => object.text(),
            runtime,
          ),
      };
    },
    head: (key) =>
      requireBoundedInfrastructureOperation(() => bucket.head(key), runtime),
    put: (key, value, options) =>
      requireBoundedInfrastructureOperation(
        () => bucket.put(key, value, options),
        runtime,
      ),
    delete: (key) =>
      requireBoundedInfrastructureOperation(() => bucket.delete(key), runtime),
    list: (options) =>
      requireBoundedInfrastructureOperation(() => bucket.list(options), runtime),
  };
}

async function finalMailboxTruth(
  env: Pick<EmergencyEnvironment, "DB" | "BUCKET" | "MAILBOX">,
  pointer: InboundArchivePointer,
  runtime: Pick<EmergencyRuntime, "infrastructureTimeoutMs">,
): Promise<FinalMailboxTruth> {
  const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(pointer.mailboxId));
  const deleted =
    pointer.rawSha256 !== undefined && mailbox.getInboundDeletionAuthority
      ? await boundedInfrastructureRead(
          () =>
            mailbox.getInboundDeletionAuthority!({
              ...projectInboundArchivePointer(pointer),
              rawSha256: pointer.rawSha256!,
            }),
          runtime,
        )
      : { ok: true as const, value: null };
  if (!deleted.ok) return "indeterminate";
  if (
    deleted.value &&
    typeof deleted.value === "object" &&
    !Array.isArray(deleted.value) &&
    Object.keys(deleted.value).sort().join("\0") ===
      ["deletedAt", "generation"].sort().join("\0") &&
    Number.isSafeInteger(deleted.value.generation) &&
    deleted.value.generation >= 2 &&
    isIsoTimestamp(deleted.value.deletedAt)
  ) {
    return "deleted";
  }
  const stored = await boundedInfrastructureRead(
    () => mailbox.getEmail(pointer.ingressId),
    runtime,
  );
  if (!stored.ok) return "indeterminate";
  // A live mailbox row under this ingress id is delivery truth: the recipient
  // already holds the mail, so the emergency copy has nothing left to rescue.
  // Requiring an exact generation-1 archive-authority match on top of it left
  // delivered mail retrying forever whenever the authority row had drifted.
  if (stored.value) return "stored";
  // Ownership and active status are admission-time policy, not post-acceptance
  // delivery truth. Once raw MIME is safe, only a mailbox projection or an
  // exact tombstone can suppress emergency delivery.
  return "active";
}

async function suppressForward(
  env: Pick<EmergencyEnvironment, "RAW_MAIL_BUCKET">,
  pointer: InboundArchivePointer,
  truth: Exclude<FinalMailboxTruth, "active" | "indeterminate"> | "integrity_mismatch",
  runtime: Pick<EmergencyRuntime, "now">,
): Promise<void> {
  let targetState: Exclude<EmergencyReceiptState, "forward_pending" | "forwarded">;
  let errorCode: string;
  if (truth === "stored") {
    targetState = "stored";
    errorCode = "MAILBOX_PROJECTION_STORED";
  } else if (truth === "deleted") {
    targetState = "deleted";
    errorCode = "MAILBOX_PROJECTION_DELETED";
  } else {
    targetState = "quarantined";
    errorCode = "RAW_ARCHIVE_INTEGRITY_MISMATCH";
  }
  let receipt = await readEmergencyReceipt(env.RAW_MAIL_BUCKET, pointer);
  if (
    receipt.kind !== "valid" ||
    receipt.value.state !== targetState ||
    receipt.value.errorCode !== errorCode
  ) {
    await putReceiptState(
      env.RAW_MAIL_BUCKET,
      pointer,
      targetState,
      runtime,
      { errorCode },
      receipt.kind === "absent"
        ? { etagDoesNotMatch: "*" }
        : { etagMatches: receipt.object.etag },
    );
    receipt = await readEmergencyReceipt(env.RAW_MAIL_BUCKET, pointer);
  }
  const value = receipt.kind === "valid" ? receipt.value : null;
  const durableSuppression =
    value !== null &&
    (value.state === "forwarded" ||
      (truth === "stored" && value.state === "stored") ||
      (truth === "deleted" && value.state === "deleted") ||
      (truth === "integrity_mismatch" &&
        value.state === "quarantined" &&
        value.errorCode === "RAW_ARCHIVE_INTEGRITY_MISMATCH"));
  if (!durableSuppression) {
    throw new Error("Emergency forward suppression was not durably committed");
  }
  await env.RAW_MAIL_BUCKET.delete(emergencyForwardMarkerKey(pointer.rawKey));
}

async function bestEffortMailTelemetryLogRef(
  kind: "ingress" | "message" | "object",
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

async function repairMarkerFromPendingReceipt(
  bucket: Pick<EmergencyBucket, "get" | "put">,
  pointer: InboundArchivePointer,
  reason: EmergencyForwardReason,
  generation: number,
  current: EmergencyMarkerRead,
  runtime: Pick<EmergencyRuntime, "now">,
): Promise<Extract<EmergencyMarkerRead, { kind: "valid" }> | null> {
  const raw = await bucket.get(pointer.rawKey);
  if (!raw || !inboundRawArchiveMatchesPointer(raw, pointer)) return null;
  const repairAuditCode =
    current.kind === "absent"
      ? "EMERGENCY_FORWARD_MARKER_RECREATED"
      : "EMERGENCY_FORWARD_MARKER_REPAIRED";
  const now = runtime.now().toISOString();
  const repaired: EmergencyMarkerValue = {
    ...projectInboundArchivePointer(pointer),
    reason,
    createdAt: now,
    generation,
    enqueuedAt: generation === 0 ? null : now,
    leaseExpiresAt: generation === 0 ? null : leaseExpiry(runtime),
    lastAttemptAt: null,
    providerAcceptedAt: null,
    providerRef: null,
  };
  await putMarker(
    bucket,
    repaired,
    current.kind === "absent"
      ? { etagDoesNotMatch: "*" }
      : { etagMatches: current.object.etag },
  );
  const reread = await readEmergencyMarker(
    bucket,
    emergencyForwardMarkerKey(pointer.rawKey),
    pointer,
  );
  if (reread.kind === "valid") {
    await persistEmergencyForwardAnomaly(
      bucket,
      pointer,
      repairAuditCode,
      runtime,
    );
  }
  return reread.kind === "valid" ? reread : null;
}

async function repairReceiptFromMarker(
  bucket: Pick<EmergencyBucket, "get" | "put">,
  marker: Extract<EmergencyMarkerRead, { kind: "valid" }>,
  receipt: EmergencyReceiptRead,
  runtime: Pick<EmergencyRuntime, "now">,
): Promise<Extract<EmergencyReceiptRead, { kind: "valid" }> | null> {
  const raw = await bucket.get(marker.value.rawKey);
  if (!raw || !inboundRawArchiveMatchesPointer(raw, marker.value)) return null;
  const repairAuditCode =
    receipt.kind === "absent"
      ? "EMERGENCY_FORWARD_RECEIPT_RECREATED"
      : "EMERGENCY_FORWARD_RECEIPT_REPAIRED";
  await putReceiptState(
    bucket,
    marker.value,
    "forward_pending",
    runtime,
    { errorCode: marker.value.reason },
    receipt.kind === "absent"
      ? { etagDoesNotMatch: "*" }
      : { etagMatches: receipt.object.etag },
  );
  const reread = await readEmergencyReceipt(bucket, marker.value);
  if (reread.kind === "valid" && reread.value.state === "forward_pending") {
    await persistEmergencyForwardAnomaly(
      bucket,
      marker.value,
      repairAuditCode,
      runtime,
    );
  }
  return reread.kind === "valid" && reread.value.state === "forward_pending"
    ? reread
    : null;
}

async function heartbeatEmergencyMarker(
  bucket: Pick<EmergencyBucket, "get" | "put">,
  marker: Extract<EmergencyMarkerRead, { kind: "valid" }>,
  generation: number,
  runtime: Pick<EmergencyRuntime, "now">,
): Promise<Extract<EmergencyMarkerRead, { kind: "valid" }> | null> {
  if (marker.value.generation !== generation) return null;
  const heartbeat: EmergencyMarkerValue = {
    ...marker.value,
    lastAttemptAt: runtime.now().toISOString(),
    leaseExpiresAt: leaseExpiry(runtime),
  };
  const written = await putMarker(
    bucket,
    heartbeat,
    { etagMatches: marker.object.etag },
  );
  if (!written) return null;
  const reread = await readEmergencyMarker(
    bucket,
    emergencyForwardMarkerKey(marker.value.rawKey),
    marker.value,
  );
  return reread.kind === "valid" && reread.value.generation === generation
    ? reread
    : null;
}

async function commitForwardedReceipt(
  bucket: Pick<EmergencyBucket, "get" | "put">,
  pointer: InboundArchivePointer,
  receipt: EmergencyReceiptRead,
  providerRef: string | null,
  runtime: Pick<EmergencyRuntime, "now">,
): Promise<boolean> {
  await putReceiptState(
    bucket,
    pointer,
    "forwarded",
    runtime,
    {
      providerAccepted: true,
      ...(providerRef === null ? {} : { providerRef }),
    },
    receipt.kind === "absent"
      ? { etagDoesNotMatch: "*" }
      : { etagMatches: receipt.object.etag },
  );
  const committed = await readEmergencyReceipt(bucket, pointer);
  return (
    committed.kind === "valid" &&
    committed.value.state === "forwarded" &&
    committed.value.providerAccepted === true &&
    (providerRef === null || committed.value.providerRef === providerRef)
  );
}

async function privacySafeProviderRef(
  messageId: string,
  runtime: Pick<EmergencyRuntime, "providerLogRef" | "bestEffortTimeoutMs">,
): Promise<string | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      runtime.providerLogRef
        ? runtime.providerLogRef(messageId)
        : mailTelemetryLogRef("message", messageId),
      new Promise<null>((resolve) => {
        timeout = setTimeout(
          () => resolve(null),
          runtime.bestEffortTimeoutMs ?? 10,
        );
      }),
    ]);
    return typeof value === "string" && /^[a-f0-9]{16}$/.test(value)
      ? value
      : null;
  } catch {
    return null;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function commitProviderAcceptanceMarker(
  bucket: Pick<EmergencyBucket, "get" | "put">,
  marker: Extract<EmergencyMarkerRead, { kind: "valid" }>,
  acceptedAt: string,
  providerRef: string | null,
  runtime: Pick<EmergencyRuntime, "now">,
): Promise<Extract<EmergencyMarkerRead, { kind: "valid" }>> {
  let current: EmergencyMarkerRead = marker;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (current.kind === "valid" && current.value.providerAcceptedAt !== null) {
      if (providerRef !== null && current.value.providerRef === null) {
        await putMarker(
          bucket,
          { ...current.value, providerRef },
          { etagMatches: current.object.etag },
        );
        const enriched = await readEmergencyMarker(
          bucket,
          emergencyForwardMarkerKey(marker.value.rawKey),
          marker.value,
        );
        if (
          enriched.kind === "valid" &&
          enriched.value.providerAcceptedAt !== null
        ) {
          return enriched;
        }
      }
      return current;
    }
    const base = current.kind === "valid" ? current.value : marker.value;
    const accepted: EmergencyMarkerValue = {
      ...base,
      providerAcceptedAt: acceptedAt,
      providerRef,
      leaseExpiresAt: leaseExpiry(runtime),
    };
    await putMarker(
      bucket,
      accepted,
      current.kind === "absent"
        ? { etagDoesNotMatch: "*" }
        : { etagMatches: current.object.etag },
    );
    current = await readEmergencyMarker(
      bucket,
      emergencyForwardMarkerKey(marker.value.rawKey),
      marker.value,
    );
    if (current.kind === "valid" && current.value.providerAcceptedAt !== null) {
      return current;
    }
  }
  throw new Error("Provider acceptance marker transition could not converge");
}

export async function commitIngressForwardAcceptance(
  env: {
    RAW_MAIL_BUCKET: Pick<
      EmergencyBucket,
      "get" | "put"
    > & Partial<Pick<EmergencyBucket, "delete">>;
  },
  pointer: InboundArchivePointer,
  providerMessageId: string,
  runtime: Pick<
    EmergencyRuntime,
    "bestEffortTimeoutMs" | "now" | "providerLogRef"
  >,
): Promise<boolean> {
  if (
    !isEmergencyForwardPointer(pointer) ||
    !providerMessageId.trim()
  ) {
    throw new Error("Ingress forward acceptance authority is invalid");
  }
  const raw = await env.RAW_MAIL_BUCKET.get(pointer.rawKey);
  if (!raw || !inboundRawArchiveMatchesPointer(raw, pointer)) {
    throw new Error("Ingress forward raw authority is unavailable");
  }
  const markerKey = emergencyForwardMarkerKey(pointer.rawKey);
  let marker = await readEmergencyMarker(
    env.RAW_MAIL_BUCKET,
    markerKey,
    pointer,
  );
  if (marker.kind !== "valid") {
    const admittedAt = runtime.now().toISOString();
    await putMarker(
      env.RAW_MAIL_BUCKET,
      {
        ...createInitialMarker(
          pointer,
          "QUEUE_RETRY_EXHAUSTED",
          runtime,
        ),
        generation: 1,
        enqueuedAt: admittedAt,
        leaseExpiresAt: leaseExpiry(runtime),
        lastAttemptAt: admittedAt,
      },
      marker.kind === "absent"
        ? { etagDoesNotMatch: "*" }
        : { etagMatches: marker.object.etag },
    );
    marker = await readEmergencyMarker(
      env.RAW_MAIL_BUCKET,
      markerKey,
      pointer,
    );
  }
  if (marker.kind !== "valid") return false;
  let accepted = await commitProviderAcceptanceMarker(
    env.RAW_MAIL_BUCKET,
    marker,
    runtime.now().toISOString(),
    null,
    runtime,
  );
  let receipt = await readEmergencyReceipt(env.RAW_MAIL_BUCKET, pointer);
  const receiptCommitted = await commitForwardedReceipt(
    env.RAW_MAIL_BUCKET,
    pointer,
    receipt,
    null,
    runtime,
  );
  const durableAcceptedAt = accepted.value.providerAcceptedAt;
  if (durableAcceptedAt === null) return false;
  const providerRef = await privacySafeProviderRef(providerMessageId, runtime);
  if (providerRef !== null) {
    await settleBestEffort(
      async () => {
        accepted = await commitProviderAcceptanceMarker(
          env.RAW_MAIL_BUCKET,
          accepted,
          durableAcceptedAt,
          providerRef,
          runtime,
        );
        receipt = await readEmergencyReceipt(env.RAW_MAIL_BUCKET, pointer);
        await commitForwardedReceipt(
          env.RAW_MAIL_BUCKET,
          pointer,
          receipt,
          providerRef,
          runtime,
        );
      },
      runtime.bestEffortTimeoutMs,
    );
  }
  if (receiptCommitted && env.RAW_MAIL_BUCKET.delete) {
    await settleBestEffort(
      () => env.RAW_MAIL_BUCKET.delete!(markerKey),
      runtime.bestEffortTimeoutMs,
    );
  }
  // The accepted marker alone is durable recovery authority. If receipt
  // persistence was lost, reconciliation repairs it without sending again.
  return accepted.value.providerAcceptedAt !== null;
}

async function readPendingReceiptForMarkerKey(
  bucket: Pick<EmergencyBucket, "get">,
  markerKey: string,
): Promise<{
  pointer: InboundArchivePointer;
  reason: EmergencyForwardReason;
} | null> {
  const rawKey = rawKeyFromEmergencyForwardMarkerKey(markerKey);
  const ingressId = rawKey ? inboundIngressIdFromRawKey(rawKey) : null;
  if (!rawKey || !ingressId) return null;
  const object = await bucket.get(receiptKey(ingressId));
  if (!object) return null;
  let value: unknown;
  try {
    value = JSON.parse(await object.text());
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const record = value;
  if (
    !isEmergencyForwardPointer(value) ||
    value.rawKey !== rawKey ||
    object.key !== receiptKey(ingressId) ||
    object.customMetadata?.state !== record.state ||
    !isIsoTimestamp(record.updatedAt) ||
    (record.state !== "forward_pending" && record.state !== "quarantined") ||
    !isValidReceiptDetails(record, record.state) ||
    !isEmergencyForwardReason(record.errorCode)
  ) {
    return null;
  }
  return {
    pointer: projectInboundArchivePointer(value),
    reason: record.errorCode,
  };
}

// The send binding refuses a re-sent original outright: the archived From:
// header never matches the emergency envelope sender, and the original's
// Received: headers are rejected as "invalid headers set". So the forward is a
// freshly composed notification that carries the untouched original as a
// message/rfc822 attachment, leaving the archived bytes byte-identical.
export function emergencyForwardNotification(
  env: Pick<
    EmergencyEnvironment,
    "EMERGENCY_FORWARD_DESTINATION" | "EMERGENCY_FORWARD_FROM"
  >,
  pointer: InboundArchivePointer,
  reason: EmergencyForwardReason,
  original: ArrayBuffer,
) {
  const attachable =
    original.byteLength <= EMERGENCY_FORWARD_MAX_ATTACHMENT_BYTES;
  const summary = [
    "An inbound email did not reach its mailbox and is being forwarded for manual recovery.",
    "",
    `Reason: ${reason}`,
    `Mailbox: ${pointer.mailboxId}`,
    `Ingress: ${pointer.ingressId}`,
    `Archived at: ${pointer.archivedAt}`,
    `Raw archive object: ${pointer.rawKey}`,
    `Raw size: ${pointer.rawSize} bytes`,
    `Raw SHA-256: ${pointer.rawSha256}`,
    "",
    attachable
      ? "The untouched original is attached as original.eml."
      : "The original exceeds the outbound attachment limit; read it from the raw archive object above.",
  ].join("\n");
  return {
    from: env.EMERGENCY_FORWARD_FROM,
    to: env.EMERGENCY_FORWARD_DESTINATION,
    subject: `Emergency mail forward (${reason}): ${pointer.ingressId}`,
    text: `${summary}\n`,
    ...(attachable
      ? {
          attachments: [
            {
              content: original,
              disposition: "attachment" as const,
              filename: "original.eml",
              type: "message/rfc822",
            },
          ],
        }
      : {}),
  };
}

export async function processEmergencyForwardMessage(
  message: EmergencyQueueMessage,
  env: EmergencyEnvironment,
  runtime: EmergencyRuntime,
): Promise<void> {
  const envelope = message.body;
  if (!isEmergencyForwardEnvelope(envelope)) {
    if (
      isRecord(envelope) &&
      isRecord(envelope.pointer) &&
      typeof envelope.pointer.ingressId === "string" &&
      typeof envelope.pointer.mailboxId === "string" &&
      typeof envelope.pointer.rawKey === "string"
    ) {
      await persistEmergencyForwardAnomaly(
        env.RAW_MAIL_BUCKET,
        {
          ingressId: envelope.pointer.ingressId,
          mailboxId: envelope.pointer.mailboxId,
          rawKey: envelope.pointer.rawKey,
        },
        "EMERGENCY_FORWARD_ENVELOPE_INTEGRITY_INVALID",
        runtime,
      );
    }
    message.ack();
    return;
  }
  const pointer = envelope.pointer;
  const ingressRef = await bestEffortMailTelemetryLogRef(
    "ingress",
    pointer.ingressId,
  );
  const retry = (): void => {
    console.error("[mail-emergency-forward] delivery retry scheduled", {
      attempt: message.attempts,
      errorCode: "EMERGENCY_FORWARD_FAILED",
      ingressRef,
      operation: "emergency_forward",
      status: "retrying",
    });
    message.retry({
      delaySeconds:
        runtime.retryDelaySeconds ?? EMERGENCY_FORWARD_RETRY_SECONDS,
    });
  };
  try {
    let receipt = await readEmergencyReceipt(env.RAW_MAIL_BUCKET, pointer);
    let marker = await readEmergencyMarker(
      env.RAW_MAIL_BUCKET,
      emergencyForwardMarkerKey(pointer.rawKey),
      pointer,
    );

    if (marker.kind === "valid" && marker.value.providerAcceptedAt !== null) {
      const hadConflict =
        receipt.kind !== "valid" || receipt.value.state !== "forwarded";
      const committed = await commitForwardedReceipt(
        env.RAW_MAIL_BUCKET,
        pointer,
        receipt,
        marker.value.providerRef,
        runtime,
      );
      if (!committed) {
        retry();
        return;
      }
      if (hadConflict) {
        await persistEmergencyForwardAnomaly(
          env.RAW_MAIL_BUCKET,
          pointer,
          "EMERGENCY_FORWARD_ACCEPTED_RECEIPT_CONFLICT",
          runtime,
        );
      }
      await env.RAW_MAIL_BUCKET.delete(emergencyForwardMarkerKey(pointer.rawKey));
      message.ack();
      return;
    }

    if (
      receipt.kind === "valid" &&
      receipt.value.state === "forwarded" &&
      receipt.value.providerAccepted === true
    ) {
      await env.RAW_MAIL_BUCKET.delete(emergencyForwardMarkerKey(pointer.rawKey));
      message.ack();
      return;
    }
    if (
      receipt.kind === "valid" &&
      isDurablePolicySuppressionReceipt(receipt.value)
    ) {
      await env.RAW_MAIL_BUCKET.delete(emergencyForwardMarkerKey(pointer.rawKey));
      message.ack();
      return;
    }

    if (
      receipt.kind === "valid" &&
      (receipt.value.state === "forward_pending" ||
        isForwardEligibleQuarantine(receipt.value)) &&
      marker.kind !== "valid"
    ) {
      const reason = isEmergencyForwardReason(receipt.value.errorCode)
        ? receipt.value.errorCode
        : null;
      marker = reason
        ? (await repairMarkerFromPendingReceipt(
            env.RAW_MAIL_BUCKET,
            pointer,
            reason,
            envelope.generation,
            marker,
            runtime,
          )) ?? marker
        : marker;
    }
    if (
      marker.kind === "valid" &&
      (receipt.kind !== "valid" ||
        isForwardEligibleQuarantine(receipt.value))
    ) {
      receipt =
        (await repairReceiptFromMarker(
          env.RAW_MAIL_BUCKET,
          marker,
          receipt,
          runtime,
        )) ?? receipt;
    }
    if (
      marker.kind !== "valid" ||
      receipt.kind !== "valid" ||
      (receipt.value.state !== "forward_pending" &&
        !receiptNeedsMailboxTruth(receipt.value))
    ) {
      await persistEmergencyForwardAnomaly(
        env.RAW_MAIL_BUCKET,
        pointer,
        "EMERGENCY_FORWARD_AUTHORITY_UNRECOVERABLE",
        runtime,
      );
      retry();
      return;
    }

    if (marker.value.generation !== envelope.generation) {
      message.ack();
      return;
    }
    if (
      marker.value.lastAttemptAt !== null &&
      markerLeaseIsLive(marker, runtime.now())
    ) {
      retry();
      return;
    }
    const heartbeat = await heartbeatEmergencyMarker(
      env.RAW_MAIL_BUCKET,
      marker,
      envelope.generation,
      runtime,
    );
    if (!heartbeat) {
      const winner = await readEmergencyMarker(
        env.RAW_MAIL_BUCKET,
        emergencyForwardMarkerKey(pointer.rawKey),
        pointer,
      );
      if (
        winner.kind === "valid" &&
        winner.value.generation !== envelope.generation
      ) {
        message.ack();
        return;
      }
      retry();
      return;
    }
    marker = heartbeat;

    if (marker.value.providerAcceptedAt !== null) {
      const committed = await commitForwardedReceipt(
        env.RAW_MAIL_BUCKET,
        pointer,
        receipt,
        marker.value.providerRef,
        runtime,
      );
      if (committed) {
        await env.RAW_MAIL_BUCKET.delete(
          emergencyForwardMarkerKey(pointer.rawKey),
        );
        message.ack();
      } else {
        retry();
      }
      return;
    }

    const rawRead = await boundedInfrastructureRead(
      () => env.RAW_MAIL_BUCKET.get(pointer.rawKey),
      runtime,
    );
    if (!rawRead.ok || !rawRead.value) {
      await persistEmergencyForwardAnomaly(
        env.RAW_MAIL_BUCKET,
        pointer,
        rawRead.ok
          ? "EMERGENCY_FORWARD_RAW_ARCHIVE_MISSING"
          : "EMERGENCY_FORWARD_RAW_ARCHIVE_READ_FAILED",
        runtime,
      );
      retry();
      return;
    }
    const raw = rawRead.value;
    if (!inboundRawArchiveMatchesPointer(raw, pointer)) {
      await suppressForward(env, pointer, "integrity_mismatch", runtime);
      console.error("[mail-emergency-forward] raw integrity suppressed", {
        errorCode: "RAW_ARCHIVE_INTEGRITY_MISMATCH",
        ingressRef,
        operation: "emergency_forward",
        status: "suppressed",
      });
      message.ack();
      return;
    }

    const finalTruth = await finalMailboxTruth(env, pointer, runtime);
    if (finalTruth !== "active" && finalTruth !== "indeterminate") {
      await suppressForward(env, pointer, finalTruth, runtime);
      message.ack();
      return;
    }
    if (receiptNeedsMailboxTruth(receipt.value)) {
      receipt =
        (await repairReceiptFromMarker(
          env.RAW_MAIL_BUCKET,
          marker,
          receipt,
          runtime,
        )) ?? receipt;
      if (receipt.kind !== "valid" || receipt.value.state !== "forward_pending") {
        throw new Error("Stale terminal receipt could not return to forwarding");
      }
    }
    const beforeSendTruth = await finalMailboxTruth(env, pointer, runtime);
    if (beforeSendTruth !== "active" && beforeSendTruth !== "indeterminate") {
      await suppressForward(env, pointer, beforeSendTruth, runtime);
      message.ack();
      return;
    }

    const providerSend = await runInboundWorkWithDeadline(
      async () =>
        env.EMERGENCY_EMAIL.send(
          emergencyForwardNotification(
            env,
            pointer,
            marker.value.reason,
            await new Response(raw.body).arrayBuffer(),
          ),
        ),
      {
        now: () => runtime.now().getTime(),
        scheduler: runtime.deadlineScheduler,
        timeoutMs:
          runtime.providerTimeoutMs ??
          EMERGENCY_FORWARD_PROVIDER_TIMEOUT_MS,
      },
    );
    if (providerSend.status !== "completed") {
      throw new Error("Emergency Email Service acceptance is ambiguous");
    }
    // A send that returns without throwing is provider acceptance. The binding
    // documents a messageId on the result, but it only feeds an optional
    // telemetry ref, so demanding it would keep an accepted forward retrying.
    const result: { messageId?: unknown } | undefined = providerSend.value;
    const providerMessageId =
      typeof result?.messageId === "string" && result.messageId.trim()
        ? result.messageId
        : null;
    const acceptedAt = runtime.now().toISOString();
    const acceptedMarker = await commitProviderAcceptanceMarker(
      env.RAW_MAIL_BUCKET,
      marker,
      acceptedAt,
      null,
      runtime,
    );
    const committed = await commitForwardedReceipt(
      env.RAW_MAIL_BUCKET,
      pointer,
      receipt,
      null,
      runtime,
    );
    if (!committed) {
      throw new Error("Forward accepted but receipt transition was not committed");
    }
    const providerRef =
      providerMessageId === null
        ? null
        : await privacySafeProviderRef(providerMessageId, runtime);
    if (providerRef !== null) {
      await settleBestEffort(
        async () => {
          await commitProviderAcceptanceMarker(
            env.RAW_MAIL_BUCKET,
            acceptedMarker,
            acceptedAt,
            providerRef,
            runtime,
          );
          const acceptedReceipt = await readEmergencyReceipt(
            env.RAW_MAIL_BUCKET,
            pointer,
          );
          await commitForwardedReceipt(
            env.RAW_MAIL_BUCKET,
            pointer,
            acceptedReceipt,
            providerRef,
            runtime,
          );
        },
        runtime.bestEffortTimeoutMs,
      );
    }
    await env.RAW_MAIL_BUCKET.delete(emergencyForwardMarkerKey(pointer.rawKey));
    console.error("[mail-emergency-forward] original raw notification sent", {
      attempt: message.attempts,
      ingressRef,
      operation: "emergency_forward",
      status: "forwarded",
    });
    message.ack();
  } catch {
    retry();
  }
}

export async function processEmergencyForwardBatch(
  batch: { messages: readonly EmergencyQueueMessage[] },
  env: EmergencyEnvironment,
  runtime: EmergencyRuntime,
): Promise<void> {
  const boundedEnvironment: EmergencyEnvironment = {
    ...env,
    RAW_MAIL_BUCKET: boundedEmergencyBucket(env.RAW_MAIL_BUCKET, runtime),
  };
  await Promise.allSettled(
    batch.messages.map(async (message) => {
      const disposition = createQueueDisposition(message);
      const attempt = disposition.createScope();
      const scopedMessage: EmergencyQueueMessage = {
        ...message,
        ack: () => {
          attempt.ack();
        },
        retry: (options) => {
          attempt.retry(options);
        },
      };
      await runInboundWorkWithDeadline(
        async () =>
          processEmergencyForwardMessage(
            scopedMessage,
            boundedEnvironment,
            runtime,
          ),
        {
          now: () => runtime.now().getTime(),
          onExpire: () => attempt.close(),
          scheduler: runtime.deadlineScheduler,
          timeoutMs:
            runtime.itemTimeoutMs ?? EMERGENCY_FORWARD_ITEM_TIMEOUT_MS,
        },
      );
      attempt.close();
      if (!disposition.isSettled()) {
        disposition.retry({
          delaySeconds:
            runtime.retryDelaySeconds ?? EMERGENCY_FORWARD_RETRY_SECONDS,
        });
      }
    }),
  );
}

type EmergencyMarkerReconciliationResult = {
  authorityDurable: boolean;
  reenqueued: boolean;
};

async function reconcileOneEmergencyForwardMarker(
  listedKey: string,
  env: Pick<
    EmergencyEnvironment,
    "BUCKET" | "DB" | "EMERGENCY_FORWARD_QUEUE" | "MAILBOX" | "RAW_MAIL_BUCKET"
  >,
  runtime: Pick<
    EmergencyRuntime,
    "now" | "bestEffortTimeoutMs" | "infrastructureTimeoutMs"
  >,
): Promise<EmergencyMarkerReconciliationResult> {
  let marker = await readEmergencyMarker(env.RAW_MAIL_BUCKET, listedKey);
  if (marker.kind === "absent") {
    return { authorityDurable: true, reenqueued: false };
  }
  if (marker.kind !== "valid") {
    const pending = await readPendingReceiptForMarkerKey(
      env.RAW_MAIL_BUCKET,
      listedKey,
    );
    if (pending) {
      marker =
        (await repairMarkerFromPendingReceipt(
          env.RAW_MAIL_BUCKET,
          pending.pointer,
          pending.reason,
          0,
          marker,
          runtime,
        )) ?? marker;
    }
    if (marker.kind !== "valid") {
      const rawKey = rawKeyFromEmergencyForwardMarkerKey(listedKey);
      const ingressId = rawKey ? inboundIngressIdFromRawKey(rawKey) : null;
      if (rawKey && ingressId) {
        await persistEmergencyForwardAnomaly(
          env.RAW_MAIL_BUCKET,
          { ingressId, mailboxId: "unknown", rawKey },
          "EMERGENCY_FORWARD_MARKER_UNRECOVERABLE",
          runtime,
        );
      }
      const objectRef = await bestEffortMailTelemetryLogRef(
        "object",
        listedKey,
      );
      console.error("[mail-emergency-forward] active marker invalid", {
        errorCode: "EMERGENCY_FORWARD_MARKER_INVALID",
        objectRef,
        operation: "emergency_forward_reconcile",
        status: "pending_operator_review",
      });
      return { authorityDurable: false, reenqueued: false };
    }
  }
  const pointer = projectInboundArchivePointer(marker.value);
  let receipt = await readEmergencyReceipt(env.RAW_MAIL_BUCKET, pointer);
  if (marker.value.providerAcceptedAt !== null) {
    const hadConflict =
      receipt.kind !== "valid" || receipt.value.state !== "forwarded";
    const committed = await commitForwardedReceipt(
      env.RAW_MAIL_BUCKET,
      pointer,
      receipt,
      marker.value.providerRef,
      runtime,
    );
    if (committed) {
      if (hadConflict) {
        await persistEmergencyForwardAnomaly(
          env.RAW_MAIL_BUCKET,
          pointer,
          "EMERGENCY_FORWARD_ACCEPTED_RECEIPT_CONFLICT",
          runtime,
        );
      }
      await env.RAW_MAIL_BUCKET.delete(listedKey);
    }
    return { authorityDurable: true, reenqueued: false };
  }
  if (
    receipt.kind === "valid" &&
    receipt.value.state === "forwarded" &&
    receipt.value.providerAccepted === true
  ) {
    await env.RAW_MAIL_BUCKET.delete(listedKey);
    return { authorityDurable: true, reenqueued: false };
  }
  if (
    receipt.kind === "valid" &&
    isDurablePolicySuppressionReceipt(receipt.value)
  ) {
    await env.RAW_MAIL_BUCKET.delete(listedKey);
    return { authorityDurable: true, reenqueued: false };
  }
  if (
    receipt.kind !== "valid" ||
    isForwardEligibleQuarantine(receipt.value) ||
    receiptNeedsMailboxTruth(receipt.value)
  ) {
    // Repairing a terminal receipt back to forward_pending would resurrect a
    // forward the consumer already settled, so mailbox truth decides first.
    const truth = await finalMailboxTruth(env, pointer, runtime);
    if (truth !== "active" && truth !== "indeterminate") {
      await suppressForward(env, pointer, truth, runtime);
      return { authorityDurable: true, reenqueued: false };
    }
    receipt =
      (await repairReceiptFromMarker(
        env.RAW_MAIL_BUCKET,
        marker,
        receipt,
        runtime,
      )) ?? receipt;
  }
  if (receipt.kind !== "valid" || receipt.value.state !== "forward_pending") {
    await persistEmergencyForwardAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer,
      "EMERGENCY_FORWARD_RECEIPT_UNRECOVERABLE",
      runtime,
    );
    return { authorityDurable: true, reenqueued: false };
  }
  if (markerLeaseIsLive(marker, runtime.now())) {
    return { authorityDurable: true, reenqueued: false };
  }
  return {
    authorityDurable: true,
    reenqueued: await claimAndEnqueue(env, marker, runtime),
  };
}

export async function reconcileEmergencyForwardMarkers(
  env: Pick<
    EmergencyEnvironment,
    "BUCKET" | "DB" | "EMERGENCY_FORWARD_QUEUE" | "MAILBOX" | "RAW_MAIL_BUCKET"
  >,
  runtime: Pick<
    EmergencyRuntime,
    "now" | "bestEffortTimeoutMs" | "infrastructureTimeoutMs"
  > = defaultRuntime,
): Promise<number> {
  const cursorRead = await boundedInfrastructureRead(
    () => env.RAW_MAIL_BUCKET.get(EMERGENCY_FORWARD_RECONCILIATION_CURSOR_KEY),
    runtime,
  );
  if (!cursorRead.ok) {
    throw new Error("Emergency forward cursor read failed or timed out");
  }
  const cursorObject = cursorRead.value;
  let cursor: string | undefined;
  let cursorEtag: string | undefined;
  let cursorWasInvalid = false;
  if (cursorObject) {
    let value: unknown;
    try {
      const cursorBodyRead = await boundedInfrastructureRead(
        () => cursorObject.text(),
        runtime,
      );
      value = cursorBodyRead.ok ? JSON.parse(cursorBodyRead.value) : null;
    } catch {
      value = null;
    }
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (key) => !["schemaVersion", "cursor", "updatedAt"].includes(key),
      ) ||
      value.schemaVersion !== 1 ||
      (value.cursor !== null && typeof value.cursor !== "string") ||
      !isIsoTimestamp(value.updatedAt)
    ) {
      cursorWasInvalid = true;
      console.error("[mail-emergency-forward] reconciliation cursor reset", {
        errorCode: "EMERGENCY_FORWARD_CURSOR_INVALID",
        operation: "emergency_forward_reconcile",
        status: "restarted",
      });
      cursor = undefined;
      cursorEtag = cursorObject.etag;
    } else {
      cursor = value.cursor === null ? undefined : value.cursor;
      cursorEtag = cursorObject.etag;
    }
  }
  const pageRead = await boundedInfrastructureRead(
    () => env.RAW_MAIL_BUCKET.list({
      prefix: EMERGENCY_FORWARD_ACTIVE_PREFIX,
      limit: EMERGENCY_FORWARD_RECONCILIATION_BATCH_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    }),
    runtime,
  );
  if (!pageRead.ok) {
    throw new Error("Emergency forward marker listing failed or timed out");
  }
  const page = pageRead.value;
  if (page.truncated && !page.cursor) {
    throw new Error("Emergency forward marker listing omitted its cursor");
  }
  let reenqueued = 0;
  let pageComplete = true;
  for (const listed of page.objects) {
    const processed = await boundedInfrastructureRead(
      () => reconcileOneEmergencyForwardMarker(listed.key, env, runtime),
      runtime,
    );
    if (!processed.ok) {
      pageComplete = false;
      const objectRef = await bestEffortMailTelemetryLogRef(
        "object",
        listed.key,
      );
      console.error("[mail-emergency-forward] marker reconciliation timed out", {
        errorCode: "EMERGENCY_FORWARD_MARKER_RECONCILIATION_FAILED",
        objectRef,
        operation: "emergency_forward_reconcile",
        recoveryAction: "retry_same_cursor",
        status: "degraded",
      });
      continue;
    }
    if (!processed.value.authorityDurable) pageComplete = false;
    if (processed.value.reenqueued) reenqueued += 1;
  }
  if (!pageComplete) return reenqueued;
  const nextCursor = page.truncated ? page.cursor! : null;
  const cursorWrite = await boundedInfrastructureRead(
    () => env.RAW_MAIL_BUCKET.put(
      EMERGENCY_FORWARD_RECONCILIATION_CURSOR_KEY,
      JSON.stringify({
        schemaVersion: 1,
        cursor: nextCursor,
        updatedAt: runtime.now().toISOString(),
      }),
      {
        httpMetadata: { contentType: "application/json" },
        onlyIf:
          cursorEtag === undefined
            ? { etagDoesNotMatch: "*" }
            : { etagMatches: cursorEtag },
      },
    ),
    runtime,
  );
  if (!cursorWrite.ok || !cursorWrite.value) {
    throw new Error("Emergency forward reconciliation cursor CAS failed");
  }
  if (cursorWasInvalid) {
    await settleBestEffort(
      () =>
        env.RAW_MAIL_BUCKET.put(
          `${EMERGENCY_FORWARD_ANOMALY_PREFIX}reconciliation-cursor.json`,
          JSON.stringify({
            schemaVersion: 1,
            errorCode: "EMERGENCY_FORWARD_CURSOR_INVALID",
            status: "restarted",
            detectedAt: runtime.now().toISOString(),
          }),
          {
            customMetadata: {
              errorCode: "EMERGENCY_FORWARD_CURSOR_INVALID",
              status: "restarted",
            },
            httpMetadata: { contentType: "application/json" },
          },
        ),
      runtime.bestEffortTimeoutMs,
    );
  }
  return reenqueued;
}
