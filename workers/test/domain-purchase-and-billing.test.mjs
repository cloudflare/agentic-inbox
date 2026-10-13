/**
 * Tests for Cloudflare Registrar domain availability, Stripe $20/yr subscription checkout sessions,
 * transparent fee breakdown, hosted bridge redirects, HMAC webhook verification, and automated domain provisioning.
 * Run: node --experimental-strip-types --import ./workers/test/register-ts-ext.mjs workers/test/domain-purchase-and-billing.test.mjs
 */

import assert from "node:assert/strict";
import { Hono } from "hono";
import { app as apiApp } from "../index.ts";
import { setDevRuntimeForTesting } from "../lib/dev-runtime.ts";
import {
	checkDomainAvailability,
	registerDomain,
	getDomainEppCode,
	setDomainTransferLock,
	computeDomainPricing,
	computeRetailPrice,
} from "../lib/cloudflare-registrar.ts";
import {
	saveDomainMetadata,
	getDomainMetadata,
} from "../lib/domain-registry.ts";
import {
	verifyStripeWebhookSignature,
	billingSessionKey,
} from "../routes/billing.ts";

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
		DOMAIN_ADMINS: "superadmin@example.com",
		MAILBOX_CREATE_POLICY: "admin_only",
		MOBILE_JWT_SECRET: "test-mobile-jwt-secret-billing-99",
		APP_BASE_URL: "https://inboxies.email",
		WORKER_NAME: "agentic-inbox",
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

