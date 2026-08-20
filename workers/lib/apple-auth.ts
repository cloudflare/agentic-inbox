// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	createRemoteJWKSet,
	jwtVerify,
	SignJWT,
	type JWTPayload,
} from "jose";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS = createRemoteJWKSet(
	new URL("https://appleid.apple.com/auth/keys"),
);

const MOBILE_TOKEN_ISSUER = "agentic-inbox";
const MOBILE_TOKEN_AUDIENCE = "agentic-inbox-ios";
const MOBILE_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface AppleIdentityClaims {
	sub: string;
	email?: string;
}

export interface MobileSessionClaims extends JWTPayload {
	sub: string;
	email?: string;
	auth: "apple" | "dev";
}

/**
 * Verify a Sign in with Apple identity token (JWT from ASAuthorizationAppleIDCredential).
 * `audience` must be the iOS app's bundle ID (APPLE_CLIENT_ID).
 */
export async function verifyAppleIdentityToken(
	identityToken: string,
	audience: string,
): Promise<AppleIdentityClaims> {
	const { payload } = await jwtVerify(identityToken, APPLE_JWKS, {
		issuer: APPLE_ISSUER,
		audience,
	});

	if (typeof payload.sub !== "string" || !payload.sub) {
		throw new Error("Apple identity token missing subject");
	}

	return {
		sub: payload.sub,
		email: typeof payload.email === "string" ? payload.email : undefined,
	};
}

export async function issueMobileSessionToken(
	secret: string,
	claims: { sub: string; email?: string; auth: "apple" | "dev" },
): Promise<{ token: string; expiresAt: string }> {
	const key = new TextEncoder().encode(secret);
	const expiresAtMs = Date.now() + MOBILE_TOKEN_TTL_SECONDS * 1000;

	const token = await new SignJWT({
		email: claims.email,
		auth: claims.auth,
	})
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(claims.sub)
		.setIssuer(MOBILE_TOKEN_ISSUER)
		.setAudience(MOBILE_TOKEN_AUDIENCE)
		.setIssuedAt()
		.setExpirationTime(Math.floor(expiresAtMs / 1000))
		.sign(key);

	return { token, expiresAt: new Date(expiresAtMs).toISOString() };
}

export async function verifyMobileSessionToken(
	token: string,
	secret: string,
): Promise<MobileSessionClaims> {
	const key = new TextEncoder().encode(secret);
	const { payload } = await jwtVerify(token, key, {
		issuer: MOBILE_TOKEN_ISSUER,
		audience: MOBILE_TOKEN_AUDIENCE,
	});

	if (typeof payload.sub !== "string" || !payload.sub) {
		throw new Error("Mobile session token missing subject");
	}

	const auth = payload.auth;
	if (auth !== "apple" && auth !== "dev") {
		throw new Error("Mobile session token missing auth claim");
	}

	return {
		...payload,
		sub: payload.sub,
		email: typeof payload.email === "string" ? payload.email : undefined,
		auth,
	};
}
