import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { createApi } from "../server/api";
import { hashApiKey, keyCanRequest } from "../server/api-keys";
const schema = "keys_" + crypto.randomUUID().replaceAll("-", "");
const root = connect(),
	db = connect(process.env.DATABASE_URL, schema),
	store = new InboxStore(db);
const mailbox = "keys@ingest.realadvisor.com",
	other = "other@ingest.realadvisor.com";
const api = (role?: "admin" | "user") =>
	createApi(db, {
		mode: "live",
		membershipEnabled: true,
		actorRole: role,
		actor: role ? "owner@realadvisor.com" : undefined,
		webhookSecretKey: "ab".repeat(32),
		readAttachment: async () => null,
	});
const call = (
	path: string,
	method = "GET",
	body?: unknown,
	key?: string,
	role?: "admin" | "user",
) =>
	api(role).request(`http://127.0.0.1:4311/api/v1/${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			...(key ? { Authorization: `Bearer ${key}` } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
before(async () => {
	await root.unsafe(`CREATE SCHEMA ${schema}`);
	await migrate(db);
	await store.createMailbox(mailbox, "Keys");
	await store.createMailbox(other, "Other");
});
after(async () => {
	await db.end();
	await root.unsafe(`DROP SCHEMA ${schema} CASCADE`);
	await root.end();
});
async function issue(permissions = ["mail:read"], mailbox_ids = [mailbox]) {
	const r = await call(
		"api-keys",
		"POST",
		{ name: "Test automation", permissions, mailbox_ids },
		undefined,
		"admin",
	);
	assert.equal(r.status, 201, await r.clone().text());
	return r.json() as Promise<{ id: string; key: string }>;
}
test("admin creates keys, hash-only storage, list redaction and authenticated usage tracking", async () => {
	const k = await issue();
	assert.match(k.key, /^inbox_[a-f0-9]{64}$/);
	const [stored] = await db`SELECT * FROM inbox_api_keys WHERE id=${k.id}`;
	assert.equal(stored.token_hash, await hashApiKey(k.key));
	assert.equal(JSON.stringify(stored).includes(k.key), false);
	const list = await (
		await call("api-keys", "GET", undefined, undefined, "admin")
	).json();
	assert.equal(JSON.stringify(list).includes(stored.token_hash), false);
	assert.equal(JSON.stringify(list).includes(k.key), false);
	assert.equal(
		(await call("mailboxes/" + mailbox + "/emails", "GET", undefined, k.key))
			.status,
		200,
	);
	const [usage] =
		await db`SELECT request_count,last_used_at FROM inbox_api_keys WHERE id=${k.id}`;
	assert.equal(Number(usage.request_count), 1);
	assert.ok(usage.last_used_at);
});
test("keys cannot read another mailbox, mutate mail, access agent/admin routes, or delegate keys", async () => {
	const { key } = await issue();
	for (const [path, method] of [
		[`mailboxes/${other}/emails`, "GET"],
		[`mailboxes/${other}/threads/${crypto.randomUUID()}`, "GET"],
		[`mailboxes/${mailbox}/drafts`, "POST"],
		[`mailboxes/${mailbox}/emails/send`, "POST"],
		[`mailboxes/${mailbox}/agent/settings`, "GET"],
		["api-keys", "GET"],
		["api-keys", "POST"],
		["access/members", "GET"],
		["tags", "POST"],
		["classification/runs", "GET"],
		[`webhooks/${mailbox}`, "GET"],
	])
		assert.equal(
			(await call(path, method, method === "POST" ? {} : undefined, key))
				.status,
			403,
			path,
		);
});
test("missing, invalid, expired and revoked keys fail closed, including with admin session", async () => {
	assert.equal((await call("config")).status, 403);
	assert.equal(
		(await call("config", "GET", undefined, "inbox_" + "0".repeat(64), "admin"))
			.status,
		401,
	);
	const k = await issue();
	await db`UPDATE inbox_api_keys SET expires_at=now()-interval '1 second' WHERE id=${k.id}`;
	assert.equal((await call("config", "GET", undefined, k.key)).status, 401);
	const valid = await issue();
	assert.equal(
		(
			await call(
				`api-keys/${valid.id}`,
				"DELETE",
				undefined,
				undefined,
				"admin",
			)
		).status,
		204,
	);
	assert.equal((await call("config", "GET", undefined, valid.key)).status, 401);
});
test("normal users cannot list/create/revoke keys and input is bounded", async () => {
	for (const method of ["GET", "POST", "DELETE"])
		assert.equal(
			(
				await call(
					method === "DELETE" ? `api-keys/${crypto.randomUUID()}` : "api-keys",
					method,
					method === "POST" ? {} : undefined,
					undefined,
					"user",
				)
			).status,
			403,
		);
	for (const patch of [
		{ permissions: ["admin"] },
		{ mailbox_ids: [] },
		{ mailbox_ids: ["missing@example.test"] },
		{ expires_at: "2020-01-01T00:00:00Z" },
	])
		assert.equal(
			(
				await call(
					"api-keys",
					"POST",
					{
						name: "x",
						permissions: ["mail:read"],
						mailbox_ids: [mailbox],
						...patch,
					},
					undefined,
					"admin",
				)
			).status,
			400,
		);
});
test("mailbox list is scoped and configuration never claims administrator access", async () => {
	const { key } = await issue();
	// Synthetic mode allows test-domain mailbox listing but must still enforce key scope.
	const local = createApi(db, { readAttachment: async () => null });
	const list = await (
		await local.request("http://127.0.0.1:4311/api/v1/mailboxes", {
			headers: { Authorization: `Bearer ${key}` },
		})
	).json();
	assert.deepEqual(
		list.map((m: { id: string }) => m.id),
		[mailbox],
	);
	const config = await (await call("config", "GET", undefined, key)).json();
	assert.equal(config.access.role, "integration");
	assert.equal(config.canManageWebhooks, false);
});
test("webhook keys manage only their own endpoints; administrators retain control", async () => {
	const a = await issue(["webhooks:manage"]),
		b = await issue(["webhooks:manage"]);
	const body = {
		url: "https://hooks.example.com/inbox",
		events: ["conversation.classified"],
	};
	const created = await call(`webhooks/${mailbox}`, "POST", body, a.key);
	assert.equal(created.status, 201, await created.clone().text());
	const endpoint = await created.json();
	assert.ok(endpoint.secret);
	const [row] =
		await db`SELECT api_key_id FROM webhook_endpoints WHERE id=${endpoint.id}`;
	assert.equal(row.api_key_id, a.id);
	assert.equal(
		(await call(`webhooks/${mailbox}/${endpoint.id}`, "PUT", body, a.key))
			.status,
		200,
	);
	assert.equal(
		(await call(`webhooks/${mailbox}/${endpoint.id}/test`, "POST", {}, a.key))
			.status,
		202,
	);
	for (const [suffix, method] of [
		["", "PUT"],
		["", "DELETE"],
		["/test", "POST"],
		["/deliveries", "GET"],
		[`/deliveries/${crypto.randomUUID()}/retry`, "POST"],
	])
		assert.equal(
			(
				await call(
					`webhooks/${mailbox}/${endpoint.id}${suffix}`,
					method,
					["POST", "PUT"].includes(method) ? body : undefined,
					b.key,
				)
			).status,
			404,
		);
	assert.deepEqual(
		await (await call(`webhooks/${mailbox}`, "GET", undefined, b.key)).json(),
		[],
	);
	assert.equal(
		(await call(`webhooks/${other}`, "POST", body, a.key)).status,
		403,
	);
	assert.equal(
		(await call(`mailboxes/${mailbox}/emails`, "GET", undefined, a.key)).status,
		403,
	);
	assert.equal(
		(
			await call(
				`webhooks/${mailbox}/${endpoint.id}`,
				"DELETE",
				undefined,
				undefined,
				"admin",
			)
		).status,
		200,
	);
});
test("any API key may read classifier health, and nothing else under it", () => {
	const key = {
		id: crypto.randomUUID(),
		permissions: ["mail:read"],
		mailbox_ids: [mailbox],
	};
	for (const k of [key, { ...key, permissions: [] }])
		assert.equal(
			keyCanRequest(k, "GET", "/api/v1/classification/health"),
			true,
		);
	for (const [method, path] of [
		["POST", "/api/v1/classification/health"],
		["GET", "/api/v1/classification/health/x"],
		["GET", "/api/v1/classification/provider-state"],
		["POST", "/api/v1/classification/provider-state/resume"],
		["GET", "/api/v1/classification/%68ealth"],
	])
		assert.equal(keyCanRequest(key, method, path), false, path);
});
test("path allowlist denies encoded separators and future routes", () => {
	const key = {
		id: crypto.randomUUID(),
		permissions: ["mail:read"],
		mailbox_ids: [mailbox],
	};
	for (const path of [
		`/api/v1/mailboxes/${mailbox}/agent`,
		`/api/v1/mailboxes/${mailbox}%2Femails`,
		`/api/v1/mailboxes/${mailbox}/emails%2Ffake`,
		`/api/v1/api-keys`,
		`/api/v1/mailboxes/${mailbox}/emails/../settings`,
	])
		assert.equal(keyCanRequest(key, "GET", path), false, path);
});

test("Worker accepts Bearer keys without Access, rejects missing keys and confines them to the API", async () => {
	const { default: worker } = await import("../server/worker");
	const database = new URL(process.env.DATABASE_URL!);
	database.searchParams.set("options", `-c search_path=${schema}`);
	const env = {
		PUBLIC_ORIGIN: "https://inbox.test",
		MAIL_MODE: "live" as const,
		ACCESS_MEMBERSHIP_ENABLED: "true",
		ACCESS_ISSUER: "https://keys-test.cloudflareaccess.com",
		ACCESS_AUDIENCE: "inbox",
		HYPERDRIVE: { connectionString: database.toString() },
		ATTACHMENTS: { get: async () => null },
		ASSETS: { fetch: async () => new Response("page") },
	};
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (p: Promise<unknown>) => pending.push(p),
		passThroughOnException: () => {},
		props: {},
	};
	const k = await issue();
	const fetch = (path: string, headers?: Record<string, string>) =>
		worker.fetch(
			new Request(`https://inbox.test${path}`, { headers }),
			env,
			ctx,
		);
	assert.equal((await fetch("/api/v1/config")).status, 401);
	assert.equal(
		(await fetch("/api/v1/config", { Authorization: `Bearer ${k.key}` }))
			.status,
		200,
	);
	assert.equal(
		(await fetch("/api/v1/config", { Authorization: "Bearer bad" })).status,
		401,
	);
	assert.equal(
		(await fetch("/", { Authorization: `Bearer ${k.key}` })).status,
		401,
	);
	assert.equal(
		(
			await fetch("/api/v1/config", {
				"cf-access-authenticated-user-email": "owner@realadvisor.com",
			})
		).status,
		401,
	);
	await Promise.all(pending);
});

