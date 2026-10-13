/**
 * Per-mailbox ACL: claim, deny, multi-mailbox owner, member cannot manage, list filter.
 * Run: node --experimental-strip-types workers/test/mailbox-acl.test.mjs
 */

import assert from "node:assert/strict";
import {
	applyIncomingAcl,
	authorizeMailbox,
	canAccessMailbox,
	canManageAcl,
	claimIfUnclaimed,
	creatorAcl,
	filterMailboxesForPrincipal,
	isUnclaimed,
	normalizeAclKey,
	parseAcl,
	principalFromClaims,
	principalKeys,
	validateAclWrite,
} from "../lib/mailbox-acl.ts";
import { mergeMailboxSettingsBlob } from "../lib/mail-automations.ts";
import { mailboxMetadataKey } from "../lib/mailbox-routing.ts";

const ada = principalFromClaims({ email: "Ada@Inboxies.Email", sub: "ada-sub" });
const bob = principalFromClaims({ email: "bob@inboxies.email", sub: "bob-sub" });
const mobileOnly = principalFromClaims({ sub: "mobile-sub" });

assert.deepEqual(principalKeys(ada).sort(), [
	"email:ada@inboxies.email",
	"sub:ada-sub",
]);
assert.equal(normalizeAclKey("Ada@Example.com"), "email:ada@example.com");
assert.equal(normalizeAclKey("email: Hello+Tag@Inboxies.Email "), "email:hello+tag@inboxies.email");
assert.equal(normalizeAclKey("sub:abc"), "sub:abc");
assert.equal(normalizeAclKey("account:acct-1"), "account:acct-1");
assert.equal(normalizeAclKey("account: account:acct-2 "), "account:acct-2");
assert.equal(normalizeAclKey("not-an-email"), null);

{
	const withAccount = principalFromClaims({
		email: "Ada@Inboxies.Email",
		sub: "ada-sub",
	});
	withAccount.linkedAccountIds = ["acct-ada"];
	assert.ok(principalKeys(withAccount).includes("account:acct-ada"));
}

assert.equal(isUnclaimed({}), true);
assert.equal(isUnclaimed({ acl: { owners: [], members: [] } }), true);
assert.equal(isUnclaimed({ acl: { owners: ["email:ada@inboxies.email"] } }), false);

{
	const unclaimed = { fromName: "Ada" };
	assert.equal(canAccessMailbox(unclaimed, ada, "ada@inboxies.email"), true);
	assert.equal(canAccessMailbox(unclaimed, bob, "ada@inboxies.email"), false);
	assert.equal(canManageAcl(unclaimed, ada), false, "email-match alone cannot manage ACL");
	const claimed = claimIfUnclaimed(unclaimed, ada, "Ada+Tag@Inboxies.Email");
	assert.deepEqual(claimed?.acl, {
		owners: ["email:ada@inboxies.email"],
		members: [],
	});
	assert.equal(claimIfUnclaimed(unclaimed, bob, "ada@inboxies.email"), null);
	const accountClaimed = claimIfUnclaimed(
		unclaimed,
		ada,
		"ada@inboxies.email",
		["account:acct-ada"],
	);
	assert.deepEqual(accountClaimed?.acl, {
		owners: ["account:acct-ada"],
		members: [],
	});
}

{
	const settings = {
		acl: {
			owners: ["email:ada@inboxies.email"],
			members: ["email:bob@inboxies.email"],
		},
	};
	assert.equal(canAccessMailbox(settings, ada, "shared@inboxies.email"), true);
	assert.equal(canAccessMailbox(settings, bob, "shared@inboxies.email"), true);
	assert.equal(canAccessMailbox(settings, mobileOnly, "shared@inboxies.email"), false);
	assert.equal(canManageAcl(settings, ada), true);
	assert.equal(canManageAcl(settings, bob), false, "member cannot edit ACL");
}

{
	const other = {
		acl: { owners: ["email:ada@inboxies.email"], members: [] },
	};
	assert.equal(canAccessMailbox(other, ada, "team@inboxies.email"), true);
	assert.equal(canAccessMailbox(other, ada, "ada@inboxies.email"), true);
	assert.equal(
		canAccessMailbox(
			{ acl: { owners: ["email:bob@inboxies.email"], members: [] } },
			ada,
			"bob@inboxies.email",
		),
		false,
	);
}

{
	const lastOwner = validateAclWrite({ owners: [], members: ["email:ada@inboxies.email"] });
	assert.equal(lastOwner.ok, false);
	const ok = validateAclWrite({
		owners: ["ada@example.com", "email:ada@example.com"],
		members: ["Bob@example.com", "email:ada@example.com"],
	});
	assert.equal(ok.ok, true);
	if (ok.ok) {
		assert.deepEqual(ok.acl.owners, ["email:ada@example.com"]);
		assert.deepEqual(ok.acl.members, ["email:bob@example.com"]);
	}
}

