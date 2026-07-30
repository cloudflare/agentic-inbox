import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { InboundArchivePointer } from "../inbound-email.ts";
import {
  beginEmergencyForward,
  commitIngressForwardAcceptance,
  EMERGENCY_FORWARD_LEASE_SECONDS,
  EMERGENCY_FORWARD_MAX_ATTACHMENT_BYTES,
  EMERGENCY_FORWARD_PARKING_RETRY_SECONDS,
  EMERGENCY_FORWARD_RECONCILIATION_CURSOR_KEY,
  EMERGENCY_FORWARD_RETRY_SECONDS,
  emergencyForwardMarkerKey,
  emergencyForwardNotification,
  type EmergencyForwardEnvelope,
  processEmergencyForwardBatch,
  processEmergencyForwardMessage,
  reconcileEmergencyForwardMarkers,
} from "./emergency-forward.ts";
import type { InboundDeadlineScheduler } from "./inbound-work-deadline.ts";

const rawSource = "raw";
const rawSha256 = createHash("sha256").update(rawSource).digest("hex");
const pointer: InboundArchivePointer = {
  schemaVersion: 1,
  ingressId: "emergency-forward-1",
  rawKey: "raw/2026/07/17/10/20/emergency-forward-1.eml",
  mailboxId: "team@example.com",
  rawSize: rawSource.length,
  rawSha256,
  archivedAt: "2026-07-17T10:20:00.000Z",
  etag: "raw-etag",
  version: "raw-version",
};

function pointerFor(index: number): InboundArchivePointer {
  const suffix = String(index).padStart(2, "0");
  return {
    ...pointer,
    ingressId: `emergency-forward-${suffix}`,
    rawKey: `raw/2026/07/17/10/20/emergency-forward-${suffix}.eml`,
    etag: `raw-etag-${suffix}`,
    version: `raw-version-${suffix}`,
  };
}

function manualDeadlineScheduler(): InboundDeadlineScheduler & {
  fireDelay(delayMs: number): void;
} {
  let nextHandle = 0;
  const pending = new Map<number, { callback: () => void; delayMs: number }>();
  return {
    setTimeout(callback, delayMs) {
      nextHandle += 1;
      pending.set(nextHandle, { callback, delayMs });
      return nextHandle;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
    fireDelay(delayMs) {
      const matches = [...pending.entries()].filter(
        ([, value]) => value.delayMs === delayMs,
      );
      assert.ok(matches.length > 0, `no ${delayMs}ms deadline was pending`);
      for (const [handle, value] of matches) {
        pending.delete(handle);
        value.callback();
      }
    },
  };
}

function receiptBody(
  state:
    | "deleted"
    | "forward_pending"
    | "forwarded"
    | "quarantined"
    | "rejected"
    | "stored",
) {
  const details =
    state === "forward_pending"
      ? { errorCode: "MIME_PARSE_FAILED" }
      : state === "forwarded"
        ? { providerAccepted: true }
      : state === "stored"
        ? { errorCode: "MAILBOX_PROJECTION_STORED" }
        : state === "deleted"
          ? { errorCode: "MAILBOX_PROJECTION_DELETED" }
          : state === "rejected"
            ? {
                errorCode: "MAILBOX_INACTIVE",
                rejectionOrigin: "smtp_ingress",
              }
            : { errorCode: "RAW_ARCHIVE_INTEGRITY_MISMATCH" };
  return JSON.stringify({
    ...pointer,
    state,
    updatedAt: "2026-07-17T10:31:00.000Z",
    ...details,
  });
}

function fixture(options: {
  sendResult?: unknown;
  sendThrows?: boolean;
  receiptCommitFailsAfterSend?: boolean;
  suppressionCommitFails?: boolean;
  suppressionConcurrentLegacyRejected?: boolean;
  truths?: Array<"active" | "deleted" | "inactive" | "stored" | "unowned">;
} = {}) {
  const values = new Map<string, string>();
  const metadata = new Map<string, Record<string, string>>();
  const etags = new Map<string, string>();
  const versions = new Map<string, string>();
  const queues: EmergencyForwardEnvelope[] = [];
  const sent: unknown[] = [];
  const acks: string[] = [];
  const retries: unknown[] = [];
  const truth = [...(options.truths ?? ["active", "active"] )];
  let truthIndex = 0;
  const currentTruth = () => truth[truthIndex] ?? "active";
  let putCount = 0;
  let forwardedReceiptCommitFailed = false;

  values.set(pointer.rawKey, rawSource);
  metadata.set(pointer.rawKey, {
    schemaVersion: "1",
    ingressId: pointer.ingressId,
    mailboxId: pointer.mailboxId,
    rawSize: String(pointer.rawSize),
    rawSha256,
    archivedAt: pointer.archivedAt,
  });
  etags.set(pointer.rawKey, pointer.etag);
  versions.set(pointer.rawKey, pointer.version);

  const bucket = {
    async get(key: string) {
      const value = values.get(key);
      if (value === undefined) return null;
      return {
        key,
        version: versions.get(key) ?? "sidecar-version",
        size: key === pointer.rawKey ? pointer.rawSize : value.length,
        etag: etags.get(key) ?? "sidecar-etag",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(value));
            controller.close();
          },
        }),
        customMetadata: metadata.get(key),
        ...(metadata.get(key)?.rawSha256
          ? {
              checksums: {
                sha256: Uint8Array.from(
                  Buffer.from(metadata.get(key)?.rawSha256 ?? "", "hex"),
                ).buffer,
              },
            }
          : {}),
        async text() { return value; },
      };
    },
    async head(key: string) {
      if (!values.has(key)) return null;
      return {
        etag: etags.get(key) ?? "sidecar-etag",
        customMetadata: metadata.get(key),
      };
    },
    async put(key: string, value: string, putOptions?: {
      customMetadata?: Record<string, string>;
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    }) {
      putCount += 1;
      if (
        options.receiptCommitFailsAfterSend &&
        sent.length > 0 &&
        key.startsWith("receipts/") &&
        !forwardedReceiptCommitFailed
      ) {
        forwardedReceiptCommitFailed = true;
        return null;
      }
      if (options.suppressionCommitFails && key.startsWith("receipts/")) {
        const state = JSON.parse(value).state;
        if (["deleted", "quarantined", "rejected", "stored"].includes(state)) {
          return null;
        }
      }
      if (
        options.suppressionConcurrentLegacyRejected &&
        key.startsWith("receipts/") &&
        JSON.parse(value).state === "quarantined"
      ) {
        values.set(
          key,
          JSON.stringify({
            ...pointer,
            state: "rejected",
            updatedAt: "2026-07-17T10:31:00.000Z",
            errorCode: "MAILBOX_INACTIVE",
          }),
        );
        metadata.set(key, { state: "rejected" });
        etags.set(key, `etag-${putCount}-legacy-rejected`);
        return null;
      }
      const current = etags.get(key);
      if (putOptions?.onlyIf?.etagDoesNotMatch === "*" && current) return null;
      if (putOptions?.onlyIf?.etagMatches && current !== putOptions.onlyIf.etagMatches) {
        return null;
      }
      values.set(key, value);
      metadata.set(key, putOptions?.customMetadata ?? {});
      const etag = `etag-${putCount}`;
      etags.set(key, etag);
      return { etag };
    },
    async delete(key: string) {
      values.delete(key);
      metadata.delete(key);
      etags.delete(key);
    },
    async list({
      prefix,
      limit,
      cursor,
    }: {
      prefix: string;
      limit: number;
      cursor?: string;
    }) {
      const keys = [...values.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort();
      const start = cursor === undefined ? 0 : Number(cursor);
      const objects = keys
        .slice(start, start + limit)
        .map((key) => ({ key }));
      const truncated = start + objects.length < keys.length;
      return {
        objects,
        truncated,
        ...(truncated ? { cursor: String(start + objects.length) } : {}),
      };
    },
  };

  const env = {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                const current = currentTruth();
                truthIndex += 1;
                return current === "active"
                  ? { id: pointer.mailboxId }
                  : null;
              },
            };
          },
        };
      },
    },
    BUCKET: {
      async head() {
        if (currentTruth() === "unowned") {
          truthIndex += 1;
          return null;
        }
        return {};
      },
    },
    RAW_MAIL_BUCKET: bucket,
    EMERGENCY_FORWARD_QUEUE: {
      async send(value: EmergencyForwardEnvelope) { queues.push(value); },
    },
    EMERGENCY_EMAIL: {
      async send(message: unknown) {
        sent.push(message);
        if (options.sendThrows) throw new Error("ambiguous provider failure");
        return ("sendResult" in options
          ? options.sendResult
          : { messageId: "provider-message-id" }) as { messageId: string };
      },
    },
    EMERGENCY_FORWARD_FROM: "emergency-forward@example.com",
    EMERGENCY_FORWARD_DESTINATION: "heshamelmahdi@gmail.com",
    MAILBOX: {
      idFromName(value: string) { return value; },
      get() {
        return {
          async isEmailDeleted() {
            if (currentTruth() === "deleted") {
              truthIndex += 1;
              return true;
            }
            return false;
          },
          async getInboundDeletionAuthority() {
            if (currentTruth() === "deleted") {
              truthIndex += 1;
              return {
                generation: 2,
                deletedAt: "2026-07-17T10:31:00.000Z",
              };
            }
            return null;
          },
          async getEmail() {
            const current = currentTruth();
            truthIndex += 1;
            return current === "stored" ? { id: pointer.ingressId } : null;
          },
        };
      },
    },
  };
  const runtime = {
    now: () => new Date("2026-07-17T10:30:00.000Z"),
  };
  const message = {
    id: "queue-message-1",
    body: { schemaVersion: 1, pointer, generation: 1 },
    attempts: 1,
    ack: () => acks.push("ack"),
    retry: (value?: unknown) => retries.push(value),
  };
  return { acks, bucket, env, etags, message, metadata, queues, retries, runtime, sent, values, versions };
}

