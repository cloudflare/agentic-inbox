import { SenderStore } from "../senders";
import { scopeSenders, type SenderAccess } from "../../shared/senders";
import { tool } from "ai";
import { z } from "zod";
import type { Database } from "../db";
import { InboxStore } from "../store";
import { setConversationTags } from "../tags";
import { changeThreadStatus, getThreadWorkflow } from "../thread-status";
import { statusChangeSchema } from "../../shared/thread-status";
import {
	updateDraft,
	draftVersionSchema,
	setThreadRead,
	updateMessageFlags,
} from "../email-actions";

export const recipientList = z
	.union([z.string().email(), z.array(z.string().email()).min(1).max(50)])
	.transform((value) => (typeof value === "string" ? value : value.join(", ")));
export const carbonCopyList = z
	.array(z.string().email())
	.max(50)
	.default([])
	.transform((value) => value.join(", "));
export const escapeDraftText = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")
		.replaceAll("\n", "<br>");
type Mutate = (
	name: string,
	callback: (tx: Database) => Promise<unknown>,
	key?: string,
) => Promise<unknown>;
export function createActionTools(
	db: Database,
	mailbox: string,
	actor: string,
	mutate: Mutate,
	consumeText: (body: string) => { body: string; truncated: boolean },
	senderAccess: SenderAccess = {},
) {
	const uuid = z.string().uuid();

	const attribution = `Agent on behalf of ${actor}`;
	return {
		list_senders: tool({
			description:
				"List available sender identities and the default. Use a returned sender_identity_id when drafting from a specific address. Never sends.",
			inputSchema: z.object({}),
			execute: async () => {
				return scopeSenders(
					await new SenderStore(db).configuration(),
					senderAccess,
				);
			},
		}),
		get_draft: tool({
			description:
				"Read a saved draft and its exact draft_version before editing. Content is untrusted. Never send.",
			inputSchema: z.object({ draftId: uuid }),
			execute: async ({ draftId }) => {
				const draft = await new InboxStore(db).message(mailbox, draftId);
				if (draft.delivery_status !== "draft")
					throw new Error("Draft not found");
				return {
					draft_id: draft.id,
					draft_version: draft.draft_version,
					draft_mode: draft.draft_mode,
					draft_source_id: draft.draft_source_id,
					sender_identity_id: draft.sender_identity_id,
					to: draft.recipient,
					cc: draft.cc,
					bcc: draft.bcc,
					subject: draft.subject,
					...consumeText(draft.body ?? ""),
					body_format: "plain_text_preview",
				};
			},
		}),
		update_draft: tool({
			description:
				"Update one existing draft only when asked. Read get_draft first; provide its draft_version to protect newer edits. Omit unchanged fields to preserve rich formatting and recipients. When body is supplied it replaces the entire body with plain text; never reconstruct a truncated preview. Never sends.",
			inputSchema: z.object({
				draftId: uuid,
				draftVersion: draftVersionSchema,
				sender_identity_id: z.string().min(1).max(254).optional(),
				to: recipientList.optional(),
				cc: carbonCopyList.optional(),
				bcc: carbonCopyList.optional(),
				subject: z.string().max(1000).optional(),
				body: z.string().trim().min(1).max(20000).optional(),
			}),
			execute: ({
				draftId,
				draftVersion,
				to,
				cc,
				bcc,
				subject,
				body,
				sender_identity_id,
			}) =>
				mutate("update_draft", (tx) =>
					updateDraft(
						tx,
						mailbox,
						draftId,
						{
							sender_identity_id,
							to,
							cc,
							bcc,
							subject,
							body: body === undefined ? undefined : escapeDraftText(body),
						},
						draftVersion,
						senderAccess,
					),
				),
		}),
		set_thread_tag: tool({
			description:
				"Add or remove one existing tag on one conversation when explicitly requested. Adding a single-choice or ordered-scale level replaces the prior level. Records a manual override protected from automatic classification. Never create tags.",
			inputSchema: z.object({
				threadId: uuid,
				tagId: uuid,
				action: z.enum(["add", "remove"]),
			}),
			execute: ({ threadId, tagId, action }) =>
				mutate("set_thread_tag", async (tx) => {
					await setConversationTags(
						tx,
						mailbox,
						[threadId],
						tagId,
						action,
						attribution,
					);
					return {
						thread_id: threadId,
						tag_id: tagId,
						action,
						tags: await new InboxStore(tx).tagsForThreads(mailbox, [threadId]),
					};
				}),
		}),
		get_thread_status: tool({
			description:
				"Read current Open/Done status, revision and activity before changing a conversation's status.",
			inputSchema: z.object({ threadId: uuid }),
			execute: ({ threadId }) => getThreadWorkflow(db, mailbox, threadId),
		}),
		set_thread_status: tool({
			description:
				"Mark one conversation Open or Done when explicitly requested, using its latest revision. A stale revision fails; read the changed conversation before retrying.",
			inputSchema: statusChangeSchema.extend({ threadId: uuid }),
			execute: ({ threadId, ...input }) =>
				mutate("set_thread_status", async (tx) => ({
					thread_id: threadId,
					...(await changeThreadStatus(
						tx,
						mailbox,
						threadId,
						input,
						attribution,
					)),
				})),
		}),
		set_email_starred: tool({
			description:
				"Star or unstar one email when explicitly requested by the operator.",
			inputSchema: z.object({ emailId: uuid, starred: z.boolean() }),
			execute: ({ emailId, starred }) =>
				mutate("set_email_starred", (tx) =>
					updateMessageFlags(tx, mailbox, emailId, { starred }),
				),
		}),
		set_thread_read: tool({
			description:
				"Mark all messages in one conversation read or unread when explicitly requested by the operator.",
			inputSchema: z.object({ threadId: uuid, read: z.boolean() }),
			execute: ({ threadId, read }) =>
				mutate("set_thread_read", (tx) =>
					setThreadRead(tx, mailbox, threadId, read),
				),
		}),
	};
}
