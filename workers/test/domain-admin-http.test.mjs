/**
 * HTTP E2E for Domain Admin + invites + password accept.
 * Run: node --experimental-strip-types --import ./workers/test/register-ts-ext.mjs workers/test/domain-admin-http.test.mjs
 */

import assert from "node:assert/strict";
import { Hono } from "hono";
import { app as apiApp } from "../index.ts";
import { mailboxMetadataKey } from "../lib/mailbox-routing.ts";
import { principalFromClaims } from "../lib/mailbox-acl.ts";
import { verifyMobileSessionToken } from "../lib/apple-auth.ts";

const admin = principalFromClaims({
	email: "admin@example.com",
	sub: "admin-sub",
});
const eve = principalFromClaims({ email: "eve@example.com", sub: "eve-sub" });

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

function mockEnv(bucket, extras = {}) {
	return {
		BUCKET: bucket,
		EMAIL_ADDRESSES: [],
		DOMAINS: "inboxies.email",
		DOMAIN_ADMINS: "admin@example.com",
		MAILBOX_CREATE_POLICY: "admin_only",
		MOBILE_JWT_SECRET: "test-mobile-jwt-secret-xx",
		APP_BASE_URL: "https://inboxies.email",
		EMAIL: {
			send: async () => ({ messageId: "msg-1" }),
		},
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
					purgeMailbox: async () => ({ conversationIds: [] }),
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
		...extras,
	};
}

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
	const parent = mountedApp(principal);
	const res = await parent.request(path, {
		method,
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	}, env);
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = { raw: text };
	}
	return { status: res.status, json, headers: res.headers };
}

// ── /me isAdmin ───────────────────────────────────────────────────

{
	const bucket = mockBucket();
	const env = mockEnv(bucket);
	const adminMe = await jsonRequest(apiApp, env, {
		path: "/api/v1/me",
		principal: admin,
	});
	assert.equal(adminMe.status, 200);
	assert.equal(adminMe.json.isAdmin, true);

	const eveMe = await jsonRequest(apiApp, env, {
		path: "/api/v1/me",
		principal: eve,
	});
	assert.equal(eveMe.status, 200);
	assert.equal(eveMe.json.isAdmin, false);
}

// ── Non-admin cannot create when admin_only ───────────────────────

{
	const bucket = mockBucket();
	const env = mockEnv(bucket);
	const res = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/mailboxes",
		principal: eve,
		body: { email: "eve@inboxies.email", name: "Eve" },
	});
	assert.equal(res.status, 403);
	assert.match(res.json.error, /admin/i);
}

// ── Admin list/create/assign-self ─────────────────────────────────

{
	const bucket = mockBucket({
		[mailboxMetadataKey("existing@inboxies.email")]: {
			fromName: "Existing",
			acl: { owners: ["email:someone@else.com"], members: [] },
		},
	});
	const env = mockEnv(bucket);

	const forbidden = await jsonRequest(apiApp, env, {
		path: "/api/v1/admin/mailboxes",
		principal: eve,
	});
	assert.equal(forbidden.status, 403);

	const list = await jsonRequest(apiApp, env, {
		path: "/api/v1/admin/mailboxes",
		principal: admin,
	});
	assert.equal(list.status, 200);
	assert.equal(list.json.length, 1);
	assert.equal(list.json[0].email, "existing@inboxies.email");

	const created = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/admin/mailboxes",
		principal: admin,
		body: {
			email: "adminbox@inboxies.email",
			name: "Admin Box",
			assignTo: "self",
		},
	});
	assert.equal(created.status, 201);
	assert.equal(created.json.email, "adminbox@inboxies.email");
	assert.equal(created.json.settings.acl.owners.length, 1);
	assert.ok(created.json.settings.acl.owners[0].startsWith("account:"));

	const userList = await jsonRequest(apiApp, env, {
		path: "/api/v1/mailboxes",
		principal: admin,
	});
	assert.equal(userList.status, 200);
	assert.ok(userList.json.some((m) => m.id === "adminbox@inboxies.email"));
}

