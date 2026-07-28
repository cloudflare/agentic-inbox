import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const section = readFileSync(
	new URL("../PushNotificationsSection.tsx", import.meta.url),
	"utf8",
);
const settings = readFileSync(
	new URL("../../../../routes/settings.tsx", import.meta.url),
	"utf8",
);
const mailboxRoute = readFileSync(
	new URL("../../../../routes/mailbox.tsx", import.meta.url),
	"utf8",
);
const pushHook = readFileSync(
	new URL("../../../../hooks/pwa/usePushSubscription.ts", import.meta.url),
	"utf8",
);
const service = readFileSync(
	new URL("../../../../services/push-health.ts", import.meta.url),
	"utf8",
);

test("Settings makes push acceptance and lock-screen privacy boundaries visible", () => {
	assert.match(section, /Push notifications are best effort/);
	assert.match(section, /does not confirm that your device or operating system/);
	assert.match(section, /Your Inbox is the source of truth/);
	assert.match(section, /short preview on your lock screen/);
	assert.doesNotMatch(section, /Last active/);
});

test("push health uses the shared parser and renders semantic accessible status", () => {
	assert.match(service, /validatePushHealthResponse/);
	assert.match(section, /<ul aria-label="Your notification devices"/);
	assert.match(section, /<time dateTime=/);
	assert.match(section, /aria-live="polite"/);
	assert.match(section, /role="alert"/);
	assert.match(section, /min-h-11/);
});

test("Settings hides its complete surface before revoked-Mailbox exit", () => {
	assert.match(settings, /const \[revokedByFeature, setRevokedByFeature\] = useState\(false\)/);
	assert.match(settings, /setRevokedByFeature\(true\)/);
	assert.match(settings, /if \(revokedByFeature\)/);
	assert.match(settings, /Mailbox access changed\. Returning to Mailboxes/);
	assert.match(settings, /exitRevokedMailbox\(/);
	assert.match(settings, /onAccessRevoked=\{exitForRevokedAccess\}/);
});

test("background push rebind immediately suppresses a revoked Mailbox", () => {
	assert.match(pushHook, /error instanceof ApiError && error\.status === 403/);
	assert.match(pushHook, /onAccessRevoked\?\.\(mailboxId\)/);
	assert.match(mailboxRoute, /useRebindExistingPushSubscription\(mailboxId, exitForRevokedAccess\)/);
	assert.match(mailboxRoute, /setRevokedByFeature\(true\)/);
	assert.match(mailboxRoute, /Mailbox access changed\. Returning to your mailboxes/);
	assert.match(mailboxRoute, /exitRevokedMailbox\(/);
});

test("the Enable action is never gated on a permission read", () => {
	// iOS reports Notification.permission as "denied" for a Home Screen web app it
	// has never prompted for. Reading it here hid the Enable button, which made the
	// repo's only requestPermission() call site unreachable, so iOS was never asked
	// and the card stayed blocked for good. Nothing may gate the action on that read.
	assert.doesNotMatch(section, /Notification\.permission/);
	assert.match(section, /attemptDenied: permissionRefused/);
	// Blocked renders the warning beside the button, never instead of it.
	assert.match(section, /setupState === "blocked" \? \(/);
	// The refusal signal comes from subscribe() rejecting, not from a permission read.
	assert.match(pushHook, /isPermissionDenied\(err\)\) return "denied"/);
	assert.doesNotMatch(pushHook, /permission !== "granted"/);
});

test("notification controls refresh or rebind current state but never replay old mail", () => {
	assert.match(section, /Refresh status/);
	assert.match(section, /Enable on this device/);
	assert.doesNotMatch(section, /Repair on this device/);
	assert.doesNotMatch(section, /Retry notification/);
	assert.doesNotMatch(section, /Send test notification/);
});
