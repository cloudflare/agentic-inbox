import type { KeyVariables } from "../api-keys";
import { translateEmail } from "./translation";
import { composeWithAi } from "./composer";
import { agentErrorMessage } from "./errors";
import {
	getCatalog,
	refreshCatalog,
	modelIdSchema,
	requireModel,
	type CatalogFetch,
} from "./catalog";
import type { ModelSource } from "../../shared/agent";
import { InboxStore } from "../store";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "../db";
import {
	claimRun,
	stopRun,
	startRun,
	getSettings,
	saveSettings,
	settingsSchema,
	type ModelFactory,
} from "./service";
import { consumeStream } from "ai";
import type { InboxChatMessage } from "../../shared/agent";

export interface AgentOptions {
	model?: ModelFactory;
	sources?: ModelSource[];
	fetchCatalog?: CatalogFetch;
	autoDraftAvailable?: boolean;
	actor?: string;
	classification?: { enabled: boolean; admin: boolean; kick?: () => void };
	disconnectSignal?: AbortSignal;
	waitUntil?: (task: Promise<unknown>) => void;
}
export function agentApi(db: Database, options: AgentOptions) {
	const app = new Hono<{ Variables: KeyVariables }>();
	app.get("/api/v1/mailboxes/:mailboxId/agent/compose", async (c) => {
		const mailbox = c.req.param("mailboxId");
		await new InboxStore(db).mailbox(mailbox);
		return c.json({
			settings: await getSettings(db, mailbox),
			catalog: await getCatalog(
				db,
				options.sources ?? (options.model ? ["workers"] : []),
			),
		});
	});
	app.post("/api/v1/mailboxes/:mailboxId/agent/compose", async (c) =>
		c.json(
			await composeWithAi(
				db,
				options,
				c.req.param("mailboxId"),
				await c.req.json(),
				c.req.raw.signal,
			),
		),
	);
	app.post(
		"/api/v1/mailboxes/:mailboxId/emails/:emailId/translation",
		async (c) =>
			c.json(
				await translateEmail(
					db,
					options,
					c.req.param("mailboxId"),
					z.string().uuid().parse(c.req.param("emailId")),
					await c.req.json(),
					c.req.raw.signal,
				),
			),
	);
	const sources =
		options.sources ?? (options.model ? ["workers" as const] : []);
	app.get("/api/v1/agent/models", async (c) =>
		c.json(await getCatalog(db, sources)),
	);
	app.post("/api/v1/agent/models/refresh", async (c) => {
		await refreshCatalog(db, options.fetchCatalog);
		return c.json(await getCatalog(db, sources));
	});
	app.get("/api/v1/mailboxes/:mailboxId/agent/conversations", async (c) => {
		const mailbox = c.req.param("mailboxId");
		await new InboxStore(db).mailbox(mailbox);
		const offset = z.coerce
			.number()
			.int()
			.min(0)
			.max(100000)
			.parse(c.req.query("offset") ?? 0);
		const search = (c.req.query("search") ?? "").slice(0, 200);
		const rows =
			await db`SELECT id,title,created_at,updated_at FROM agent_conversations WHERE mailbox_id=${mailbox} AND position(lower(${search}) in lower(title))>0 ORDER BY updated_at DESC,id DESC LIMIT 51 OFFSET ${offset}`;
		return c.json({
			conversations: rows.slice(0, 50),
			hasMore: rows.length > 50,
		});
	});
	app.post("/api/v1/mailboxes/:mailboxId/agent/conversations", async (c) => {
		const mailbox = c.req.param("mailboxId");
		await new InboxStore(db).mailbox(mailbox);
		const [conversation] =
			await db`INSERT INTO agent_conversations(mailbox_id) VALUES(${mailbox}) RETURNING id,title,created_at,updated_at`;
		return c.json(conversation, 201);
	});
	app.get("/api/v1/mailboxes/:mailboxId/agent", async (c) => {
		const mailbox = c.req.param("mailboxId");
		await new InboxStore(db).mailbox(mailbox);
		const conversationId = z
			.string()
			.uuid()
			.optional()
			.parse(c.req.query("conversationId"));
		let conversation;
		if (conversationId) {
			[conversation] =
				await db`SELECT id,title,created_at,updated_at FROM agent_conversations WHERE mailbox_id=${mailbox} AND id=${conversationId}`;
			if (!conversation)
				throw new HTTPException(404, { message: "Conversation not found" });
		} else {
			[conversation] =
				await db`SELECT id,title,created_at,updated_at FROM agent_conversations WHERE mailbox_id=${mailbox} ORDER BY updated_at DESC,id DESC LIMIT 1`;
			if (!conversation)
				[conversation] =
					await db`INSERT INTO agent_conversations(mailbox_id,legacy) VALUES(${mailbox},true) ON CONFLICT(mailbox_id) WHERE legacy DO UPDATE SET legacy=true RETURNING id,title,created_at,updated_at`;
		}
		const before = z.string().uuid().optional().parse(c.req.query("before"));
		const turns =
			await db`SELECT id,model,prompt,answer,actions,ui_message,usage,
		 CASE WHEN status='running' AND created_at<now()-interval '3 minutes' THEN 'failed' ELSE status END AS status,created_at
		 FROM agent_turns WHERE mailbox_id=${mailbox} AND conversation_id=${conversation.id}
		 AND (${before ?? null}::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM agent_turns WHERE id=${before ?? null} AND mailbox_id=${mailbox} AND conversation_id=${conversation.id}))
		 ORDER BY created_at DESC,id DESC LIMIT 31`;
		return c.json({
			available: !!options.model,
			autoDraftAvailable: !!options.autoDraftAvailable,
			settings: await getSettings(db, mailbox),
			catalog: await getCatalog(db, sources),
			conversation,
			hasMore: turns.length > 30,
			turns: turns.slice(0, 30).reverse(),
		});
	});
	app.put("/api/v1/mailboxes/:mailboxId/agent/settings", async (c) => {
		const input = settingsSchema.parse(await c.req.json());
		const previous = await getSettings(db, c.req.param("mailboxId"));
		if (input.auto_draft || input.model !== previous.model)
			await requireModel(db, input.model, sources);
		if (input.auto_draft && (!options.model || !options.autoDraftAvailable))
			throw new HTTPException(503, {
				message: "Automatic drafting is not configured",
			});
		return c.json(await saveSettings(db, c.req.param("mailboxId"), input));
	});
	app.post("/api/v1/mailboxes/:mailboxId/agent/stop", async (c) => {
		const { id } = z
			.object({ id: z.string().uuid() })
			.strict()
			.parse(await c.req.json());
		return c.json(await stopRun(db, c.req.param("mailboxId"), id));
	});

	app.post("/api/v1/mailboxes/:mailboxId/agent/chat", async (c) => {
		if (!options.model)
			throw new HTTPException(503, { message: "No AI provider is configured" });
		const input = z
			.object({
				id: z.string().uuid(),
				prompt: z.string().trim().min(1).max(8000),
				conversationId: z.string().uuid().optional(),
				emailId: z.string().uuid().optional(),
				model: modelIdSchema.optional(),
			})
			.strict()
			.parse(await c.req.json());
		const run = {
			...input,
			mailbox: c.req.param("mailboxId"),
			actor: c.get("apiKey")
				? `api-key:${c.get("apiKey")!.id}`
				: (options.actor ?? "local-synthetic-user"),
			permissions: c.get("apiKey")?.permissions,
			mailboxIds: c.get("apiKey")?.mailbox_ids,
			senderIds: c.get("apiKey")?.sender_identity_ids,
			defaultSenderId: c.get("apiKey")?.default_sender_identity_id,
			classification: options.classification && {
				...options.classification,
				admin: c.get("apiKey")
					? c.get("apiKey")!.permissions.includes("classifications:run")
					: options.classification.admin,
			},
		};
		await requireModel(
			db,
			input.model ?? (await getSettings(db, run.mailbox)).model,
			sources,
		);
		const settings = await claimRun(db, run);
		try {
			const execution = await startRun(
				db,
				run,
				settings,
				options.model,
				undefined,
				options.disconnectSignal ?? c.req.raw.signal,
			);
			options.waitUntil?.(execution.completion);
			return execution.result.toUIMessageStreamResponse<InboxChatMessage>({
				generateMessageId: () => `${run.id}-assistant`,
				sendReasoning: false,
				messageMetadata: ({ part }) =>
					part.type === "start" ? { model: settings.model } : undefined,
				onError: agentErrorMessage,
				onFinish: async ({ responseMessage }) => {
					await execution.completion;
					await db`UPDATE agent_turns SET ui_message=${db.json(JSON.parse(JSON.stringify(responseMessage)))} WHERE id=${run.id} AND mailbox_id=${run.mailbox}`;
				},
				// Drain final stream state after abort so partial history is saved.
				consumeSseStream: ({ stream }) => {
					const task = consumeStream({ stream });
					options.waitUntil?.(task);
					return task;
				},
				headers: {
					"Cache-Control": "no-store",
					"x-chat-model": settings.model,
				},
			});
		} catch (error) {
			await db`UPDATE agent_turns SET status='failed',answer='Could not start the model. Check provider configuration.' WHERE id=${run.id} AND mailbox_id=${run.mailbox} AND status='running'`;
			await db`UPDATE agent_settings SET active_run=NULL,lease_until=NULL WHERE mailbox_id=${run.mailbox} AND active_run=${run.id}`;
			throw error;
		}
	});
	return app;
}