test("durably markers and receipts before the emergency Queue handoff", async () => {
  const f = fixture();
  let sawMarker = false;
  f.env.EMERGENCY_FORWARD_QUEUE.send = async () => {
    sawMarker = f.values.has(emergencyForwardMarkerKey(pointer.rawKey));
    throw new Error("Queue unavailable");
  };
  await assert.rejects(
    beginEmergencyForward(
      f.env,
      pointer,
      "QUEUE_RETRY_EXHAUSTED",
      f.runtime,
    ),
  );
  assert.equal(sawMarker, true);
  assert.equal(
    (await f.env.RAW_MAIL_BUCKET.head(`receipts/${pointer.ingressId}.json`))
      ?.customMetadata?.state,
    "forward_pending",
  );
});

test("ingress recovery reason commits validator-readable forwarding authority", async () => {
  const f = fixture();

  await beginEmergencyForward(
    f.env,
    pointer,
    "INGRESS_RECOVERY_REQUIRED",
    f.runtime,
  );

  assert.equal(
    JSON.parse(
      f.values.get(emergencyForwardMarkerKey(pointer.rawKey)) ?? "null",
    ).reason,
    "INGRESS_RECOVERY_REQUIRED",
  );
  assert.equal(
    JSON.parse(
      f.values.get(`receipts/${pointer.ingressId}.json`) ?? "null",
    ).state,
    "forward_pending",
  );
  assert.deepEqual(f.queues, [
    { schemaVersion: 1, pointer, generation: 1 },
  ]);
});

test("fresh ingress acceptance creates a valid accepted generation and never resends", async () => {
  const f = fixture();
  const accepted = await commitIngressForwardAcceptance(
    {
      RAW_MAIL_BUCKET: {
        get: f.env.RAW_MAIL_BUCKET.get.bind(f.env.RAW_MAIL_BUCKET),
        put: f.env.RAW_MAIL_BUCKET.put.bind(f.env.RAW_MAIL_BUCKET),
      },
    },
    pointer,
    "ingress-provider-message",
    f.runtime,
  );

  assert.equal(accepted, true);
  const marker = JSON.parse(
    f.values.get(emergencyForwardMarkerKey(pointer.rawKey)) ?? "null",
  );
  assert.equal(marker.generation, 1);
  assert.equal(marker.providerAcceptedAt, "2026-07-17T10:30:00.000Z");
  assert.equal(typeof marker.enqueuedAt, "string");
  assert.equal(typeof marker.leaseExpiresAt, "string");
  assert.equal(
    JSON.parse(
      f.values.get(`receipts/${pointer.ingressId}.json`) ?? "null",
    ).state,
    "forwarded",
  );

  await processEmergencyForwardMessage(
    {
      ...f.message,
      body: { schemaVersion: 1, pointer, generation: 1 },
    },
    f.env,
    f.runtime,
  );
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.acks, ["ack"]);
});

test("ingress acceptance is durable before provider diagnostics start", async () => {
  const f = fixture();
  let observedDurableAuthority = false;

  await commitIngressForwardAcceptance(
    {
      RAW_MAIL_BUCKET: {
        get: f.env.RAW_MAIL_BUCKET.get.bind(f.env.RAW_MAIL_BUCKET),
        put: f.env.RAW_MAIL_BUCKET.put.bind(f.env.RAW_MAIL_BUCKET),
      },
    },
    pointer,
    "ingress-provider-message",
    {
      ...f.runtime,
      async providerLogRef() {
        const marker = JSON.parse(
          f.values.get(emergencyForwardMarkerKey(pointer.rawKey)) ?? "null",
        );
        const receipt = JSON.parse(
          f.values.get(`receipts/${pointer.ingressId}.json`) ?? "null",
        );
        observedDurableAuthority =
          marker.providerAcceptedAt !== null &&
          marker.providerRef === null &&
          receipt.state === "forwarded" &&
          receipt.providerAccepted === true;
        return "a".repeat(16);
      },
    },
  );

  assert.equal(observedDurableAuthority, true);
});

test("Queue provider acceptance is durable before provider diagnostics start", async () => {
  const f = fixture();
  let observedDurableAuthority = false;
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);

  await processEmergencyForwardMessage(f.message, f.env, {
    ...f.runtime,
    async providerLogRef() {
      const marker = JSON.parse(
        f.values.get(emergencyForwardMarkerKey(pointer.rawKey)) ?? "null",
      );
      const receipt = JSON.parse(
        f.values.get(`receipts/${pointer.ingressId}.json`) ?? "null",
      );
      observedDurableAuthority =
        marker.providerAcceptedAt !== null &&
        marker.providerRef === null &&
        receipt.state === "forwarded" &&
        receipt.providerAccepted === true;
      return "b".repeat(16);
    },
  });

  assert.equal(observedDurableAuthority, true);
  assert.deepEqual(f.acks, ["ack"]);
});

test("missing SHA authority is audited and never reaches either delivery Queue", async () => {
  const f = fixture();
  const { rawSha256: _rawSha256, ...legacyPointer } = pointer;
  await assert.rejects(
    beginEmergencyForward(
      f.env,
      legacyPointer,
      "QUEUE_RETRY_EXHAUSTED",
      f.runtime,
    ),
    /exact SHA-256 pointer/,
  );
  assert.equal(f.queues.length, 0);
  assert.equal(f.sent.length, 0);
  assert.ok(
    [...f.values.keys()].some((key) =>
      key.startsWith("system/emergency-forward/anomalies/"),
    ),
  );

  await processEmergencyForwardMessage(
    {
      ...f.message,
      body: {
        schemaVersion: 1,
        pointer: legacyPointer,
        generation: 1,
      } as unknown as EmergencyForwardEnvelope,
    },
    f.env,
    f.runtime,
  );
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.acks, ["ack"]);
});

test("sends the exact R2 raw as a fresh notification and commits forwarded truth", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  await processEmergencyForwardMessage(f.message, f.env, f.runtime);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.acks, ["ack"]);
  assert.deepEqual(f.retries, []);
  assert.equal(f.values.has(emergencyForwardMarkerKey(pointer.rawKey)), false);
  assert.equal(
    (await f.env.RAW_MAIL_BUCKET.head(`receipts/${pointer.ingressId}.json`))
      ?.customMetadata?.state,
    "forwarded",
  );
  const receipt = JSON.parse(
    f.values.get(`receipts/${pointer.ingressId}.json`) ?? "null",
  );
  assert.match(receipt.providerRef, /^[a-f0-9]{16}$/);
});

