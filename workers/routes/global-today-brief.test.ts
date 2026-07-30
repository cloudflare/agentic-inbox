import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import { GlobalTodayBriefAccessChangedError } from "../lib/global-today-brief-runtime.ts";
import {
	createGlobalTodayBriefRoutes,
	type GlobalTodayBriefRouteContext,
	type GlobalTodayBriefRouteInput,
} from "./global-today-brief.ts";

const session = { sub: "user-a", email: "user@example.com", mailbox: "user@example.com", role: "AGENT", sessionVersion: 1 } satisfies SessionClaims;

function app(options: {
	session?: SessionClaims;
	fail?: boolean | "access";
	rosters?: Array<{ mailboxIds: string[] } | null | Error>;
} = {}) {
	const calls: GlobalTodayBriefRouteInput[] = [];
	const root = new Hono<GlobalTodayBriefRouteContext>();
	root.use("*", async (c, next) => {
		if (options.session) c.set("session", options.session);
		await next();
	});
	root.route("/", createGlobalTodayBriefRoutes({
		run: async (input) => {
			calls.push(input);
			if (options.fail === "access") throw new GlobalTodayBriefAccessChangedError();
			if (options.fail) throw new Error("private infrastructure detail");
			return { state: "no_attention", counts: { privateRemindersDue: 0, unreadConversations: 0 }, omittedCount: 0 };
		},
	}, async () => {
		const nextRoster = options.rosters?.shift();
		const roster = nextRoster === undefined
			? { mailboxIds: ["user@example.com"] }
			: nextRoster;
		if (roster instanceof Error) throw roster;
		return roster;
	}));
	return { root, calls };
}

function request(body: string, headers: Record<string, string> = {}) {
	return new Request("http://mail.example.com/api/v1/today/brief", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
	});
}

test("global Today brief authenticates before parsing and never stores responses", async () => {
	const unauthenticated = app();
	const denied = await unauthenticated.root.request(request("not-json"));
	assert.equal(denied.status, 401);
	assert.equal(unauthenticated.calls.length, 0);
	assert.equal(denied.headers.get("cache-control"), "private, no-store");

	const authenticated = app({ session });
	const accepted = await authenticated.root.request(request(JSON.stringify({ timeZone: "Africa/Cairo" })));
	assert.equal(accepted.status, 200);
	assert.equal(accepted.headers.get("cache-control"), "private, no-store");
	assert.equal(authenticated.calls[0]?.actorUserId, "user-a");
	assert.equal(authenticated.calls[0]?.refresh, false);
});

test("global Today brief accepts only exact bounded automatic or Refresh bodies", async () => {
	const valid = app({ session });
	assert.equal((await valid.root.request(request(JSON.stringify({ timeZone: "UTC", refresh: true })))).status, 200);
	assert.equal(valid.calls[0]?.refresh, true);

	for (const body of [
		"not-json",
		JSON.stringify({}),
		JSON.stringify({ timeZone: "Mars/Olympus" }),
		JSON.stringify({ timeZone: "UTC", refresh: "true" }),
		JSON.stringify({ timeZone: "UTC", refresh: false }),
		JSON.stringify({ timeZone: "UTC", mailboxIds: ["secret@example.com"] }),
	]) {
		assert.equal((await app({ session }).root.request(request(body))).status, 400);
	}
	assert.equal((await app({ session }).root.request(request(JSON.stringify({ timeZone: "UTC" }), { "content-length": "2048" }))).status, 413);
});

test("global Today brief failures remain card-local and redact infrastructure details", async () => {
	const response = await app({ session, fail: true }).root.request(request(JSON.stringify({ timeZone: "UTC" })));
	assert.equal(response.status, 200);
	const body = await response.json() as { state: string; reason: string };
	assert.equal(body.state, "brief_unavailable");
	assert.match(body.reason, /^[a-z0-9_:]+$/);
	assert.equal(JSON.stringify(body).includes("private infrastructure detail"), false);
});

test("revocation after runtime work returns forbidden so the client purges all mail state", async () => {
	const response = await app({ session, fail: "access" }).root.request(request(JSON.stringify({ timeZone: "UTC" })));
	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "Mailbox access changed" });
});

test("global Today brief discards success or private failure after exact roster drift", async () => {
	for (const fail of [false, true]) {
		const response = await app({
			session,
			fail,
			rosters: [
				{ mailboxIds: ["a@example.com", "b@example.com"] },
				{ mailboxIds: ["b@example.com"] },
			],
		}).root.request(request(JSON.stringify({ timeZone: "UTC" })));
		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: "Mailbox access changed" });
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
});
