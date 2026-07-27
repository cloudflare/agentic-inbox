import assert from "node:assert/strict";
import test from "node:test";
import type { Email } from "../types/index.ts";
import {
	planKeyboardConversationAction,
	updateEmailFailureTitle,
} from "./conversation-actions.ts";

const threadRow = {
	id: "latest-1",
	conversation_id: "thread-1",
	thread_id: "thread-1",
	thread_count: 3,
	thread_unread_count: 1,
	read: true,
} as Email;

test("U toggles aggregate conversation read state within the represented folder", () => {
	assert.deepEqual(planKeyboardConversationAction("toggle-unread", threadRow, "inbox"), {
		kind: "conversation-read",
		conversationId: "thread-1",
		folderId: "inbox",
		read: true,
	});
	assert.deepEqual(
		planKeyboardConversationAction(
			"toggle-unread",
			{ ...threadRow, thread_unread_count: 0 },
			"inbox",
		),
		{
			kind: "conversation-read",
			conversationId: "thread-1",
			folderId: "inbox",
			read: false,
		},
	);
});

test("Archive and Trash target the represented conversation, not its latest email", () => {
	assert.deepEqual(planKeyboardConversationAction("archive", threadRow, "inbox"), {
		kind: "conversation-archive",
		conversationId: "thread-1",
		folderId: "inbox",
		representativeEmailId: "latest-1",
	});
	assert.deepEqual(planKeyboardConversationAction("trash", threadRow, "sent"), {
		kind: "conversation-trash",
		conversationId: "thread-1",
		folderId: "sent",
		representativeEmailId: "latest-1",
	});
});

test("disables unsafe or nonsensical folder-level keyboard actions", () => {
	assert.equal(planKeyboardConversationAction("toggle-unread", threadRow, "sent"), null);
	assert.equal(planKeyboardConversationAction("archive", threadRow, "sent"), null);
	assert.equal(planKeyboardConversationAction("archive", threadRow, "archive"), null);
	assert.equal(planKeyboardConversationAction("trash", threadRow, "draft"), null);
	assert.equal(planKeyboardConversationAction("trash", threadRow, "outbox"), null);
});

test("keeps singleton rows on the existing per-email mutation seam", () => {
	assert.deepEqual(
		planKeyboardConversationAction(
			"archive",
			{ ...threadRow, thread_count: 1 },
			"inbox",
		),
		{ kind: "email-archive", emailId: "latest-1" },
	);
});

test("names the failed write so a reverted optimistic update explains itself", () => {
	assert.equal(
		updateEmailFailureTitle({ starred: true }),
		"Couldn’t star the conversation",
	);
	assert.equal(
		updateEmailFailureTitle({ starred: false }),
		"Couldn’t remove the star",
	);
	assert.equal(
		updateEmailFailureTitle({ read: true }),
		"Couldn’t mark the conversation as read",
	);
	assert.equal(
		updateEmailFailureTitle({ read: false }),
		"Couldn’t mark the conversation as unread",
	);
	assert.equal(
		updateEmailFailureTitle({ labels: ["x"] }),
		"Couldn’t update the conversation",
	);
	assert.equal(updateEmailFailureTitle(undefined), "Couldn’t update the conversation");
});
