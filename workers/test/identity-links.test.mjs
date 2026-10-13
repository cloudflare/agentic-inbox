/**
 * Identity links: account ↔ principals (email / sub / user).
 * Run: node --experimental-strip-types --import ./workers/test/register-ts-ext.mjs workers/test/identity-links.test.mjs
 */

import assert from "node:assert/strict";
import { findUserIdByLoginEmail } from "../lib/platform-users.ts";
import {
	autoLinkSubIfAdminEmail,
	attachIdpToSessionAccount,
	attachPasswordToSessionAccount,
	createIdentityLinkCode,
	ensureIdentityAccount,
	expandPrincipalWithLinks,
	IdentityAlreadyLinkedError,
	IdentityNotOwnedError,
	identityLinkCodeIsActive,
	listIdentitiesForPrincipal,
	mintIdentityLinkCode,
	ownerKeysForAssign,
	parseIdentityLink,
	passwordUserForSessionAccount,
	redeemIdentityLinkCode,
	resolveAdminLinkEmails,
	updatePasswordHashForSessionAccount,
	upsertIdentityLink,
} from "../lib/identity-links.ts";
import {
	aclFromOwnerKeys,
	canAccessMailbox,
	filterMailboxesForPrincipal,
	principalFromClaims,
	principalKeys,
} from "../lib/mailbox-acl.ts";
import { principalIsDomainAdmin, parseDomainAdminsEnv } from "../lib/domain-admin.ts";
import { mailboxMetadataKey } from "../lib/mailbox-routing.ts";
import {
	savePlatformUser,
} from "../lib/platform-users.ts";

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

// ── principalKeys includes linkedEmails + linkedUserIds ───────────

{
	const p = principalFromClaims({
		email: "relay@privaterelay.appleid.com",
		sub: "apple.sub.1",
	});
	p.linkedEmails = ["admin@example.com"];
	p.linkedUserIds = ["abc-123"];
	const keys = principalKeys(p);
	assert.ok(keys.includes("email:relay@privaterelay.appleid.com"));
	assert.ok(keys.includes("email:admin@example.com"));
	assert.ok(keys.includes("sub:apple.sub.1"));
	assert.ok(keys.includes("user:abc-123"));
}

// ── expand + Domain Admin match via link ──────────────────────────

{
	const bucket = mockBucket();
	await upsertIdentityLink(bucket, {
		sub: "apple.sub.2",
		provider: "apple",
		emails: ["admin@example.com"],
		linkedByKeys: ["test"],
	});
	const appleOnly = principalFromClaims({ sub: "apple.sub.2" });
	const expanded = await expandPrincipalWithLinks(bucket, appleOnly);
	assert.equal(expanded.email, "admin@example.com");
	assert.deepEqual(expanded.linkedEmails, ["admin@example.com"]);

	const allow = new Set(parseDomainAdminsEnv("admin@example.com"));
	assert.equal(principalIsDomainAdmin(appleOnly, allow), false);
	assert.equal(principalIsDomainAdmin(expanded, allow), true);
}

// ── list-as-admin / ACL: Access-owned mailbox visible after Apple expand ─

{
	const bucket = mockBucket({
		[mailboxMetadataKey("ops@inboxies.email")]: {
			fromName: "Ops",
			acl: {
				owners: ["email:admin@example.com"],
				members: [],
			},
		},
	});
	await upsertIdentityLink(bucket, {
		sub: "apple.sub.3",
		provider: "apple",
		emails: ["admin@example.com"],
	});
	const apple = await expandPrincipalWithLinks(
		bucket,
		principalFromClaims({ sub: "apple.sub.3" }),
	);
	assert.equal(
		canAccessMailbox(
			{
				acl: {
					owners: ["email:admin@example.com"],
					members: [],
				},
			},
			apple,
			"ops@inboxies.email",
		),
		true,
	);
	const listed = await filterMailboxesForPrincipal(
		bucket,
		[{ id: "ops@inboxies.email", email: "ops@inboxies.email" }],
		apple,
	);
	assert.deepEqual(
		listed.map((m) => m.id),
		["ops@inboxies.email"],
	);
}

// ── assign / create: account-scoped owner keys (not method swarm) ─