// ── Admin invite + accept password ────────────────────────────────

{
	const bucket = mockBucket();
	const env = mockEnv(bucket);

	const created = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/admin/mailboxes",
		principal: admin,
		body: {
			email: "alex@inboxies.email",
			name: "Alex",
			assignTo: {
				inviteEmail: "alex.person@gmail.com",
				inviteeName: "Alex",
			},
		},
	});
	assert.equal(created.status, 201);
	assert.ok(created.json.invite?.token);
	assert.equal(created.json.invite.emailSent, true);
	assert.ok(created.json.invite.inviteUrl.includes("/invite/"));

	const token = created.json.invite.token;

	const pub = await jsonRequest(apiApp, env, {
		path: `/api/v1/invites/${token}`,
	});
	assert.equal(pub.status, 200);
	assert.equal(pub.json.mailboxId, "alex@inboxies.email");
	assert.equal(pub.json.status, "pending");

	const accept = await jsonRequest(apiApp, env, {
		method: "POST",
		path: `/api/v1/invites/${token}/accept`,
		body: { password: "secure-password-1", displayName: "Alex P" },
	});
	assert.equal(accept.status, 200);
	assert.equal(accept.json.mailboxId, "alex@inboxies.email");
	assert.ok(accept.json.token);
	assert.ok(accept.json.accountId);
	assert.ok(accept.json.principal.keys.some((k) => k.startsWith("user:")));
	assert.ok(
		accept.json.principal.keys.includes(`account:${accept.json.accountId}`),
	);

	const settingsObj = JSON.parse(
		bucket.store.get(mailboxMetadataKey("alex@inboxies.email")),
	);
	assert.ok(
		settingsObj.acl.owners.includes(`account:${accept.json.accountId}`),
		"invite accept stamps account-scoped owner",
	);
	assert.equal(
		settingsObj.acl.owners.some((k) => k.startsWith("user:")),
		false,
		"invite accept does not dual-stamp user: on ACL",
	);

	const sessionClaims = await verifyMobileSessionToken(
		accept.json.token,
		env.MOBILE_JWT_SECRET,
	);
	assert.equal(sessionClaims.auth, "password");

	const inviteePrincipal = principalFromClaims(sessionClaims);
	const mailboxes = await jsonRequest(apiApp, env, {
		path: "/api/v1/mailboxes",
		principal: inviteePrincipal,
	});
	assert.equal(mailboxes.status, 200);
	assert.equal(mailboxes.json.length, 1);
	assert.equal(mailboxes.json[0].id, "alex@inboxies.email");

	const eveList = await jsonRequest(apiApp, env, {
		path: "/api/v1/mailboxes",
		principal: eve,
	});
	assert.equal(eveList.json.length, 0);

	const login = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/auth/password",
		body: { email: "alex@inboxies.email", password: "secure-password-1" },
	});
	assert.equal(login.status, 200);
	assert.ok(login.json.token);

	const badLogin = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/auth/password",
		body: { email: "alex@inboxies.email", password: "nope-nope-no" },
	});
	assert.equal(badLogin.status, 401);
}

// ── Invite-create keeps provisional admin owner (not claimable) ───

{
	const bucket = mockBucket();
	const env = mockEnv(bucket);
	const created = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/admin/mailboxes",
		principal: admin,
		body: {
			email: "pending@inboxies.email",
			assignTo: { inviteEmail: "person@gmail.com" },
		},
	});
	assert.equal(created.status, 201);
	assert.equal(created.json.settings.acl.owners.length, 1);
	assert.ok(
		created.json.settings.acl.owners[0].startsWith("account:"),
		"invite-assigned mailbox must keep provisional admin account owner",
	);

	// Matching Access identity must NOT auto-claim over the provisional owner.
	const claimer = principalFromClaims({
		email: "pending@inboxies.email",
		sub: "pending-sub",
	});
	const list = await jsonRequest(apiApp, env, {
		path: "/api/v1/mailboxes",
		principal: claimer,
	});
	assert.equal(list.status, 200);
	assert.equal(
		list.json.some((m) => m.id === "pending@inboxies.email"),
		false,
	);
}