test("Worker verifies Access cookies on bypassed API paths and enforces browser origin", async () => {
	const { default: worker } = await import("../server/worker");
	const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const jwk = {
		...(await exportJWK(publicKey)),
		kid: "cookie-key",
		alg: "RS256",
		use: "sig",
	};
	const issuer = "https://cookie-keys-test.cloudflareaccess.com";
	const original = globalThis.fetch;
	globalThis.fetch = async () => Response.json({ keys: [jwk] });
	const pending: Promise<unknown>[] = [];
	try {
		await db`INSERT INTO inbox_members(email,role,created_by) VALUES('cookie@realadvisor.com','admin','test')`;
		const token = await new SignJWT({
			type: "app",
			email: "cookie@realadvisor.com",
		})
			.setProtectedHeader({ alg: "RS256", kid: "cookie-key" })
			.setIssuer(issuer)
			.setAudience("inbox")
			.setSubject("cookie")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		const database = new URL(process.env.DATABASE_URL!);
		database.searchParams.set("options", `-c search_path=${schema}`);
		const env = {
			PUBLIC_ORIGIN: "https://inbox.test",
			MAIL_MODE: "live" as const,
			ACCESS_MEMBERSHIP_ENABLED: "true",
			ACCESS_ISSUER: issuer,
			ACCESS_AUDIENCE: "inbox",
			HYPERDRIVE: { connectionString: database.toString() },
			ATTACHMENTS: { get: async () => null },
			ASSETS: { fetch: async () => new Response("page") },
		};
		const ctx = {
			waitUntil: (p: Promise<unknown>) => pending.push(p),
			passThroughOnException: () => {},
			props: {},
		};
		const fetch = (cookie: string, origin = "https://inbox.test") =>
			worker.fetch(
				new Request("https://inbox.test/api/v1/api-keys", {
					headers: { Cookie: `CF_Authorization=${cookie}`, Origin: origin },
				}),
				env,
				ctx,
			);
		assert.equal((await fetch(token)).status, 200);
		assert.equal((await fetch(token, "https://attacker.test")).status, 403);
		assert.equal((await fetch(token + "forged")).status, 401);
		await db`DELETE FROM inbox_members WHERE email='cookie@realadvisor.com'`;
		assert.equal((await fetch(token)).status, 403);
	} finally {
		globalThis.fetch = original;
		await Promise.all(pending);
	}
});