{
	const existing = {
		fromName: "Ada",
		acl: { owners: ["email:ada@inboxies.email"], members: [] },
	};
	const merged = mergeMailboxSettingsBlob(existing, {
		fromName: "Ada",
		forwarding: { enabled: true, email: "ada@example.com" },
	});
	assert.deepEqual(merged.acl, existing.acl, "omitted acl is preserved");

	const memberPut = applyIncomingAcl(
		existing,
		{ ...merged, acl: { owners: ["email:bob@inboxies.email"], members: [] } },
		{ acl: { owners: ["email:bob@inboxies.email"], members: [] } },
		bob,
	);
	assert.equal(memberPut.ok, true);
	if (memberPut.ok) {
		assert.deepEqual(memberPut.settings.acl, existing.acl, "member ACL write is stripped");
	}

	const ownerPut = applyIncomingAcl(
		existing,
		{ ...existing },
		{ acl: { owners: ["email:ada@inboxies.email"], members: ["email:bob@inboxies.email"] } },
		ada,
	);
	assert.equal(ownerPut.ok, true);
	if (ownerPut.ok) {
		assert.deepEqual(ownerPut.settings.acl, {
			owners: ["email:ada@inboxies.email"],
			members: ["email:bob@inboxies.email"],
		});
	}
}

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
			return store.has(key) ? {} : null;
		},
	};
}

{
	const bucket = mockBucket({
		[mailboxMetadataKey("ada@inboxies.email")]: { fromName: "Unclaimed Ada" },
		[mailboxMetadataKey("shared@inboxies.email")]: {
			acl: {
				owners: ["email:ada@inboxies.email"],
				members: ["email:bob@inboxies.email"],
			},
		},
		[mailboxMetadataKey("secret@inboxies.email")]: {
			acl: { owners: ["email:other@inboxies.email"], members: [] },
		},
	});

	const claimed = await authorizeMailbox(bucket, ada, "Ada@Inboxies.Email");
	assert.equal(claimed.ok, true);
	if (claimed.ok) {
		assert.equal(claimed.settings.acl.owners.length, 1);
		assert.ok(
			claimed.settings.acl.owners[0].startsWith("account:"),
			"claim writes account-scoped owner",
		);
		assert.ok(claimed.principal.linkedAccountIds?.length);
		assert.ok(
			claimed.principal.linkedAccountIds.includes(
				claimed.settings.acl.owners[0].slice("account:".length),
			),
		);
	}

	const denied = await authorizeMailbox(bucket, bob, "secret@inboxies.email");
	assert.equal(denied.ok, false);
	if (!denied.ok) assert.equal(denied.status, 403);

	const listed = await filterMailboxesForPrincipal(
		bucket,
		[
			{ id: "ada@inboxies.email", email: "ada@inboxies.email" },
			{ id: "shared@inboxies.email", email: "shared@inboxies.email" },
			{ id: "secret@inboxies.email", email: "secret@inboxies.email" },
		],
		ada,
	);
	assert.deepEqual(
		listed.map((m) => m.id),
		["ada@inboxies.email", "shared@inboxies.email"],
	);

	const bobList = await filterMailboxesForPrincipal(
		bucket,
		[
			{ id: "ada@inboxies.email", email: "ada@inboxies.email" },
			{ id: "shared@inboxies.email", email: "shared@inboxies.email" },
			{ id: "secret@inboxies.email", email: "secret@inboxies.email" },
		],
		bob,
	);
	assert.deepEqual(
		bobList.map((m) => m.id),
		["shared@inboxies.email"],
	);
}

{
	const acl = creatorAcl(ada);
	assert.ok(acl.owners.includes("email:ada@inboxies.email"));
	assert.ok(acl.owners.includes("sub:ada-sub"));
	assert.deepEqual(acl.members, []);
	assert.equal(
		acl.owners.includes("email:ada+tag@inboxies.email"),
		false,
		"creator ACL stores canonical email, not plus-tag",
	);
}

{
	const plusOwner = {
		acl: { owners: ["email:ada+ops@inboxies.email"], members: [] },
	};
	assert.equal(
		canAccessMailbox(plusOwner, ada, "team@inboxies.email"),
		true,
		"stored plus-tag owner matches untagged principal",
	);
	assert.equal(canManageAcl(plusOwner, ada), true);
	assert.equal(canAccessMailbox(plusOwner, bob, "team@inboxies.email"), false);
}

{
	const parsed = parseAcl({
		acl: { owners: ["email:ADA@inboxies.email"], members: ["not-valid", "email:bob@inboxies.email"] },
	});
	assert.deepEqual(parsed.owners, ["email:ada@inboxies.email"]);
	assert.deepEqual(parsed.members, ["email:bob@inboxies.email"]);
}

{
	const { mailboxIdFromAgentsUrl } = await import("../../shared/agent-conversations.ts");
	assert.equal(
		mailboxIdFromAgentsUrl("https://app.example/agents/email-agent/ada@inboxies.email::c1"),
		"ada@inboxies.email",
	);
	// Not decoded: the gate rejects escaped names instead of authorizing a
	// different string than the agent is named after.
	assert.equal(
		mailboxIdFromAgentsUrl("https://app.example/agents/email-agent/ada%40inboxies.email"),
		"ada%40inboxies.email",
	);
	assert.equal(
		mailboxIdFromAgentsUrl("https://app.example/agents/mailbox/ada@inboxies.email"),
		null,
	);
	assert.equal(
		mailboxIdFromAgentsUrl("https://app.example/agents/email-agent/ada@inboxies.email"),
		"ada@inboxies.email",
	);
	assert.equal(mailboxIdFromAgentsUrl("https://app.example/agents/email-agent"), null);
	assert.equal(mailboxIdFromAgentsUrl("https://app.example/mcp"), null);
}

console.log("mailbox-acl tests passed");
