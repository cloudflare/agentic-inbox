// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { importPKCS8, SignJWT } from "jose";
import type { Env } from "../types";

export interface APNsPayload {
	title: string;
	body: string;
	mailboxId: string;
	emailId: string;
	folderId?: string;
	badge?: number;
}

let cachedKey: CryptoKey | null = null;
let cachedKeyPem: string | null = null;
let cachedJwt: string | null = null;
let cachedJwtIssuedAt = 0;

/**
 * Parses and imports the APNs .p8 EC private key.
 */
async function getPrivateKey(pem: string): Promise<CryptoKey> {
	if (cachedKey && cachedKeyPem === pem) {
		return cachedKey;
	}

	let trimmed = pem.trim().replace(/\\n/g, "\n");
	const formattedPem = trimmed.includes("-----BEGIN")
		? trimmed
		: `-----BEGIN PRIVATE KEY-----\n${trimmed}\n-----END PRIVATE KEY-----`;

	cachedKey = (await importPKCS8(formattedPem, "ES256")) as CryptoKey;
	cachedKeyPem = pem;
	return cachedKey;
}

/**
 * Generates an APNs authentication token (valid for up to 50 minutes).
 */
async function getAPNsBearerToken(env: Env): Promise<string | null> {
	if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_PRIVATE_KEY) {
		return null;
	}

	const now = Math.floor(Date.now() / 1000);
	// Apple permits JWTs to be reused for up to 60 minutes; refresh every 45 minutes
	if (cachedJwt && now - cachedJwtIssuedAt < 45 * 60) {
		return cachedJwt;
	}

	try {
		const key = await getPrivateKey(env.APNS_PRIVATE_KEY);
		cachedJwt = await new SignJWT({})
			.setProtectedHeader({ alg: "ES256", kid: env.APNS_KEY_ID })
			.setIssuer(env.APNS_TEAM_ID)
			.setIssuedAt(now)
			.sign(key);
		cachedJwtIssuedAt = now;
		return cachedJwt;
	} catch (err) {
		console.error("[APNs] Failed to sign APNs JWT:", err);
		return null;
	}
}

/**
 * Dispatches an Apple Push Notification to one or more iOS device tokens.
 */
export async function sendAPNsPush(
	env: Env,
	deviceTokens: string[],
	payload: APNsPayload,
): Promise<{ successCount: number; failureCount: number; staleTokens: string[]; details: any[] }> {
	if (!deviceTokens || deviceTokens.length === 0) {
		return { successCount: 0, failureCount: 0, staleTokens: [], details: [] };
	}

	const jwt = await getAPNsBearerToken(env);
	if (!jwt) {
		console.warn(
			"[APNs] Push notification skipped: APNS_KEY_ID, APNS_TEAM_ID, or APNS_PRIVATE_KEY not configured.",
		);
		return { successCount: 0, failureCount: 0, staleTokens: [], details: [] };
	}

	const isExplicitProd = env.APNS_SANDBOX === "false";
	const primaryHost = isExplicitProd
		? "https://api.push.apple.com"
		: "https://api.sandbox.push.apple.com";
	const fallbackHost = (primaryHost === "https://api.sandbox.push.apple.com")
		? "https://api.push.apple.com"
		: "https://api.sandbox.push.apple.com";
	const topic = env.APNS_TOPIC || "co.inboxies.app";

	console.log(`[APNs] Dispatching push for mailbox "${payload.mailboxId}" to ${deviceTokens.length} device(s). Target: ${primaryHost}, topic: ${topic}`);

	const requestBody = JSON.stringify({
		aps: {
			alert: {
				title: payload.title,
				body: payload.body,
			},
			sound: "default",
			badge: payload.badge,
			"content-available": 1, // Wakes up app in background to pre-sync local SQLite
		},
		mailboxId: payload.mailboxId,
		emailId: payload.emailId,
		folderId: payload.folderId ?? "inbox",
	});

	let successCount = 0;
	let failureCount = 0;
	const staleTokens: string[] = [];
	const details: any[] = [];

	await Promise.all(
		deviceTokens.map(async (token) => {
			async function postToHost(h: string) {
				return fetch(`${h}/3/device/${token}`, {
					method: "POST",
					headers: {
						authorization: `bearer ${jwt}`,
						"apns-topic": topic,
						"apns-push-type": "alert",
						"apns-priority": "10",
						"content-type": "application/json",
					},
					body: requestBody,
				});
			}

			try {
				let usedHost = primaryHost;
				let response = await postToHost(usedHost);
				let respText = "";

				// If BadDeviceToken on sandbox/production, try the alternate server automatically
				if (!response.ok && response.status === 400) {
					respText = await response.text();
					if (respText.includes("BadDeviceToken") || respText.includes("TopicDisallowed")) {
						console.log(`[APNs] Primary server (${usedHost}) returned ${respText}. Attempting fallback (${fallbackHost})...`);
						const fallbackResponse = await postToHost(fallbackHost);
						if (fallbackResponse.ok) {
							response = fallbackResponse;
							usedHost = fallbackHost;
							respText = "";
						} else {
							respText = await fallbackResponse.text();
							usedHost = fallbackHost;
						}
					}
				} else if (!response.ok) {
					respText = await response.text();
				}

				if (response.ok) {
					successCount += 1;
					console.log(`[APNs] ✓ Successfully sent push to ${token.slice(0, 8)}... via ${usedHost}`);
					details.push({ token: token.slice(0, 8) + "...", status: 200, host: usedHost });
				} else {
					failureCount += 1;
					console.warn(
						`[APNs] ✗ Failed to send push to ${token.slice(0, 8)}... status=${response.status} body=${respText} host=${usedHost}`,
					);
					details.push({ token: token.slice(0, 8) + "...", status: response.status, body: respText, host: usedHost });
					if (
						response.status === 410 ||
						(response.status === 400 && respText.includes("BadDeviceToken"))
					) {
						staleTokens.push(token);
					}
				}
			} catch (err) {
				failureCount += 1;
				console.error(`[APNs] Network exception sending to ${token.slice(0, 8)}:`, err);
				details.push({ token: token.slice(0, 8) + "...", error: String(err) });
			}
		}),
	);

	return { successCount, failureCount, staleTokens, details };
}