test("retries an ambiguous provider failure while retaining marker", async () => {
  const f = fixture({ sendThrows: true });
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  await processEmergencyForwardMessage(f.message, f.env, f.runtime);
  assert.deepEqual(f.acks, []);
  assert.equal(f.retries.length, 1);
  assert.equal(f.values.has(emergencyForwardMarkerKey(pointer.rawKey)), true);
});

test("a send that returns no usable messageId still settles as delivered", async () => {
  for (const sendResult of [undefined, {}, { messageId: "" }] as const) {
    const f = fixture({ sendResult });
    await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
    await processEmergencyForwardMessage(f.message, f.env, f.runtime);
    const label = JSON.stringify(sendResult ?? null);
    assert.equal(f.sent.length, 1, label);
    assert.deepEqual(f.acks, ["ack"], label);
    assert.deepEqual(f.retries, [], label);
    assert.equal(
      f.values.has(emergencyForwardMarkerKey(pointer.rawKey)),
      false,
      label,
    );
    const receipt = JSON.parse(
      f.values.get(`receipts/${pointer.ingressId}.json`) ?? "null",
    );
    assert.equal(receipt.state, "forwarded", label);
    assert.equal(receipt.providerAccepted, true, label);
    assert.equal(receipt.providerRef, undefined, label);
  }
});

test("the notification the binding accepts carries the byte-exact original", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  await processEmergencyForwardMessage(f.message, f.env, f.runtime);

  const notification = f.sent[0] as {
    from: string;
    to: string;
    subject: string;
    text: string;
    headers?: Record<string, string>;
    raw?: unknown;
    attachments: Array<{
      content: ArrayBuffer;
      disposition: string;
      filename: string;
      type: string;
    }>;
  };
  // The binding rejects a re-sent original on exactly two rules: the From:
  // header must equal the envelope sender, and no Received: header may survive
  // into the message it is asked to send.
  assert.equal(notification.from, f.env.EMERGENCY_FORWARD_FROM);
  assert.equal(notification.to, f.env.EMERGENCY_FORWARD_DESTINATION);
  assert.equal(notification.raw, undefined);
  assert.equal(
    Object.keys(notification.headers ?? {}).some(
      (key) => key.toLowerCase() === "received",
    ),
    false,
  );
  assert.equal(/^received:/im.test(notification.text), false);
  assert.match(notification.subject, /MIME_PARSE_FAILED/);
  assert.equal(notification.attachments.length, 1);
  assert.equal(notification.attachments[0].type, "message/rfc822");
  assert.equal(notification.attachments[0].disposition, "attachment");
  assert.equal(
    new TextDecoder().decode(notification.attachments[0].content),
    rawSource,
  );
});

test("an original past the outbound attachment cap is announced without it", () => {
  const notification = emergencyForwardNotification(
    {
      EMERGENCY_FORWARD_FROM: "emergency-forward@example.com",
      EMERGENCY_FORWARD_DESTINATION: "heshamelmahdi@gmail.com",
    },
    pointer,
    "EMAXLEN",
    new ArrayBuffer(EMERGENCY_FORWARD_MAX_ATTACHMENT_BYTES + 1),
  );

  assert.equal("attachments" in notification, false);
  assert.match(notification.text, new RegExp(pointer.rawKey));
  assert.equal(/^received:/im.test(notification.text), false);
  assert.equal(notification.from, "emergency-forward@example.com");
});

test("accepted send with a transient receipt CAS failure commits on retry without resending", async () => {
  const f = fixture({ receiptCommitFailsAfterSend: true });
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  await processEmergencyForwardMessage(f.message, f.env, f.runtime);
  assert.equal(f.sent.length, 1);
  assert.equal(f.retries.length, 1);
  assert.equal(f.values.has(emergencyForwardMarkerKey(pointer.rawKey)), true);
  assert.equal(
    typeof JSON.parse(
      f.values.get(emergencyForwardMarkerKey(pointer.rawKey)) ?? "null",
    ).providerAcceptedAt,
    "string",
  );

  await processEmergencyForwardMessage(f.message, f.env, f.runtime);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.acks, ["ack"]);
  assert.equal(f.values.has(emergencyForwardMarkerKey(pointer.rawKey)), false);
  const receipt = JSON.parse(
    f.values.get(`receipts/${pointer.ingressId}.json`) ?? "null",
  );
  assert.equal(receipt.state, "forwarded");
  assert.equal(receipt.providerAccepted, true);
});

test("provider acceptance survives a concurrent marker CAS winner before any retry can resend", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  const markerKey = emergencyForwardMarkerKey(pointer.rawKey);
  const originalPut = f.env.RAW_MAIL_BUCKET.put.bind(f.env.RAW_MAIL_BUCKET);
  let loseAcceptanceCas = true;
  f.env.RAW_MAIL_BUCKET.put = async (key, value, options) => {
    const body = key === markerKey ? JSON.parse(value) : null;
    if (loseAcceptanceCas && body?.providerAcceptedAt) {
      loseAcceptanceCas = false;
      f.etags.set(markerKey, "concurrent-marker-etag");
      return null;
    }
    return originalPut(key, value, options);
  };

  await processEmergencyForwardMessage(f.message, f.env, f.runtime);

  const receipt = JSON.parse(
    f.values.get(`receipts/${pointer.ingressId}.json`) ?? "null",
  );
  assert.equal(f.sent.length, 1);
  assert.equal(receipt.state, "forwarded");
  assert.equal(receipt.providerAccepted, true);
  assert.deepEqual(f.acks, ["ack"]);
  assert.deepEqual(f.retries, []);
});

test("durable provider acceptance overrides every later non-forwarded receipt class", async () => {
  const receiptKey = `receipts/${pointer.ingressId}.json`;
  for (const receiptState of [
    "absent",
    "invalid",
    "forward_pending",
    "stored",
    "deleted",
    "rejected",
    "quarantined",
  ] as const) {
    const f = fixture();
    await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
    const markerKey = emergencyForwardMarkerKey(pointer.rawKey);
    const marker = JSON.parse(f.values.get(markerKey) ?? "null");
    marker.providerAcceptedAt = "2026-07-17T10:31:00.000Z";
    f.values.set(markerKey, JSON.stringify(marker));
    if (receiptState === "absent") {
      await f.env.RAW_MAIL_BUCKET.delete(receiptKey);
    } else if (receiptState === "invalid") {
      f.values.set(receiptKey, "not-json");
      f.metadata.set(receiptKey, { state: "stored" });
    } else {
      f.values.set(receiptKey, receiptBody(receiptState));
      f.metadata.set(receiptKey, { state: receiptState });
    }

    await processEmergencyForwardMessage(f.message, f.env, {
      ...f.runtime,
      bestEffortTimeoutMs: 1,
    });

    const receipt = JSON.parse(f.values.get(receiptKey) ?? "null");
    assert.equal(receipt.state, "forwarded", receiptState);
    assert.equal(receipt.providerAccepted, true, receiptState);
    assert.equal(f.sent.length, 0, receiptState);
    assert.deepEqual(f.acks, ["ack"], receiptState);
    assert.deepEqual(f.retries, [], receiptState);
    assert.equal(f.values.has(markerKey), false, receiptState);
  }
});

test("begin handoff applies accepted-marker precedence before every receipt class", async () => {
  const receiptKey = `receipts/${pointer.ingressId}.json`;
  for (const receiptState of [
    "absent",
    "invalid",
    "forward_pending",
    "forwarded",
    "stored",
    "deleted",
    "rejected",
    "quarantined",
  ] as const) {
    const f = fixture();
    await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
    f.queues.length = 0;
    const markerKey = emergencyForwardMarkerKey(pointer.rawKey);
    const marker = JSON.parse(f.values.get(markerKey) ?? "null");
    marker.providerAcceptedAt = "2026-07-17T10:31:00.000Z";
    f.values.set(markerKey, JSON.stringify(marker));
    if (receiptState === "absent") {
      await f.env.RAW_MAIL_BUCKET.delete(receiptKey);
    } else if (receiptState === "invalid") {
      f.values.set(receiptKey, "not-json");
      f.metadata.set(receiptKey, { state: "stored" });
    } else {
      f.values.set(receiptKey, receiptBody(receiptState));
      f.metadata.set(receiptKey, { state: receiptState });
    }

    await beginEmergencyForward(
      f.env,
      pointer,
      "QUEUE_RETRY_EXHAUSTED",
      { ...f.runtime, bestEffortTimeoutMs: 1 },
    );

    const receipt = JSON.parse(f.values.get(receiptKey) ?? "null");
    assert.equal(receipt.state, "forwarded", receiptState);
    assert.equal(receipt.providerAccepted, true, receiptState);
    assert.equal(f.values.has(markerKey), false, receiptState);
    assert.equal(f.queues.length, 0, receiptState);
    assert.equal(f.sent.length, 0, receiptState);
  }
});