async function stripeSignatureHeader(rawBody, secret, ts = Math.floor(Date.now() / 1000)) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${rawBody}`));
	const hex = Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `t=${ts},v1=${hex}`;
}

function postWebhook(rawBody, env, headers = {}) {
	return apiApp.request(
		"/api/v1/billing/stripe-webhook",
		{
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: rawBody,
		},
		env,
	);
}

/** Mirrors workers/app.ts: API routes mounted ahead of the React Router catch-all. */
function workerShell() {
	const shell = new Hono();
	shell.route("/", apiApp);
	shell.all("*", (c) => c.text("react-router"));
	return shell;
}

async function withDevRuntime(fn) {
	setDevRuntimeForTesting(true);
	try {
		return await fn();
	} finally {
		setDevRuntimeForTesting(undefined);
	}
}

async function runTests() {
	console.log("Starting Cloudflare Registrar & Stripe Billing tests...\n");

	// ---------------------------------------------------------
	// 1. Unit Tests: Transparent Pricing & Cloudflare Registrar Client
	// ---------------------------------------------------------
	console.log("1. Testing Cloudflare Registrar Client & Transparent Pricing...");

	const comPricing = computeDomainPricing(10.44);
	assert.equal(comPricing.totalAnnualUsd, 20.0, "Standard .com wholesale maps to $20.00 total");
	assert.equal(comPricing.domainFeeUsd, 10.44, "Domain fee is $10.44");
	assert.equal(comPricing.platformFeeUsd, 9.56, "Platform & AI fee is $9.56 ($20.00 - $10.44)");
	assert.equal(computeRetailPrice(10.44), 20.0);

	const orgPricing = computeDomainPricing(10.11);
	assert.equal(orgPricing.totalAnnualUsd, 20.0, "Standard .org wholesale maps to $20.00 total");
	assert.equal(orgPricing.domainFeeUsd, 10.11);
	assert.equal(orgPricing.platformFeeUsd, 9.89);

	// Domains > $15 wholesale add flat $10 fee
	const ioPricing = computeDomainPricing(35.0);
	assert.equal(ioPricing.totalAnnualUsd, 45.0, "Premium .io ($35) maps to $45 total ($35 + $10)");
	assert.equal(ioPricing.domainFeeUsd, 35.0);
	assert.equal(ioPricing.platformFeeUsd, 10.0);
	assert.equal(computeRetailPrice(35.0), 45.0);

	const mockEnvInst = { CF_API_TOKEN: "", CF_ACCOUNT_ID: "" };

	const availCom = await checkDomainAvailability(mockEnvInst, "brand-new-startup-123.com");
	assert.equal(availCom.available, true, "New domain should be available");
	assert.equal(availCom.registered, false);
	assert.equal(availCom.retailPriceUsd, 20.0, "Retail price should be $20.00");
	assert.equal(availCom.pricing.domainFeeUsd, 10.44);
	assert.equal(availCom.pricing.platformFeeUsd, 9.56);
	assert.equal(availCom.tldSupported, true);

	const taken = await checkDomainAvailability(mockEnvInst, "google.com");
	assert.equal(taken.available, false, "google.com should not be available");
	assert.equal(taken.registered, true);

	const unsupported = await checkDomainAvailability(mockEnvInst, "example.faketld");
	assert.equal(unsupported.tldSupported, false);
	assert.equal(unsupported.available, false);

	// Test registration
	const registered = await registerDomain(mockEnvInst, "brand-new-startup-123.com");
	assert.equal(registered.status, "active");
	assert.equal(registered.registrationInfo.provider, "cloudflare_registrar");
	assert.equal(registered.locked, true);

	// Test transfer lock and EPP code
	const unlocked = await setDomainTransferLock(mockEnvInst, "brand-new-startup-123.com", false);
	assert.equal(unlocked, false);

	const eppCode = await getDomainEppCode(mockEnvInst, "brand-new-startup-123.com");
	assert.match(eppCode, /^EPP-/, "EPP code format should start with EPP-");

	// Test live Cloudflare Registrar API check (POST /accounts/{account_id}/registrar/domain-check)
	const origFetch = globalThis.fetch;
	try {
		globalThis.fetch = async (url, init) => {
			const urlStr = String(url);
			if (urlStr.includes("/registrar/domain-check")) {
				const body = JSON.parse(init.body);
				const reqDomain = body.domains[0];
				if (reqDomain === "live-available.com") {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							success: true,
							result: {
								domains: [
									{
										name: "live-available.com",
										registrable: true,
										tier: "standard",
										pricing: {
											currency: "USD",
											registration_cost: "10.44",
											renewal_cost: "10.44",
										},
									},
								],
							},
						}),
					};
				} else if (reqDomain === "live-taken.com") {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							success: true,
							result: {
								domains: [
									{
										name: "live-taken.com",
										registrable: false,
										reason: "domain_unavailable",
									},
								],
							},
						}),
					};
				}
			}
			return origFetch(url, init);
		};

		const liveEnv = { CF_API_TOKEN: "test-token", CF_ACCOUNT_ID: "test-account" };
		const liveAvail = await checkDomainAvailability(liveEnv, "live-available.com");
		assert.equal(liveAvail.available, true, "Domain from live domain-check should be available");
		assert.equal(liveAvail.registered, false);
		assert.equal(liveAvail.retailPriceUsd, 20.0);
		assert.equal(liveAvail.pricing.domainFeeUsd, 10.44);
		assert.equal(liveAvail.pricing.platformFeeUsd, 9.56);

		const liveTaken = await checkDomainAvailability(liveEnv, "live-taken.com");
		assert.equal(liveTaken.available, false, "Domain from live domain-check should be taken");
		assert.equal(liveTaken.registered, true);

		// Test DoH fallback when registrar domain-check endpoint errors
		globalThis.fetch = async (url) => {
			const urlStr = String(url);
			if (urlStr.includes("/registrar/domain-check")) {
				return {
					ok: false,
					status: 403,
					json: async () => ({
						success: false,
						errors: [{ code: 10000, message: "Authentication error / unauthorized" }],
					}),
				};
			}
			if (urlStr.includes("cloudflare-dns.com/dns-query")) {
				if (urlStr.includes("doh-taken.com")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							Status: 0,
							Answer: [{ name: "doh-taken.com", type: 2, data: "ns1.cloudflare.com" }],
						}),
					};
				}
				if (urlStr.includes("doh-available.com")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({
							Status: 3, // NXDOMAIN
						}),
					};
				}
			}
			return origFetch(url);
		};

		const fallbackAvail = await checkDomainAvailability(liveEnv, "doh-available.com");
		assert.equal(fallbackAvail.available, true, "Fallback via DoH NXDOMAIN should report domain available");
		assert.equal(fallbackAvail.registered, false);

		const fallbackTaken = await checkDomainAvailability(liveEnv, "doh-taken.com");
		assert.equal(fallbackTaken.available, false, "Fallback via DoH NS should report domain taken");
		assert.equal(fallbackTaken.registered, true);
	} finally {
		globalThis.fetch = origFetch;
	}

	console.log("✔ Cloudflare Registrar & transparent pricing unit tests passed");

	// ---------------------------------------------------------
	// 2. HTTP Endpoint: GET /api/v1/auth/domains/check
	// ---------------------------------------------------------
	console.log("\n2. Testing GET /api/v1/auth/domains/check...");
	const bucket = mockBucket();
	const env = mockEnv(bucket);

	// Invalid domain
	const invRes = await apiApp.request("/api/v1/auth/domains/check?domain=invalid", {}, env);
	assert.equal(invRes.status, 400);

	// Available domain
	const checkRes = await apiApp.request("/api/v1/auth/domains/check?domain=fresh-domain-88.com", {}, env);
	assert.equal(checkRes.status, 200);
	const checkData = await checkRes.json();
	assert.equal(checkData.available, true);
	assert.equal(checkData.retailPriceUsd, 20.0);
	assert.equal(checkData.pricing.domainFeeUsd, 10.44);
	assert.equal(checkData.pricing.platformFeeUsd, 9.56);
	assert.equal(checkData.alreadyInInboxies, false);

	// Domain already registered in Inboxies R2
	await saveDomainMetadata(bucket, {
		domain: "existing-inboxies.org",
		zoneId: "zone-existing",
		ownerUserId: "u-1",
		adminUserIds: ["u-1"],
		status: "active",
		nameservers: ["ns1.cloudflare.com"],
		emailRoutingEnabled: true,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});

	const existsRes = await apiApp.request("/api/v1/auth/domains/check?domain=existing-inboxies.org", {}, env);
	assert.equal(existsRes.status, 200);
	const existsData = await existsRes.json();
	assert.equal(existsData.available, false);
	assert.equal(existsData.alreadyInInboxies, true);
	assert.equal(existsData.retailPriceUsd, 20.0);

	console.log("✔ Domain availability check HTTP tests passed");

	// ---------------------------------------------------------
	// 3. HTTP Endpoint: POST /api/v1/billing/create-domain-checkout
	// ---------------------------------------------------------
	console.log("\n3. Testing POST /api/v1/billing/create-domain-checkout...");

	// Conflict if domain is already in Inboxies
	const conflictRes = await apiApp.request(
		"/api/v1/billing/create-domain-checkout",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ domain: "existing-inboxies.org" }),
		},
		env,
	);
	assert.equal(conflictRes.status, 409);

	// Unavailable domain
	const unavailRes = await apiApp.request(
		"/api/v1/billing/create-domain-checkout",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ domain: "google.com" }),
		},
		env,
	);
	assert.equal(unavailRes.status, 400);

	// Without a Stripe key, production refuses rather than handing out the dev-only mock checkout
	const mockCheckoutBody = JSON.stringify({
		domain: "my-novel-company.com",
		username: "founder",
		displayName: "Alex Founder",
		password: "SuperSecretPassword123!",
		client: "ios",
	});
	const prodNoStripeRes = await apiApp.request(
		"/api/v1/billing/create-domain-checkout",
		{ method: "POST", headers: { "Content-Type": "application/json" }, body: mockCheckoutBody },
		env,
	);
	assert.equal(prodNoStripeRes.status, 503, "Production without STRIPE_SECRET_KEY must not create mock sessions");
	assert.equal(
		[...bucket.store.keys()].some((key) => key.startsWith("billing/sessions/mock_cs_")),
		false,
		"No mock session record should be written in production",
	);

	// Mock session creation (without Stripe key) in local dev
	const checkoutRes = await withDevRuntime(() =>
		apiApp.request(
			"/api/v1/billing/create-domain-checkout",
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: mockCheckoutBody },
			env,
		),
	);
	assert.equal(checkoutRes.status, 200);
	const checkoutData = await checkoutRes.json();
	assert.equal(checkoutData.domain, "my-novel-company.com");
	assert.equal(checkoutData.priceUsd, 20.0);
	assert.equal(checkoutData.pricing.domainFeeUsd, 10.44);
	assert.equal(checkoutData.pricing.platformFeeUsd, 9.56);
	assert.ok(checkoutData.checkoutUrl.includes("my-novel-company.com"));
	assert.ok(checkoutData.sessionId.startsWith("mock_cs_"));

	// Live Stripe Session Creation (with STRIPE_SECRET_KEY set)
	const stripeEnv = mockEnv(bucket, { STRIPE_SECRET_KEY: "sk_test_mock_key_123" });
	const originalFetch = globalThis.fetch;
	let capturedStripePayload = null;

	try {
		globalThis.fetch = async (url, init) => {
			const urlStr = String(url);
			if (urlStr.includes("api.stripe.com/v1/checkout/sessions")) {
				capturedStripePayload = new URLSearchParams(init.body);
				return {
					ok: true,
					status: 200,
					json: async () => ({
						id: "cs_stripe_live_test_777",
						url: "https://checkout.stripe.com/c/pay/cs_stripe_live_test_777",
					}),
				};
			}
			return originalFetch(url, init);
		};

		const liveCheckoutRes = await apiApp.request(
			"/api/v1/billing/create-domain-checkout",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					domain: "my-novel-company.com",
					username: "founder",
					client: "ios",
				}),
			},
			stripeEnv,
		);

		assert.equal(liveCheckoutRes.status, 200);
		const liveData = await liveCheckoutRes.json();
		assert.equal(liveData.sessionId, "cs_stripe_live_test_777");
		assert.equal(liveData.checkoutUrl, "https://checkout.stripe.com/c/pay/cs_stripe_live_test_777");

		// Verify Stripe payload complies with rules:
		assert.ok(capturedStripePayload, "Stripe API payload should have been captured");
		assert.equal(capturedStripePayload.get("mode"), "subscription", "Mode must be subscription");
		assert.equal(capturedStripePayload.get("line_items[0][price_data][recurring][interval]"), "year");
		assert.equal(capturedStripePayload.get("line_items[0][price_data][unit_amount]"), "1044", "Domain fee is 1044 cents");
		assert.equal(capturedStripePayload.get("line_items[1][price_data][recurring][interval]"), "year");
		assert.equal(capturedStripePayload.get("line_items[1][price_data][unit_amount]"), "956", "Platform/AI fee is 956 cents");
		assert.ok(capturedStripePayload.get("success_url").startsWith("https://inboxies.email/api/v1/billing/checkout-return"));
		assert.ok(capturedStripePayload.get("cancel_url").startsWith("https://inboxies.email/api/v1/billing/checkout-cancel"));
		assert.equal(capturedStripePayload.get("payment_method_types[0]"), null, "Must omit payment_method_types for dynamic methods");
	} finally {
		globalThis.fetch = originalFetch;
	}

	console.log("✔ Create domain checkout subscription session tests passed");

	// ---------------------------------------------------------
	// 4. HTTP Endpoints: Hosted Bridge (checkout-return & checkout-cancel & checkout-status)
	// ---------------------------------------------------------
	console.log("\n4. Testing Hosted Bridge Endpoints (checkout-return, checkout-cancel, checkout-status)...");

	// Mobile return triggers deep link redirect with token if available
	const mobileReturnRes = await apiApp.request(
		"/api/v1/billing/checkout-return?domain=my-novel-company.com&session_id=cs_test_123&client=ios",
		{
			headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" },
		},
		env,
	);
	assert.equal(mobileReturnRes.status, 302);
	const mobileLoc = mobileReturnRes.headers.get("Location");
	assert.ok(mobileLoc.startsWith("inboxies://onboarding/domain-ready?domain=my-novel-company.com"));

	// Desktop web return redirects to /checkout/success
	const webReturnRes = await apiApp.request(
		"/api/v1/billing/checkout-return?domain=my-novel-company.com&session_id=cs_test_123",
		{
			headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
		},
		env,
	);
	assert.equal(webReturnRes.status, 302);
	assert.ok(webReturnRes.headers.get("Location").includes("/checkout/success"));

	// Cancellation endpoints
	const mobileCancelRes = await apiApp.request(
		"/api/v1/billing/checkout-cancel?domain=my-novel-company.com&client=ios",
		{},
		env,
	);
	assert.equal(mobileCancelRes.status, 302);
	assert.equal(mobileCancelRes.headers.get("Location"), "inboxies://onboarding/cancelled?domain=my-novel-company.com");

	const webCancelRes = await apiApp.request(
		"/api/v1/billing/checkout-cancel?domain=my-novel-company.com",
		{},
		env,
	);
	assert.equal(webCancelRes.status, 302);
	assert.equal(webCancelRes.headers.get("Location"), "/checkout/cancel?domain=my-novel-company.com");

	// Status endpoint
	const statusRes = await apiApp.request(
		"/api/v1/billing/checkout-status?domain=my-novel-company.com",
		{},
		env,
	);
	assert.equal(statusRes.status, 200);
	const statusData = await statusRes.json();
	assert.ok(statusData.status);

	console.log("✔ Hosted bridge endpoints tests passed");

	// ---------------------------------------------------------
	// 5. HTTP Endpoint: POST /api/v1/billing/stripe-webhook & HMAC Signature Verification
	// ---------------------------------------------------------
	console.log("\n5. Testing POST /api/v1/billing/stripe-webhook fulfillment & HMAC signature verification...");

	// Unit test for verifyStripeWebhookSignature
	const webhookSecret = "whsec_test_secret_for_unit_tests_12345";
	const rawPayload = JSON.stringify({ hello: "world" });
	const ts = Math.floor(Date.now() / 1000);
	const signedContent = `${ts}.${rawPayload}`;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(webhookSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const validSigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
	const validSigHex = Array.from(new Uint8Array(validSigBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	const goodHeader = `t=${ts},v1=${validSigHex}`;
	const badHeader = `t=${ts},v1=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb`;

	const goodVerify = await verifyStripeWebhookSignature(rawPayload, goodHeader, webhookSecret);
	assert.equal(goodVerify.valid, true, "Valid HMAC signature should pass");

	const badVerify = await verifyStripeWebhookSignature(rawPayload, badHeader, webhookSecret);
	assert.equal(badVerify.valid, false, "Tampered signature should fail");

	// Webhook HTTP verification with secret configured
	const secureEnv = mockEnv(bucket, { STRIPE_WEBHOOK_SECRET: webhookSecret });

	const webhookPayload = {
		id: "evt_test_123",
		type: "checkout.session.completed",
		data: {
			object: {
				id: "cs_test_completed_123",
				metadata: {
					domain: "my-novel-company.com",
					username: "founder",
					displayName: "Alex Founder",
					passwordHash: "mock-pw-hash-99",
					totalAnnualUsd: "20.00",
					domainFeeUsd: "10.44",
					platformFeeUsd: "9.56",
				},
			},
		},
	};

	const rawWebhookBody = JSON.stringify(webhookPayload);
	const hookTs = Math.floor(Date.now() / 1000);
	const hookSigBuf = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${hookTs}.${rawWebhookBody}`),
	);
	const hookSigHex = Array.from(new Uint8Array(hookSigBuf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	// Production without a usable secret fails closed, signed or not
	for (const [label, misconfiguredEnv] of [
		["missing secret", env],
		["placeholder secret", mockEnv(bucket, { STRIPE_WEBHOOK_SECRET: "whsec_..." })],
	]) {
		const unsignedRes = await postWebhook(rawWebhookBody, misconfiguredEnv);
		assert.equal(unsignedRes.status, 503, `Prod + ${label}: unsigned event must be rejected`);
		assert.match((await unsignedRes.json()).error, /not configured/);

		const forgedRes = await postWebhook(rawWebhookBody, misconfiguredEnv, {
			"stripe-signature": await stripeSignatureHeader(rawWebhookBody, "whsec_attacker_chosen"),
		});
		assert.equal(forgedRes.status, 503, `Prod + ${label}: self-signed event must be rejected`);
	}

	// 1. Rejected on invalid signature
	const rejectRes = await apiApp.request(
		"/api/v1/billing/stripe-webhook",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"stripe-signature": `t=${hookTs},v1=invalid_sig`,
			},
			body: rawWebhookBody,
		},
		secureEnv,
	);
	assert.equal(rejectRes.status, 400);

	const unsignedProdRes = await postWebhook(rawWebhookBody, secureEnv);
	assert.equal(unsignedProdRes.status, 400, "Prod + secret: missing stripe-signature must be rejected");

	const wrongSecretRes = await postWebhook(rawWebhookBody, secureEnv, {
		"stripe-signature": await stripeSignatureHeader(rawWebhookBody, "whsec_some_other_secret"),
	});
	assert.equal(wrongSecretRes.status, 400, "Prod + secret: signature from another secret must be rejected");

	// A configured secret is enforced in local dev too
	const devUnsignedWithSecretRes = await withDevRuntime(() => postWebhook(rawWebhookBody, secureEnv));
	assert.equal(devUnsignedWithSecretRes.status, 400, "Dev + secret: unsigned event must be rejected");

	assert.equal(
		await getDomainMetadata(bucket, "my-novel-company.com"),
		null,
		"Rejected webhooks must not provision the domain",
	);

	// 2. Accepted on valid signature
	const webhookRes = await apiApp.request(
		"/api/v1/billing/stripe-webhook",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"stripe-signature": `t=${hookTs},v1=${hookSigHex}`,
			},
			body: rawWebhookBody,
		},
		secureEnv,
	);

	assert.equal(webhookRes.status, 200);
	const webhookData = await webhookRes.json();
	assert.equal(webhookData.status, "provisioned");
	assert.equal(webhookData.retailPriceUsd, 20.0);
	assert.equal(webhookData.pricing.domainFeeUsd, 10.44);
	assert.equal(webhookData.pricing.platformFeeUsd, 9.56);

	// Verify Domain Metadata was saved in R2
	const savedMeta = await getDomainMetadata(bucket, "my-novel-company.com");
	assert.ok(savedMeta, "Domain metadata should exist in R2");
	assert.equal(savedMeta.domain, "my-novel-company.com");
	assert.equal(savedMeta.status, "active");
	assert.equal(savedMeta.emailRoutingEnabled, true);
	assert.equal(savedMeta.registration?.provider, "cloudflare_registrar");
	assert.equal(savedMeta.registration?.retailPriceUsd, 20.0);
	assert.equal(savedMeta.registration?.locked, true);

	// Verify Admin Mailbox was provisioned in R2
	const mailboxMeta = await bucket.get("mailboxes/founder@my-novel-company.com.json");
	assert.ok(mailboxMeta, "Mailbox settings should be stored in R2");

	// Verify status endpoint now reports ready
	const readyStatusRes = await apiApp.request(
		"/api/v1/billing/checkout-status?domain=my-novel-company.com",
		{},
		env,
	);
	const readyStatus = await readyStatusRes.json();
	assert.equal(readyStatus.status, "ready");
	assert.equal(readyStatus.domain, "my-novel-company.com");

	// checkout-return is public: knowing a provisioned domain must not yield
	// a session for its owner, on mobile or web.
	assert.ok(savedMeta.ownerUserId, "fixture domain must have an owner");
	const hijackMobile = await apiApp.request(
		"/api/v1/billing/checkout-return?domain=my-novel-company.com&client=ios",
		{},
		env,
	);
	const hijackMobileLoc = hijackMobile.headers.get("Location") || "";
	assert.ok(!hijackMobileLoc.includes("token="), "mobile return must not carry a session token");
	assert.ok(!(await hijackMobile.text()).includes("token="), "bridge page must not carry a session token");
	const hijackWeb = await apiApp.request(
		"/api/v1/billing/checkout-return?domain=my-novel-company.com",
		{ headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } },
		env,
	);
	assert.equal(hijackWeb.headers.get("Set-Cookie"), null, "web return must not set a session cookie");

	console.log("✔ Stripe webhook fulfillment & HMAC verification tests passed");

	// ---------------------------------------------------------
	// 6. Dev-only /checkout/mock simulator
	// ---------------------------------------------------------
	console.log("\n6. Testing dev-only /checkout/mock flow...");

	const shell = workerShell();

	// Unreachable in production, including React Router data requests and path spelling variants
	for (const path of [
		"/checkout/mock?session_id=mock_cs_x&domain=x.com",
		"/checkout/mock/",
		"/checkout/mock.data",
		"/Checkout/MOCK",
		"/checkout/%6Dock",
	]) {
		const res = await shell.request(path, {}, env);
		assert.equal(res.status, 404, `Prod: ${path} must be unreachable`);
	}
	const successPageRes = await shell.request("/checkout/success?domain=x.com", {}, env);
	assert.equal(await successPageRes.text(), "react-router", "Guard must not catch other checkout pages");

	// Dev without a secret still rejects a signature it cannot check
	const unknownSigHeader = await stripeSignatureHeader(rawWebhookBody, "whsec_unknown");
	const devSignedNoSecretRes = await withDevRuntime(() =>
		postWebhook(rawWebhookBody, env, { "stripe-signature": unknownSigHeader }),
	);
	assert.equal(devSignedNoSecretRes.status, 400, "Dev + no secret: signed delivery must be rejected");

	// End-to-end mock purchase in local dev (placeholder secret from .dev.vars.example)
	const devEnv = mockEnv(bucket, { STRIPE_WEBHOOK_SECRET: "whsec_..." });
	await withDevRuntime(async () => {
		const devCheckoutRes = await apiApp.request(
			"/api/v1/billing/create-domain-checkout",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ domain: "dev-mock-purchase.com", client: "android" }),
			},
			devEnv,
		);
		assert.equal(devCheckoutRes.status, 200);
		const devCheckout = await devCheckoutRes.json();
		assert.equal(devCheckout.mock, true);
		const mockPage = new URL(devCheckout.checkoutUrl);
		assert.equal(mockPage.pathname, "/checkout/mock");

		const mockPageRes = await shell.request(`${mockPage.pathname}${mockPage.search}`, {}, devEnv);
		assert.equal(mockPageRes.status, 200);
		assert.equal(await mockPageRes.text(), "react-router", "Dev: /checkout/mock falls through to the SPA");

		// Same unsigned event app/routes/checkout-mock.tsx posts
		const mockEventRes = await postWebhook(
			JSON.stringify({
				type: "checkout.session.completed",
				data: {
					object: {
						id: devCheckout.sessionId,
						metadata: {
							domain: "dev-mock-purchase.com",
							username: "admin",
							displayName: "Admin",
							totalAnnualUsd: "20.00",
							domainFeeUsd: "10.44",
							platformFeeUsd: "9.56",
						},
					},
				},
			}),
			devEnv,
		);
		assert.equal(mockEventRes.status, 200, "Dev: unsigned mock event is accepted");
		assert.equal((await mockEventRes.json()).status, "provisioned");

		const devStatusRes = await apiApp.request(
			`/api/v1/billing/checkout-status?session_id=${encodeURIComponent(devCheckout.sessionId)}`,
			{},
			devEnv,
		);
		assert.equal((await devStatusRes.json()).status, "ready");
	});
	assert.equal((await getDomainMetadata(bucket, "dev-mock-purchase.com"))?.status, "active");

	console.log("✔ Dev-only /checkout/mock flow tests passed");

	console.log("\n=========================================");
	console.log("ALL REGISTRAR & BILLING TESTS PASSED!");
	console.log("=========================================\n");
}

runTests().catch((err) => {
	console.error("\n❌ Test failed:", err);
	process.exit(1);
});