test("draft keys can edit and delete drafts but cannot send or delete received mail", async () => {
	const { key } = await issue(["drafts:manage"]);
	const path = `mailboxes/${mailbox}`;
	const created = await call(
		`${path}/drafts`,
		"POST",
		{ to: "test@example.test", subject: "Draft", body: "First" },
		key,
	);
	assert.equal(created.status, 201, await created.clone().text());
	const draft = await created.json();
	assert.equal(
		(
			await call(
				`${path}/drafts`,
				"POST",
				{
					draft_id: draft.draft_id,
					draft_version: draft.draft_version,
					body: "Updated",
				},
				key,
			)
		).status,
		200,
	);
	assert.equal(
		(
			await call(
				`${path}/emails`,
				"POST",
				{ to: "test@example.test", subject: "No", text: "No" },
				key,
			)
		).status,
		403,
	);
	const received = await store.insert(mailbox, {
		sender: "sender@example.test",
		recipient: mailbox,
		subject: "Received",
		body: "Body",
		folder_id: "inbox",
	});
	assert.equal(
		(await call(`${path}/emails/${received!.id}`, "DELETE", undefined, key))
			.status,
		404,
	);
	assert.equal(
		(
			await call(
				`${path}/emails/${received!.id}/move`,
				"POST",
				{ folderId: "draft" },
				key,
			)
		).status,
		403,
	);
	assert.equal(
		(await call(`mailboxes/${other}/drafts`, "POST", { body: "No" }, key))
			.status,
		403,
	);
	assert.equal(
		(await call(`${path}/emails/${draft.draft_id}`, "DELETE", undefined, key))
			.status,
		204,
	);
});