test("begin handoff retains accepted evidence across receipt CAS loss", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  f.queues.length = 0;
  const markerKey = emergencyForwardMarkerKey(pointer.rawKey);
  const marker = JSON.parse(f.values.get(markerKey) ?? "null");
  marker.providerAcceptedAt = "2026-07-17T10:31:00.000Z";
  f.values.set(markerKey, JSON.stringify(marker));
  const receiptKey = `receipts/${pointer.ingressId}.json`;
  f.values.set(receiptKey, receiptBody("rejected"));
  f.metadata.set(receiptKey, { state: "rejected" });
  const originalPut = f.env.RAW_MAIL_BUCKET.put.bind(f.env.RAW_MAIL_BUCKET);
  let loseCas = true;
  f.env.RAW_MAIL_BUCKET.put = async (key, value, options) => {
    if (
      loseCas &&
      key === receiptKey &&
      JSON.parse(value).state === "forwarded"
    ) {
      loseCas = false;
      return null;
    }
    return originalPut(key, value, options);
  };

  await assert.rejects(
    beginEmergencyForward(f.env, pointer, "QUEUE_RETRY_EXHAUSTED", f.runtime),
    /could not converge/,
  );
  assert.equal(f.values.has(markerKey), true);
  assert.equal(JSON.parse(f.values.get(receiptKey) ?? "null").state, "rejected");
  assert.equal(f.queues.length, 0);

  await beginEmergencyForward(f.env, pointer, "QUEUE_RETRY_EXHAUSTED", f.runtime);
  assert.equal(JSON.parse(f.values.get(receiptKey) ?? "null").state, "forwarded");
  assert.equal(f.values.has(markerKey), false);
  assert.equal(f.queues.length, 0);
});

test("accepted precedence survives a receipt CAS loss and converges without resend", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  const markerKey = emergencyForwardMarkerKey(pointer.rawKey);
  const marker = JSON.parse(f.values.get(markerKey) ?? "null");
  marker.providerAcceptedAt = "2026-07-17T10:31:00.000Z";
  f.values.set(markerKey, JSON.stringify(marker));
  const receiptKey = `receipts/${pointer.ingressId}.json`;
  f.values.set(receiptKey, receiptBody("stored"));
  f.metadata.set(receiptKey, { state: "stored" });
  const originalPut = f.env.RAW_MAIL_BUCKET.put.bind(f.env.RAW_MAIL_BUCKET);
  let loseForwardedCas = true;
  f.env.RAW_MAIL_BUCKET.put = async (key, value, options) => {
    if (
      loseForwardedCas &&
      key === receiptKey &&
      JSON.parse(value).state === "forwarded"
    ) {
      loseForwardedCas = false;
      return null;
    }
    return originalPut(key, value, options);
  };

  await processEmergencyForwardMessage(f.message, f.env, f.runtime);
  assert.deepEqual(f.retries, [{ delaySeconds: EMERGENCY_FORWARD_RETRY_SECONDS }]);
  assert.equal(f.values.has(markerKey), true);
  await processEmergencyForwardMessage(f.message, f.env, f.runtime);

  const receipt = JSON.parse(f.values.get(receiptKey) ?? "null");
  assert.equal(receipt.state, "forwarded");
  assert.equal(receipt.providerAccepted, true);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.acks, ["ack"]);
  assert.equal(f.values.has(markerKey), false);
});

test("accepted conflict convergence never depends on anomaly storage", async () => {
  for (const failure of ["throw", "hang"] as const) {
    const f = fixture();
    await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
    const markerKey = emergencyForwardMarkerKey(pointer.rawKey);
    const marker = JSON.parse(f.values.get(markerKey) ?? "null");
    marker.providerAcceptedAt = "2026-07-17T10:31:00.000Z";
    f.values.set(markerKey, JSON.stringify(marker));
    const receiptKey = `receipts/${pointer.ingressId}.json`;
    f.values.set(receiptKey, receiptBody("rejected"));
    f.metadata.set(receiptKey, { state: "rejected" });
    const originalPut = f.env.RAW_MAIL_BUCKET.put.bind(f.env.RAW_MAIL_BUCKET);
    f.env.RAW_MAIL_BUCKET.put = async (key, value, options) => {
      if (key.startsWith("system/emergency-forward/anomalies/")) {
        if (failure === "throw") throw new Error("anomaly unavailable");
        return new Promise(() => {});
      }
      return originalPut(key, value, options);
    };

    await Promise.race([
      processEmergencyForwardMessage(f.message, f.env, {
        ...f.runtime,
        bestEffortTimeoutMs: 1,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("accepted conflict audit blocked")), 25),
      ),
    ]);

    const receipt = JSON.parse(f.values.get(receiptKey) ?? "null");
    assert.equal(receipt.state, "forwarded", failure);
    assert.equal(receipt.providerAccepted, true, failure);
    assert.deepEqual(f.acks, ["ack"], failure);
    assert.equal(f.values.has(markerKey), false, failure);
  }
});

test("reconciliation applies accepted precedence across every receipt class", async () => {
  const receiptKey = `receipts/${pointer.ingressId}.json`;
  for (const receiptState of [
    "absent",
    "invalid",
    "forward_pending",
    "stored",
    "deleted",
    "rejected",
    "quarantined",
  ] as const) {
    const f = fixture();
    await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
    f.queues.length = 0;
    const markerKey = emergencyForwardMarkerKey(pointer.rawKey);
    const marker = JSON.parse(f.values.get(markerKey) ?? "null");
    marker.providerAcceptedAt = "2026-07-17T10:31:00.000Z";
    f.values.set(markerKey, JSON.stringify(marker));
    if (receiptState === "absent") {
      await f.env.RAW_MAIL_BUCKET.delete(receiptKey);
    } else if (receiptState === "invalid") {
      f.values.set(receiptKey, "not-json");
      f.metadata.set(receiptKey, { state: "stored" });
    } else {
      f.values.set(receiptKey, receiptBody(receiptState));
      f.metadata.set(receiptKey, { state: receiptState });
    }

    await reconcileEmergencyForwardMarkers(f.env, {
      now: () => new Date("2026-07-17T10:35:00.000Z"),
      bestEffortTimeoutMs: 1,
    });

    const receipt = JSON.parse(f.values.get(receiptKey) ?? "null");
    assert.equal(receipt.state, "forwarded", receiptState);
    assert.equal(receipt.providerAccepted, true, receiptState);
    assert.equal(f.values.has(markerKey), false, receiptState);
    assert.equal(f.queues.length, 0, receiptState);
  }
});

test("suppresses a stored or deleted race both before and after raw fetch", async () => {
  for (const truths of [["stored"], ["active", "stored"], ["deleted"]] as const) {
    const f = fixture({ truths: [...truths] });
    await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
    await processEmergencyForwardMessage(f.message, f.env, f.runtime);
    assert.equal(f.sent.length, 0);
    assert.deepEqual(f.acks, ["ack"]);
    assert.equal(f.values.has(emergencyForwardMarkerKey(pointer.rawKey)), false);
  }
});

test("a live Mailbox row settles the loop while an absent one still forwards", async () => {
  const delivered = fixture({ truths: ["stored"] });
  await beginEmergencyForward(
    delivered.env,
    pointer,
    "MIME_PARSE_FAILED",
    delivered.runtime,
  );
  await processEmergencyForwardMessage(
    delivered.message,
    delivered.env,
    delivered.runtime,
  );
  assert.equal(delivered.sent.length, 0);
  assert.deepEqual(delivered.retries, []);
  assert.deepEqual(delivered.acks, ["ack"]);
  assert.equal(
    JSON.parse(
      delivered.values.get(`receipts/${pointer.ingressId}.json`) ?? "null",
    ).state,
    "stored",
  );
  // The reconciler must not resurrect what the consumer just settled.
  assert.equal(
    delivered.values.has(emergencyForwardMarkerKey(pointer.rawKey)),
    false,
  );
  await reconcileEmergencyForwardMarkers(delivered.env, delivered.runtime);
  assert.deepEqual(delivered.queues.slice(1), []);

  const undelivered = fixture({ truths: ["active"] });
  await beginEmergencyForward(
    undelivered.env,
    pointer,
    "MIME_PARSE_FAILED",
    undelivered.runtime,
  );
  await processEmergencyForwardMessage(
    undelivered.message,
    undelivered.env,
    undelivered.runtime,
  );
  assert.equal(undelivered.sent.length, 1);
});

