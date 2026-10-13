// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, type Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import {
	checkDomainAvailability,
	registerDomain,
	computeDomainPricing,
	type DomainPricingBreakdown,
} from "../lib/cloudflare-registrar";
import {
	createZone,
	enableEmailRouting,
	createCatchAllWorkerRule,
	autoConfigureEmailDns,
	ensureFullEmailDns,
	listDnsRecords,
	auditEmailHealth,
} from "../lib/cloudflare-client";
import {
	getDomainMetadata,
	saveDomainMetadata,
	type DomainMetadata,
} from "../lib/domain-registry";
import {
	hashPassword,
	verifyPasswordSessionToken,
	PASSWORD_SESSION_COOKIE,
} from "../lib/password-auth";
import {
	findUserIdByLoginEmail,
	savePlatformUser,
	principalFromPlatformUser,
	type PlatformUser,
} from "../lib/platform-users";
import {
	canonicalMailboxId,
	mailboxMetadataKey,
} from "../lib/mailbox-routing";
import { ensurePrincipalAccount } from "../lib/identity-links";
import { aclFromOwnerKeys } from "../lib/mailbox-acl";
import { seedWelcomeEmailsForMailbox } from "../lib/welcome-emails";
import { isDevRuntime } from "../lib/dev-runtime";

const CreateDomainCheckoutBody = z.object({
	domain: z
		.string()
		.trim()
		.min(3, "Domain is required")
		.max(253)
		.regex(
			/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
			"Invalid domain format",
		),
	username: z
		.string()
		.trim()
		.min(2)
		.max(50)
		.regex(/^[a-zA-Z0-9._-]+$/)
		.optional(),
	password: z.string().min(10).max(200).optional(),
	displayName: z.string().trim().max(200).optional(),
	client: z.enum(["web", "ios", "android"]).optional(),
	returnUrl: z.string().url().optional(),
});

interface StripeSessionResponse {
	id: string;
	url: string;
}

export interface BillingSessionRecord {
	sessionId: string;
	domain: string;
	status: "pending" | "provisioning" | "ready" | "failed";
	pricing: DomainPricingBreakdown;
	username?: string;
	displayName?: string;
	mailboxId?: string;
	ownerUserId?: string;
	client?: string;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export function billingSessionKey(sessionId: string): string {
	return `billing/sessions/${sessionId}.json`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const trimmed = part.trim();
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		if (trimmed.slice(0, eq) !== name) continue;
		try {
			return decodeURIComponent(trimmed.slice(eq + 1));
		} catch {
			return trimmed.slice(eq + 1);
		}
	}
	return undefined;
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/**
 * Verify Stripe webhook signature using Web Crypto HMAC-SHA256.
 */
export async function verifyStripeWebhookSignature(
	rawBody: string,
	signatureHeader: string,
	secret: string,
	toleranceSeconds = 300,
): Promise<{ valid: boolean; error?: string }> {
	if (!signatureHeader || !secret) {
		return { valid: false, error: "Missing signature header or secret" };
	}

	const parts = signatureHeader.split(",");
	let timestamp: string | undefined;
	const signatures: string[] = [];

	for (const part of parts) {
		const [k, v] = part.split("=");
		if (k === "t") timestamp = v;
		else if (k === "v1") signatures.push(v);
	}

	if (!timestamp || signatures.length === 0) {
		return { valid: false, error: "Invalid signature header format" };
	}

	const tsNum = parseInt(timestamp, 10);
	if (isNaN(tsNum)) {
		return { valid: false, error: "Invalid timestamp in signature" };
	}

	const nowSeconds = Math.floor(Date.now() / 1000);
	if (Math.abs(nowSeconds - tsNum) > toleranceSeconds) {
		return { valid: false, error: "Webhook timestamp out of tolerance" };
	}

	const signedPayload = `${timestamp}.${rawBody}`;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);

