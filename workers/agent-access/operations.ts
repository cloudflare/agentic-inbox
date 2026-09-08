import type { Env } from "../types";
import type { AgentActivity } from "../../shared/agent-access";
import { AgentAccessError, authorizeAgent, digest, loadCredential } from "./credentials";
import { getAgentTool, type AgentAction } from "./definitions";
import { performAgentAction, type AgentInput } from "./actions";
import { getMailboxStub } from "../lib/email-helpers";
import { signatureTextFromHtml } from "../../shared/signature";

type Operation = { hash: string; status: "pending" | "complete"; result?: Record<string, unknown> };
export async function runAgentOperation(env: Env, storage: DurableObjectStorage, accessId: string, tokenHash: string, action: AgentAction, input: unknown): Promise<Record<string, unknown>> {
	const tool = getAgentTool(action);
	if (!tool) throw new AgentAccessError("Unknown agent action", 404);
	const args = tool.schema.parse(input) as AgentInput;
	const { record } = await loadCredential(env, accessId);
	if (record.tokenHash !== tokenHash) throw new AgentAccessError("Agent key changed", 401);
	authorizeAgent(record, args.mailboxId, tool.permissions);
	if (!args.requestId) throw new AgentAccessError("requestId is required", 400);
	const requestId = args.requestId;
	const hash = await digest(JSON.stringify({ action, args }));
	const key = `agent-operation:${accessId}:${args.requestId}`;
	const date = new Date().toISOString();
	const activityKey = `agent-activity:${accessId}:${String(9999999999999 - Date.parse(date)).padStart(13, "0")}:${args.requestId}`;
	const direct = action.startsWith("send_") && record.sendMode === "direct";
	const previous = await storage.transaction(async txn => {
		const existing = await txn.get<Operation>(key);
		if (existing) return existing;
		if (direct && args.draftId && await txn.get(`agent-submitted-draft:${args.draftId}`)) throw new AgentAccessError("This draft already has a direct submission; check its status instead of resending", 409);
		const kind = action === "generate_reply_draft" ? "generation" : direct ? "send" : "draft";
		const limit = kind === "generation" ? record.maxGenerationsPerDay : kind === "send" ? record.maxSendsPerDay : 200;
		const counter = `agent-usage:${accessId}:${date.slice(0, 10)}:${kind}`;
		const count = await txn.get<number>(counter) || 0;
		if (count >= limit) throw new AgentAccessError(`Daily ${kind} limit reached for this agent and mailbox`, 429);
		await txn.put(counter, count + 1);
		await txn.put(key, { hash, status: "pending" } satisfies Operation);
		await txn.put(activityKey, { requestId, action, date, status: "pending" } satisfies AgentActivity);
		if (direct && args.draftId) await txn.put(`agent-submitted-draft:${args.draftId}`, { accessId, requestId: args.requestId, date });
		return undefined;
	});
	if (previous) {
		if (previous.hash !== hash) throw new AgentAccessError("requestId was already used with different arguments", 409);
		if (previous.status === "pending") throw new AgentAccessError("Operation is pending or its outcome is uncertain. Do not retry with a new requestId; inspect the mailbox", 409);
		const result = previous.result!;
		if (typeof result.draftId === "string") {
			const draft = await getMailboxStub(env, args.mailboxId).getEmail(result.draftId);
			return { ...result, ...(draft ? { html: draft.body, text: signatureTextFromHtml(draft.body || "") } : {}) };
		}
		return result;
	}
	let result: Record<string, unknown>;
	try {
		result = await performAgentAction(env, record, action, args);
	} catch (error) {
		result = { status: direct && !(error instanceof AgentAccessError) ? "outcome_unknown" : "failed", sent: direct && !(error instanceof AgentAccessError) ? null : false, error: error instanceof AgentAccessError ? error.message : "Operation failed; inspect the mailbox before attempting another send", httpStatus: error instanceof AgentAccessError ? error.status : 502 };
	}
	const activity: AgentActivity = { requestId: args.requestId, action, date, status: String(result.status), ...(typeof result.emailId === "string" ? { emailId: result.emailId } : {}) };
	await storage.transaction(async txn => {
		// Email bodies stay in the email store, not duplicated in the bounded KV operation record.
		const { html: _, text: __, ...receipt } = result;
		await txn.put(key, { hash, status: "complete", result: receipt } satisfies Operation);
		await txn.put(activityKey, activity);
	});
	return result;
}

export async function executeAgentOperation(env: Env, storage: DurableObjectStorage, accessId: string, tokenHash: string, action: AgentAction, inputJson: string): Promise<string> {
	try { return JSON.stringify(await runAgentOperation(env, storage, accessId, tokenHash, action, JSON.parse(inputJson))); }
	catch (error) { return JSON.stringify({ status: "rejected", error: error instanceof AgentAccessError ? error.message : "Agent operation failed", httpStatus: error instanceof AgentAccessError ? error.status : 500 }); }
}
