// Runs the real send_email binding under workerd to prove the emergency-forward
// payload shape the consumer builds is the one the binding accepts. The original
// implementation re-sent the archived raw MIME and was rejected on every attempt
// for two independent reasons; both are asserted here so a regression cannot
// reintroduce a forward that never leaves the Worker.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Log, LogLevel, Miniflare } from "miniflare";

// Run under `node --experimental-strip-types` so the harness exercises the
// production composer itself; a hand-rolled copy could pass here while the
// payload the Worker actually sends drifts away from it.
import { emergencyForwardNotification } from "../workers/lib/emergency-forward.ts";

const FROM = "emergency-forward@example.com";
const DESTINATION = "backup@example.com";
const MINIFLARE_COMPATIBILITY_DATE = "2026-03-12";

const ORIGINAL_RAW = [
  "Received: from mail.example.net by mx.example.com; Fri, 17 Jul 2026 10:20:00 +0000",
  "Message-ID: <original@example.net>",
  "From: sender@example.net",
  "To: team@example.com",
  "Subject: original subject",
  "",
  "original body",
  "",
].join("\r\n");

// The Worker only relays: it rehydrates the base64 attachment the production
// composer produced and hands the payload to the binding untouched.
const WORKER = `
import { EmailMessage } from "cloudflare:email";

const ORIGINAL_RAW = ${JSON.stringify(ORIGINAL_RAW)};

export default {
  async fetch(request, env) {
    const shape = new URL(request.url).searchParams.get("shape");
    const composed = shape === "notification" ? await request.json() : null;
    try {
      const result = await env.EMERGENCY_EMAIL.send(payload(shape, env, composed));
      return Response.json({
        accepted: true,
        resultType: typeof result,
        messageId: result?.messageId ?? null,
      });
    } catch (error) {
      return Response.json({ accepted: false, message: String(error.message) });
    }
  },
};

function payload(shape, env, composed) {
  if (shape === "raw") {
    return new EmailMessage(env.FROM, env.DESTINATION, ORIGINAL_RAW);
  }
  if (shape === "raw-rewritten-from") {
    return new EmailMessage(
      env.FROM,
      env.DESTINATION,
      ORIGINAL_RAW.replace("From: sender@example.net", "From: " + env.FROM),
    );
  }
  return {
    ...composed,
    ...(composed.attachments
      ? {
          attachments: composed.attachments.map((attachment) => ({
            ...attachment,
            content: Uint8Array.from(atob(attachment.content), (character) =>
              character.charCodeAt(0),
            ).buffer,
          })),
        }
      : {}),
  };
}
`;

function composeProductionNotification() {
  const original = new TextEncoder().encode(ORIGINAL_RAW);
  const notification = emergencyForwardNotification(
    { EMERGENCY_FORWARD_FROM: FROM, EMERGENCY_FORWARD_DESTINATION: DESTINATION },
    {
      schemaVersion: 1,
      ingressId: "emergency-forward-harness",
      rawKey: "raw/2026/07/17/10/20/emergency-forward-harness.eml",
      mailboxId: "team@example.com",
      rawSize: original.byteLength,
      rawSha256: createHash("sha256").update(original).digest("hex"),
      archivedAt: "2026-07-17T10:20:00.000Z",
      etag: "raw-etag",
      version: "raw-version",
    },
    "MIME_PARSE_FAILED",
    original.buffer,
  );
  return {
    ...notification,
    attachments: notification.attachments?.map((attachment) => ({
      ...attachment,
      content: Buffer.from(attachment.content).toString("base64"),
    })),
  };
}

async function send(mf, shape, body) {
  const response = await mf.dispatchFetch(`http://localhost/?shape=${shape}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response.json();
}

export async function verifyEmergencyForwardSendShape({
  stdout = console.log,
} = {}) {
  const mf = new Miniflare({
    compatibilityDate: MINIFLARE_COMPATIBILITY_DATE,
    log: new Log(LogLevel.ERROR),
    modules: true,
    script: WORKER,
    bindings: { DESTINATION, FROM },
    email: {
      send_email: [
        {
          name: "EMERGENCY_EMAIL",
          destination_address: DESTINATION,
          allowed_sender_addresses: [FROM],
        },
      ],
    },
  });

  try {
    const raw = await send(mf, "raw");
    assert.equal(raw.accepted, false, "re-sent raw MIME must be rejected");
    assert.match(raw.message, /From: header does not match mail from/);

    const rewritten = await send(mf, "raw-rewritten-from");
    assert.equal(
      rewritten.accepted,
      false,
      "rewriting only the From: header must still be rejected",
    );
    assert.match(rewritten.message, /invalid headers set/);

    const composed = composeProductionNotification();
    assert.equal(composed.from, FROM, "composer must send from the envelope");
    assert.equal(composed.attachments.length, 1);
    assert.equal(composed.attachments[0].type, "message/rfc822");
    const notification = await send(mf, "notification", composed);
    assert.equal(
      notification.accepted,
      true,
      `composed notification must be accepted: ${notification.message}`,
    );

    stdout(
      [
        "emergency-forward send shape verified",
        `  re-sent raw MIME rejected: ${raw.message}`,
        `  From-corrected raw MIME rejected: ${rewritten.message}`,
        `  composed notification accepted; result type ${notification.resultType}, messageId ${notification.messageId}`,
      ].join("\n"),
    );
    return notification;
  } finally {
    await mf.dispose();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await verifyEmergencyForwardSendShape();
}
