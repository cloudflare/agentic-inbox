import type { DirectorySearch } from "./workspace-directory";
import {
	sendEmailSchema as sendSchema,
	saveDraftSchema as draftSchema,
	saveDraftResultSchema,
	type SendResult,
} from "../shared/mail";
import { operationsApi, readiness } from "./operations";
import type { ObjectStore } from "./inbound";
import {
	apiKeysApi,
	keySenderAccess,
	authenticateApiKey,
	keyCanRequest,
	type KeyVariables,
} from "./api-keys";
import { membersApi, type MemberRole } from "./members";
import { webhookApi } from "./webhooks/api";
import {
	updateDraft,
	updateMessageFlags,
	messageFlagsSchema,
	setThreadRead,
} from "./email-actions";
import { DraftIntentConflict, draftSendIntent } from "./draft-intent";
import { recipientSuggestions } from "./contacts";
import {
	statusChangeSchema,
	threadStatusSchema,
} from "../shared/thread-status";
import { getThreadWorkflow, changeThreadStatus } from "./thread-status";
import { agentApi, type AgentOptions } from "./agent/api";
import { classifierApi } from "./classification/api";
import { setConversationTags } from "./tags";
import { tagGroupsApi } from "./tag-groups";
import { documentation } from "./docs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Database } from "./db";
import { InboxStore, type MessageRow } from "./store";

import { SenderStore } from "./senders";
import { scopeSenders } from "../shared/senders";
import { sendReal, type MailSender } from "./outbound";
import { liveSender, mailboxConfig } from "./mailboxes";

const id = z.string().uuid();
const tagSchema = z
	.object({
		name: z.string().trim().min(1).max(80),
		color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
	})
	.strict();
const querySchema = z.object({
	score_group: id.optional(),
	status: threadStatusSchema.optional(),
	tag_id: id.optional(),
	tag_ids: z
		.string()
		.max(1849)
		.transform((v) => v.split(","))
		.pipe(z.array(id).min(1).max(50))
		.optional(),
	tag_match: z.enum(["all", "any"]).optional(),
	needs_review: z.enum(["true", "false"]).optional(),
	page: z.coerce.number().int().min(1).max(100000).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
	thread_id: id.optional(),
	date_start: z.string().datetime({ offset: true }).optional(),
	date_end: z.string().datetime({ offset: true }).optional(),
	is_read: z.enum(["true", "false"]).optional(),
	is_starred: z.enum(["true", "false"]).optional(),
});

export interface ApiOptions {
	directorySearch?: DirectorySearch;
	readinessCheck?: () => Promise<boolean>;
	recoveryObjects?: ObjectStore;
	webhookSecretKey?: string;
	actorRole?: MemberRole;
	membershipEnabled?: boolean;
	agent?: AgentOptions;
	jevKey?: string;
	jevTransport?: typeof fetch;
	classifierPreview?: boolean;
	classifiersEnabled?: boolean;
	kickClassifiers?: (tokens?: string[]) => void;
	previewRoutes?: Hono;
	readAttachment: (key: string) => Promise<Uint8Array | null>;
	// Remote authentication is enforced by the Worker before it constructs this API.
	origin?: string;
	mode?: "live" | "synthetic";
	sender?: MailSender;
	actor?: string;
	mailboxAdmins?: string[];
	mailboxCreationEnabled?: boolean;
}