test("a redelivery lands after the lease it was scheduled behind expires", () => {
  assert.ok(EMERGENCY_FORWARD_RETRY_SECONDS >= EMERGENCY_FORWARD_LEASE_SECONDS);
});

test("stored and deleted receipts suppress only with matching authoritative Mailbox truth", async () => {
  const receiptKey = `receipts/${pointer.ingressId}.json`;
  for (const state of ["stored", "deleted"] as const) {
    const stale = fixture({ truths: ["active"] });
    await beginEmergencyForward(stale.env, pointer, "MIME_PARSE_FAILED", stale.runtime);
    stale.values.set(receiptKey, receiptBody(state));
    stale.metadata.set(receiptKey, { state });
    await processEmergencyForwardMessage(stale.message, stale.env, stale.runtime);
    assert.equal(stale.sent.length, 1, `stale ${state}`);
    assert.deepEqual(stale.acks, ["ack"], `stale ${state}`);
    assert.equal(
      JSON.parse(stale.values.get(receiptKey) ?? "null").state,
      "forwarded",
      `stale ${state}`,
    );

    const authoritative = fixture({ truths: [state] });
    await beginEmergencyForward(
      authoritative.env,
      pointer,
      "MIME_PARSE_FAILED",
      authoritative.runtime,
    );
    authoritative.values.set(receiptKey, receiptBody(state));
    authoritative.metadata.set(receiptKey, { state });
    await processEmergencyForwardMessage(
      authoritative.message,
      authoritative.env,
      authoritative.runtime,
    );
    assert.equal(authoritative.sent.length, 0, `authoritative ${state}`);
    assert.deepEqual(authoritative.acks, ["ack"], `authoritative ${state}`);
    assert.equal(
      authoritative.values.has(emergencyForwardMarkerKey(pointer.rawKey)),
      false,
      `authoritative ${state}`,
    );
  }
});

test("indeterminate Mailbox, ownership, and D1 truth converges to checksum-verified forwarding", async () => {
  for (const boundary of ["deleted", "stored", "ownership", "active"] as const) {
    for (const failure of ["throw", "hang"] as const) {
      const f = fixture({ truths: ["active"] });
      await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
      const failedRead = () => {
        if (failure === "throw") throw new Error(`${boundary} unavailable`);
        return new Promise<never>(() => {});
      };
      if (boundary === "deleted" || boundary === "stored") {
        const originalGet = f.env.MAILBOX.get.bind(f.env.MAILBOX);
        f.env.MAILBOX.get = (id) => {
          const mailbox = originalGet(id);
          return {
            ...mailbox,
            ...(boundary === "deleted"
              ? { isEmailDeleted: failedRead }
              : { getEmail: failedRead }),
          };
        };
      } else if (boundary === "ownership") {
        f.env.BUCKET.head = failedRead;
      } else {
        f.env.DB.prepare = () => ({
          bind: () => ({ first: failedRead }),
        });
      }

      await assert.doesNotReject(
        Promise.race([
          processEmergencyForwardMessage(f.message, f.env, {
            ...f.runtime,
            infrastructureTimeoutMs: 1,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`${boundary} ${failure} blocked forwarding`)),
              40,
            ),
          ),
        ]),
      );
      assert.equal(f.sent.length, 1, `${boundary} ${failure}`);
      assert.deepEqual(f.acks, ["ack"], `${boundary} ${failure}`);
      assert.deepEqual(f.retries, [], `${boundary} ${failure}`);
    }
  }
});

test("exact rejected and integrity suppression wins without infrastructure truth", async () => {
  const receiptKey = `receipts/${pointer.ingressId}.json`;
  for (const state of ["rejected", "quarantined"] as const) {
    const f = fixture();
    await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
    f.values.set(receiptKey, receiptBody(state));
    f.metadata.set(receiptKey, { state });
    if (state === "quarantined") {
      f.etags.set(pointer.rawKey, "verified-mismatched-etag");
    }
    f.env.MAILBOX.get = () => ({
      isEmailDeleted: () => new Promise<boolean>(() => {}),
      getEmail: () => new Promise<null>(() => {}),
    });
    f.env.BUCKET.head = () => new Promise<null>(() => {});
    f.env.DB.prepare = () => ({
      bind: () => ({ first: () => new Promise<null>(() => {}) }),
    });

    await processEmergencyForwardMessage(f.message, f.env, {
      ...f.runtime,
      infrastructureTimeoutMs: 1,
    });

    assert.equal(f.sent.length, 0, state);
    assert.deepEqual(f.acks, ["ack"], state);
    assert.equal(
      f.values.has(emergencyForwardMarkerKey(pointer.rawKey)),
      false,
      state,
    );
  }
});

test("legacy or malformed rejected receipts are repaired and automatically forwarded", async () => {
  const receiptKey = `receipts/${pointer.ingressId}.json`;
  for (const details of [
    { errorCode: "MAILBOX_INACTIVE" },
    { errorCode: "UNKNOWN_REJECTION", rejectionOrigin: "smtp_ingress" },
  ]) {
    const f = fixture();
    await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
    f.values.set(
      receiptKey,
      JSON.stringify({
        ...pointer,
        state: "rejected",
        updatedAt: "2026-07-17T10:31:00.000Z",
        ...details,
      }),
    );
    f.metadata.set(receiptKey, { state: "rejected" });
    await processEmergencyForwardMessage(f.message, f.env, f.runtime);
    assert.equal(f.sent.length, 1, JSON.stringify(details));
    assert.deepEqual(f.acks, ["ack"], JSON.stringify(details));
  }
});

test("post-acceptance inactive and unowned state still forwards; raw-integrity failure suppresses", async () => {
  for (const truth of ["inactive", "unowned"] as const) {
    const f = fixture({ truths: [truth] });
    await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
    await processEmergencyForwardMessage(f.message, f.env, f.runtime);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.acks, ["ack"]);
    assert.equal(
      (await f.env.RAW_MAIL_BUCKET.head(`receipts/${pointer.ingressId}.json`))
        ?.customMetadata?.state,
      "forwarded",
    );
  }

  const integrity = fixture();
  integrity.etags.set(pointer.rawKey, "mismatched-etag");
  await beginEmergencyForward(
    integrity.env,
    pointer,
    "MIME_PARSE_FAILED",
    integrity.runtime,
  );
  await processEmergencyForwardMessage(
    integrity.message,
    integrity.env,
    integrity.runtime,
  );
  assert.equal(integrity.sent.length, 0);
  assert.equal(
    (
      await integrity.env.RAW_MAIL_BUCKET.head(
        `receipts/${pointer.ingressId}.json`,
      )
    )?.customMetadata?.state,
    "quarantined",
  );
});

test("an absent raw archive retains forwarding authority and retries", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  f.values.delete(pointer.rawKey);

  await processEmergencyForwardMessage(f.message, f.env, f.runtime);

  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.acks, []);
  assert.deepEqual(f.retries, [{ delaySeconds: EMERGENCY_FORWARD_RETRY_SECONDS }]);
  assert.equal(f.values.has(emergencyForwardMarkerKey(pointer.rawKey)), true);
  assert.equal(
    JSON.parse(
      f.values.get(`receipts/${pointer.ingressId}.json`) ?? "null",
    ).state,
    "forward_pending",
  );
});

