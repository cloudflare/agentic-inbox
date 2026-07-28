import assert from "node:assert/strict";
import test from "node:test";
import type { MailboxManagementRow } from "../lib/mailbox-access.ts";
import { resolveBrand } from "./brand.ts";
import { renderAdminMailboxesPage } from "./admin-mailboxes-page.ts";

const mailboxes: MailboxManagementRow[] = [
	{
		id: "hesham@wiserchat.ai",
		address: "hesham@wiserchat.ai",
		type: "PERSONAL",
		owner_user_id: "usr_admin",
		is_active: 1,
		created_at: 1,
		updated_at: 1,
		member_count: 0,
	},
	{
		id: "support@wiserchat.ai",
		address: "support@wiserchat.ai",
		type: "SHARED",
		owner_user_id: null,
		is_active: 1,
		created_at: 2,
		updated_at: 2,
		member_count: 3,
	},
];

const users = [
	{ id: "usr_admin", email: "hesham@wiserchat.ai", is_active: 1 },
	{ id: "usr_member", email: "kareem@wiserchat.ai", is_active: 1 },
	{ id: "usr_inactive", email: "former@wiserchat.ai", is_active: 0 },
];

test("mailbox administration page distinguishes Personal and Shared mailboxes", () => {
	const html = renderAdminMailboxesPage(resolveBrand("wiser"), users, mailboxes);

	assert.match(html, />Personal Mailboxes</);
	assert.match(html, />Shared Mailboxes</);
	assert.match(html, /hesham@wiserchat\.ai/);
	assert.match(html, /support@wiserchat\.ai/);
	assert.match(html, /3 members/);
	assert.match(html, /same access as a member on every mailbox/);
	assert.doesNotMatch(html, /stays private to its owner/);
	assert.doesNotMatch(html, /does not grant access to its messages/);
});

test("mailbox administration page exposes only the intentionally simple shared access model", () => {
	const html = renderAdminMailboxesPage(resolveBrand("wiser"), users, mailboxes);

	assert.match(html, /read, compose, and reply/);
	assert.match(html, /Read state is shared across the mailbox/);
	assert.match(html, /Actions are attributed to the person who performed them/);
	assert.doesNotMatch(html, /\bassignments?\b/i);
	assert.doesNotMatch(html, /\bSLAs?\b/i);
	assert.doesNotMatch(html, /\bdue dates?\b/i);
	assert.doesNotMatch(html, /\bgranular permissions?\b/i);
});

test("mailbox administration page wires creation and membership to the mailbox APIs", () => {
	const html = renderAdminMailboxesPage(resolveBrand("wiser"), users, mailboxes);

	assert.match(html, /requestJson\("\/api\/v1\/mailboxes"/);
	assert.match(html, /\/api\/v1\/admin\/shared-mailboxes\//);
	assert.match(html, /\/members/);
	assert.match(html, /kareem@wiserchat\.ai/);
	assert.doesNotMatch(html, /former@wiserchat\.ai/);
});

test("mailbox administration page escapes mailbox and user data in HTML and script contexts", () => {
	const html = renderAdminMailboxesPage(
		resolveBrand("wiser"),
		[
			{
				id: "usr_<script>",
				email: "person+<script>@wiserchat.ai",
				is_active: 1,
			},
		],
		[
			{
				...mailboxes[1],
				id: "<script>alert(1)</script>@wiserchat.ai",
				address: "<script>alert(1)</script>@wiserchat.ai",
			},
		],
	);

	assert.doesNotMatch(html, /<script>alert\(1\)<\/script>@wiserchat\.ai/);
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;@wiserchat\.ai/);
	assert.doesNotMatch(html, /"usr_<script>"/);
	assert.match(html, /usr_\\u003cscript\\u003e/);
});