// ── Member invite must not steal mailbox password login ───────────

{
	const bucket = mockBucket();
	const env = mockEnv(bucket);
	const created = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/admin/mailboxes",
		principal: admin,
		body: {
			email: "shared@inboxies.email",
			assignTo: {
				inviteEmail: "owner@gmail.com",
				role: "owner",
			},
		},
	});
	assert.equal(created.status, 201);
	const ownerToken = created.json.invite.token;
	const ownerAccept = await jsonRequest(apiApp, env, {
		method: "POST",
		path: `/api/v1/invites/${ownerToken}/accept`,
		body: { password: "owner-password-1" },
	});
	assert.equal(ownerAccept.status, 200);

	const memberInvite = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/admin/invites",
		principal: admin,
		body: {
			mailboxId: "shared@inboxies.email",
			inviteEmail: "member@gmail.com",
			role: "member",
		},
	});
	assert.equal(memberInvite.status, 201);
	const memberAccept = await jsonRequest(apiApp, env, {
		method: "POST",
		path: `/api/v1/invites/${memberInvite.json.token}/accept`,
		body: { password: "member-password-1" },
	});
	assert.equal(memberAccept.status, 200);

	const ownerLogin = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/auth/password",
		body: { email: "shared@inboxies.email", password: "owner-password-1" },
	});
	assert.equal(ownerLogin.status, 200);
	assert.equal(ownerLogin.json.sub, ownerAccept.json.principal.sub);

	const memberViaMailbox = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/auth/password",
		body: { email: "shared@inboxies.email", password: "member-password-1" },
	});
	assert.equal(memberViaMailbox.status, 401);

	const memberViaContact = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/auth/password",
		body: { email: "member@gmail.com", password: "member-password-1" },
	});
	assert.equal(memberViaContact.status, 200);

	const secondOwnerInvite = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/admin/invites",
		principal: admin,
		body: {
			mailboxId: "shared@inboxies.email",
			inviteEmail: "other-owner@gmail.com",
			role: "owner",
		},
	});
	assert.equal(secondOwnerInvite.status, 201);
	const secondAccept = await jsonRequest(apiApp, env, {
		method: "POST",
		path: `/api/v1/invites/${secondOwnerInvite.json.token}/accept`,
		body: { password: "other-owner-pw1" },
	});
	assert.equal(secondAccept.status, 409);
}

// ── Accepting your own invite must not grant the invitee's identity ──

{
	const bucket = mockBucket({
		[mailboxMetadataKey("eve@inboxies.email")]: {
			fromName: "Eve",
			acl: { owners: ["email:eve@example.com"], members: [] },
		},
		[mailboxMetadataKey("vault@inboxies.email")]: {
			fromName: "Victim",
			acl: { owners: ["email:victim@example.com"], members: [] },
		},
	});
	const env = mockEnv(bucket);

	// Eve owns a mailbox, so she can invite any address and sees the token.
	const invite = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/mailboxes/eve@inboxies.email/invites",
		principal: eve,
		body: { inviteEmail: "victim@example.com", role: "member" },
	});
	assert.equal(invite.status, 201);
	const accept = await jsonRequest(apiApp, env, {
		method: "POST",
		path: `/api/v1/invites/${invite.json.token}/accept`,
		body: { password: "attacker-password-1" },
	});
	assert.equal(accept.status, 200);

	const claims = await verifyMobileSessionToken(
		accept.json.token,
		env.MOBILE_JWT_SECRET,
	);
	assert.notEqual(claims.email, "victim@example.com", "session must not claim the invitee email");
	const asSession = principalFromClaims(claims);
	const vault = await jsonRequest(apiApp, env, {
		path: "/api/v1/mailboxes/vault@inboxies.email",
		principal: asSession,
	});
	assert.equal(vault.status, 403, "invite accept must not open the invitee's mailboxes");

	// The invitee email still works as a login for the new member.
	const login = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/auth/password",
		body: { email: "victim@example.com", password: "attacker-password-1" },
	});
	assert.equal(login.status, 200);
	const loginClaims = await verifyMobileSessionToken(login.json.token, env.MOBILE_JWT_SECRET);
	assert.notEqual(loginClaims.email, "victim@example.com");
}

