/**
 * HTTP E2E for mailbox ACL: parent Hono principal → child API routes,
 * list/create/get/put/delete, requireMailbox emails, claim, 403 member.
 *
 * Run: node --experimental-strip-types --import ./workers/test/register-ts-ext.mjs workers/test/mailbox-acl-http.test.mjs
 */

import assert from "node:assert/strict";
import { Hono } from "hono";
import { app as apiApp } from "../index.ts";
import { mailboxMetadataKey } from "../lib/mailbox-routing.ts";
import { mailboxIdFromAgentsUrl } from "../../shared/agent-conversations.ts";
import {
	authorizeMailbox,
	principalFromClaims,
} from "../lib/mailbox-acl.ts";

const ada = principalFromClaims({ email: "Ada@Inboxies.Email", sub: "ada-sub" });
const bob = principalFromClaims({ email: "bob@inboxies.email", sub: "bob-sub" });
const eve = principalFromClaims({ email: "eve@inboxies.email", sub: "eve-sub" });

function mockBucket(initial = {}) {
	const store = new Map(
		Object.entries(initial).map(([key, value]) => [
			key,
			typeof value === "string" ? value : JSON.stringify(value),
		]),
	);
	return {
		store,
		async get(key) {
			if (!store.has(key)) return null;
			const text = store.get(key);
			return { json: async () => JSON.parse(text) };
		},
		async put(key, value) {
			store.set(key, typeof value === "string" ? value : JSON.stringify(value));
		},
		async head(key) {
			return store.has(key) ? { key } : null;
		},
		async list({ prefix = "" } = {}) {
			return {
				objects: [...store.keys()]
					.filter((key) => key.startsWith(prefix))
					.map((key) => ({ key })),
			};
		},
		async delete(key) {
			store.delete(key);
		},
	};
}

function mockEnv(bucket, { emailAddresses = [], purgeCalls = [] } = {}) {
	return {
		BUCKET: bucket,
		EMAIL_ADDRESSES: emailAddresses,
		DOMAINS: "inboxies.email",
		MAILBOX: {
			idFromName(name) {
				return name;
			},
			get(id) {
				return {
					id,
					reviveMailbox: async () => {},
					getFolders: async () => [],
					getEmails: async () => [],
					countEmails: async () => 0,
					purgeMailbox: async (mailboxId) => {
						purgeCalls.push(mailboxId);
						return { conversationIds: [] };
					},
				};
			},
		},
		EMAIL_AGENT: {
			idFromName(name) {
				return name;
			},
			get() {
				return { purge: async () => {} };
			},
		},
	};
}

/** Same shape as workers/app.ts: parent middleware sets principal, then route("/", apiApp). */
function mountedApp(principal) {
	const parent = new Hono();
	parent.use("*", async (c, next) => {
		if (principal) c.set("principal", principal);
		await next();
	});
	parent.route("/", apiApp);
	return parent;
}

async function jsonRequest(app, env, { method = "GET", path, principal, body } = {}) {
	const hono = mountedApp(principal);
	const headers = { };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await hono.fetch(
		new Request(`https://inboxies.test${path}`, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		}),
		env,
	);
	const contentType = res.headers.get("content-type") ?? "";
	let payload = null;
	if (res.status !== 204 && contentType.includes("application/json")) {
		payload = await res.json();
	} else if (res.status !== 204) {
		payload = await res.text();
	}
	return { status: res.status, payload };
}

{
	const parent = new Hono();
	parent.use("*", async (c, next) => {
		c.set("principal", ada);
		await next();
	});
	const child = new Hono();
	child.get("/api/v1/me", (c) => c.json({ email: c.get("principal")?.email ?? null }));
	parent.route("/", child);
	const res = await parent.fetch(new Request("https://inboxies.test/api/v1/me"));
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { email: "ada@inboxies.email" });
}

{
	const env = mockEnv(mockBucket());
	const bare = await apiApp.fetch(new Request("https://inboxies.test/api/v1/me"), env);
	assert.equal(bare.status, 401, "API app fail-closes when parent did not set principal");

	const { status, payload } = await jsonRequest(apiApp, env, {
		path: "/api/v1/me",
		principal: ada,
	});
	assert.equal(status, 200);
	assert.equal(payload.email, "ada@inboxies.email");
	assert.ok(payload.keys.includes("email:ada@inboxies.email"));
	assert.ok(payload.keys.includes("sub:ada-sub"));
}

