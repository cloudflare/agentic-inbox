import { Folders } from "../../shared/folders.ts";
import type { Email } from "../types/index.ts";

type ConversationKeyboardCommand = "toggle-unread" | "archive" | "trash";

export type PlannedKeyboardConversationAction =
	| { kind: "conversation-read"; conversationId: string; folderId: string; read: boolean }
	| {
		kind: "conversation-archive";
		conversationId: string;
		folderId: string;
		representativeEmailId: string;
	}
	| {
		kind: "conversation-trash";
		conversationId: string;
		folderId: string;
		representativeEmailId: string;
	}
	| { kind: "email-read"; emailId: string; read: boolean }
	| { kind: "email-archive"; emailId: string }
	| { kind: "email-trash"; emailId: string };

/**
 * Names the write that failed so a reverted optimistic update is never silent.
 * Every star/read toggle routes through one mutation, so the copy is derived
 * from the patch rather than repeated at each call site.
 */
export function updateEmailFailureTitle(data: unknown): string {
	const patch = (data ?? {}) as { starred?: unknown; read?: unknown };
	if (typeof patch.starred === "boolean") {
		return patch.starred
			? "Couldn’t star the conversation"
			: "Couldn’t remove the star";
	}
	if (typeof patch.read === "boolean") {
		return patch.read
			? "Couldn’t mark the conversation as read"
			: "Couldn’t mark the conversation as unread";
	}
	return "Couldn’t update the conversation";
}

export function planKeyboardConversationAction(
	command: ConversationKeyboardCommand,
	email: Email,
	folderId: string,
): PlannedKeyboardConversationAction | null {
	if (folderId === Folders.OUTBOX || folderId === Folders.DRAFT) return null;
	if (command === "toggle-unread" && folderId === Folders.SENT) return null;
	if (
		command === "archive" &&
		(folderId === Folders.SENT ||
			folderId === Folders.TRASH ||
			folderId === Folders.ARCHIVE)
	) {
		return null;
	}
	if (command === "trash" && folderId === Folders.TRASH) return null;

	const conversationId = email.conversation_id ?? email.thread_id ?? undefined;
	const isConversation = Boolean(conversationId) && (email.thread_count ?? 1) > 1;
	if (command === "toggle-unread") {
		const read = email.thread_unread_count !== undefined
			? email.thread_unread_count > 0
			: !email.read;
		return isConversation
			? { kind: "conversation-read", conversationId: conversationId!, folderId, read }
			: { kind: "email-read", emailId: email.id, read };
	}
	if (command === "archive") {
		return isConversation
			? {
				kind: "conversation-archive",
				conversationId: conversationId!,
				folderId,
				representativeEmailId: email.id,
			}
			: { kind: "email-archive", emailId: email.id };
	}
	return isConversation
		? {
			kind: "conversation-trash",
			conversationId: conversationId!,
			folderId,
			representativeEmailId: email.id,
		}
		: { kind: "email-trash", emailId: email.id };
}
