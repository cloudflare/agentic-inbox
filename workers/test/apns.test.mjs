import assert from "node:assert";
import { generateKeyPair, exportPKCS8, jwtVerify, createRemoteJWKSet, exportJWK, importJWK } from "jose";

// Test APNs JWT generation logic using jose with ES256
async function testAPNsTokenGeneration() {
    console.log("Starting APNs JWT signing test...");

    // 1. Generate a test P-256 EC key pair (same as Apple's .p8)
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const pkcs8Pem = await exportPKCS8(privateKey);
    const publicJwk = await exportJWK(publicKey);

    assert(pkcs8Pem.includes("BEGIN PRIVATE KEY"), "Generated key must be valid PKCS#8 PEM");

    // 2. Simulate APNs token generation
    const keyId = "TESTKEY123";
    const teamId = "TEAMID1234";

    const { importPKCS8, SignJWT } = await import("jose");
    const importedKey = await importPKCS8(pkcs8Pem, "ES256");

    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: keyId })
        .setIssuer(teamId)
        .setIssuedAt(now)
        .sign(importedKey);

    assert(typeof jwt === "string" && jwt.split(".").length === 3, "JWT must be 3 dot-separated parts");

    // 3. Verify JWT with public key
    const verificationKey = await importJWK(publicJwk, "ES256");
    const { payload, protectedHeader } = await jwtVerify(jwt, verificationKey, {
        issuer: teamId,
    });

    assert.strictEqual(protectedHeader.alg, "ES256");
    assert.strictEqual(protectedHeader.kid, keyId);
    assert.strictEqual(payload.iss, teamId);
    assert(Math.abs(payload.iat - now) <= 1);

    console.log("✓ APNs ES256 JWT signing and verification PASSED!");
}

testAPNsTokenGeneration().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});
