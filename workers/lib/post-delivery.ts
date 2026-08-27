import { sendEmail } from "../email-sender";
import type { Env } from "../types";

export interface DeliveredEmail {
  mailboxId: string;
  emailId: string;
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  date: string;
  messageId?: string | null;
  alreadyForwarded?: boolean;
}

type NotificationSettings = {
  forwarding?: {
    enabled?: boolean;
    email?: string;
    includeInternal?: boolean;
  };
  telegram?: {
    enabled?: boolean;
    botToken?: string;
    chatId?: string;
    includeInternal?: boolean;
  };
};

function extractAddresses(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function isInternal(delivery: DeliveredEmail, env: Env): boolean {
  const domains = String(env.DOMAINS || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const recipients = extractAddresses(delivery.recipient);
  const sender = delivery.sender.toLowerCase();
  const isInternalAddress = (address: string) =>
    domains.some((domain) => address.endsWith(`@${domain}`));
  return isInternalAddress(sender) && recipients.some(isInternalAddress);
}

function renderForwardBody(email: DeliveredEmail): string {
  return [
    `---------- Forwarded message ----------`,
    `From: ${email.sender}`,
    `To: ${email.recipient}`,
    `Date: ${email.date}`,
    `Subject: ${email.subject}`,
    ``,
    email.body || "",
  ].join("\n");
}

function telegramText(email: DeliveredEmail): string {
  const body = (email.body || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const snippet = body.length > 700 ? `${body.slice(0, 700)}…` : body;
  return [
    `📧 New email: ${email.mailboxId}`,
    `From: ${email.sender}`,
    `Subject: ${email.subject || "(no subject)"}`,
    snippet ? `\n${snippet}` : "",
  ].join("\n");
}

async function notifyTelegram(settings: NotificationSettings["telegram"], email: DeliveredEmail) {
  if (!settings?.enabled || !settings.botToken || !settings.chatId) return;
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(settings.botToken)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: settings.chatId,
      text: telegramText(email),
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) throw new Error(`Telegram notification failed: HTTP ${response.status}`);
}

/** Load per-mailbox notification settings without exposing secrets to callers. */
export async function getPostDeliverySettings(env: Env, mailboxId: string): Promise<NotificationSettings> {
  const object = await env.BUCKET.get(`mailboxes/${mailboxId.toLowerCase()}.json`);
  if (!object) return {};
  const value = await object.json<NotificationSettings & { forwarding?: Record<string, unknown> }>();
  return {
    forwarding: value.forwarding
      ? {
          enabled: value.forwarding.enabled === true,
          email: typeof value.forwarding.email === "string" ? value.forwarding.email : "",
          includeInternal: value.forwarding.includeInternal !== false,
        }
      : undefined,
    telegram: value.telegram
      ? {
          enabled: value.telegram.enabled === true,
          botToken: typeof value.telegram.botToken === "string" ? value.telegram.botToken : "",
          chatId: typeof value.telegram.chatId === "string" ? value.telegram.chatId : "",
          includeInternal: value.telegram.includeInternal !== false,
        }
      : undefined,
  };
}

/**
 * Runs after an email has been durably stored.
 *
 * Native Cloudflare EmailMessage.forward() is intentionally awaited while the
 * email event is still active. Cloudflare's native forward is tied to the
 * original EmailMessage event and must not be deferred into waitUntil().
 * Telegram notification is independent and is scheduled separately, so a
 * forwarding failure can never suppress Telegram notification.
 */
export async function runPostDelivery(
  env: Env,
  executionCtx: ExecutionContext,
  email: DeliveredEmail,
  settings: NotificationSettings,
  nativeForward?: (target: string) => Promise<void>,
) {
  const internal = isInternal(email, env);
  const forwarding = settings.forwarding;
  const telegram = settings.telegram;
  const tasks: Promise<unknown>[] = [];

  if (!internal && forwarding?.enabled && forwarding.email) {
    const target = forwarding.email.trim().toLowerCase();
    const recipientAddresses = extractAddresses(email.recipient);
    if (
      target &&
      target !== email.mailboxId.toLowerCase() &&
      !recipientAddresses.includes(target) &&
      email.alreadyForwarded !== true
    ) {
      if (nativeForward) {
        // IMPORTANT: do not defer EmailMessage.forward() to waitUntil().
        // It must execute while the Cloudflare email event is alive.
        try {
          await nativeForward(target);
        } catch (error) {
          console.error(
            `Native forwarding to ${target} failed:`,
            error instanceof Error ? error.message : error,
          );
        }
      } else {
        tasks.push(
          sendEmail(env.EMAIL, {
            to: target,
            from: email.mailboxId,
            subject: `[Forwarded] ${email.subject || "(no subject)"}`,
            text: renderForwardBody(email),
            headers: {
              "X-Agentic-Inbox-Forwarded": "1",
              ...(email.messageId ? { "X-Agentic-Inbox-Original-Message-Id": email.messageId } : {}),
            },
          }),
        );
      }
    }
  }

  if (!internal && telegram?.enabled && telegram.botToken && telegram.chatId) {
    tasks.push(notifyTelegram(telegram, email));
  }

  if (tasks.length === 0) return;

  executionCtx.waitUntil(
    Promise.allSettled(tasks).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error(
            "Post-delivery notification failed:",
            result.reason instanceof Error ? result.reason.message : result.reason,
          );
        }
      }
    }),
  );
}