{
	const bucket = mockBucket();
	await upsertIdentityLink(bucket, {
		sub: "apple.sub.4",
		provider: "apple",
		emails: ["admin@example.com"],
	});
	const access = principalFromClaims({
		email: "admin@example.com",
		sub: "access-sub",
	});
	const keys = await ownerKeysForAssign(bucket, access);
	assert.equal(keys.length, 1);
	assert.ok(keys[0].startsWith("account:"));
	assert.equal(keys.includes("email:admin@example.com"), false);
	assert.equal(keys.includes("sub:access-sub"), false);
	assert.equal(keys.includes("sub:apple.sub.4"), false);
	const acl = aclFromOwnerKeys(keys);
	assert.deepEqual(acl.owners, keys);

	// Access session expanded with account can manage; Apple on same account too.
	const expandedAccess = await expandPrincipalWithLinks(bucket, access);
	assert.ok(expandedAccess.linkedAccountIds?.includes(keys[0].slice("account:".length)));
	assert.equal(
		canAccessMailbox({ acl }, expandedAccess, "ops@inboxies.email"),
		true,
	);
	const apple = principalFromClaims({ sub: "apple.sub.4" });
	const expandedApple = await expandPrincipalWithLinks(bucket, apple);
	assert.equal(
		canAccessMailbox({ acl }, expandedApple, "ops@inboxies.email"),
		true,
		"linked Apple session sees account-owned mailbox",
	);
	const stranger = principalFromClaims({ sub: "apple.unrelated" });
	const expandedStranger = await expandPrincipalWithLinks(bucket, stranger);
	assert.equal(
		canAccessMailbox({ acl }, expandedStranger, "ops@inboxies.email"),
		false,
		"raw Apple sub without account link does not get access",
	);
}

// ── auto-link only when email is Domain Admin ─────────────────────

{
	const bucket = mockBucket();
	const env = { DOMAIN_ADMINS: "admin@example.com", BUCKET: bucket };
	const linked = await autoLinkSubIfAdminEmail(env, {
		sub: "apple.sub.5",
		email: "admin@example.com",
		provider: "apple",
	});
	assert.ok(linked);
	assert.deepEqual(linked.emails, ["admin@example.com"]);

	const skipped = await autoLinkSubIfAdminEmail(env, {
		sub: "apple.sub.6",
		email: "stranger@example.com",
		provider: "apple",
	});
	assert.equal(skipped, null);

	const noEmail = await autoLinkSubIfAdminEmail(env, {
		sub: "apple.sub.7",
		provider: "apple",
	});
	assert.equal(noEmail, null);
}

// ── link code lifecycle ───────────────────────────────────────────

{
	const code = createIdentityLinkCode({
		emails: ["Admin@Example.com"],
		createdByKeys: ["email:admin@example.com"],
		nowMs: 1_000_000,
	});
	assert.equal(code.emails[0], "admin@example.com");
	assert.equal(identityLinkCodeIsActive(code, 1_000_000), true);
	assert.equal(identityLinkCodeIsActive(code, 1_000_000 + 16 * 60 * 1000), false);
	const used = { ...code, usedAt: new Date().toISOString() };
	assert.equal(identityLinkCodeIsActive(used, 1_000_000), false);
}

{
	const bucket = mockBucket();
	const admin = principalFromClaims({
		email: "admin@example.com",
		sub: "access-sub",
	});
	const emails = await resolveAdminLinkEmails(
		{ DOMAIN_ADMINS: "admin@example.com", BUCKET: bucket },
		admin,
	);
	assert.ok(emails.includes("admin@example.com"));
}

{
	const parsed = parseIdentityLink({
		sub: "x",
		provider: "apple",
		emails: ["A@B.com"],
		linkedAt: "t",
		updatedAt: "t",
		linkedByKeys: [],
	});
	assert.ok(parsed);
	assert.equal(parsed.emails[0], "a@b.com");
}

// ── Any user mints; Apple redeems → same account / ACL union ──────

{
	const bucket = mockBucket({
		[mailboxMetadataKey("team@inboxies.email")]: {
			fromName: "Team",
			acl: { owners: ["email:eve@example.com"], members: [] },
		},
	});
	const eve = principalFromClaims({
		email: "eve@example.com",
		sub: "eve-access",
	});
	const mint = await mintIdentityLinkCode(
		{ DOMAIN_ADMINS: "admin@example.com", BUCKET: bucket },
		eve,
	);
	assert.ok(mint.code);
	assert.ok(mint.accountId);
	assert.ok(mint.emails.includes("eve@example.com"));

	const apple = principalFromClaims({ sub: "apple.eve.hide" });
	const redeemed = await redeemIdentityLinkCode(bucket, apple, mint.code);
	assert.ok(redeemed.linkedEmails.includes("eve@example.com"));

	const expanded = await expandPrincipalWithLinks(bucket, apple);
	assert.ok(principalKeys(expanded).includes("email:eve@example.com"));
	assert.equal(
		canAccessMailbox(
			{ acl: { owners: ["email:eve@example.com"], members: [] } },
			expanded,
			"team@inboxies.email",
		),
		true,
	);
}