test("send scope sends and replies with key attribution and idempotency through the live handler", async () => {
	const k = await issue(["mail:send"]);
	let sends = 0;
	const live = createApi(db, {
		mode: "live",
		membershipEnabled: true,
		readAttachment: async () => null,
		sender: {
			send: async () => {
				sends++;
				return { messageId: `test-${sends}` };
			},
		},
	});
	const send = (
		scope: string,
		box: string,
		suffix: string,
		requestId: string,
	) =>
		live.request(
			`http://127.0.0.1:4311/api/v1/mailboxes/${box}/emails${suffix}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${scope}`,
					"idempotency-key": requestId,
				},
				body: JSON.stringify({
					to: "recipient@example.test",
					subject: "Test",
					text: "Body",
				}),
			},
		);
	const requestId = crypto.randomUUID();
	const response = await send(k.key, mailbox, "", requestId);
	assert.equal(response.status, 201, await response.clone().text());
	const sent = await response.json();
	assert.equal((await send(k.key, mailbox, "", requestId)).status, 201);
	assert.equal(sends, 1);
	for (const action of ["reply", "forward"])
		assert.equal(
			(await send(k.key, mailbox, `/${sent.id}/${action}`, crypto.randomUUID()))
				.status,
			201,
		);
	const [record] =
		await db`SELECT actor FROM outbound_requests WHERE request_id=${requestId}`;
	assert.equal(record.actor, `api-key:${k.id}`);
	const reader = await issue();
	assert.equal(
		(await send(reader.key, mailbox, "", crypto.randomUUID())).status,
		403,
	);
	assert.equal((await send(k.key, other, "", crypto.randomUUID())).status, 403);
	assert.equal(
		(await call(`mailboxes/${mailbox}/drafts`, "POST", { body: "No" }, k.key))
			.status,
		403,
	);
	const drafter = await issue(["drafts:manage", "conversations:manage"]);
	assert.equal(
		(
			await call(
				`mailboxes/${mailbox}/emails/${sent.id}/move`,
				"POST",
				{ folderId: "draft" },
				drafter.key,
			)
		).status,
		204,
	);
	assert.equal(
		(
			await call(
				`mailboxes/${mailbox}/emails/${sent.id}`,
				"DELETE",
				undefined,
				drafter.key,
			)
		).status,
		404,
	);
});

