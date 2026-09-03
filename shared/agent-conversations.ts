// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Helpers for multi-conversation EmailAgent Durable Object naming.
 *
 * Legacy web clients connect with `name = mailboxId` (single chat).
 * Mobile / multi-chat clients use `mailboxId::conversationId`.
 * Auto-drafts land in the reserved `auto` conversation.
 */

export const AUTO_CONVERSATION_ID = "auto";
export const AGENT_NAME_SEPARATOR = "::";

export function agentInstanceName(
	mailboxId: string,
	conversationId: string,
): string {
	return `${mailboxId}${AGENT_NAME_SEPARATOR}${conversationId}`;
}

/**
 * Resolve the mailbox email from an EmailAgent DO `name`.
 * Supports both legacy (`mailboxId`) and multi-chat (`mailboxId::convId`) forms.
 */
export function mailboxIdFromAgentName(agentName: string): string {
	const idx = agentName.lastIndexOf(AGENT_NAME_SEPARATOR);
	if (idx === -1) return agentName;
	return agentName.slice(0, idx);
}

export function conversationIdFromAgentName(agentName: string): string | null {
	const idx = agentName.lastIndexOf(AGENT_NAME_SEPARATOR);
	if (idx === -1) return null;
	return agentName.slice(idx + AGENT_NAME_SEPARATOR.length) || null;
}
