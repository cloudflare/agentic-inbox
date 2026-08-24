import PostalMime from "postal-mime";
import { receiveEmail } from "./index";
import type { Env } from "./types";
import { getPostDeliverySettings, runPostDelivery, type DeliveredEmail } from "./lib/post-delivery";

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function readRaw(stream: ReadableStream, size: number): Promise<Uint8Array> {
	if (size > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${size} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (size <= 0) throw new Error(`Invalid stream size: ${size}`);
	const result = new Uint8Array(size);
	let offset = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (offset + value.length > size) {
			await reader.cancel();
			throw new Error("Incoming email stream exceeds declared size");
		}
		result.set(value, offset);
		offset += value.length;
	}
	return result.subarray(0, offset);
}

function extractMessageId(value: string | undefined | null): string | null {
	if (!value) return null;
	const match = value.match(/<([^>]+)>/);
	return match ? match[1] : value.trim().split(/\s+/)[0] || null;
}

function findMailbox(parsed: any, env: Env): string | undefined {
	const allowed = ((env.EMAIL_ADDRESSES ?? []) as string[]).map((a) => a.toLowerCase());
	const recipients = (parsed.to || [])
		.map((entry: any) => entry.address?.toLowerCase())
		.filter(Boolean) as string[];
	if (allowed.length > 0) return recipients.find((address) => allowed.includes(address));
	return recipients[0];
}

function hasForwardingMarker(parsed: any): boolean {
	return (parsed.headers || []).some((header: any) =>
		String(header.key || "").toLowerCase() === "x-agentic-inbox-forwarded" &&
		String(header.value || "").trim() === "1"
	);
}

/**
 * Reads the inbound stream once, feeds the original receiver unchanged, and
 * then runs the optional forwarding/Telegram pipeline after durable storage.
 * This deliberately keeps receiveEmail as the source of truth for mailbox
 * persistence while making both internal and external inbound mail observable
 * to the same post-delivery service.
 */
export async function receiveEmailWithNotifications(
	event: { raw: ReadableStream; rawSize: number },
	env: Env,
	ctx: ExecutionContext,
) {
	const raw = await readRaw(event.raw, event.rawSize);
	const parsed = await new PostalMime().parse(raw);
	const mailboxId = findMailbox(parsed, env);
	if (!mailboxId) {
		await receiveEmail({ raw: new Response(raw).body!, rawSize: raw.byteLength }, env, ctx);
		return;
	}

	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
		await receiveEmail({ raw: new Response(raw).body!, rawSize: raw.byteLength }, env, ctx);
		return;
	}

	await receiveEmail({ raw: new Response(raw).body!, rawSize: raw.byteLength }, env, ctx);

	const sender = (parsed.from?.address || "").toLowerCase();
	const recipients = (parsed.to || [])
		.map((entry: any) => entry.address?.toLowerCase())
		.filter(Boolean)
		.join(", ");
	const originalMessageId = extractMessageId(parsed.messageId);
	const delivered: DeliveredEmail = {
		mailboxId,
		emailId: originalMessageId || crypto.randomUUID(),
		sender,
		recipient: recipients,
		subject: parsed.subject || "",
		body: parsed.html || parsed.text || "",
		date: new Date().toISOString(),
		messageId: originalMessageId,
		alreadyForwarded: hasForwardingMarker(parsed),
	};

	const settings = await getPostDeliverySettings(env, mailboxId);
	runPostDelivery(env, ctx, delivered, settings);
}
