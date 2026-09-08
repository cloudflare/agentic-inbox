import { z } from "zod";
import type { AgentPermission } from "../../shared/agent-access";

const mailboxId = z.string().trim().toLowerCase().email();
const id = z.string().min(1).max(200);
const footer = z.object({ enabled: z.boolean(), text: z.string().max(20000).optional() }).strict();
const write = { mailboxId, requestId: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/) };
const message = { ...write, to: z.string().trim().toLowerCase().email(), subject: z.string().max(1000).regex(/^[^\r\n]*$/), bodyHtml: z.string().min(1).max(200000), footer };
export const agentTools = {
	list_mailboxes: { description: "List only the mailboxes this agent can access and its permissions.", permissions: [], schema: z.object({}).strict() },
	get_mailbox: { description: "Get the selected mailbox's sender name and saved footer, without private administration settings.", permissions: [], schema: z.object({ mailboxId }).strict() },
	list_emails: { description: "List email metadata in an authorized mailbox.", permissions: ["read"], schema: z.object({ mailboxId, folder: z.enum(["inbox", "sent", "draft", "archive", "trash", "spam"]).default("inbox"), limit: z.number().int().min(1).max(100).default(20), page: z.number().int().min(1).default(1) }).strict() },
	get_email: { description: "Read one email or draft in an authorized mailbox.", permissions: ["read"], schema: z.object({ mailboxId, emailId: id }).strict() },
	get_thread: { description: "Read a conversation in an authorized mailbox.", permissions: ["read"], schema: z.object({ mailboxId, threadId: id }).strict() },
	search_emails: { description: "Search an authorized mailbox.", permissions: ["read"], schema: z.object({ mailboxId, query: z.string().min(1).max(1000) }).strict() },
	create_draft: { description: "Store supplied content as a new draft. Never sends or reads existing emails. Explicitly choose footer.enabled. Reuse requestId for retries.", permissions: ["draft"], schema: z.object(message).strict() },
	generate_reply_draft: { description: "Have the inbox AI write and save a reply using this mailbox's prompt and thread context. Returns draft content for review; never sends. Works when automatic drafts are off. Reuse requestId for retries.", permissions: ["read", "draft"], schema: z.object({ ...write, originalEmailId: id, instructions: z.string().max(4000).optional(), footer }).strict() },
	send_email: { description: "Submit a new message. In draft_only mode this ONLY saves a draft; direct mode sends. Explicit footer.enabled is required. Reuse the same requestId and arguments on retries to prevent duplicate delivery.", permissions: ["send"], schema: z.object(message).strict() },
	send_reply: { description: "Submit a threaded reply. In draft_only mode only saves a draft. Explicit footer.enabled and a stable requestId are required.", permissions: ["read", "send"], schema: z.object({ ...message, originalEmailId: id }).strict() },
	send_draft: { description: "Submit an existing draft without deleting it. In draft_only mode it remains a draft. Explicitly select the footer, optionally overriding its text. Reuse requestId on retries.", permissions: ["read", "send"], schema: z.object({ ...write, draftId: id, footer }).strict() },
} satisfies Record<string, { description: string; permissions: AgentPermission[]; schema: z.AnyZodObject }>;
export type AgentAction = keyof typeof agentTools;
export function getAgentTool(action: string) {
	return Object.prototype.hasOwnProperty.call(agentTools, action) ? agentTools[action as AgentAction] : undefined;
}
