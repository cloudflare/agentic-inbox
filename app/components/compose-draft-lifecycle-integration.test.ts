import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relativePath: string) =>
	readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("composer autosave is serialized, debounced, version-aware, and flushed before send", () => {
	const form = read("../hooks/useComposeForm.ts");

	assert.match(form, /savePromiseRef/);
	assert.match(
		form,
		/window\.setTimeout\([\s\S]*?saveCurrentDraft[\s\S]*?1_200/,
	);
	assert.match(form, /draft_id: identity\?\.id/);
	assert.match(form, /draft_version: identity\?\.version/);
	assert.match(
		form,
		/const needsDraftFlush[\s\S]*?await saveCurrentDraft\(\)[\s\S]*?sendPayload/,
	);
	assert.match(form, /window\.addEventListener\("beforeunload"/);
});

test("close and discard remain explicit authoritative operations", () => {
	const form = read("../hooks/useComposeForm.ts");
	const compose = read("./ComposeEmail.tsx");

	assert.match(form, /const requestClose = useCallback/);
	assert.match(form, /discardDraftMutation\.mutateAsync/);
	assert.match(form, /composeMailboxIdRef/);
	assert.match(compose, />\s*Keep editing\s*</);
	assert.match(compose, />\s*Save and close\s*</);
	assert.match(compose, /"Discard draft"/);
	assert.match(compose, /"Discard changes"/);
	assert.doesNotMatch(
		compose,
		/onClick=\{\(\) => !isSending && closeCompose\(\)\}/,
	);
});

test("saving state is visible and mailbox navigation keeps the original draft scope", () => {
	const form = read("../hooks/useComposeForm.ts");
	const compose = read("./ComposeEmail.tsx");
	const store = read("../hooks/useUIStore.ts");

	assert.match(form, /"Saving…"/);
	assert.match(form, /"Save failed"/);
	assert.match(form, /"Saved"/);
	assert.match(compose, /draftStatusLabel/);
	assert.match(compose, /You changed mailboxes/);
	assert.match(store, /state\.isComposing[\s\S]*?selectedEmailId: null/);
});

test("SPA navigation and browser Back cannot unmount unconfirmed or saving work", () => {
	const compose = read("./ComposeEmail.tsx");
	const form = read("../hooks/useComposeForm.ts");

	assert.match(compose, /useBlocker\(isComposing && hasUnconfirmedWork\)/);
	assert.match(
		compose,
		/navigationBlocker\.state === "blocked"[\s\S]*?requestClose\(\(\) => navigationBlocker\.proceed\(\)\)/,
	);
	assert.match(compose, /navigationBlocker\.reset\(\)/);
	assert.match(
		form,
		/lifecycle\.phase === "saving"[\s\S]*?hasUnpersistedInitialDraft/,
	);
});

test("AI seeds flush before send and AI generation remains pinned to the origin mailbox", () => {
	const form = read("../hooks/useComposeForm.ts");
	const compose = read("./ComposeEmail.tsx");
	const assistant = read("./ComposeAiAssistant.tsx");

	assert.match(
		form,
		/hasUnpersistedInitialDraft && !draftIdentityRef\.current/,
	);
	assert.match(
		form,
		/draft_create_key: identity \? undefined : draftCreateKeyRef\.current/,
	);
	assert.match(compose, /originMailboxId=\{originMailboxId\}/);
	assert.match(assistant, /mailboxId: originMailboxId/);
});

test("revoked mailbox access offers an explicit local-only close without claiming server deletion", () => {
	const form = read("../hooks/useComposeForm.ts");
	const compose = read("./ComposeEmail.tsx");

	assert.match(form, /ApiError/);
	assert.match(form, /"access-revoked"/);
	assert.match(form, /The server draft was left unchanged/);
	assert.match(compose, /Discard local changes and close/);
});

test("runtime recovery restores dirty lifecycle and pins the snapshot origin mailbox", () => {
	const form = read("../hooks/useComposeForm.ts");
	const recovery = read("../lib/compose-recovery.ts");

	assert.match(form, /recoveryAtMountRef\.current\?\.mailboxId \?\? mailboxId/);
	assert.match(
		form,
		/restoredComposeLifecycle\(recoveryAtMountRef\.current\.lifecycle\)/,
	);
	// The snapshot carries the edit-aware lifecycle, and is written from a commit
	// rather than during render, so rendering the composer stays side-effect free.
	assert.match(
		form,
		/useEffect\(\(\) => \{[\s\S]*?writeComposeRecovery\(\{[\s\S]*?lifecycle: composeRecoveryLifecycleForRender\([\s\S]*?baseline !== null && baseline !== renderFingerprint/,
	);
	assert.doesNotMatch(form, /^\tif \([\s\S]*?writeComposeRecovery/m);
	assert.match(
		form,
		/lifecycle\.phase === "failed" && recoveryAutosaveNeededRef\.current/,
	);
	assert.match(recovery, /localRevision: Math\.max/);
	assert.match(
		recovery,
		/phase: lifecycle\.phase === "failed" \? "failed" : "pending"/,
	);
});

test("terminal delivery replay never closes as a fresh queue and safe resend renews the draft revision", () => {
	const form = read("../hooks/useComposeForm.ts");

	assert.match(form, /planComposeEnqueueResult\(result\)/);
	assert.match(
		form,
		/enqueuePlan\.action === "renew_revision_and_resend"[\s\S]*?saveCurrentDraft\(true\)[\s\S]*?enqueueConfirmedDraft/,
	);
	assert.match(
		form,
		/enqueuePlan\.action !== "finish"[\s\S]*?setError\(message\)[\s\S]*?return/,
	);
	assert.match(
		form,
		/trackSend\(\{[\s\S]*?deliveryId: result\.deliveryId[\s\S]*?emailId: result\.id[\s\S]*?mailboxId: composeMailboxId/,
		"an accepted send must outlive this composer, which finishClose unmounts on the next line",
	);
	assert.doesNotMatch(form, /Submitting email/);
});