	const sigBuffer = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(signedPayload),
	);

	const expectedSig = Array.from(new Uint8Array(sigBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	for (const sig of signatures) {
		if (timingSafeEqual(sig, expectedSig)) {
			return { valid: true };
		}
	}

	return { valid: false, error: "Signature mismatch" };
}

/** The value `.dev.vars.example` ships with; never a usable signing secret. */
const STRIPE_WEBHOOK_SECRET_PLACEHOLDER = "whsec_...";

function configuredStripeWebhookSecret(env: Env): string | undefined {
	const secret = env.STRIPE_WEBHOOK_SECRET;
	if (!secret || secret === STRIPE_WEBHOOK_SECRET_PLACEHOLDER) return undefined;
	return secret;
}

/** `/checkout/mock` and its React Router `.data` / nested variants, however the path is cased or encoded. */
function isMockCheckoutPath(pathname: string): boolean {
	let decoded = pathname;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {}
	return /^\/checkout\/mock(?:[/.]|$)/i.test(decoded);
}

export function registerBillingRoutes(app: Hono<{ Bindings: Env }>) {
	/**
	 * The mock checkout page simulates payment by posting an unsigned webhook event,
	 * so it only exists in local dev. Runs ahead of the React Router catch-all.
	 */
	app.use("*", async (c, next) => {
		if (!isDevRuntime() && isMockCheckoutPath(new URL(c.req.url).pathname)) {
			return c.text("Not Found", 404);
		}
		await next();
	});

	/**
	 * Initiate an annual Stripe Checkout subscription session to purchase and register a domain.
	 * Transparent fee breakdown:
	 * - Domain Registration: Wholesale cost ($10.44 for .com)
	 * - Inboxies Platform, AI & Cloud Infrastructure: Platform fee ($9.56 for standard; $10 for domains > $15)
	 * - Total: $20.00/yr (or wholesale + $10/yr)
	 */
	app.post("/api/v1/billing/create-domain-checkout", async (c) => {
		const parsed = CreateDomainCheckoutBody.safeParse(await c.req.json().catch(() => ({})));
		if (!parsed.success) {
			return c.json(
				{ error: parsed.error.issues[0]?.message || "Invalid input" },
				400,
			);
		}

		const { domain: rawDomain, username, password, displayName, client, returnUrl } = parsed.data;
		const domain = rawDomain.toLowerCase();

		// 1. Verify not already registered inside Inboxies
		const existingDomain = await getDomainMetadata(c.env.BUCKET, domain);
		if (existingDomain) {
			return c.json(
				{ error: "This domain is already registered with Inboxies" },
				409,
			);
		}

		// 2. Pre-check availability via Cloudflare Registrar
		const avail = await checkDomainAvailability(c.env, domain);
		if (!avail.available && !avail.alreadyInInboxies) {
			return c.json(
				{ error: `Domain '${domain}' is not available for purchase` },
				400,
			);
		}

		const pricing = computeDomainPricing(avail.wholesalePriceUsd);

		// 3. Resolve caller identity if already logged in (e.g. from Admin DNS suite)
		let callerUserId: string | undefined;
		const authHeader = c.req.header("authorization");
		const bearer = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
		const cookieSession = readCookie(c.req.header("cookie"), PASSWORD_SESSION_COOKIE);
		const sessionToken = bearer || cookieSession;
		const secret = c.env.MOBILE_JWT_SECRET || (isDevRuntime() ? "dev-mobile-jwt-secret-change-me" : "");
		if (sessionToken && secret) {
			try {
				const claims = await verifyPasswordSessionToken(sessionToken, secret);
				callerUserId = claims.uid;
			} catch {}
		}

		const appBase = c.env.APP_BASE_URL || "https://inboxies.email";
		const clientParam = client ? `&client=${encodeURIComponent(client)}` : "";
		const effectiveSuccessUrl = `${appBase}/api/v1/billing/checkout-return?session_id={CHECKOUT_SESSION_ID}&domain=${encodeURIComponent(domain)}${clientParam}`;
		const effectiveCancelUrl = `${appBase}/api/v1/billing/checkout-cancel?domain=${encodeURIComponent(domain)}${clientParam}`;

		// 4. Create Stripe Checkout Subscription Session if STRIPE_SECRET_KEY is configured
		if (c.env.STRIPE_SECRET_KEY) {
			const form = new URLSearchParams();
			form.append("mode", "subscription");

			// Item 1: Domain Registration (Annual ICANN wholesale fee)
			form.append("line_items[0][price_data][currency]", "usd");
			form.append("line_items[0][price_data][recurring][interval]", "year");
			form.append(
				"line_items[0][price_data][product_data][name]",
				`Domain Registration: ${domain} (Annual)`,
			);
			form.append(
				"line_items[0][price_data][product_data][description]",
				`1-year domain registration & wholesale ICANN fee via Cloudflare Registrar`,
			);
			form.append("line_items[0][price_data][unit_amount]", Math.round(pricing.domainFeeUsd * 100).toString());
			form.append("line_items[0][quantity]", "1");

			// Item 2: Inboxies Platform, AI & Cloud Infrastructure (Annual)
			form.append("line_items[1][price_data][currency]", "usd");
			form.append("line_items[1][price_data][recurring][interval]", "year");
			form.append(
				"line_items[1][price_data][product_data][name]",
				"Inboxies Platform, AI & Cloud Infrastructure (Annual)",
			);
			form.append(
				"line_items[1][price_data][product_data][description]",
				"Dedicated AI email agent, edge server sync, R2 storage, Anycast DNS, and email security",
			);
			form.append("line_items[1][price_data][unit_amount]", Math.round(pricing.platformFeeUsd * 100).toString());
			form.append("line_items[1][quantity]", "1");

			form.append("metadata[domain]", domain);
			form.append("metadata[domainFeeUsd]", pricing.domainFeeUsd.toFixed(2));
			form.append("metadata[platformFeeUsd]", pricing.platformFeeUsd.toFixed(2));
			form.append("metadata[totalAnnualUsd]", pricing.totalAnnualUsd.toFixed(2));
			if (username) form.append("metadata[username]", username.toLowerCase());
			if (displayName) form.append("metadata[displayName]", displayName);
			if (password) {
				const pwHash = await hashPassword(password);
				form.append("metadata[passwordHash]", pwHash);
			}
			if (callerUserId) form.append("metadata[ownerUserId]", callerUserId);
			if (client) form.append("metadata[client]", client);

			form.append("success_url", effectiveSuccessUrl);
			form.append("cancel_url", effectiveCancelUrl);

			const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: form.toString(),
			});

			if (!stripeRes.ok) {
				const errBody = (await stripeRes.json().catch(() => ({}))) as {
					error?: { message?: string };
				};
				const msg = errBody.error?.message || `Stripe session error: ${stripeRes.status}`;
				return c.json({ error: msg }, 502);
			}

			const session = (await stripeRes.json()) as StripeSessionResponse;

			// Save session record in R2 for status tracking
			const sessionRecord: BillingSessionRecord = {
				sessionId: session.id,
				domain,
				status: "pending",
				pricing,
				username: username?.toLowerCase(),
				displayName: displayName || username,
				ownerUserId: callerUserId,
				client,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			await c.env.BUCKET.put(billingSessionKey(session.id), JSON.stringify(sessionRecord));

			return c.json({
				checkoutUrl: session.url,
				sessionId: session.id,
				domain,
				pricing,
				priceUsd: pricing.totalAnnualUsd,
			});
		}

		// Without live Stripe credentials only local dev gets the /checkout/mock simulator
		if (!isDevRuntime()) {
			return c.json({ error: "Domain checkout is not configured" }, 503);
		}

		const mockSessionId = `mock_cs_${domain.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}`;
		const mockUrl = `${appBase}/checkout/mock?session_id=${mockSessionId}&domain=${encodeURIComponent(domain)}${clientParam}`;

		const mockRecord: BillingSessionRecord = {
			sessionId: mockSessionId,
			domain,
			status: "pending",
			pricing,
			username: username?.toLowerCase(),
			displayName: displayName || username,
			ownerUserId: callerUserId,
			client,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		await c.env.BUCKET.put(billingSessionKey(mockSessionId), JSON.stringify(mockRecord));

		return c.json({
			checkoutUrl: mockUrl,
			sessionId: mockSessionId,
			domain,
			pricing,
			priceUsd: pricing.totalAnnualUsd,
			mock: true,
		});
	});

	/**
	 * Hosted Bridge Return Handler after Stripe checkout completes.
	 * Redirects mobile clients to `inboxies://onboarding/domain-ready`, closing the
	 * in-app browser (ASWebAuthenticationSession / Custom Tabs), and desktop web
	 * users to `/checkout/success`.
	 *
	 * This route is public and only knows the domain, so it never issues a
	 * session: clients sign in with the password chosen at checkout once
	 * `checkout-status` reports ready.
	 */
	app.get("/api/v1/billing/checkout-return", async (c) => {
		const domain = (c.req.query("domain") || "").toLowerCase().trim();
		const sessionId = c.req.query("session_id") || "";
		const clientQuery = c.req.query("client") || "";
		const userAgent = c.req.header("user-agent") || "";
		const isMobile = clientQuery === "ios" || clientQuery === "android" || /iPhone|iPad|iPod|Android/i.test(userAgent);

		if (isMobile) {
			const deepLink = `inboxies://onboarding/domain-ready?domain=${encodeURIComponent(domain)}&session_id=${encodeURIComponent(sessionId)}`;

			// 302 Redirect with HTML bridge script fallback to close in-app browser
			return c.html(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Redirecting to Inboxies...</title>
<script>
window.location.href = ${JSON.stringify(deepLink)};
</script>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fafafb; color: #1f1f24;">
<div style="text-align: center; padding: 24px;">
  <p style="font-size: 16px; font-weight: 600;">Payment complete! Returning to Inboxies...</p>
  <a href="${deepLink}" style="display: inline-block; margin-top: 14px; padding: 10px 22px; background: #2659d9; color: #fff; text-decoration: none; border-radius: 8px; font-size: 14px;">Open Inboxies</a>
</div>
</body>
</html>`, 302, {
				Location: deepLink,
			});
		}

		return new Response(null, {
			status: 302,
			headers: {
				Location: `/checkout/success?session_id=${encodeURIComponent(sessionId)}&domain=${encodeURIComponent(domain)}`,
			},
		});
	});

	/**
	 * Hosted Bridge Cancellation Handler.
	 * Redirects mobile clients to `inboxies://onboarding/cancelled` (closing in-app browser).
	 * Redirects desktop web users to `/checkout/cancel`.
	 */
	app.get("/api/v1/billing/checkout-cancel", async (c) => {
		const domain = (c.req.query("domain") || "").toLowerCase().trim();
		const clientQuery = c.req.query("client") || "";
		const userAgent = c.req.header("user-agent") || "";
		const isMobile = clientQuery === "ios" || clientQuery === "android" || /iPhone|iPad|iPod|Android/i.test(userAgent);

		if (isMobile) {
			const cancelDeepLink = `inboxies://onboarding/cancelled?domain=${encodeURIComponent(domain)}`;
			return c.redirect(cancelDeepLink, 302);
		}

		return c.redirect(`/checkout/cancel?domain=${encodeURIComponent(domain)}`, 302);
	});

	/**
	 * Query Domain Checkout Provisioning Status.
	 * Used by Web and Mobile checkout success screens to live-poll DNS and mailbox activation.
	 */
	app.get("/api/v1/billing/checkout-status", async (c) => {
		const sessionId = c.req.query("session_id") || "";
		const domain = (c.req.query("domain") || "").toLowerCase().trim();

		if (!sessionId && !domain) {
			return c.json({ error: "Missing session_id or domain" }, 400);
		}

		let sessionRecord: BillingSessionRecord | null = null;
		if (sessionId) {
			const res = await c.env.BUCKET.get(billingSessionKey(sessionId));
			if (res) {
				sessionRecord = (await res.json()) as BillingSessionRecord;
			}
		}

		const targetDomain = domain || sessionRecord?.domain;
		if (targetDomain) {
			const meta = await getDomainMetadata(c.env.BUCKET, targetDomain);
			if (meta && meta.status === "active") {
				return c.json({
					status: "ready",
					domain: targetDomain,
					pricing: sessionRecord?.pricing ?? computeDomainPricing(10.44),
					mailboxId: sessionRecord?.mailboxId,
				});
			}
		}

		if (sessionRecord) {
			return c.json({
				status: sessionRecord.status,
				domain: sessionRecord.domain,
				pricing: sessionRecord.pricing,
				mailboxId: sessionRecord.mailboxId,
			});
		}

		return c.json({
			status: "pending",
			domain: targetDomain || "",
		});
	});

	/**
	 * Stripe Webhook: listens for checkout.session.completed and invoice.payment_succeeded events.
	 * Cryptographically verifies signatures, calls Cloudflare Registrar wholesale, provisions DNS, and creates primary mailbox.
	 */
	app.post("/api/v1/billing/stripe-webhook", async (c) => {
		const rawBody = await c.req.text();
		const sigHeader = c.req.header("stripe-signature") || "";
		const webhookSecret = configuredStripeWebhookSecret(c.env);

		// Fulfillment buys domains, so unsigned events are only accepted from the local
		// /checkout/mock simulator. A real secret is always enforced, dev included.
		if (webhookSecret) {
			const verifyRes = await verifyStripeWebhookSignature(rawBody, sigHeader, webhookSecret);
			if (!verifyRes.valid) {
				return c.json({ error: `Webhook verification failed: ${verifyRes.error}` }, 400);
			}
		} else if (!isDevRuntime()) {
			return c.json({ error: "Stripe webhook secret is not configured" }, 503);
		} else if (sigHeader) {
			// A signed delivery (e.g. `stripe listen`) can't be checked without the secret
			return c.json({ error: "Webhook verification failed: STRIPE_WEBHOOK_SECRET is not set" }, 400);
		}

		let event: any;
		try {
			event = JSON.parse(rawBody);
		} catch {
			return c.json({ error: "Invalid JSON payload" }, 400);
		}

		// Handle annual subscription renewal
		if (event.type === "invoice.payment_succeeded") {
			return c.json({ received: true, type: "invoice.payment_succeeded" });
		}

		if (event.type !== "checkout.session.completed") {
			return c.json({ received: true, ignored: true });
		}

		const session = event.data?.object;
		if (!session) {
			return c.json({ error: "Missing session object" }, 400);
		}

		const domain = (session.metadata?.domain || "").toLowerCase().trim();
		if (!domain) {
			return c.json({ error: "No domain metadata in checkout session" }, 400);
		}

		const username = (session.metadata?.username || "").toLowerCase().trim();
		const displayName = session.metadata?.displayName || username;
		const passwordHash = session.metadata?.passwordHash;
		const metadataOwnerUserId = session.metadata?.ownerUserId;
		const totalAnnualUsd = parseFloat(session.metadata?.totalAnnualUsd || "20.00");
		const domainFeeUsd = parseFloat(session.metadata?.domainFeeUsd || "10.44");
		const platformFeeUsd = parseFloat(session.metadata?.platformFeeUsd || "9.56");

		// 1. Check if domain was already provisioned
		let existing = await getDomainMetadata(c.env.BUCKET, domain);
		if (existing && existing.status === "active") {
			return c.json({ received: true, domain, status: "already_provisioned" });
		}

		// 2. Register domain via Cloudflare Registrar
		let registrationResult;
		try {
			registrationResult = await registerDomain(c.env, domain);
		} catch (regErr: unknown) {
			const msg = regErr instanceof Error ? regErr.message : "Registrar registration failed";
			return c.json({ error: `Registrar error: ${msg}` }, 502);
		}

		// 3. Provision Cloudflare Zone & Email Routing
		let zone;
		try {
			zone = await createZone(c.env, domain);
			await ensureFullEmailDns(c.env, zone.id, domain);
		} catch (cfErr: unknown) {
			const msg = cfErr instanceof Error ? cfErr.message : "Cloudflare setup failed";
			return c.json({ error: `Cloudflare setup failed: ${msg}` }, 502);
		}

		// 4. Provision primary admin user & mailbox if credentials provided
		let ownerUserId = metadataOwnerUserId || "registrar_owner";
		let primaryCanonical: string | undefined;

		if (username && passwordHash) {
			const fullEmail = `${username}@${domain}`;
			const canonical = canonicalMailboxId(fullEmail);
			if (canonical) {
				primaryCanonical = canonical;
				const existingUser = await findUserIdByLoginEmail(c.env.BUCKET, canonical);
				if (!existingUser) {
					ownerUserId = crypto.randomUUID();
					const user: PlatformUser = {
						id: ownerUserId,
						contactEmail: canonical,
						mailboxEmail: canonical,
						passwordHash,
						linkedSubs: [],
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					};
					await savePlatformUser(c.env.BUCKET, user);

					const principal = principalFromPlatformUser(user);
					const ensured = await ensurePrincipalAccount(c.env.BUCKET, principal);

					const metaKey = mailboxMetadataKey(canonical);
					const settings = {
						fromName: displayName || username,
						forwarding: { enabled: false, email: "" },
						signature: { enabled: false, text: "" },
						autoReply: { enabled: false, subject: "", message: "" },
						screener: { enabled: true },
						acl: aclFromOwnerKeys(ensured.ownerKeys),
					};
					await c.env.BUCKET.put(metaKey, JSON.stringify(settings));

					// Revive Durable Object stub
					const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(canonical));
					await stub.reviveMailbox();
					await stub.getFolders();
					await seedWelcomeEmailsForMailbox(c.env, canonical, canonical.split("@")[0]);
				}
			}
		}

		// 5. Persist Domain Metadata in R2
		const domainMetadata: DomainMetadata = {
			domain,
			zoneId: zone.id,
			ownerUserId,
			adminUserIds: [ownerUserId],
			status: "active",
			nameservers: zone.name_servers,
			emailRoutingEnabled: true,
			registration: {
				provider: "cloudflare_registrar",
				registeredAt: registrationResult.registeredAt,
				expiresAt: registrationResult.expiresAt,
				autoRenew: registrationResult.autoRenew,
				whoisPrivacy: registrationResult.whoisPrivacy,
				locked: registrationResult.locked,
				retailPriceUsd: totalAnnualUsd,
			},
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		await saveDomainMetadata(c.env.BUCKET, domainMetadata);

		// 6. Update session record in R2 if session ID is known
		if (session.id) {
			const sKey = billingSessionKey(session.id);
			const currentRec = await c.env.BUCKET.get(sKey);
			if (currentRec) {
				const rec = (await currentRec.json()) as BillingSessionRecord;
				rec.status = "ready";
				rec.mailboxId = primaryCanonical;
				rec.ownerUserId = ownerUserId;
				rec.updatedAt = new Date().toISOString();
				await c.env.BUCKET.put(sKey, JSON.stringify(rec));
			}
		}

		return c.json({
			received: true,
			domain,
			status: "provisioned",
			retailPriceUsd: totalAnnualUsd,
			zoneId: zone.id,
			pricing: {
				domainFeeUsd,
				platformFeeUsd,
				totalAnnualUsd,
			},
		});
	});
}