test("a failed raw archive read retains forwarding authority and retries", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  const originalGet = f.env.RAW_MAIL_BUCKET.get.bind(f.env.RAW_MAIL_BUCKET);
  f.env.RAW_MAIL_BUCKET.get = async (key: string) => {
    if (key === pointer.rawKey) throw new Error("R2 unavailable");
    return originalGet(key);
  };

  await processEmergencyForwardMessage(f.message, f.env, f.runtime);

  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.acks, []);
  assert.deepEqual(f.retries, [{ delaySeconds: EMERGENCY_FORWARD_RETRY_SECONDS }]);
  assert.equal(f.values.has(emergencyForwardMarkerKey(pointer.rawKey)), true);
  assert.equal(
    JSON.parse(
      f.values.get(`receipts/${pointer.ingressId}.json`) ?? "null",
    ).state,
    "forward_pending",
  );
});

test("a duplicate Queue delivery observes forwarded truth and never resends", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  await processEmergencyForwardMessage(f.message, f.env, f.runtime);
  await processEmergencyForwardMessage(f.message, f.env, f.runtime);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.acks, ["ack", "ack"]);
});

test("a hung first provider send cannot block a healthy second Queue message or commit late", async () => {
  const f = fixture();
  const secondRawSource = "healthy-raw";
  const second = {
    ...pointerFor(2),
    rawSize: secondRawSource.length,
    rawSha256: createHash("sha256").update(secondRawSource).digest("hex"),
  };
  assert.ok(second.rawSha256);
  f.values.set(second.rawKey, secondRawSource);
  f.metadata.set(second.rawKey, {
    schemaVersion: "1",
    ingressId: second.ingressId,
    mailboxId: second.mailboxId,
    rawSize: String(second.rawSize),
    rawSha256: second.rawSha256,
    archivedAt: second.archivedAt,
  });
  f.etags.set(second.rawKey, second.etag);
  f.versions.set(second.rawKey, second.version);
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  await beginEmergencyForward(f.env, second, "MIME_PARSE_FAILED", f.runtime);
  const envelopes = [...f.queues];
  const scheduler = manualDeadlineScheduler();
  const dispositions = {
    first: [] as string[],
    second: [] as string[],
  };
  let sendCount = 0;
  let finishFirst!: (value: { messageId: string }) => void;
  f.env.EMERGENCY_EMAIL.send = async (message) => {
    sendCount += 1;
    const source = new TextDecoder().decode(
      (message as unknown as { attachments: Array<{ content: ArrayBuffer }> })
        .attachments[0].content,
    );
    if (source === rawSource) {
      return new Promise((resolve) => {
        finishFirst = resolve;
      });
    }
    return { messageId: "healthy-provider-message" };
  };

  const work = processEmergencyForwardBatch(
    {
      messages: [
        {
          id: "hung-provider",
          body: envelopes[0],
          attempts: 1,
          ack() {
            dispositions.first.push("ack");
          },
          retry(options) {
            dispositions.first.push(`retry:${options?.delaySeconds}`);
          },
        },
        {
          id: "healthy-provider",
          body: envelopes[1],
          attempts: 1,
          ack() {
            dispositions.second.push("ack");
          },
          retry(options) {
            dispositions.second.push(`retry:${options?.delaySeconds}`);
          },
        },
      ],
    },
    f.env,
    {
      ...f.runtime,
      deadlineScheduler: scheduler,
      providerTimeoutMs: 60_000,
    },
  );

  await Promise.race([
    (async () => {
      while (sendCount < 2) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })(),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("healthy provider send was blocked")),
        50,
      );
    }),
  ]);
  scheduler.fireDelay(60_000);
  await work;

  assert.deepEqual(dispositions.first, [
    `retry:${EMERGENCY_FORWARD_RETRY_SECONDS}`,
  ]);
  assert.deepEqual(dispositions.second, ["ack"]);
  finishFirst({ messageId: "late-provider-message" });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(dispositions.first, [
    `retry:${EMERGENCY_FORWARD_RETRY_SECONDS}`,
  ]);
  assert.equal(
    JSON.parse(
      f.values.get(`receipts/${pointer.ingressId}.json`) ?? "null",
    ).state,
    "forward_pending",
  );
});

test("a hung sidecar operation is cut off at the infrastructure budget without blocking its batch peer", async () => {
  const f = fixture();
  const second = pointerFor(2);
  assert.ok(second.rawSha256);
  f.values.set(second.rawKey, rawSource);
  f.metadata.set(second.rawKey, {
    schemaVersion: "1",
    ingressId: second.ingressId,
    mailboxId: second.mailboxId,
    rawSize: String(second.rawSize),
    rawSha256: second.rawSha256,
    archivedAt: second.archivedAt,
  });
  f.etags.set(second.rawKey, second.etag);
  f.versions.set(second.rawKey, second.version);
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  await beginEmergencyForward(f.env, second, "MIME_PARSE_FAILED", f.runtime);
  const envelopes = [...f.queues];

  const originalGet = f.env.RAW_MAIL_BUCKET.get.bind(f.env.RAW_MAIL_BUCKET);
  const blockedReceiptKey = `receipts/${pointer.ingressId}.json`;
  let releaseBlockedGet!: (
    value: Awaited<ReturnType<typeof originalGet>>,
  ) => void;
  let blocked = true;
  f.env.RAW_MAIL_BUCKET.get = async (key) => {
    if (blocked && key === blockedReceiptKey) {
      blocked = false;
      return new Promise((resolve) => {
        releaseBlockedGet = resolve;
      });
    }
    return originalGet(key);
  };

  const dispositions = {
    first: [] as string[],
    second: [] as string[],
  };
  await processEmergencyForwardBatch(
    {
      messages: [
        {
          id: "hung-sidecar",
          body: envelopes[0],
          attempts: 1,
          ack() {
            dispositions.first.push("ack");
          },
          retry(options) {
            dispositions.first.push(`retry:${options?.delaySeconds}`);
          },
        },
        {
          id: "healthy-sidecar-peer",
          body: envelopes[1],
          attempts: 1,
          ack() {
            dispositions.second.push("ack");
          },
          retry(options) {
            dispositions.second.push(`retry:${options?.delaySeconds}`);
          },
        },
      ],
    },
    f.env,
    {
      ...f.runtime,
      infrastructureTimeoutMs: 5,
    },
  );

  assert.deepEqual(dispositions.first, [
    `retry:${EMERGENCY_FORWARD_RETRY_SECONDS}`,
  ]);
  assert.deepEqual(dispositions.second, ["ack"]);
  assert.equal(f.sent.length, 1);

  releaseBlockedGet(await originalGet(blockedReceiptKey));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    dispositions.first,
    [`retry:${EMERGENCY_FORWARD_RETRY_SECONDS}`],
    "a late sidecar completion must not replace the timeout disposition",
  );
});

test("reconciler re-enqueues a stranded marker after Queue loss", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "QUEUE_RETRY_EXHAUSTED", f.runtime);
  f.queues.length = 0;
  assert.equal(
    await reconcileEmergencyForwardMarkers(f.env, {
      now: () => new Date("2026-07-17T10:50:00.000Z"),
    }),
    1,
  );
  assert.deepEqual(f.queues, [
    { schemaVersion: 1, pointer, generation: 2 },
  ]);
});

test("marker reconciliation settles a terminal receipt whose mailbox row is live", async () => {
  const receiptKey = `receipts/${pointer.ingressId}.json`;
  const markerKey = emergencyForwardMarkerKey(pointer.rawKey);

  // Suppression wrote the terminal receipt but lost the marker delete, which is
  // the one shape that can still hand a settled forward back to the Queue.
  const delivered = fixture({ truths: ["stored"] });
  await beginEmergencyForward(
    delivered.env,
    pointer,
    "MIME_PARSE_FAILED",
    delivered.runtime,
  );
  delivered.queues.length = 0;
  delivered.values.set(receiptKey, receiptBody("stored"));
  delivered.metadata.set(receiptKey, { state: "stored" });

  await reconcileEmergencyForwardMarkers(delivered.env, {
    now: () => new Date("2026-07-17T10:50:00.000Z"),
  });

  assert.deepEqual(delivered.queues, []);
  assert.equal(delivered.values.has(markerKey), false);
  assert.equal(
    JSON.parse(delivered.values.get(receiptKey) ?? "null").state,
    "stored",
  );

  const undelivered = fixture({ truths: ["active"] });
  await beginEmergencyForward(
    undelivered.env,
    pointer,
    "MIME_PARSE_FAILED",
    undelivered.runtime,
  );
  undelivered.queues.length = 0;
  undelivered.values.set(receiptKey, receiptBody("stored"));
  undelivered.metadata.set(receiptKey, { state: "stored" });

  await reconcileEmergencyForwardMarkers(undelivered.env, {
    now: () => new Date("2026-07-17T10:50:00.000Z"),
  });

  assert.equal(undelivered.queues.length, 1);
  assert.equal(undelivered.values.has(markerKey), true);
});