export function createApi(db: Database, options: ApiOptions) {
	const store = new InboxStore(db, {
		classifierPreview: options.classifierPreview,
	});
	const isLive = options.mode === "live";
	const senders = new SenderStore(db);
	const isAdmin =
		!isLive ||
		(options.actorRole
			? options.actorRole === "admin"
			: (options.mailboxAdmins ?? []).includes(
					options.actor?.toLowerCase() ?? "",
				));
	const canCreate =
		!isLive ||
		(options.mailboxCreationEnabled === true && !!options.actor && isAdmin);
	const app = new Hono<{ Variables: KeyVariables }>();
	app.use("*", bodyLimit({ maxSize: 256_000 }));
	app.use("*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		const authorization = c.req.header("authorization");
		if (authorization && /^Bearer\s/i.test(authorization)) {
			const key = await authenticateApiKey(db, authorization);
			c.set("apiKey", key);
			if (!keyCanRequest(key, c.req.method, c.req.path))
				throw new HTTPException(403, {
					message: "API key does not permit this operation or mailbox",
				});
		}
		if (
			isLive &&
			options.membershipEnabled &&
			!options.actorRole &&
			!c.get("apiKey")
		)
			throw new HTTPException(403, { message: "Inbox membership required" });
		// Local origin checks are retained; the Worker authenticates remote requests.
		const host = c.req.header("host") ?? new URL(c.req.url).host;
		if (
			options.origin
				? host !== new URL(options.origin).host
				: !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)
		)
			return c.json({ error: "Local access only" }, 403);
		const origin = c.req.header("origin");
		if (
			origin &&
			(options.origin
				? origin !== options.origin
				: !/^http:\/\/(localhost|127\.0\.0\.1):(4310|4311)$/.test(origin))
		)
			return c.json({ error: "Cross-origin access denied" }, 403);
		if (
			["POST", "PUT", "PATCH"].includes(c.req.method) &&
			!c.req.header("content-type")?.startsWith("application/json")
		) {
			return c.json({ error: "Use application/json" }, 415);
		}
		c.header("Cache-Control", "no-store");
		await next();
	});
	app.onError((error, c) => {
		if (error instanceof DraftIntentConflict)
			return c.json(
				{
					error: error.message,
					code: "draft_intent_conflict",
					rejected_request_id: error.rejectedRequestId,
				},
				422,
			);
		if (error instanceof HTTPException)
			return c.json({ error: error.message }, error.status);
		if (error instanceof z.ZodError || error instanceof SyntaxError)
			return c.json({ error: "Invalid request", details: error.message }, 400);
		if ("code" in error && error.code === "23505")
			return c.json({ error: "Already exists" }, 409);
		if ("code" in error && error.code === "23503")
			return c.json(
				{ error: "Referenced item does not exist or is still in use" },
				409,
			);
		console.error("Inbox request failed:", error.message);
		return c.json({ error: "Request failed" }, 500);
	});
	app.route(
		"/api/v1/api-keys",
		apiKeysApi(db, { admin: isAdmin, actor: options.actor ?? "local-preview" }),
	);
	app.route(
		"/api/v1/webhooks",
		webhookApi(db, {
			secretKey: options.webhookSecretKey,
			canManage: isAdmin,
		}),
	);

	app.use("/api/*", async (c, next) => {
		if (
			options.membershipEnabled &&
			!isAdmin &&
			!["GET", "HEAD", "OPTIONS"].includes(c.req.method)
		) {
			const path = c.req.path;
			if (
				/^\/api\/v1\/tags(?:\/|$)/.test(path) ||
				path === "/api/v1/agent/models/refresh" ||
				/\/agent\/settings$/.test(path) ||
				/^\/api\/v1\/mailboxes\/[^/]+$/.test(path)
			)
				throw new HTTPException(403, {
					message: "Administrator access required",
				});
		}
		await next();
	});
	app.use("/api/v1/access/members", async (c, next) => {
		if (isLive && !options.membershipEnabled)
			throw new HTTPException(503, {
				message: "Member management is not enabled",
			});
		await next();
	});
	app.use("/api/v1/access/members/*", async (c, next) => {
		if (isLive && !options.membershipEnabled)
			throw new HTTPException(503, {
				message: "Member management is not enabled",
			});
		await next();
	});
	app.route(
		"/api/v1/access/members",
		membersApi(db, {
			actor: options.actor?.toLowerCase() ?? "local-preview",
			admin: isAdmin,
		}),
	);

	app.route("/", documentation());
	app.route(
		"/api/v1/operations",
		operationsApi(db, {
			admin: isAdmin,
			actor: options.actor ?? "local-preview",
			objects: options.recoveryObjects,
		}),
	);
	app.get("/api/health", async (c) => {
		const ready = await readiness(db, options.readinessCheck);
		return c.json(
			{ status: ready ? "ready" : "unavailable" },
			ready ? 200 : 503,
		);
	});
	app.get("/api/v1/config", (c) =>
		c.json(
			c.get("apiKey")
				? {
						access: { role: "integration", managed: true },
						mailbox_ids: c.get("apiKey")!.mailbox_ids,
						permissions: c.get("apiKey")!.permissions,
						sender_identity_ids: c.get("apiKey")!.sender_identity_ids,
						default_sender_identity_id:
							c.get("apiKey")!.default_sender_identity_id,
						canManageWebhooks: c
							.get("apiKey")!
							.permissions.includes("webhooks:manage"),
					}
				: {
						domains:
							options.mode === "live"
								? ["ingest.realadvisor.com"]
								: ["example.test"],
						emailAddresses: [],
						access: {
							role: isAdmin ? "admin" : "user",
							managed: options.membershipEnabled === true || !isLive,
						},
						canCreateMailboxes: canCreate,
						classifierPreview: !isLive && options.classifierPreview === true,
						classifiersEnabled: options.classifiersEnabled === true,
						canManageWebhooks: isAdmin,
						canManageClassifiers:
							options.classifiersEnabled === true && isAdmin,
						canDeleteMailboxes: !isLive,
						mode: options.mode ?? "synthetic",
					},
		),
	);
	app.get("/api/v1/sender-identities", async (c) => {
		const config = await senders.configuration();
		if (isLive)
			config.senders = config.senders.map((s) => ({
				...s,
				active:
					s.active && !!s.mailbox_id && liveSender(s.mailbox_id) === s.email,
			}));
		return c.json(scopeSenders(config, keySenderAccess(c.get("apiKey"))));
	});
	const senderInput = z
		.object({
			email: z
				.string()
				.trim()
				.email()
				.max(254)
				.transform((s) => s.toLowerCase()),
			name: z.string().trim().min(1).max(200),
			mailbox_id: z.string().min(1).max(254),
		})
		.strict();
	app.use("/api/v1/sender-identities/*", async (c, next) => {
		if (c.req.method !== "GET" && c.req.method !== "HEAD") {
			const key = c.get("apiKey");
			if (key ? !key.permissions.includes("senders:manage") : !isAdmin)
				throw new HTTPException(403, {
					message: "Administrator access or senders:manage permission required",
				});
		}
		await next();
	});
	app.post("/api/v1/sender-identities", async (c) => {
		const key = c.get("apiKey");
		if (key ? !key.permissions.includes("senders:manage") : !isAdmin)
			throw new HTTPException(403, {
				message: "Administrator access or senders:manage permission required",
			});
		return c.json(
			await senders.save(senderInput.parse(await c.req.json()), {
				live: isLive,
				mailboxIds: key?.mailbox_ids,
			}),
			201,
		);
	});
	app.put("/api/v1/sender-identities/:senderId", async (c) =>
		c.json(
			await senders.save(
				senderInput.parse(await c.req.json()),
				{ live: isLive, mailboxIds: c.get("apiKey")?.mailbox_ids },
				c.req.param("senderId"),
			),
		),
	);
	app.delete("/api/v1/sender-identities/:senderId", async (c) => {
		await senders.remove(c.req.param("senderId"), c.get("apiKey")?.mailbox_ids);
		return c.body(null, 204);
	});

	app.patch("/api/v1/inbox-settings", async (c) => {
		const key = c.get("apiKey");
		if (key ? !key.permissions.includes("senders:manage") : !isAdmin)
			throw new HTTPException(403, {
				message: "Administrator access or senders:manage permission required",
			});
		const input = z
			.object({ default_sender_identity_id: z.string().min(1).max(254) })
			.strict()
			.parse(await c.req.json());
		await senders.setDefault(input.default_sender_identity_id, {
			live: isLive,
			mailboxIds: key?.mailbox_ids,
		});
		return c.json(input);
	});
	app.route("/api/v1/tag-groups", tagGroupsApi(db, isAdmin));
	app.get("/api/v1/tags", async (c) =>
		c.json(
			await db`SELECT t.*,g.name AS group_name,g.selection AS group_selection FROM tags t LEFT JOIN tag_groups g ON g.id=t.group_id WHERE t.archived_at IS NULL ORDER BY g.name,t.position,lower(t.name),t.id`,
		),
	);
	app.post("/api/v1/tags", async (c) => {
		const input = tagSchema.parse(await c.req.json());
		const [tag] = await db`INSERT INTO tags ${db(input)} RETURNING *`;
		return c.json(tag, 201);
	});
	app.put("/api/v1/tags/:tagId", async (c) => {
		const input = tagSchema.parse(await c.req.json());
		const [grouped] =
			await db`SELECT 1 FROM tags WHERE id=${id.parse(c.req.param("tagId"))} AND group_id IS NOT NULL`;
		if (grouped)
			throw new HTTPException(409, {
				message:
					"Edit this tag in its group so Jev's instructions stay in sync.",
			});
		const [tag] =
			await db`UPDATE tags SET ${db(input)}, updated_at=now() WHERE id=${id.parse(c.req.param("tagId"))} RETURNING *`;
		if (!tag) throw new HTTPException(404);
		return c.json(tag);
	});
	app.delete("/api/v1/tags/:tagId", async (c) => {
		const [grouped] =
			await db`SELECT 1 FROM tags WHERE id=${id.parse(c.req.param("tagId"))} AND group_id IS NOT NULL`;
		if (grouped)
			throw new HTTPException(409, {
				message: "Remove this tag through its group.",
			});
		if (c.req.query("confirm") !== "true")
			throw new HTTPException(400, {
				message: "Deleting a shared tag requires confirm=true",
			});
		const rows =
			await db`DELETE FROM tags WHERE id=${id.parse(c.req.param("tagId"))} RETURNING id`;
		if (!rows.length) throw new HTTPException(404);
		return c.body(null, 204);
	});
	app.get("/api/v1/mailboxes", async (c) =>
		c.json(
			(await store.listMailboxes()).filter(
				(m) =>
					(!c.get("apiKey") || c.get("apiKey")!.mailbox_ids.includes(m.id)) &&
					(options.mode !== "live" || liveSender(m.id)),
			),
		),
	);
	app.post("/api/v1/mailboxes", async (c) => {
		if (!canCreate)
			throw new HTTPException(403, {
				message: "Mailbox creation requires an enabled mailbox administrator",
			});
		const input = z
			.object({
				email: z.string().email().max(254),
				name: z.string().trim().min(1).max(120),
			})
			.parse(await c.req.json());
		const address = input.email.toLowerCase();
		if (isLive && !liveSender(address))
			throw new HTTPException(400, {
				message:
					"Use a valid address on ingest.realadvisor.com (letters, numbers, dots, hyphens or underscores; maximum 64 characters before @)",
			});
		return c.json(
			await store.createMailbox(address, input.name, options.actor),
			201,
		);
	});
	app.use("/api/v1/mailboxes/:mailboxId", async (c, next) => {
		if (
			options.mode === "live" &&
			!(await mailboxConfig(db, c.req.param("mailboxId")))
		)
			throw new HTTPException(404);
		await next();
	});
	app.use("/api/v1/mailboxes/:mailboxId/*", async (c, next) => {
		if (
			options.mode === "live" &&
			!(await mailboxConfig(db, c.req.param("mailboxId")))
		)
			throw new HTTPException(404);
		await store.mailbox(c.req.param("mailboxId"));
		await next();
	});
	app.route(
		"/",
		agentApi(db, {
			...options.agent,
			actor: options.actor,
			classification: {
				enabled: options.classifiersEnabled === true,
				admin: isAdmin,
				kick: options.kickClassifiers,
			},
		}),
	);
	const tagActor = (key?: KeyVariables["apiKey"]) => {
		if (key) return `api-key:${key.id}`;
		if (isLive && !options.actor) throw new HTTPException(403);
		return options.actor ?? "local-synthetic-user";
	};
	for (const method of ["put", "delete"] as const) {
		app[method](
			"/api/v1/mailboxes/:mailboxId/threads/:threadId/tags/:tagId",
			async (c) => {
				await setConversationTags(
					db,
					c.req.param("mailboxId"),
					[id.parse(c.req.param("threadId"))],
					id.parse(c.req.param("tagId")),
					method === "put" ? "add" : "remove",
					tagActor(c.get("apiKey")),
				);
				return c.body(null, 204);
			},
		);
	}
	app.post("/api/v1/mailboxes/:mailboxId/tags/bulk", async (c) => {
		const input = z
			.object({
				thread_ids: z.array(id).min(1).max(100),
				tag_id: id,
				action: z.enum(["add", "remove"]),
			})
			.strict()
			.parse(await c.req.json());
		await setConversationTags(
			db,
			c.req.param("mailboxId"),
			input.thread_ids,
			input.tag_id,
			input.action,
			tagActor(c.get("apiKey")),
		);
		return c.body(null, 204);
	});
	app.get("/api/v1/mailboxes/:mailboxId/recipients", async (c) =>
		c.json(
			await recipientSuggestions(
				db,
				c.req.param("mailboxId"),
				c.req.query("q") ?? "",
				(c.req.query("exclude") ?? "").split(",").slice(0, 50),
				c.get("apiKey") ? undefined : options.directorySearch,
			),
		),
	);
	app.get("/api/v1/mailboxes/:mailboxId", async (c) =>
		c.json(await store.mailbox(c.req.param("mailboxId"))),
	);
	app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
		await store.mailbox(c.req.param("mailboxId"));
		const { settings } = z
			.object({ settings: z.object({ fromName: z.string().max(120) }) })
			.parse(await c.req.json());
		const [row] = await db`UPDATE mailboxes SET settings = ${db.json(
			settings,
		)} WHERE id = ${c.req.param("mailboxId")} RETURNING *`;
		return c.json(row);
	});
	app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
		if (options.mode === "live")
			throw new HTTPException(403, {
				message: "Live mailboxes cannot be deleted",
			});
		await store.mailbox(c.req.param("mailboxId"));
		await db`DELETE FROM mailboxes WHERE id = ${c.req.param("mailboxId")}`;
		return c.body(null, 204);
	});
	for (const suffix of ["emails", "search"]) {
		app.get(`/api/v1/mailboxes/:mailboxId/${suffix}`, async (c) => {
			querySchema.parse(c.req.query());
			return c.json(await store.list(c.req.param("mailboxId"), c.req.query()));
		});
	}
	app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c) =>
		c.json(
			await store.message(
				c.req.param("mailboxId"),
				id.parse(c.req.param("id")),
			),
		),
	);
	app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c) => {
		const input = messageFlagsSchema.parse(await c.req.json());
		const messageId = id.parse(c.req.param("id"));
		await updateMessageFlags(db, c.req.param("mailboxId"), messageId, input);
		return c.json(await store.message(c.req.param("mailboxId"), messageId));
	});
	app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c) => {
		if (c.get("apiKey")) {
			const rows =
				await db`DELETE FROM emails WHERE mailbox_id=${c.req.param("mailboxId")} AND id=${id.parse(c.req.param("id"))} AND delivery_status='draft' AND NOT EXISTS (SELECT 1 FROM outbound_requests WHERE email_id=emails.id) RETURNING id`;
			if (!rows.length)
				throw new HTTPException(404, { message: "Draft not found" });
			return c.body(null, 204);
		}
		const [outbound] =
			await db`SELECT request_id FROM outbound_requests WHERE mailbox_id=${c.req.param("mailboxId")} AND email_id=${id.parse(c.req.param("id"))}`;
		if (outbound)
			throw new HTTPException(409, {
				message:
					"Sent messages retain their delivery record. Move this message to Trash instead.",
			});
		const rows = await db`DELETE FROM emails WHERE mailbox_id = ${c.req.param(
			"mailboxId",
		)} AND id = ${id.parse(c.req.param("id"))} RETURNING id`;
		if (!rows.length) throw new HTTPException(404);
		return c.body(null, 204);
	});
	app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c) => {
		const { folderId } = z
			.object({ folderId: z.string().min(1).max(100) })
			.parse(await c.req.json());
		const rows =
			await db`UPDATE emails SET folder_id = ${folderId} WHERE mailbox_id = ${c.req.param(
				"mailboxId",
			)} AND id = ${id.parse(c.req.param("id"))} RETURNING id`;
		if (!rows.length) throw new HTTPException(404);
		return c.body(null, 204);
	});
	app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c) =>
		c.json(
			await store.thread(
				c.req.param("mailboxId"),
				id.parse(c.req.param("threadId")),
			),
		),
	);
	app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId/status", async (c) =>
		c.json(
			await getThreadWorkflow(
				db,
				c.req.param("mailboxId"),
				id.parse(c.req.param("threadId")),
			),
		),
	);
	app.put(
		"/api/v1/mailboxes/:mailboxId/threads/:threadId/status",
		async (c) => {
			const parsed = statusChangeSchema.safeParse(await c.req.json());
			if (!parsed.success)
				throw new HTTPException(400, {
					message: parsed.error.issues[0].message,
				});
			return c.json(
				await changeThreadStatus(
					db,
					c.req.param("mailboxId"),
					id.parse(c.req.param("threadId")),
					parsed.data,
					tagActor(c.get("apiKey")),
				),
			);
		},
	);
	app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c) => {
		const body = await c.req.text();
		const input = z
			.object({ read: z.boolean().default(true) })
			.strict()
			.parse(body ? JSON.parse(body) : {});
		await setThreadRead(
			db,
			c.req.param("mailboxId"),
			id.parse(c.req.param("threadId")),
			input.read,
		);
		return c.body(null, 204);
	});
	app.get("/api/v1/mailboxes/:mailboxId/folders", async (c) =>
		c.json(await store.folders(c.req.param("mailboxId"))),
	);
	app.post("/api/v1/mailboxes/:mailboxId/folders", async (c) => {
		const { name } = z
			.object({ name: z.string().trim().min(1).max(100) })
			.parse(await c.req.json());
		const [row] =
			await db`INSERT INTO folders (mailbox_id, id, name) VALUES (${c.req.param(
				"mailboxId",
			)}, ${crypto.randomUUID()}, ${name}) RETURNING *, 0 AS "unreadCount"`;
		return c.json(row, 201);
	});
	app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c) => {
		const { name } = z
			.object({ name: z.string().trim().min(1).max(100) })
			.parse(await c.req.json());
		const [row] =
			await db`UPDATE folders SET name = ${name} WHERE mailbox_id = ${c.req.param(
				"mailboxId",
			)} AND id = ${c.req.param("id")} AND is_deletable RETURNING *`;
		if (!row)
			throw new HTTPException(409, { message: "Cannot rename this folder" });
		return c.json(row);
	});
	app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c) => {
		const rows = await db`DELETE FROM folders WHERE mailbox_id = ${c.req.param(
			"mailboxId",
		)} AND id = ${c.req.param("id")} AND is_deletable RETURNING id`;
		if (!rows.length)
			throw new HTTPException(409, { message: "Cannot delete this folder" });
		return c.body(null, 204);
	});
	app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c) => {
		const input = draftSchema.parse(await c.req.json());
		const mailbox = await store.mailbox(c.req.param("mailboxId"));
		const existing = input.draft_id
			? await store.message(mailbox.id, input.draft_id)
			: undefined;
		if (existing && existing.delivery_status !== "draft")
			throw new HTTPException(404);
		if (
			input.in_reply_to &&
			input.draft_source_id &&
			input.in_reply_to !== input.draft_source_id
		)
			throw new HTTPException(400, { message: "Conflicting draft source IDs" });
		if (
			existing &&
			input.in_reply_to &&
			input.in_reply_to !== existing.draft_source_id
		)
			throw new HTTPException(409, { message: "Draft source cannot change" });
		// An already-open pre-upgrade composer supplies only the legacy alias.
		// Keep that intent unknown, rather than inventing an explicit new mode
		// that would conflict with the old tab's subsequent reply endpoint.
		const mode =
			input.draft_mode ??
			existing?.draft_mode ??
			(input.in_reply_to ? null : "new");
		const parentId =
			input.draft_source_id ?? input.in_reply_to ?? existing?.draft_source_id;
		if (mode !== "new" && !parentId)
			throw new HTTPException(400, { message: "Draft source is required" });
		const parent = parentId
			? await store.message(mailbox.id, parentId)
			: undefined;
		if (parent?.delivery_status === "draft")
			throw new HTTPException(400, {
				message: "Draft source must be a delivered message",
			});
		const sender = await senders.resolve(
			{
				explicit: input.sender_identity_id,
				draft: existing?.sender_identity_id,
				reply: mode === "reply" || mode === "reply-all" ? parent : undefined,
				mailboxId: mailbox.id,
			},
			{ live: isLive, ...keySenderAccess(c.get("apiKey")) },
		);
		let threadId = input.thread_id;
		if (parent) {
			threadId = parent.thread_id ?? parent.id;
		} else if (threadId && !(await store.thread(mailbox.id, threadId)).length)
			throw new HTTPException(404);
		if (input.draft_id) {
			return c.json(
				await updateDraft(
					db,
					mailbox.id,
					input.draft_id,
					{ ...input, sender_identity_id: sender.id },
					input.draft_version,
				),
			);
		}
		const draft = await store.insert(mailbox.id, {
			sender: sender.email,
			sender_identity_id: sender.id,
			recipient: input.to,
			subject: input.subject,
			body: input.body,
			cc: input.cc,
			bcc: input.bcc,
			folder_id: "draft",
			delivery_status: "draft",
			read: true,
			thread_id: threadId,
			draft_mode: mode,
			draft_source_id: parentId,
		});
		return c.json(
			saveDraftResultSchema.parse({
				draft_id: draft!.id,
				sender_identity_id: sender.id,
				sender: sender.email,
				draft_version: (await store.message(mailbox.id, draft!.id))
					.draft_version,
			}),
			201,
		);
	});
	for (const action of ["", "/:id/reply", "/:id/forward"]) {
		app.post(`/api/v1/mailboxes/:mailboxId/emails${action}`, async (c) => {
			const input = sendSchema.parse(await c.req.json());
			if (options.mode === "live") {
				const actor = c.get("apiKey")
					? `api-key:${c.get("apiKey")!.id}`
					: options.actor;
				if (!options.sender || !actor)
					throw new HTTPException(503, {
						message: "Email sending is not configured",
					});
				const key = id.parse(c.req.header("idempotency-key"));
				return c.json(
					await sendReal(
						db,
						options.sender,
						c.req.param("mailboxId"),
						key,
						input,
						actor,
						action ? c.req.param("id") : undefined,
						action.endsWith("reply"),
						keySenderAccess(c.get("apiKey")),
					),
					201,
				);
			}
			const mailbox = await store.mailbox(c.req.param("mailboxId"));

			const draft = input.draft_id
				? await store.message(mailbox.id, input.draft_id)
				: undefined;
			if (draft && draft.delivery_status !== "draft")
				throw new HTTPException(404);
			const { parent, isReply: reply } = await draftSendIntent(
				store,
				mailbox.id,
				draft,
				action ? id.parse(c.req.param("id")) : undefined,
				action.endsWith("reply"),
				input.draft_mode,
			);
			const sender = await senders.resolve(
				{
					explicit: input.sender_identity_id,
					draft: draft?.sender_identity_id,
					reply: reply ? parent : undefined,
					mailboxId: mailbox.id,
				},
				keySenderAccess(c.get("apiKey")),
			);
			const message = await store.insert(mailbox.id, {
				sender: sender.email,
				sender_identity_id: sender.id,
				recipient: joinRecipients(input.to),
				cc: joinRecipients(input.cc),
				bcc: joinRecipients(input.bcc),
				subject: input.subject,
				body: input.html ?? escapeHtml(input.text ?? ""),
				folder_id: "sent",
				read: true,
				delivery_status: "simulated",
				thread_id: parent?.thread_id ?? parent?.id,
				in_reply_to: reply ? (parent?.message_id ?? undefined) : undefined,
				email_references: reply
					? [parent?.email_references, parent?.message_id]
							.filter(Boolean)
							.join(" ")
					: undefined,
			});
			return c.json(
				{
					id: message?.id,
					status: "simulated",
					sender_identity_id: sender.id,
					sender: sender.email,
				} satisfies SendResult,
				201,
			);
		});
	}
	app.get(
		"/api/v1/mailboxes/:mailboxId/emails/:id/attachments/:attachmentId",
		async (c) => {
			const [attachment] = await db<
				{ storage_key: string; filename: string; mimetype: string | null }[]
			>`SELECT storage_key, filename, mimetype FROM attachments
			WHERE mailbox_id = ${c.req.param("mailboxId")} AND email_id = ${id.parse(
				c.req.param("id"),
			)} AND id = ${id.parse(c.req.param("attachmentId"))}`;
			// The key is server-written and scoped by the mailbox query above; inbound
			// mail stores `inbound-attachments/...` keys, imports store UUIDs.
			if (!attachment?.storage_key) throw new HTTPException(404);
			const content = await options.readAttachment(attachment.storage_key);
			if (!content) throw new HTTPException(404);
			const filename = encodeURIComponent(attachment.filename);
			const type = inlineAttachmentType(attachment.mimetype);
			return new Response(new Uint8Array(content), {
				headers: {
					"Content-Type": type ?? "application/octet-stream",
					"X-Content-Type-Options": "nosniff",
					"Content-Disposition": `${type ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
					...(type?.startsWith("image/")
						? { "Content-Security-Policy": "default-src 'none'; sandbox" }
						: {}),
				},
			});
		},
	);
	app.route(
		"/api/v1/classification",
		classifierApi(db, {
			enabled: options.classifiersEnabled === true,
			admin: isAdmin,
			actor: options.actor ?? "local",
			kick: options.kickClassifiers,
			key: options.jevKey,
			transport: options.jevTransport,
		}),
	);
	if (!isLive && options.classifierPreview && options.previewRoutes)
		app.route("/api/preview", options.previewRoutes);
	app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
	return app;
}

// Types a browser can display without running attacker content (no SVG/HTML).
const INLINE_ATTACHMENT_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"application/pdf",
]);
export function inlineAttachmentType(mimetype: string | null | undefined) {
	const type = mimetype?.split(";")[0]?.trim().toLowerCase();
	if (type === "image/jpg" || type === "image/pjpeg") return "image/jpeg";
	return type && INLINE_ATTACHMENT_TYPES.has(type) ? type : null;
}

function joinRecipients(value: string | string[] | undefined) {
	return Array.isArray(value) ? value.join(", ") : (value ?? "");
}
function escapeHtml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "<br>");
}
