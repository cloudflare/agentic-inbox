/**
 * Mobile JWT issue/verify round-trip (jose).
 * Run: node workers/test/mobile-auth.test.mjs
 */

import assert from "node:assert/strict";
import { SignJWT, jwtVerify } from "jose";

const MOBILE_TOKEN_ISSUER = "agentic-inbox";
const MOBILE_TOKEN_AUDIENCE = "agentic-inbox-ios";
const secret = new TextEncoder().encode("test-secret");

const token = await new SignJWT({ email: "a@b.com", auth: "dev" })
	.setProtectedHeader({ alg: "HS256" })
	.setSubject("dev:a@b.com")
	.setIssuer(MOBILE_TOKEN_ISSUER)
	.setAudience(MOBILE_TOKEN_AUDIENCE)
	.setIssuedAt()
	.setExpirationTime("1h")
	.sign(secret);

const { payload } = await jwtVerify(token, secret, {
	issuer: MOBILE_TOKEN_ISSUER,
	audience: MOBILE_TOKEN_AUDIENCE,
});

assert.equal(payload.sub, "dev:a@b.com");
assert.equal(payload.auth, "dev");
assert.equal(payload.email, "a@b.com");

console.log("mobile-auth jwt round-trip: ok");
