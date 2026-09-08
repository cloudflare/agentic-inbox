import { Hono } from "hono";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AgentConfigSchema } from "../../shared/agent-access";
import type { Env } from "../types";
import { getMailboxStub } from "../lib/email-helpers";
import { agentTools, getAgentTool, type AgentAction } from "./definitions";
import { performAgentAction, type AgentInput } from "./actions";
import { AgentAccessError, authenticateAgent, authorizeAgent, createCredential, credentialKey, listCredentials, loadCredential, publicCredential, type AgentCredential } from "./credentials";

const MAX_BODY_BYTES = 300000;
type BackgroundContext = { waitUntil(promise: Promise<unknown>): void };
async function readJson(request: Request) {
	if (!request.headers.get("Content-Type")?.includes("application/json")) throw new AgentAccessError("Content-Type must be application/json", 415);
	const reader = request.body?.getReader();
	if (!reader) throw new AgentAccessError("JSON body required", 400);
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new AgentAccessError("Request body is too large", 413); }
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
	try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AgentAccessError("Invalid JSON", 400); }
}
function rejectForeignOrigin(request: Request) {
	const origin = request.headers.get("Origin");
	if (origin && origin !== new URL(request.url).origin) throw new AgentAccessError("Cross-origin requests are not allowed");
}
function errorResponse(error: unknown) {
	const status = error instanceof AgentAccessError ? error.status : error instanceof z.ZodError ? 400 : 500;
	const message = error instanceof AgentAccessError ? error.message : error instanceof z.ZodError ? "Invalid agent request parameters" : "Agent operation failed";
	return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

// Mounted ONLY behind the existing human Cloudflare Access authentication.
export const agentAdminRoutes = new Hono<{ Bindings: Env }>();
agentAdminRoutes.use("*", async (c, next) => { rejectForeignOrigin(c.req.raw); c.header("Cache-Control", "no-store"); return next(); });
agentAdminRoutes.onError(errorResponse);
agentAdminRoutes.get("/", async c => c.json(await listCredentials(c.env)));
agentAdminRoutes.post("/", async c => {
	const config = AgentConfigSchema.parse(await readJson(c.req.raw));
	for (const mailboxId of config.mailboxIds) if (!await c.env.BUCKET.head(`mailboxes/${mailboxId}.json`)) throw new AgentAccessError("Selected mailbox does not exist", 400);
	return c.json(await createCredential(c.env, config), 201);
});
agentAdminRoutes.put("/:id", async c => {
	const { config, revision } = z.object({ config: AgentConfigSchema, revision: z.string().min(1) }).strict().parse(await readJson(c.req.raw));
	const { record } = await loadCredential(c.env, c.req.param("id"));
	if (config.enabled) for (const mailboxId of config.mailboxIds) if (!await c.env.BUCKET.head(`mailboxes/${mailboxId}.json`)) throw new AgentAccessError("Selected mailbox does not exist", 400);
	const updated = { ...record, ...config, updatedAt: new Date().toISOString() };
	const result = await c.env.BUCKET.put(credentialKey(record.id), JSON.stringify(updated), { onlyIf: { etagMatches: revision } });
	if (!result) throw new AgentAccessError("Agent access changed elsewhere. Reload before saving", 409);
	return c.json(publicCredential(updated, result.etag));
});
agentAdminRoutes.get("/:id/activity", async c => {
	const { record } = await loadCredential(c.env, c.req.param("id"));
	const mailboxId = c.req.query("mailboxId");
	if (!mailboxId || !record.mailboxIds.includes(mailboxId)) throw new AgentAccessError("Select an assigned mailbox", 400);
	return c.json(await getMailboxStub(c.env, mailboxId).getAgentActivity(record.id));
});

export async function dispatchAgentAction(env: Env, access: AgentCredential, name: string, input: unknown, ctx?: BackgroundContext): Promise<Record<string, unknown>> {
	const definition = getAgentTool(name);
	if (!definition) throw new AgentAccessError("Unknown agent action", 404);
	const args = definition.schema.parse(input) as AgentInput;
	// Re-read for every call; no cached sessions can retain revoked permissions.
	const { record } = await loadCredential(env, access.id);
	if (record.tokenHash !== access.tokenHash || !record.enabled) throw new AgentAccessError("Agent access is disabled", 401);
	if (name === "list_mailboxes") {
		const mailboxIds: string[] = [];
		for (const mailboxId of record.mailboxIds) if (await env.BUCKET.head(`mailboxes/${mailboxId}.json`)) mailboxIds.push(mailboxId);
		return { mailboxIds, permissions: record.permissions, sendMode: record.sendMode, testMode: record.testMode, testRecipient: record.testRecipient };
	}
	authorizeAgent(record, args.mailboxId, definition.permissions);
	if (!await env.BUCKET.head(`mailboxes/${args.mailboxId}.json`)) throw new AgentAccessError("Mailbox not found", 404);
	if (!args.requestId) return performAgentAction(env, record, name as AgentAction, args);
	const operation = getMailboxStub(env, args.mailboxId).executeAgentAction(record.id, record.tokenHash, name as AgentAction, JSON.stringify(args)).then(value => JSON.parse(value) as Record<string, unknown>);
	ctx?.waitUntil(operation.then(() => {}, () => {}));
	return operation;
}

// This namespace authenticates with its own scoped keys, never with browser cookies.
export async function handleAgentRequest(request: Request, env: Env, ctx: BackgroundContext): Promise<Response> {
	try {
		rejectForeignOrigin(request);
		const access = await authenticateAgent(env, request);
		const url = new URL(request.url);
		if (url.pathname === "/agent/mcp") {
			if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
			const parsedBody = await readJson(request);
			const server = new McpServer({ name: "agentic-inbox-agent", version: "1.0.0" });
			for (const [name, definition] of Object.entries(agentTools)) {
				if (definition.permissions.some(p => !access.permissions.includes(p))) continue;
				server.tool(name, definition.description, definition.schema.shape, async input => {
					try {
						const result = await dispatchAgentAction(env, access, name, input, ctx);
						return { content: [{ type: "text" as const, text: JSON.stringify(result) }], ...("error" in result ? { isError: true } : {}) };
					} catch (error) {
						const response = errorResponse(error);
						return { content: [{ type: "text" as const, text: await response.text() }], isError: true };
					}
				});
			}
			const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
			await server.connect(transport);
			try {
				const response = await transport.handleRequest(request, { parsedBody });
				response.headers.set("Cache-Control", "no-store");
				return response;
			}
			finally { await server.close(); }
		}
		const match = url.pathname.match(/^\/agent\/api\/([a-z_]+)$/);
		if (!match || request.method !== "POST") throw new AgentAccessError("Unknown agent endpoint", 404);
		const result = await dispatchAgentAction(env, access, match[1], await readJson(request), ctx);
		return Response.json(result, { status: typeof result.httpStatus === "number" ? result.httpStatus : 200, headers: { "Cache-Control": "no-store" } });
	} catch (error) { return errorResponse(error); }
}