// ── Admin transfer ACL ────────────────────────────────────────────

{
	const bucket = mockBucket({
		[mailboxMetadataKey("xfer@inboxies.email")]: {
			fromName: "X",
			acl: { owners: ["email:old@example.com"], members: [] },
		},
	});
	const env = mockEnv(bucket);
	const res = await jsonRequest(apiApp, env, {
		method: "PUT",
		path: "/api/v1/admin/mailboxes/xfer@inboxies.email/acl",
		principal: admin,
		body: { owners: ["email:admin@example.com"], members: [] },
	});
	assert.equal(res.status, 200);
	assert.deepEqual(res.json.settings.acl.owners, ["email:admin@example.com"]);
}

// ── Identity link code + Apple principal list / isAdmin ───────────

{
	const bucket = mockBucket({
		[mailboxMetadataKey("ops@inboxies.email")]: {
			fromName: "Ops",
			acl: { owners: ["email:admin@example.com"], members: [] },
		},
	});
	const env = mockEnv(bucket);

	const mint = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/me/identity-link-codes",
		principal: admin,
	});
	assert.equal(mint.status, 200);
	assert.ok(mint.json.code);
	assert.ok(mint.json.emails.includes("admin@example.com"));

	const apple = principalFromClaims({ sub: "apple.hide.email.sub" });
	const before = await jsonRequest(apiApp, env, {
		path: "/api/v1/me",
		principal: apple,
	});
	assert.equal(before.json.isAdmin, false);

	const redeem = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/auth/redeem-identity-link",
		principal: apple,
		body: { code: mint.json.code },
	});
	assert.equal(redeem.status, 200);
	assert.equal(redeem.json.isAdmin, true);
	assert.ok(redeem.json.linkedEmails.includes("admin@example.com"));

	// Middleware expands from R2 on subsequent requests.
	const afterMe = await jsonRequest(apiApp, env, {
		path: "/api/v1/me",
		principal: apple,
	});
	assert.equal(afterMe.json.isAdmin, true);
	assert.ok(afterMe.json.keys.includes("email:admin@example.com"));

	const list = await jsonRequest(apiApp, env, {
		path: "/api/v1/mailboxes",
		principal: apple,
	});
	assert.equal(list.status, 200);
	assert.deepEqual(
		list.json.map((m) => m.id),
		["ops@inboxies.email"],
	);

	// Assign-to-me stamps account-scoped owner (not Access email / Apple sub rows).
	const assign = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/admin/mailboxes/ops@inboxies.email/assign",
		principal: admin,
		body: { assignTo: "self" },
	});
	assert.equal(assign.status, 200);
	assert.equal(assign.json.settings.acl.owners.length, 1);
	assert.ok(assign.json.settings.acl.owners[0].startsWith("account:"));
	assert.equal(
		assign.json.settings.acl.owners.includes("email:admin@example.com"),
		false,
	);
	assert.equal(
		assign.json.settings.acl.owners.includes("sub:apple.hide.email.sub"),
		false,
	);

	const appleGet = await jsonRequest(apiApp, env, {
		path: "/api/v1/mailboxes/ops@inboxies.email",
		principal: apple,
	});
	assert.equal(appleGet.status, 200);
	assert.equal(appleGet.json.canManage, true);
}