test("conversation permission changes flags, folders, tags and status without admin access", async () => {
	const k = await issue(["conversations:manage"]);
	const email = await store.insert(mailbox, {
		sender: "sender@example.test",
		recipient: mailbox,
		subject: "Actions",
		body: "Body",
		folder_id: "inbox",
	});
	const [row] = await db`SELECT thread_id FROM emails WHERE id=${email!.id}`;
	const base = `mailboxes/${mailbox}`;
	assert.equal(
		(
			await call(
				`${base}/emails/${email!.id}`,
				"PUT",
				{ read: true, starred: true },
				k.key,
			)
		).status,
		200,
	);
	assert.equal(
		(
			await call(
				`${base}/emails/${email!.id}/move`,
				"POST",
				{ folderId: "archive" },
				k.key,
			)
		).status,
		204,
	);
	assert.equal(
		(
			await call(
				`${base}/threads/${row.thread_id}/read`,
				"POST",
				{ read: false },
				k.key,
			)
		).status,
		204,
	);
	const [state] =
		await db`SELECT revision FROM conversations WHERE mailbox_id=${mailbox} AND thread_id=${row.thread_id}`;
	const changed = await call(
		`${base}/threads/${row.thread_id}/status`,
		"PUT",
		{ status: "done", revision: state.revision },
		k.key,
	);
	assert.equal(changed.status, 200, await changed.clone().text());
	assert.equal((await changed.json()).updated_by, `api-key:${k.id}`);
	const tagResponse = await call(
		"tags",
		"POST",
		{ name: "Key test", color: "#3366ff" },
		undefined,
		"admin",
	);
	assert.equal(tagResponse.status, 201, await tagResponse.clone().text());
	const tag = await tagResponse.json();
	for (const method of ["PUT", "DELETE"])
		assert.equal(
			(
				await call(
					`${base}/threads/${row.thread_id}/tags/${tag.id}`,
					method,
					undefined,
					k.key,
				)
			).status,
			204,
		);
	assert.equal(
		(
			await call(
				`${base}/tags/bulk`,
				"POST",
				{ thread_ids: [row.thread_id], tag_id: tag.id, action: "add" },
				k.key,
			)
		).status,
		204,
	);
	for (const [path, method, body] of [
		[`${base}/emails/${email!.id}`, "DELETE", undefined],
		[`${base}/folders`, "POST", { name: "No" }],
		[`mailboxes/${other}/emails/${email!.id}`, "PUT", { read: true }],
		["tags", "POST", { name: "No" }],
	] as const)
		assert.equal((await call(path, method, body, k.key)).status, 403);
});

test("all automation scopes remain mailbox scoped and cannot reach administration", async () => {
	const { apiKeyPermissions } = await import("../server/api-keys");
	const k = await issue([...apiKeyPermissions]);
	const principal = {
		id: k.id,
		mailbox_ids: [mailbox],
		permissions: [...apiKeyPermissions],
	};
	for (const [method, path] of [
		["GET", `classification/results/${mailbox}`],
		["GET", `classification/threads/${mailbox}/thread/classifications`],
		["GET", `classification/threads/${mailbox}/thread`],
		["PUT", `classification/results/${mailbox}/thread/classifier`],
		["POST", `classification/threads/${mailbox}/thread/rerun`],
		["GET", `mailboxes/${mailbox}/agent`],
		["POST", `mailboxes/${mailbox}/agent/chat`],
		["POST", `mailboxes/${mailbox}/agent/compose`],
		["POST", `mailboxes/${mailbox}/folders`],
		["DELETE", `mailboxes/${mailbox}/folders/folder`],
	]) {
		assert.equal(
			keyCanRequest(principal, method, `/api/v1/${path}`),
			true,
			path,
		);
		assert.equal(
			keyCanRequest(
				principal,
				method,
				`/api/v1/${path.replace(mailbox, other)}`,
			),
			false,
			path,
		);
		assert.equal(
			keyCanRequest(
				{ ...principal, permissions: [] },
				method,
				`/api/v1/${path}`,
			),
			false,
			path,
		);
	}
	for (const path of [
		"api-keys",
		"access/members",
		"classification/classifiers",
		"classification/backfills",
		`mailboxes/${mailbox}/agent/settings`,
	])
		assert.equal(keyCanRequest(principal, "PUT", `/api/v1/${path}`), false);
	const folders = await call(
		`mailboxes/${mailbox}/folders`,
		"POST",
		{ name: "Automation" },
		k.key,
	);
	assert.equal(folders.status, 201);
	const f = await folders.json();
	assert.equal(
		(
			await call(
				`mailboxes/${mailbox}/folders/${f.id}`,
				"PUT",
				{ name: "Renamed" },
				k.key,
			)
		).status,
		200,
	);
	assert.equal(
		(
			await call(
				`mailboxes/${mailbox}/folders/${f.id}`,
				"DELETE",
				undefined,
				k.key,
			)
		).status,
		204,
	);
	assert.equal(
		(await call(`mailboxes/${mailbox}/agent/conversations`, "POST", {}, k.key))
			.status,
		201,
	);
	const agentOnly = await issue(["agent:use"]);
	assert.equal(
		(await call(`mailboxes/${mailbox}/agent`, "GET", undefined, agentOnly.key))
			.status,
		403,
	);
});

