import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SignatureSettingsCard.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../../routes/settings.tsx", import.meta.url), "utf8");

test("signature card is discoverable, labeled, independently saved, and safely previewed", () => {
	assert.match(source, /Email signature/);
	assert.match(source, /type="checkbox"/);
	assert.match(source, /aria-label="Enable email signature"/);
	assert.match(source, /<textarea/);
	assert.match(source, /Signature text/);
	assert.match(source, /whitespace-pre-wrap/);
	assert.match(source, /Save signature/);
	assert.match(source, /role="alert"/);
	assert.match(source, /Signature saved/);
	assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});

test("Shared members get clear managed read-only copy and admin-only access does not require mailbox content", () => {
	assert.match(source, /managed for this shared mailbox/i);
	assert.match(source, /canManage/);
	assert.match(page, /SignatureSettingsCard/);
	assert.match(page, /mailboxId/);
	assert.doesNotMatch(source, /useMailbox\(/);
});

test("mailbox settings track dirty state and never lose in-progress edits", () => {
	// Save is only offered when there is something to save.
	assert.match(page, /disabled=\{!isDirty \|\| isSaving\}/);
	// A background refetch reseeds only a clean form, or a different mailbox.
	assert.match(
		page,
		/if \(seededMailboxRef\.current === mailbox\.id && isDirty\) return;/,
	);
	// Leaving with unsaved edits asks first, in-app and on unload.
	assert.match(page, /useBlocker\(isDirty && !revokedByFeature\)/);
	assert.match(
		page,
		/navigationBlocker\.state !== "blocked"[\s\S]*?window\.confirm\([\s\S]*?navigationBlocker\.proceed\(\)[\s\S]*?navigationBlocker\.reset\(\)/,
	);
	assert.match(page, /addEventListener\("beforeunload", warnBeforeUnload\)/);
});
