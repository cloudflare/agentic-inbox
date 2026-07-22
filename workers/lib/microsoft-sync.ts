import type { Env } from "../types";
import { listGraphMessages, refreshMicrosoftToken } from "./microsoft-graph";
import { decryptToken, encryptToken } from "./token-crypto";

export async function syncMicrosoftInbox(env: Env, mailboxId: string): Promise<number> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId)) as any;
	const accounts = await stub.listConnectedAccounts();
	const account = accounts.find((candidate: { provider: string }) => candidate.provider === "microsoft");
	if (!account) throw new Error("Connect a Microsoft account first");
	const stored = await stub.getConnectedAccount(account.id);
	if (!stored?.tokenCiphertext) throw new Error("Microsoft account requires reauthentication");
	let token = JSON.parse(await decryptToken(env.TOKEN_ENCRYPTION_KEY, stored.tokenCiphertext)) as { access_token?: string; refresh_token?: string; expires_at?: number };
	if ((!token.access_token || (token.expires_at && token.expires_at <= Date.now())) && token.refresh_token) {
		const refreshed = await refreshMicrosoftToken(env, token.refresh_token);
		await stub.updateConnectedAccountToken(stored.id, await encryptToken(env.TOKEN_ENCRYPTION_KEY, refreshed));
		token = refreshed as typeof token;
	}
	if (!token.access_token) throw new Error("Microsoft account requires reauthentication");
	const messages = await listGraphMessages(token.access_token);
	for (const message of messages) {
		const sender = message.from?.emailAddress;
		const recipients = (message.toRecipients ?? []).map((entry) => entry.emailAddress?.address).filter(Boolean).join(", ");
		await stub.upsertSyncedEmail({ id: `microsoft:${message.id}`, subject: message.subject || "", sender: sender?.address || sender?.name || "", recipient: recipients, date: message.receivedDateTime || new Date().toISOString(), body: message.body?.content || message.bodyPreview || "", read: message.isRead !== false, threadId: message.conversationId ? `microsoft:${message.conversationId}` : null });
	}
	return messages.length;
}
