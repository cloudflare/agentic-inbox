import type { Env } from "../types";

/** Restore an incomplete copy only from the same original message in another mailbox. */
export async function restoreAttachments(env: Env, mailboxId: string, emailId: string, sourceMailbox: string, sourceId: string) {
	const sourceStub = env.MAILBOX.get(env.MAILBOX.idFromName(sourceMailbox));
	const targetStub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const [source, target] = await Promise.all([sourceStub.getEmail(sourceId), targetStub.getEmail(emailId)]);
	if (!source || !target || !source.message_id || source.message_id !== target.message_id || source.sender !== target.sender || source.body !== target.body) {
		throw new Error("Source and target must be copies of the same original message");
	}
	if (target.attachments.length || !source.attachments.length) return { restored: 0 };
	// Verify every byte source before writing any target metadata.
	const objects = await Promise.all(source.attachments.map(a => env.BUCKET.get(`attachments/${sourceId}/${a.id}/${a.filename}`)));
	if (objects.some(obj => !obj)) throw new Error("Source attachment file missing");
	const attachments = source.attachments.map(a => ({ ...a, id: crypto.randomUUID(), email_id: emailId }));
	for (const [i, a] of attachments.entries()) {
		await env.BUCKET.put(`attachments/${emailId}/${a.id}/${a.filename}`, objects[i]!.body);
	}
	const restored = await targetStub.restoreMissingAttachments(emailId, source.message_id, attachments);
	return { restored };
}
