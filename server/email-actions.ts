import {
	draftContentSchema,
	draftVersionSchema,
	type SaveDraftResult,
} from "../shared/mail";
export { draftContentSchema, draftVersionSchema } from "../shared/mail";
import { SenderStore } from "./senders";
import type { SenderAccess } from "../shared/senders";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "./db";

export const messageFlagsSchema = z
	.object({ read: z.boolean().optional(), starred: z.boolean().optional() })
	.strict()
	.refine((value) => Object.keys(value).length > 0);
export async function updateMessageFlags(
	db: Database,
	mailbox: string,
	id: string,
	input: z.infer<typeof messageFlagsSchema>,
) {
	const flags = messageFlagsSchema.parse(input);
	const [row] =
		await db`UPDATE emails SET ${db(flags)} WHERE mailbox_id=${mailbox} AND id=${id} RETURNING id`;
	if (!row) throw new HTTPException(404, { message: "Email not found" });
	return { email_id: id, ...flags };
}
export async function setThreadRead(
	db: Database,
	mailbox: string,
	thread: string,
	read: boolean,
) {
	const rows =
		await db`UPDATE emails SET read=${read} WHERE mailbox_id=${mailbox} AND thread_id=${thread} RETURNING id`;
	if (!rows.length)
		throw new HTTPException(404, { message: "Conversation not found" });
	return { thread_id: thread, read, message_count: rows.length };
}
// Hash the exact editable fields in SQL, including intent, avoiding timestamp precision loss.
export async function updateDraft(
	db: Database,
	mailbox: string,
	id: string,
	content: Partial<z.infer<typeof draftContentSchema>>,
	version?: string,
	senderAccess: SenderAccess = {},
): Promise<SaveDraftResult> {
	const input = draftContentSchema.partial().parse(content);
	const [current] =
		await db`SELECT draft_mode,draft_source_id FROM emails WHERE mailbox_id=${mailbox} AND id=${id} AND delivery_status='draft'`;
	if (!current) throw new HTTPException(404, { message: "Draft not found" });
	if (
		(input.draft_mode !== undefined &&
			input.draft_mode !== (current.draft_mode ?? "new")) ||
		(input.draft_source_id !== undefined &&
			input.draft_source_id !== current.draft_source_id)
	)
		throw new HTTPException(409, {
			message:
				"Draft intent changed. Create a new draft to change its mode or source.",
		});
	const sender = input.sender_identity_id
		? await new SenderStore(db).resolve(
				{ explicit: input.sender_identity_id, mailboxId: mailbox },
				senderAccess,
			)
		: undefined;
	const changes = Object.fromEntries(
		Object.entries(input)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => [key === "to" ? "recipient" : key, value]),
	);
	if (sender) changes.sender = sender.email;
	if (!Object.keys(changes).length)
		throw new HTTPException(400, {
			message: "Provide at least one draft field to change",
		});
	if (version !== undefined) draftVersionSchema.parse(version);
	const [row] = await db<
		(Omit<SaveDraftResult, "draft_id"> & { id: string })[]
	>`UPDATE emails SET ${db(changes)},date=clock_timestamp()
 WHERE mailbox_id=${mailbox} AND id=${id} AND delivery_status='draft'
 AND (${version ?? null}::text IS NULL OR md5(jsonb_build_array(recipient,cc,bcc,subject,body,sender_identity_id,draft_mode,draft_source_id)::text)=${version ?? null})
 RETURNING id,sender,sender_identity_id,md5(jsonb_build_array(recipient,cc,bcc,subject,body,sender_identity_id,draft_mode,draft_source_id)::text) AS draft_version`;
	if (!row) {
		const [exists] =
			await db`SELECT id FROM emails WHERE mailbox_id=${mailbox} AND id=${id} AND delivery_status='draft'`;
		throw new HTTPException(exists ? 409 : 404, {
			message: exists
				? "Draft changed. Read it again before saving; do not overwrite newer edits."
				: "Draft not found",
		});
	}
	return {
		draft_id: row.id,
		sender: String(row.sender),
		sender_identity_id:
			typeof row.sender_identity_id === "string"
				? row.sender_identity_id
				: null,
		draft_version: row.draft_version,
	};
}