test("the parking lane redelivers on its own cadence, not the primary lane's", async () => {
  const lanes: Array<{ retryDelaySeconds: number; expected: number }> = [
    {
      retryDelaySeconds: EMERGENCY_FORWARD_RETRY_SECONDS,
      expected: EMERGENCY_FORWARD_RETRY_SECONDS,
    },
    {
      retryDelaySeconds: EMERGENCY_FORWARD_PARKING_RETRY_SECONDS,
      expected: EMERGENCY_FORWARD_PARKING_RETRY_SECONDS,
    },
  ];
  assert.notEqual(
    EMERGENCY_FORWARD_PARKING_RETRY_SECONDS,
    EMERGENCY_FORWARD_RETRY_SECONDS,
  );
  for (const lane of lanes) {
    const f = fixture({ sendThrows: true });
    await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
    await processEmergencyForwardBatch({ messages: [f.message] }, f.env, {
      ...f.runtime,
      retryDelaySeconds: lane.retryDelaySeconds,
    });
    assert.deepEqual(
      f.retries,
      [{ delaySeconds: lane.expected }],
      String(lane.retryDelaySeconds),
    );
  }
});

test("a long Queue outage creates only one live generation and stale backlog cannot duplicate delivery", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "QUEUE_RETRY_EXHAUSTED", f.runtime);

  const outageStart = Date.parse("2026-07-17T10:30:00.000Z");
  const fiveHours = 5 * 60 * 60_000;
  for (let elapsed = 5 * 60_000; elapsed <= fiveHours; elapsed += 5 * 60_000) {
    await reconcileEmergencyForwardMarkers(f.env, {
      now: () => new Date(outageStart + elapsed),
    });
  }

  assert.ok(
    f.queues.length <=
      1 + fiveHours / (EMERGENCY_FORWARD_LEASE_SECONDS * 1_000),
    `lease fencing admitted ${f.queues.length} Queue generations`,
  );
  assert.deepEqual(
    f.queues.map(({ generation }) => generation),
    Array.from({ length: f.queues.length }, (_, index) => index + 1),
  );

  for (const envelope of f.queues) {
    await processEmergencyForwardMessage(
      { ...f.message, body: envelope },
      f.env,
      {
        ...f.runtime,
        now: () => new Date(outageStart + fiveHours),
      },
    );
  }
  assert.equal(f.sent.length, 1);
  assert.equal(f.retries.length, 0);
  assert.equal(f.acks.length, f.queues.length);
});

test("provider ambiguity is fenced for 180 seconds before a new generation may send", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "QUEUE_RETRY_EXHAUSTED", f.runtime);
  f.env.EMERGENCY_EMAIL.send = async (message) => {
    f.sent.push(message);
    return new Promise(() => {});
  };
  await processEmergencyForwardMessage(f.message, f.env, {
    ...f.runtime,
    providerTimeoutMs: 1,
  });

  assert.equal(EMERGENCY_FORWARD_LEASE_SECONDS, 180);
  assert.equal(
    await reconcileEmergencyForwardMarkers(f.env, {
      now: () => new Date("2026-07-17T10:32:59.000Z"),
      bestEffortTimeoutMs: 1,
    }),
    0,
  );
  assert.deepEqual(f.queues.map(({ generation }) => generation), [1]);
  assert.equal(
    await reconcileEmergencyForwardMarkers(f.env, {
      now: () => new Date("2026-07-17T10:33:00.000Z"),
      bestEffortTimeoutMs: 1,
    }),
    1,
  );
  assert.deepEqual(f.queues.map(({ generation }) => generation), [1, 2]);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.retries, [{ delaySeconds: EMERGENCY_FORWARD_RETRY_SECONDS }]);
});

test("repairs a missing marker from exact pending receipt and raw authority", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  await f.env.RAW_MAIL_BUCKET.delete(emergencyForwardMarkerKey(pointer.rawKey));
  await processEmergencyForwardMessage(f.message, f.env, f.runtime);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.acks, ["ack"]);
  assert.deepEqual(f.retries, []);
});

test("repairs corrupt or missing sidecar authority from the exact surviving sidecar and raw archive", async () => {
  for (const corrupt of ["marker", "receipt"] as const) {
    const f = fixture();
    await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
    const key =
      corrupt === "marker"
        ? emergencyForwardMarkerKey(pointer.rawKey)
        : `receipts/${pointer.ingressId}.json`;
    if (corrupt === "receipt") {
      await f.env.RAW_MAIL_BUCKET.delete(key);
    } else {
      f.values.set(key, "not-json");
    }
    await processEmergencyForwardMessage(f.message, f.env, f.runtime);
    assert.equal(f.sent.length, 1, corrupt);
    assert.deepEqual(f.acks, ["ack"], corrupt);
    assert.deepEqual(f.retries, [], corrupt);
  }
});

test("rebuilds dual-corrupt marker and receipt authority from the exact raw archive", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  f.values.set(emergencyForwardMarkerKey(pointer.rawKey), "not-json");
  f.values.set(`receipts/${pointer.ingressId}.json`, "not-json");

  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  const envelope = f.queues.at(-1);
  assert.ok(envelope);
  assert.doesNotThrow(() =>
    JSON.parse(f.values.get(emergencyForwardMarkerKey(pointer.rawKey)) ?? ""),
  );
  assert.equal(
    JSON.parse(
      f.values.get(`receipts/${pointer.ingressId}.json`) ?? "null",
    ).state,
    "forward_pending",
  );

  await processEmergencyForwardMessage(
    { ...f.message, body: envelope },
    f.env,
    f.runtime,
  );
  assert.equal(f.sent.length, 1);
});

test("sidecar repair remains authoritative when anomaly storage throws or never resolves", async () => {
  for (const sidecar of ["marker", "receipt"] as const) {
    for (const failure of ["throw", "hang"] as const) {
      const f = fixture();
      await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
      const sidecarKey =
        sidecar === "marker"
          ? emergencyForwardMarkerKey(pointer.rawKey)
          : `receipts/${pointer.ingressId}.json`;
      f.values.set(sidecarKey, "not-json");
      const originalPut = f.env.RAW_MAIL_BUCKET.put.bind(f.env.RAW_MAIL_BUCKET);
      f.env.RAW_MAIL_BUCKET.put = async (key, value, options) => {
        if (key.startsWith("system/emergency-forward/anomalies/")) {
          if (failure === "throw") throw new Error("anomaly unavailable");
          return new Promise(() => {});
        }
        return originalPut(key, value, options);
      };
      await assert.doesNotReject(
        Promise.race([
          processEmergencyForwardMessage(f.message, f.env, {
            ...f.runtime,
            bestEffortTimeoutMs: 1,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`anomaly blocked ${sidecar} repair`)),
              25,
            ),
          ),
        ]),
        `${sidecar} ${failure}`,
      );
      assert.equal(f.sent.length, 1, `${sidecar} ${failure}`);
      assert.deepEqual(f.acks, ["ack"], `${sidecar} ${failure}`);
    }
  }
});

test("raw-integrity quarantine is terminal only while the exact mismatch remains", async () => {
  const f = fixture();
  f.etags.set(pointer.rawKey, "mismatched-etag");
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  await processEmergencyForwardMessage(f.message, f.env, f.runtime);
  f.etags.set(pointer.rawKey, pointer.etag);
  await processEmergencyForwardMessage(f.message, f.env, f.runtime);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.acks, ["ack"]);
  assert.deepEqual(f.retries, [{ delaySeconds: EMERGENCY_FORWARD_RETRY_SECONDS }]);
});

test("retains marker and retries when suppression receipt CAS fails", async () => {
  const f = fixture({ suppressionCommitFails: true });
  f.etags.set(pointer.rawKey, "mismatched-etag");
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  await processEmergencyForwardMessage(f.message, f.env, f.runtime);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.acks, []);
  assert.deepEqual(f.retries, [{ delaySeconds: EMERGENCY_FORWARD_RETRY_SECONDS }]);
  assert.equal(f.values.has(emergencyForwardMarkerKey(pointer.rawKey)), true);
});

