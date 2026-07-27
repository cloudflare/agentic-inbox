import assert from "node:assert/strict";
import test from "node:test";
import {
	mutationOriginDecision,
	workersDevRequestDecision,
} from "./request-security.ts";

test("cookie-backed mutations accept only the portal's own origin", () => {
	assert.equal(
		mutationOriginDecision(
			new Request("https://mail.wiserchat.ai/api/v1/mailboxes", {
				method: "POST",
				headers: { Origin: "https://mail.wiserchat.ai" },
			}),
		),
		"allow",
	);
	assert.equal(
		mutationOriginDecision(
			new Request("https://mail.wiserchat.ai/api/v1/mailboxes", {
				method: "POST",
				headers: { Origin: "https://attacker.example" },
			}),
		),
		"forbid",
	);
});

test("cookie-backed mutations fail closed when browser origin evidence is absent or opaque", () => {
	for (const headers of [
		{},
		{ Origin: "null" },
		{ "Sec-Fetch-Site": "cross-site" },
	]) {
		assert.equal(
			mutationOriginDecision(
				new Request("https://mail.wiserchat.ai/logout", {
					method: "POST",
					headers,
				}),
			),
			"forbid",
		);
	}
});

test("safe reads and the separately authenticated SES webhook bypass browser-origin enforcement", () => {
	assert.equal(
		mutationOriginDecision(new Request("https://mail.wiserchat.ai/")),
		"allow",
	);
	assert.equal(
		mutationOriginDecision(
			new Request("https://mail.wiserchat.ai/webhooks/ses", {
				method: "POST",
			}),
		),
		"allow",
	);
});

test("the workers.dev hostname serves the SES webhook and nothing else", () => {
	// It is reachable only because the zone's Bot Fight Mode challenges AWS
	// EventBridge; every other surface stays behind the zone.
	assert.equal(
		workersDevRequestDecision(
			new Request("https://wiser-mail-portal.acme.workers.dev/webhooks/ses", {
				method: "POST",
			}),
		),
		"allow",
	);
	for (const [method, path] of [
		["GET", "/"],
		["GET", "/login"],
		["POST", "/login"],
		["GET", "/webhooks/ses"],
		["GET", "/api/v1/mailboxes"],
		["POST", "/mcp"],
		["POST", "/token"],
		["POST", "/register"],
		["GET", "/.well-known/oauth-authorization-server"],
		["GET", "/health"],
		["GET", "/assets/app.js"],
		["POST", "/webhooks/ses/extra"],
	] as const) {
		assert.equal(
			workersDevRequestDecision(
				new Request(`https://wiser-mail-portal.acme.workers.dev${path}`, {
					method,
				}),
			),
			"not-found",
			`${method} ${path} must not be served on workers.dev`,
		);
	}
});

test("zone hostnames are untouched by the workers.dev guard", () => {
	for (const [method, path] of [
		["GET", "/"],
		["GET", "/login"],
		["POST", "/webhooks/ses"],
		["POST", "/mcp"],
		["GET", "/api/v1/mailboxes"],
	] as const) {
		for (const host of [
			"mail.wiserchat.ai",
			"wiserchat.ai",
			"mail.whispyrcrm.com",
			"localhost:5173",
		]) {
			assert.equal(
				workersDevRequestDecision(
					new Request(`https://${host}${path}`, { method }),
				),
				"allow",
				`${method} ${path} on ${host} must be unaffected`,
			);
		}
	}
	// A lookalike host is not the real suffix.
	assert.equal(
		workersDevRequestDecision(
			new Request("https://notworkers.dev/login", { method: "GET" }),
		),
		"allow",
	);
});
