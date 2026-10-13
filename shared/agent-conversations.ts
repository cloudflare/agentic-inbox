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

/**
 * Mailbox id from `/agents/email-agent/{instanceName}` where instanceName is
 * `mailboxId` or `mailboxId::conversationId`. Returned exactly as sent, not
 * decoded: partyserver names the agent after the raw path segment and the
 * agent builds its tools from that name, so the gate must authorize this same
 * string. Other agent classes (e.g. the mailbox DO) are not routable.
 */
export function mailboxIdFromAgentPath(pathname: string): string | null {
	const parts = pathname.split("/").filter(Boolean);
	if (parts[0] !== "agents" || parts[1] !== "email-agent" || parts.length < 3) {
		return null;
	}
	return mailboxIdFromAgentName(parts[2]) || null;
}

export function mailboxIdFromAgentsUrl(url: string): string | null {
	try {
		return mailboxIdFromAgentPath(new URL(url).pathname);
	} catch {
		return null;
	}
}