// ── Password account ↔ Apple via link code ────────────────────────

{
	const bucket = mockBucket();
	const userId = "pwd-user-1";
	const user = {
		id: userId,
		contactEmail: "invitee@gmail.com",
		mailboxEmail: "alex@inboxies.email",
		passwordHash: "x",
		linkedSubs: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	await savePlatformUser(bucket, user);

	const passwordPrincipal = {
		email: "alex@inboxies.email",
		sub: `user:${userId}`,
	};
	await ensureIdentityAccount(bucket, passwordPrincipal);

	const mint = await mintIdentityLinkCode(
		{ DOMAIN_ADMINS: "", BUCKET: bucket },
		passwordPrincipal,
	);
	const apple = principalFromClaims({ sub: "apple.invitee.1" });
	const redeemed = await redeemIdentityLinkCode(bucket, apple, mint.code);
	assert.ok(redeemed.expanded.linkedUserIds?.includes(userId));
	assert.ok(principalKeys(redeemed.expanded).includes(`user:${userId}`));
	assert.ok(
		principalKeys(redeemed.expanded).includes("email:alex@inboxies.email"),
	);

	const reloaded = await expandPrincipalWithLinks(bucket, apple);
	assert.ok(principalKeys(reloaded).includes(`user:${userId}`));
}

// ── In-session Connect IdP (attach) ───────────────────────────────

{
	const bucket = mockBucket();
	const access = principalFromClaims({
		email: "admin@example.com",
		sub: "access-admin",
	});
	await ensureIdentityAccount(bucket, access);

	const attached = await attachIdpToSessionAccount(bucket, access, {
		sub: "apple.connect.1",
		provider: "apple",
		emails: ["relay@privaterelay.appleid.com"],
	});
	assert.ok(principalKeys(attached.expanded).includes("sub:apple.connect.1"));
	assert.ok(
		principalKeys(attached.expanded).includes("email:admin@example.com"),
	);

	const expanded = await expandPrincipalWithLinks(
		bucket,
		principalFromClaims({ sub: "apple.connect.1" }),
	);
	assert.ok(principalKeys(expanded).includes("email:admin@example.com"));
	assert.equal(
		principalIsDomainAdmin(
			expanded,
			new Set(parseDomainAdminsEnv("admin@example.com")),
		),
		true,
	);
}

{
	const bucket = mockBucket();
	const a = principalFromClaims({ email: "a@example.com", sub: "a-sub" });
	const b = principalFromClaims({ email: "b@example.com", sub: "b-sub" });
	await ensureIdentityAccount(bucket, a);
	await attachIdpToSessionAccount(bucket, b, {
		sub: "google.taken",
		provider: "google",
		emails: ["b@example.com"],
	});
	await assert.rejects(
		() =>
			attachIdpToSessionAccount(bucket, a, {
				sub: "google.taken",
				provider: "google",
			}),
		(err) => err instanceof IdentityAlreadyLinkedError,
	);
}

{
	const bucket = mockBucket();
	const access = principalFromClaims({
		email: "eve@example.com",
		sub: "eve-access-2",
	});
	const pwd = await attachPasswordToSessionAccount(bucket, access, {
		passwordHash: "hash-placeholder",
	});
	assert.ok(pwd.userId);
	assert.ok(principalKeys(pwd.expanded).includes(`user:${pwd.userId}`));
	await assert.rejects(
		() =>
			attachPasswordToSessionAccount(bucket, access, {
				passwordHash: "hash-2",
			}),
		(err) =>
			err instanceof Error &&
			err.message.includes("already has a password"),
	);

	const listed = await listIdentitiesForPrincipal(bucket, access);
	const passwordRow = listed.identities.find((i) => i.type === "password");
	assert.ok(passwordRow);
	assert.ok(
		passwordRow.label.includes("eve@example.com") ||
			passwordRow.label === "Password",
	);

	const userBefore = await passwordUserForSessionAccount(bucket, access);
	assert.ok(userBefore);
	assert.equal(userBefore.passwordHash, "hash-placeholder");

	const changed = await updatePasswordHashForSessionAccount(
		bucket,
		access,
		"hash-changed",
	);
	assert.equal(changed.userId, pwd.userId);
	const userAfter = await passwordUserForSessionAccount(bucket, access);
	assert.ok(userAfter);
	assert.equal(userAfter.passwordHash, "hash-changed");

	const noPassword = principalFromClaims({
		email: "nopw@example.com",
		sub: "nopw-access",
	});
	await ensureIdentityAccount(bucket, noPassword);
	assert.equal(await passwordUserForSessionAccount(bucket, noPassword), null);
	await assert.rejects(
		() =>
			updatePasswordHashForSessionAccount(bucket, noPassword, "hash-x"),
		(err) =>
			err instanceof Error &&
			err.message.includes("no password sign-in method"),
	);
}

// ── Connected UI: Access email+sub → one Access method (never raw sub) ─

{
	const bucket = mockBucket();
	const access = principalFromClaims({
		email: "emmanuel@example.com",
		sub: "access-uuid-abc",
	});
	const listed = await listIdentitiesForPrincipal(bucket, access);
	assert.equal(listed.identities.length, 1);
	assert.equal(listed.identities[0].type, "access");
	assert.equal(listed.identities[0].label, "emmanuel@example.com");
	assert.equal(listed.identities[0].current, true);
	assert.ok(
		!listed.identities.some((i) => i.type === "sub" || i.type === "email"),
	);

	// New layout keys written
	assert.ok(
		[...bucket.store.keys()].some((k) =>
			k.startsWith("platform/identity/accounts/"),
		),
	);
	assert.ok(
		[...bucket.store.keys()].some((k) =>
			k.startsWith("platform/identity/by-key/"),
		),
	);
	// Legacy dual-write still present during migration window
	assert.ok(
		[...bucket.store.keys()].some((k) =>
			k.startsWith("platform/identity-accounts/"),
		),
	);
}

// ── Access + Apple + Password → three real methods ────────────────

{
	const bucket = mockBucket();
	const access = principalFromClaims({
		email: "eve@example.com",
		sub: "eve-access-3",
	});
	await attachIdpToSessionAccount(bucket, access, {
		sub: "apple.eve",
		provider: "apple",
		emails: ["eve@example.com"],
	});
	await attachPasswordToSessionAccount(bucket, access, {
		passwordHash: "hash-p",
	});
	const listed = await listIdentitiesForPrincipal(bucket, access);
	const types = listed.identities.map((i) => i.type).sort();
	assert.deepEqual(types, ["access", "apple", "password"]);
	assert.ok(!listed.identities.some((i) => i.type === "sub"));
}

// ── Add password cannot claim an email the account doesn't own ─────

{
	const bucket = mockBucket();
	const google = principalFromClaims({
		email: "mallory@gmail.com",
		sub: "google.mallory",
	});
	await assert.rejects(
		() =>
			attachPasswordToSessionAccount(bucket, google, {
				passwordHash: "hash-x",
				loginEmail: "victim@example.com",
			}),
		(err) => err instanceof IdentityNotOwnedError,
	);
	assert.equal(
		await findUserIdByLoginEmail(bucket, "victim@example.com"),
		null,
		"a rejected attach must not leave a login pointer behind",
	);
	// The account's own email is still accepted.
	const ok = await attachPasswordToSessionAccount(bucket, google, {
		passwordHash: "hash-y",
		loginEmail: "Mallory@gmail.com",
	});
	assert.ok(ok.userId);
}

// ── Dual-read: legacy account + by-key still expands / lists ──────

{
	const bucket = mockBucket();
	const accountId = "legacy-account-1";
	const emailKey = "email:legacy@example.com";
	const subKey = "sub:legacy-access";
	await bucket.put(
		`platform/identity-accounts/${accountId}.json`,
		JSON.stringify({
			id: accountId,
			principals: [emailKey, subKey],
			primaryEmail: "legacy@example.com",
			createdAt: "t0",
			updatedAt: "t0",
		}),
	);
	await bucket.put(
		`platform/identity-accounts-by-key/${encodeURIComponent(emailKey)}.json`,
		JSON.stringify({ accountId }),
	);
	await bucket.put(
		`platform/identity-accounts-by-key/${encodeURIComponent(subKey)}.json`,
		JSON.stringify({ accountId }),
	);

	const expanded = await expandPrincipalWithLinks(
		bucket,
		principalFromClaims({ sub: "legacy-access" }),
	);
	assert.equal(expanded.email, "legacy@example.com");

	const listed = await listIdentitiesForPrincipal(
		bucket,
		principalFromClaims({
			email: "legacy@example.com",
			sub: "legacy-access",
		}),
	);
	assert.equal(listed.accountId, accountId);
	assert.equal(listed.identities.length, 1);
	assert.equal(listed.identities[0].type, "access");
	// Migrated to new path
	assert.ok(bucket.store.has(`platform/identity/accounts/${accountId}.json`));
}

// ── Password credentials dual-read from legacy platform/users ─────

{
	const bucket = mockBucket();
	const userId = "legacy-user-1";
	await bucket.put(
		`platform/users/${userId}.json`,
		JSON.stringify({
			id: userId,
			contactEmail: "pwd@example.com",
			mailboxEmail: "pwd@inboxies.email",
			passwordHash: "legacy-hash",
			linkedSubs: [],
			createdAt: "t0",
			updatedAt: "t0",
		}),
	);
	await bucket.put(
		`platform/users-by-login/pwd@inboxies.email.json`,
		JSON.stringify({ userId }),
	);

	const { findUserIdByLoginEmail, loadPlatformUser } = await import(
		"../lib/platform-users.ts"
	);
	const found = await findUserIdByLoginEmail(bucket, "pwd@inboxies.email");
	assert.equal(found, userId);
	const user = await loadPlatformUser(bucket, userId);
	assert.ok(user);
	assert.equal(user.passwordHash, "legacy-hash");
	assert.ok(bucket.store.has(`platform/identity/passwords/${userId}.json`));
}

// ── Access-owned mailbox → link Apple → Apple session sees same ACL ─

{
	const bucket = mockBucket();
	const access = principalFromClaims({
		email: "owner@example.com",
		sub: "access.owner.1",
	});
	const ownerKeys = await ownerKeysForAssign(bucket, access);
	assert.equal(ownerKeys.length, 1);
	assert.ok(ownerKeys[0].startsWith("account:"));
	const accountId = ownerKeys[0].slice("account:".length);

	await bucket.put(
		mailboxMetadataKey("box@inboxies.email"),
		JSON.stringify({
			fromName: "Box",
			acl: aclFromOwnerKeys(ownerKeys),
		}),
	);

	// Unlinked Apple cannot see the mailbox.
	const strangerApple = principalFromClaims({ sub: "apple.stranger" });
	const strangerList = await filterMailboxesForPrincipal(
		bucket,
		[{ id: "box@inboxies.email", email: "box@inboxies.email" }],
		strangerApple,
	);
	assert.deepEqual(strangerList, []);

	// Link Apple into the Access account.
	await attachIdpToSessionAccount(bucket, access, {
		sub: "apple.owner.1",
		provider: "apple",
		emails: ["relay@privaterelay.appleid.com"],
	});

	const apple = principalFromClaims({ sub: "apple.owner.1" });
	const expandedApple = await expandPrincipalWithLinks(bucket, apple);
	assert.ok(expandedApple.linkedAccountIds?.includes(accountId));
	assert.ok(principalKeys(expandedApple).includes(`account:${accountId}`));
	assert.equal(
		canAccessMailbox(
			{ acl: aclFromOwnerKeys(ownerKeys) },
			expandedApple,
			"box@inboxies.email",
		),
		true,
	);

	const appleList = await filterMailboxesForPrincipal(
		bucket,
		[{ id: "box@inboxies.email", email: "box@inboxies.email" }],
		apple,
	);
	assert.deepEqual(
		appleList.map((m) => m.id),
		["box@inboxies.email"],
	);

	// ACL blob stayed account-only (no Apple sub / relay email rows).
	const persisted = JSON.parse(
		bucket.store.get(mailboxMetadataKey("box@inboxies.email")),
	);
	assert.deepEqual(persisted.acl.owners, [`account:${accountId}`]);
	assert.equal(persisted.acl.owners.includes("sub:apple.owner.1"), false);
	assert.equal(
		persisted.acl.owners.includes("email:relay@privaterelay.appleid.com"),
		false,
	);
}

console.log("identity-links: ok");