{
	const bucket = mockBucket();
	const env = mockEnv(bucket);
	const eveMint = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/me/identity-link-codes",
		principal: eve,
	});
	assert.equal(eveMint.status, 200);
	assert.ok(eveMint.json.code);
	assert.ok(eveMint.json.emails.includes("eve@example.com"));

	const apple = principalFromClaims({ sub: "apple.eve.nonadmin" });
	const redeem = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/auth/redeem-identity-link",
		principal: apple,
		body: { code: eveMint.json.code },
	});
	assert.equal(redeem.status, 200);
	assert.ok(redeem.json.keys.includes("email:eve@example.com"));

	const identities = await jsonRequest(apiApp, env, {
		path: "/api/v1/me/identities",
		principal: apple,
	});
	assert.equal(identities.status, 200);
	assert.ok(Array.isArray(identities.json.identities));
	assert.ok(
		identities.json.identities.some(
			(i) => i.key === "email:eve@example.com" || i.label === "eve@example.com",
		),
	);
}

// ── In-session attach password + conflict ─────────────────────────

{
	const bucket = mockBucket();
	const env = mockEnv(bucket);
	const attach = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/me/identities/attach",
		principal: eve,
		body: { provider: "password", password: "correct-horse-battery" },
	});
	assert.equal(attach.status, 200);
	assert.equal(attach.json.provider, "password");
	assert.ok(attach.json.userId);
	assert.ok(
		attach.json.identities.some((i) => i.type === "password"),
	);

	const again = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/me/identities/attach",
		principal: eve,
		body: { provider: "password", password: "another-long-password" },
	});
	assert.equal(again.status, 409);

	const login = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/auth/password",
		body: { email: "eve@example.com", password: "correct-horse-battery" },
	});
	assert.equal(login.status, 200);
	assert.ok(login.json.token);

	const wrongCurrent = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/me/identities/password",
		principal: eve,
		body: {
			currentPassword: "wrong-current-password",
			newPassword: "brand-new-password-1",
		},
	});
	assert.equal(wrongCurrent.status, 401);

	const tooShort = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/me/identities/password",
		principal: eve,
		body: {
			currentPassword: "correct-horse-battery",
			newPassword: "short",
		},
	});
	assert.equal(tooShort.status, 400);

	const changed = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/me/identities/password",
		principal: eve,
		body: {
			currentPassword: "correct-horse-battery",
			newPassword: "brand-new-password-1",
		},
	});
	assert.equal(changed.status, 200);
	assert.equal(changed.json.ok, true);
	assert.ok(changed.json.userId);

	const oldLogin = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/auth/password",
		body: { email: "eve@example.com", password: "correct-horse-battery" },
	});
	assert.equal(oldLogin.status, 401);

	const newLogin = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/auth/password",
		body: { email: "eve@example.com", password: "brand-new-password-1" },
	});
	assert.equal(newLogin.status, 200);
	assert.ok(newLogin.json.token);
}

{
	const bucket = mockBucket();
	const env = mockEnv(bucket);
	const noPassword = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/me/identities/password",
		principal: admin,
		body: {
			currentPassword: "whatever-long-enough",
			newPassword: "brand-new-password-2",
		},
	});
	assert.equal(noPassword.status, 404);
}

{
	const bucket = mockBucket();
	const env = mockEnv(bucket, {
		APPLE_CLIENT_ID: "co.inboxies.app",
		GOOGLE_CLIENT_ID: "test-google-client.apps.googleusercontent.com",
	});
	const badApple = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/me/identities/attach",
		principal: admin,
		body: { provider: "apple", identityToken: "not-a-real-jwt" },
	});
	assert.equal(badApple.status, 401);

	const badGoogle = await jsonRequest(apiApp, env, {
		method: "POST",
		path: "/api/v1/me/identities/attach",
		principal: admin,
		body: { provider: "google", idToken: "not-a-real-jwt" },
	});
	assert.equal(badGoogle.status, 401);

	const cfg = await jsonRequest(apiApp, env, { path: "/api/v1/config" });
	assert.equal(cfg.status, 200);
	assert.equal(
		cfg.json.googleClientId,
		"test-google-client.apps.googleusercontent.com",
	);
	assert.equal(cfg.json.appleSignInConfigured, true);
}

console.log("domain-admin-http: ok");
