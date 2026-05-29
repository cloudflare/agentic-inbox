// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Canonical folder ID constants.
 *
 * Every part of the stack — API routes, Durable Object, MCP, agent,
 * frontend sidebar — references folder IDs. This module is the single
 * source of truth so we don't scatter magic strings everywhere.
 */

export const Folders = {
	INBOX: "inbox",
	SENT: "sent",
	DRAFT: "draft",
	ARCHIVE: "archive",
	TRASH: "trash",
	SPAM: "spam",
} as const;

export type FolderId = (typeof Folders)[keyof typeof Folders];

/**
 * System folder IDs that appear in the sidebar (excludes spam).
 * Order here matches the sidebar display order.
 */
export const SYSTEM_FOLDER_IDS: readonly FolderId[] = [
	Folders.INBOX,
	Folders.SENT,
	Folders.DRAFT,
	Folders.ARCHIVE,
	Folders.SPAM,
	Folders.TRASH,
];

/**
 * Human-readable display names for folder IDs.
 * Used in the sidebar, search result badges, and tool descriptions.
 */
export const FOLDER_DISPLAY_NAMES: Record<string, string> = {
	[Folders.INBOX]: "Inbox",
	[Folders.SENT]: "Sent",
	[Folders.DRAFT]: "Drafts",
	[Folders.ARCHIVE]: "Archive",
	[Folders.TRASH]: "Trash",
	[Folders.SPAM]: "Spam",
};

/** Formatted string for tool parameter descriptions (agent + MCP). */
export const FOLDER_TOOL_DESCRIPTION =
	"Folder to list: inbox, sent, draft, archive, spam, trash";

/** Formatted string for move-email tool descriptions. */
export const MOVE_FOLDER_TOOL_DESCRIPTION =
	"Target folder: inbox, sent, draft, archive, spam, trash";

/**
 * Look up a display name for a folder ID, falling back to the raw ID
 * with a capitalised first letter.
 */
export function getFolderDisplayName(folderId: string): string {
	return FOLDER_DISPLAY_NAMES[folderId.toLowerCase()] || folderId.charAt(0).toUpperCase() + folderId.slice(1);
}
