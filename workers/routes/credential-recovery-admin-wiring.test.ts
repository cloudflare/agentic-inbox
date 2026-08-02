import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("admin setup issuance uses the encrypted outbox and canonical brand origin", () => {
  const admin = readFileSync(new URL("./admin.ts", import.meta.url), "utf8");
  const runtime = readFileSync(
    new URL("../lib/credential-recovery-runtime.ts", import.meta.url),
    "utf8",
  );

  assert.match(admin, /credentialRecoveryWorkflow\(c\.env\)\.issue\(/);
  assert.match(admin, /origin: resolveBrand\(c\.env\.BRAND\)\.mailOrigin/);
  assert.match(admin, /const maintenance = drainCredentialRecoveryDeliveries\(c\.env\)/);
  assert.match(admin, /waitUntil\(maintenance\)/);
  assert.doesNotMatch(runtime, /sendEmailWithOutcome|prepareSesSend|fetch\(/);
});

test("admin user creation separates a broken directory from an uncovered address", () => {
  const admin = readFileSync(new URL("./admin.ts", import.meta.url), "utf8");

  assert.match(
    admin,
    /error instanceof RecoveryDirectoryError\s*&&\s*error\.code === "INVALID_CONFIG"/,
  );
  assert.match(admin, /The platform recovery directory is misconfigured\./);
  assert.match(
    admin,
    /The platform recovery directory does not cover this portal email\./,
  );
  assert.doesNotMatch(admin, /has no valid entry for this account/);
});