{
	const bucket = mockBucket({
		[mailboxMetadataKey("ada@inboxies.email")]: { fromName: "Unclaimed Ada" },
		[mailboxMetadataKey("shared@inboxies.email")]: {
			fromName: "Shared",
			acl: {
				owners: ["email:ada@inboxies.email"],
				members: ["email:bob@inboxies.email"],
			},
		},
		[mailboxMetadataKey("secret@inboxies.email")]: {
			acl: { owners: ["email:eve@inboxies.email"], members: [] },
		},
	});
	const env = mockEnv(bucket);

	const listed = await jsonRequest(apiApp, env, { path: "/api/v1/mailboxes", principal: ada });
	assert.equal(listed.status, 200);
	assert.deepEqual(
		listed.payload.map((m) => m.id).sort(),
		["ada@inboxies.email", "shared@inboxies.email"],
	);

	const claimed = await jsonRequest(apiApp, env, {
		path: "/api/v1/mailboxes/Ada%40Inboxies.Email",
		principal: ada,
	});
	assert.equal(claimed.status, 200);
	assert.equal(claimed.payload.canManage, true);
	assert.equal(claimed.payload.settings.acl.owners.length, 1);
	assert.ok(
		claimed.payload.settings.acl.owners[0].startsWith("account:"),
		"claim persists account-scoped owner",
	);
	const persisted = JSON.parse(bucket.store.get(mailboxMetadataKey("ada@inboxies.email")));
	assert.deepEqual(persisted.acl.owners, claimed.payload.settings.acl.owners);

	const secret = await jsonRequest(apiApp, env, {
		path: "/api/v1/mailboxes/secret@inboxies.email",
		principal: bob,
	});
	assert.equal(secret.status, 403);

	const missing = await jsonRequest(apiApp, env, {
		path: "/api/v1/mailboxes/nope@inboxies.email",
		principal: ada,
	});
	assert.equal(missing.status, 404);

	const memberGet = await jsonRequest(apiApp, env, {
		path: "/api/v1/mailboxes/shared@inboxies.email",
		principal: bob,
	});
	assert.equal(memberGet.status, 200);
	assert.equal(memberGet.payload.canManage, false);
}

{
	const bucket = mockBucket();
	const env = mockEnv(bucket);
	const created = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/mailboxes",
		principal: ada,
		body: {
			email: "Team@Inboxies.Email",
			name: "Team",
			settings: {
				acl: { owners: ["email:eve@inboxies.email"], members: [] },
			},
		},
	});
	assert.equal(created.status, 201);
	assert.equal(created.payload.id, "team@inboxies.email");
	assert.equal(created.payload.canManage, true);
	assert.equal(created.payload.settings.acl.owners.length, 1);
	assert.ok(
		created.payload.settings.acl.owners[0].startsWith("account:"),
		"create stamps account-scoped owner only",
	);
	assert.equal(
		created.payload.settings.acl.owners.includes("email:eve@inboxies.email"),
		false,
		"create ignores caller-supplied owners",
	);
	assert.equal(
		created.payload.settings.acl.owners.includes("email:ada@inboxies.email"),
		false,
		"create does not stamp method email: rows",
	);
	assert.equal(
		created.payload.settings.acl.owners.includes("sub:ada-sub"),
		false,
		"create does not stamp method sub: rows",
	);

	const second = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/mailboxes",
		principal: ada,
		body: { email: "other@inboxies.email", name: "Other" },
	});
	assert.equal(second.status, 201);

	const listed = await jsonRequest(apiApp, env, { path: "/api/v1/mailboxes", principal: ada });
	assert.deepEqual(
		listed.payload.map((m) => m.id).sort(),
		["other@inboxies.email", "team@inboxies.email"],
	);

	const bobList = await jsonRequest(apiApp, env, { path: "/api/v1/mailboxes", principal: bob });
	assert.deepEqual(bobList.payload, []);
}

{
	const bucket = mockBucket();
	const env = mockEnv(bucket, { emailAddresses: ["allow@inboxies.email"] });
	const denied = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/mailboxes",
		principal: ada,
		body: { email: "nope@inboxies.email", name: "Nope" },
	});
	assert.equal(denied.status, 403);
	const allowed = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/mailboxes",
		principal: ada,
		body: { email: "allow@inboxies.email", name: "Allow" },
	});
	assert.equal(allowed.status, 201);
}