test("agent tool inventory honors each key permission and fails closed", async () => {
	const { createTools } = await import("../server/agent/service");
	const run = {
		id: crypto.randomUUID(),
		mailbox,
		actor: "api-key:test",
		prompt: "Test",
		classification: { enabled: true, admin: true },
	};
	const read = createTools(
		db,
		{ ...run, permissions: ["mail:read", "agent:use"] },
		() => {},
	);
	assert.ok(read.get_email);
	for (const name of [
		"draft_email",
		"draft_reply",
		"update_draft",
		"discard_draft",
		"set_thread_tag",
		"move_email",
		"review_classification",
		"inspect_classifications",
		"rerun_classification",
	])
		assert.equal(name in read, false, name);
	const { apiKeyPermissions } = await import("../server/api-keys");
	const all = createTools(
		db,
		{ ...run, permissions: [...apiKeyPermissions] },
		() => {},
	);
	for (const name of [
		"draft_email",
		"update_draft",
		"set_thread_tag",
		"inspect_classifications",
		"review_classification",
		"rerun_classification",
	])
		assert.ok(name in all, name);
	assert.deepEqual(
		Object.keys(createTools(db, { ...run, permissions: [] }, () => {})),
		[],
	);
});

test("classification read review and rerun work with key identity and scope", async () => {
	const { apiKeyPermissions } = await import("../server/api-keys");
	const k = await issue([...apiKeyPermissions]);
	const app = createApi(db, {
		mode: "live",
		membershipEnabled: true,
		classifiersEnabled: true,
		readAttachment: async () => null,
	});
	const invoke = (path: string, method = "GET", body?: unknown, key = k.key) =>
		app.request(`http://127.0.0.1:4311/api/v1/classification/${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const email = await store.insert(mailbox, {
		sender: "sender@example.test",
		recipient: mailbox,
		subject: "Review",
		body: "Test",
		delivery_status: "received",
	});
	const thread = email!.thread_id!;
	const [tag] =
		await db`INSERT INTO tags(name,color) VALUES('API review','#3366ff') RETURNING id`;
	const [classifier] =
		await db`INSERT INTO classifiers(tag_id,question,enabled) VALUES(${tag.id},'Needs attention?',true) RETURNING id,revision`;
	const [job] =
		await db`INSERT INTO conversation_classifications(mailbox_id,thread_id,classifier_id,revision,generation,status) SELECT ${mailbox},${thread},${classifier.id},${classifier.revision},generation,'review' FROM conversations WHERE mailbox_id=${mailbox} AND thread_id=${thread} RETURNING token`;
	assert.equal(
		(await invoke(`threads/${mailbox}/${thread}/classifications`)).status,
		200,
	);
	assert.equal((await invoke(`results/${mailbox}`)).status, 200);
	assert.equal((await invoke(`threads/${mailbox}/${thread}`)).status, 200);
	const reader = await issue(["classifications:read"]);
	assert.equal(
		(await invoke(`threads/${mailbox}/${thread}/rerun`, "POST", {}, reader.key))
			.status,
		403,
	);
	const reviewed = await invoke(
		`results/${mailbox}/${thread}/${classifier.id}`,
		"PUT",
		{ answer: true, revision: classifier.revision, token: job.token },
	);
	assert.equal(reviewed.status, 204, await reviewed.clone().text());
	const [result] =
		await db`SELECT actor,source FROM conversation_classifications WHERE classifier_id=${classifier.id} AND thread_id=${thread}`;
	assert.equal(result.actor, `api-key:${k.id}`);
	assert.equal(result.source, "agent");
	assert.equal(
		(await invoke(`threads/${mailbox}/${thread}/rerun`, "POST", {})).status,
		202,
	);
	assert.equal(
		(await invoke(`threads/${other}/${thread}/classifications`)).status,
		403,
	);
});

test("key creation and authentication work with Worker fetch_types disabled", async () => {
	const { default: postgres } = await import("postgres");
	const workerDb = postgres(process.env.DATABASE_URL!, {
		fetch_types: false,
		connection: { search_path: schema },
	});
	try {
		const app = createApi(workerDb, {
			mode: "live",
			membershipEnabled: true,
			actorRole: "admin",
			actor: "owner@realadvisor.com",
			readAttachment: async () => null,
		});
		const created = await app.request("http://127.0.0.1:4311/api/v1/api-keys", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "Worker key",
				mailbox_ids: [mailbox],
				permissions: ["mail:read", "drafts:manage"],
			}),
		});
		assert.equal(created.status, 201, await created.clone().text());
		const key = await created.json();
		const list = await (
			await app.request("http://127.0.0.1:4311/api/v1/api-keys")
		).json();
		const item = list.find((k: { id: string }) => k.id === key.id);
		assert.deepEqual(item.mailbox_ids, [mailbox]);
		assert.deepEqual(item.permissions, ["mail:read", "drafts:manage"]);
		const config = await app.request("http://127.0.0.1:4311/api/v1/config", {
			headers: { Authorization: `Bearer ${key.key}` },
		});
		assert.equal(config.status, 200);
		const principal = await config.json();
		assert.deepEqual(principal.mailbox_ids, [mailbox]);
		assert.deepEqual(principal.permissions, ["mail:read", "drafts:manage"]);
	} finally {
		await workerDb.end();
	}
});

test("webhook secrets are revealed and rotated only by admins or the owning key", async () => {
	const owner = await issue(["webhooks:manage"]),
		stranger = await issue(["webhooks:manage"]),
		reader = await issue();
	const created = await call(
		`webhooks/${mailbox}`,
		"POST",
		{
			url: "https://hooks.example.com/secrets",
			events: ["email.received"],
			enabled: false,
		},
		owner.key,
	);
	assert.equal(created.status, 201);
	const endpoint = await created.json();
	const path = `webhooks/${mailbox}/${endpoint.id}/secret`;
	for (const suffix of ["", "/rotate"]) {
		assert.equal(
			(await call(path + suffix, "POST", {}, stranger.key)).status,
			404,
		);
		assert.equal(
			(await call(path + suffix, "POST", {}, reader.key)).status,
			403,
		);
		assert.equal(
			(await call(path + suffix, "POST", {}, undefined, "user")).status,
			403,
		);
		assert.equal(
			(
				await call(
					`webhooks/${other}/${endpoint.id}/secret` + suffix,
					"POST",
					{},
					owner.key,
				)
			).status,
			403,
		);
	}
	const revealed = await call(path, "POST", {}, owner.key);
	assert.equal(revealed.headers.get("cache-control"), "no-store");
	assert.equal((await revealed.json()).secret, endpoint.secret);
	const rotated = await call(path + "/rotate", "POST", {}, undefined, "admin");
	assert.equal(rotated.status, 200);
	assert.equal(rotated.headers.get("cache-control"), "no-store");
	const fresh = await rotated.json();
	assert.match(fresh.secret, /^whsec_[a-f0-9]{64}$/);
	assert.notEqual(fresh.secret, endpoint.secret);
	assert.equal(
		(await (await call(path, "POST", {}, owner.key)).json()).secret,
		fresh.secret,
	);
	const [stored] =
		await db`SELECT secret,enabled FROM webhook_endpoints WHERE id=${endpoint.id}`;
	assert.notEqual(stored.secret, fresh.secret);
	assert.equal(stored.enabled, false);
	const listed = await (
		await call(`webhooks/${mailbox}`, "GET", undefined, owner.key)
	).text();
	assert.ok(!listed.includes(fresh.secret));
	assert.ok(!listed.includes(stored.secret));
	assert.equal(
		(await call(`webhooks/${mailbox}/${endpoint.id}`, "DELETE", {}, owner.key))
			.status,
		200,
	);
});