test("legacy rejected CAS winner cannot suppress an integrity-mismatch retry", async () => {
  const f = fixture({ suppressionConcurrentLegacyRejected: true });
  f.etags.set(pointer.rawKey, "mismatched-etag");
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  await processEmergencyForwardMessage(f.message, f.env, f.runtime);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.acks, []);
  assert.deepEqual(f.retries, [{ delaySeconds: EMERGENCY_FORWARD_RETRY_SECONDS }]);
  assert.equal(f.values.has(emergencyForwardMarkerKey(pointer.rawKey)), true);
});

test("provider acceptance commits even when telemetry reference hashing fails", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  await processEmergencyForwardMessage(f.message, f.env, {
    ...f.runtime,
    async providerLogRef() {
      throw new Error("telemetry unavailable");
    },
  });
  const receipt = JSON.parse(
    f.values.get(`receipts/${pointer.ingressId}.json`) ?? "null",
  );
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.acks, ["ack"]);
  assert.deepEqual(f.retries, []);
  assert.equal(receipt.state, "forwarded");
  assert.equal(receipt.providerAccepted, true);
  assert.equal(receipt.providerRef, undefined);
});

test("provider acceptance is durable before a never-resolving telemetry reference", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "MIME_PARSE_FAILED", f.runtime);
  await assert.doesNotReject(
    Promise.race([
      processEmergencyForwardMessage(f.message, f.env, {
        ...f.runtime,
        providerLogRef: () => new Promise<string>(() => {}),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("telemetry blocked acceptance")), 25),
      ),
    ]),
  );
  const receipt = JSON.parse(
    f.values.get(`receipts/${pointer.ingressId}.json`) ?? "null",
  );
  assert.equal(receipt.state, "forwarded");
  assert.equal(receipt.providerAccepted, true);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.acks, ["ack"]);
});

test("reconciliation cursor advances past invalid first page without starving later markers", async () => {
  const f = fixture();
  const pointers = Array.from({ length: 9 }, (_, index) => pointerFor(index));
  for (const value of pointers) {
    f.values.set(value.rawKey, rawSource);
    f.metadata.set(value.rawKey, {
      schemaVersion: "1",
      ingressId: value.ingressId,
      mailboxId: value.mailboxId,
      rawSize: String(value.rawSize),
      rawSha256: value.rawSha256,
      archivedAt: value.archivedAt,
    });
    f.etags.set(value.rawKey, value.etag);
    f.versions.set(value.rawKey, value.version);
    await beginEmergencyForward(f.env, value, "QUEUE_RETRY_EXHAUSTED", f.runtime);
  }
  f.queues.length = 0;
  const invalidKey = emergencyForwardMarkerKey(pointers[0].rawKey);
  f.values.set(invalidKey, "not-json");

  await reconcileEmergencyForwardMarkers(f.env, {
    now: () => new Date("2026-07-17T10:50:00.000Z"),
  });
  assert.equal(f.queues.length, 8);
  const cursor = JSON.parse(
    f.values.get(EMERGENCY_FORWARD_RECONCILIATION_CURSOR_KEY) ?? "null",
  );
  assert.equal(cursor.cursor, "8");

  assert.equal(
    await reconcileEmergencyForwardMarkers(f.env, {
      now: () => new Date("2026-07-17T10:50:00.000Z"),
    }),
    1,
  );
  assert.deepEqual(f.queues.at(-1), {
    schemaVersion: 1,
    pointer: pointers[8],
    generation: 2,
  });
});

test("a corrupt reconciliation cursor is audited, restarted, and replaced", async () => {
  const f = fixture();
  await beginEmergencyForward(f.env, pointer, "QUEUE_RETRY_EXHAUSTED", f.runtime);
  f.queues.length = 0;
  f.values.set(EMERGENCY_FORWARD_RECONCILIATION_CURSOR_KEY, "not-json");
  f.etags.set(EMERGENCY_FORWARD_RECONCILIATION_CURSOR_KEY, "bad-cursor-etag");

  assert.equal(
    await reconcileEmergencyForwardMarkers(f.env, {
      now: () => new Date("2026-07-17T10:50:00.000Z"),
    }),
    1,
  );
  assert.deepEqual(f.queues, [
    { schemaVersion: 1, pointer, generation: 2 },
  ]);
  const cursor = JSON.parse(
    f.values.get(EMERGENCY_FORWARD_RECONCILIATION_CURSOR_KEY) ?? "null",
  );
  assert.equal(cursor.cursor, null);
  assert.ok(
    [...f.values.keys()].some((key) =>
      key === "system/emergency-forward/anomalies/reconciliation-cursor.json",
    ),
  );
});

test("a corrupt cursor restarts even when its audit write throws or never resolves", async () => {
  for (const failure of ["throw", "hang"] as const) {
    const f = fixture();
    await beginEmergencyForward(f.env, pointer, "QUEUE_RETRY_EXHAUSTED", f.runtime);
    f.queues.length = 0;
    f.values.set(EMERGENCY_FORWARD_RECONCILIATION_CURSOR_KEY, "not-json");
    f.etags.set(EMERGENCY_FORWARD_RECONCILIATION_CURSOR_KEY, "bad-cursor-etag");
    const originalPut = f.env.RAW_MAIL_BUCKET.put.bind(f.env.RAW_MAIL_BUCKET);
    f.env.RAW_MAIL_BUCKET.put = async (key, value, options) => {
      if (key === "system/emergency-forward/anomalies/reconciliation-cursor.json") {
        if (failure === "throw") throw new Error("cursor audit unavailable");
        return new Promise(() => {});
      }
      return originalPut(key, value, options);
    };

    assert.equal(
      await Promise.race([
        reconcileEmergencyForwardMarkers(f.env, {
          now: () => new Date("2026-07-17T10:55:00.000Z"),
          bestEffortTimeoutMs: 1,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("cursor audit blocked sweep")), 25),
        ),
      ]),
      1,
      failure,
    );
    assert.equal(
      JSON.parse(
        f.values.get(EMERGENCY_FORWARD_RECONCILIATION_CURSOR_KEY) ?? "null",
      ).cursor,
      null,
      failure,
    );
  }
});

test("reconciliation never advances cursor past a failed Queue handoff", async () => {
  const f = fixture();
  await beginEmergencyForward(
    f.env,
    pointerFor(0),
    "QUEUE_RETRY_EXHAUSTED",
    f.runtime,
  );
  f.env.EMERGENCY_FORWARD_QUEUE.send = async () => {
    throw new Error("Queue unavailable");
  };
  await assert.doesNotReject(
    reconcileEmergencyForwardMarkers(f.env, {
      now: () => new Date("2026-07-17T10:50:00.000Z"),
    }),
  );
  assert.equal(
    f.values.has(EMERGENCY_FORWARD_RECONCILIATION_CURSOR_KEY),
    false,
  );
  assert.equal(
    f.values.has(emergencyForwardMarkerKey(pointerFor(0).rawKey)),
    true,
  );
});

test("a hung first marker cannot block a later emergency marker", async () => {
  const f = fixture();
  const first = pointerFor(0);
  const second = pointerFor(1);
  await beginEmergencyForward(f.env, first, "QUEUE_RETRY_EXHAUSTED", f.runtime);
  await beginEmergencyForward(f.env, second, "QUEUE_RETRY_EXHAUSTED", f.runtime);
  f.queues.length = 0;
  const originalGet = f.env.RAW_MAIL_BUCKET.get.bind(f.env.RAW_MAIL_BUCKET);
  f.env.RAW_MAIL_BUCKET.get = async (key: string) => {
    if (key === emergencyForwardMarkerKey(first.rawKey)) {
      return new Promise(() => {});
    }
    return originalGet(key);
  };

  assert.equal(
    await reconcileEmergencyForwardMarkers(f.env, {
      now: () => new Date("2026-07-17T10:50:00.000Z"),
      infrastructureTimeoutMs: 1,
    }),
    1,
  );
  assert.deepEqual(f.queues, [
    { schemaVersion: 1, pointer: second, generation: 2 },
  ]);
  assert.equal(
    f.values.has(EMERGENCY_FORWARD_RECONCILIATION_CURSOR_KEY),
    false,
  );
});