{
	const bucket = mockBucket({
		[mailboxMetadataKey("shared@inboxies.email")]: {
			fromName: "Shared",
			acl: {
				owners: ["email:ada@inboxies.email"],
				members: ["email:bob@inboxies.email"],
			},
		},
	});
	const env = mockEnv(bucket);

	const memberPut = await jsonRequest(apiApp, env, {
		method: "PUT",
		path: "/api/v1/mailboxes/shared@inboxies.email",
		principal: bob,
		body: {
			settings: {
				fromName: "Hijack",
				acl: { owners: ["email:bob@inboxies.email"], members: [] },
			},
		},
	});
	assert.equal(memberPut.status, 200);
	assert.equal(memberPut.payload.settings.fromName, "Hijack");
	assert.deepEqual(memberPut.payload.settings.acl.owners, ["email:ada@inboxies.email"]);
	assert.equal(memberPut.payload.canManage, false);

	const ownerPut = await jsonRequest(apiApp, env, {
		method: "PUT",
		path: "/api/v1/mailboxes/shared@inboxies.email",
		principal: ada,
		body: {
			settings: {
				acl: {
					owners: ["email:ada@inboxies.email"],
					members: ["email:bob@inboxies.email", "email:eve@inboxies.email"],
				},
			},
		},
	});
	assert.equal(ownerPut.status, 200);
	assert.deepEqual(ownerPut.payload.settings.acl.members.sort(), [
		"email:bob@inboxies.email",
		"email:eve@inboxies.email",
	]);
	assert.equal(ownerPut.payload.canManage, true);

	const emptyOwners = await jsonRequest(apiApp, env, {
		method: "PUT",
		path: "/api/v1/mailboxes/shared@inboxies.email",
		principal: ada,
		body: { settings: { acl: { owners: [], members: ["email:bob@inboxies.email"] } } },
	});
	assert.equal(emptyOwners.status, 400);
}

{
	const purgeCalls = [];
	const bucket = mockBucket({
		[mailboxMetadataKey("shared@inboxies.email")]: {
			acl: {
				owners: ["email:ada@inboxies.email"],
				members: ["email:bob@inboxies.email"],
			},
		},
	});
	const env = mockEnv(bucket, { purgeCalls });

	const memberDelete = await jsonRequest(apiApp, env, {
		method: "DELETE",
		path: "/api/v1/mailboxes/shared@inboxies.email",
		principal: bob,
	});
	assert.equal(memberDelete.status, 403);
	assert.deepEqual(purgeCalls, []);

	const ownerDelete = await jsonRequest(apiApp, env, {
		method: "DELETE",
		path: "/api/v1/mailboxes/shared@inboxies.email",
		principal: ada,
	});
	assert.equal(ownerDelete.status, 204);
	assert.deepEqual(purgeCalls, ["shared@inboxies.email"]);
}

{
	const bucket = mockBucket({
		[mailboxMetadataKey("shared@inboxies.email")]: {
			acl: {
				owners: ["email:ada@inboxies.email"],
				members: ["email:bob@inboxies.email"],
			},
		},
		[mailboxMetadataKey("secret@inboxies.email")]: {
			acl: { owners: ["email:eve@inboxies.email"], members: [] },
		},
	});
	const env = mockEnv(bucket);

	const memberEmails = await jsonRequest(apiApp, env, {
		path: "/api/v1/mailboxes/shared@inboxies.email/emails",
		principal: bob,
	});
	assert.equal(memberEmails.status, 200, "member passes requireMailbox");
	assert.deepEqual(memberEmails.payload, []);

	const encoded = await jsonRequest(apiApp, env, {
		path: "/api/v1/mailboxes/shared%40inboxies.email/emails",
		principal: ada,
	});
	assert.equal(encoded.status, 200);

	const denied = await jsonRequest(apiApp, env, {
		path: "/api/v1/mailboxes/secret@inboxies.email/emails",
		principal: bob,
	});
	assert.equal(denied.status, 403);

	const unauthed = await jsonRequest(apiApp, env, {
		path: "/api/v1/mailboxes/shared@inboxies.email/emails",
	});
	assert.equal(unauthed.status, 403);
}

{
	const bucket = mockBucket({
		[mailboxMetadataKey("ada@inboxies.email")]: { fromName: "Ada" },
		[mailboxMetadataKey("secret@inboxies.email")]: {
			acl: { owners: ["email:eve@inboxies.email"], members: [] },
		},
	});
	const agentUrl = "https://inboxies.test/agents/email-agent/ada@inboxies.email::auto/get-messages";
	assert.equal(mailboxIdFromAgentsUrl(agentUrl), "ada@inboxies.email");
	const allowed = await authorizeMailbox(
		bucket,
		ada,
		mailboxIdFromAgentsUrl(agentUrl),
	);
	assert.equal(allowed.ok, true);

	const deniedUrl = "https://inboxies.test/agents/email-agent/secret%40inboxies.email::c1";
	assert.equal(mailboxIdFromAgentsUrl(deniedUrl), "secret%40inboxies.email");
	const denied = await authorizeMailbox(
		bucket,
		bob,
		mailboxIdFromAgentsUrl(deniedUrl),
	);
	assert.equal(denied.ok, false);
	if (!denied.ok) assert.equal(denied.status, 403);

	const mcpDenied = await authorizeMailbox(bucket, eve, "ada@inboxies.email");
	assert.equal(mcpDenied.ok, false, "MCP-style authorizeMailbox denies other principals");
}

console.log("mailbox-acl HTTP e2e tests passed");
