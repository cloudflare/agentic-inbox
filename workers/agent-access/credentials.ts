import type { Env } from "../types";
import { AgentConfigSchema, type AgentAccess, type AgentConfig, type AgentPermission } from "../../shared/agent-access";

export class AgentAccessError extends Error {
	constructor(message: string, public status = 403) { super(message); }
}
export type AgentCredential = Omit<AgentAccess, "revision"> & { tokenHash: string };
const PREFIX = "agent-access/credentials/";
export const credentialKey = (id: string) => `${PREFIX}${id}.json`;
export async function digest(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("");
}
export function publicCredential(value: AgentCredential, revision: string): AgentAccess {
	const { tokenHash: _, ...publicValue } = value;
	return { ...publicValue, revision };
}
export async function loadCredential(env: Env, id: string) {
	if (!/^[a-f0-9-]{36}$/.test(id)) throw new AgentAccessError("Invalid agent access", 401);
	const object = await env.BUCKET.get(credentialKey(id));
	if (!object) throw new AgentAccessError("Agent access not found", 401);
	const record = await object.json<AgentCredential>();
	if (record.id !== id || !/^[a-f0-9]{64}$/.test(record.tokenHash)) throw new AgentAccessError("Invalid agent access", 401);
	AgentConfigSchema.parse(recordConfig(record));
	return { record, revision: object.etag };
}
function recordConfig(record: AgentCredential): AgentConfig {
	const { id: _, createdAt: __, updatedAt: ___, tokenHash: ____, ...config } = record;
	return config;
}
export async function authenticateAgent(env: Env, request: Request): Promise<AgentCredential> {
	const token = request.headers.get("Authorization")?.match(/^Bearer (mai_[a-f0-9-]{36}_[a-f0-9]{64})$/)?.[1];
	if (!token) throw new AgentAccessError("A scoped agent Bearer key is required", 401);
	const { record } = await loadCredential(env, token.split("_")[1]);
	const hash = await digest(token);
	let mismatch = record.tokenHash.length ^ hash.length;
	for (let i = 0; i < hash.length; i++) mismatch |= hash.charCodeAt(i) ^ (record.tokenHash.charCodeAt(i) || 0);
	if (mismatch || !record.enabled) throw new AgentAccessError("Invalid or disabled agent key", 401);
	return record;
}
export function authorizeAgent(record: AgentCredential, mailboxId: string, permissions: AgentPermission[]) {
	if (!record.enabled || !record.mailboxIds.includes(mailboxId) || permissions.some(p => !record.permissions.includes(p))) {
		throw new AgentAccessError("This agent is not authorized for this mailbox or operation");
	}
}
export async function createCredential(env: Env, config: AgentConfig) {
	const id = crypto.randomUUID();
	const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, "0")).join("");
	const token = `mai_${id}_${secret}`;
	const now = new Date().toISOString();
	const record: AgentCredential = { ...config, id, createdAt: now, updatedAt: now, tokenHash: await digest(token) };
	const saved = await env.BUCKET.put(credentialKey(id), JSON.stringify(record));
	return { access: publicCredential(record, saved!.etag), token };
}
export async function listCredentials(env: Env): Promise<AgentAccess[]> {
	const records: AgentAccess[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.BUCKET.list({ prefix: PREFIX, cursor });
		for (const item of page.objects) {
			const object = await env.BUCKET.get(item.key);
			if (object) records.push(publicCredential(await object.json<AgentCredential>(), object.etag));
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
