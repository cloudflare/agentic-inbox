/**
 * Lightweight checks for shared agent conversation naming helpers.
 * Run: pnpm test:unit
 */

import assert from "node:assert/strict";

const AGENT_NAME_SEPARATOR = "::";
const AUTO_CONVERSATION_ID = "auto";

function agentInstanceName(mailboxId, conversationId) {
	return `${mailboxId}${AGENT_NAME_SEPARATOR}${conversationId}`;
}

function mailboxIdFromAgentName(agentName) {
	const idx = agentName.lastIndexOf(AGENT_NAME_SEPARATOR);
	if (idx === -1) return agentName;
	return agentName.slice(0, idx);
}

function conversationIdFromAgentName(agentName) {
	const idx = agentName.lastIndexOf(AGENT_NAME_SEPARATOR);
	if (idx === -1) return null;
	return agentName.slice(idx + AGENT_NAME_SEPARATOR.length) || null;
}

const mailbox = "hello@example.com";
const conv = "c_abc123";

assert.equal(agentInstanceName(mailbox, conv), "hello@example.com::c_abc123");
assert.equal(mailboxIdFromAgentName("hello@example.com"), "hello@example.com");
assert.equal(
	mailboxIdFromAgentName(agentInstanceName(mailbox, conv)),
	mailbox,
);
assert.equal(
	conversationIdFromAgentName(agentInstanceName(mailbox, AUTO_CONVERSATION_ID)),
	AUTO_CONVERSATION_ID,
);
assert.equal(conversationIdFromAgentName(mailbox), null);

console.log("agent-conversations helpers: ok");
