import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./EmailPanel.tsx", import.meta.url), "utf8");

test("Send Draft shares the authoritative enqueue policy and renews definitive terminal revisions once", () => {
	assert.match(panel, /useSaveDraft/);
	assert.match(panel, /planComposeEnqueueResult/);
	assert.match(
		panel,
		/let enqueuePlan = planComposeEnqueueResult\(result\)[\s\S]*?enqueuePlan\.action === "renew_revision_and_resend"/,
	);
	assert.match(
		panel,
		/saveDraftMut\.mutateAsync\([\s\S]*?draft_id: target\.id[\s\S]*?draft_version: target\.draft_version[\s\S]*?attachments: attachmentPolicy\.refs[\s\S]*?draftSendIdentityRef\.current\.reset\(\)[\s\S]*?enqueueDraft\(target\)/,
	);
});

test("Send Draft keeps blocked terminal outcomes open and only exposes policy-approved Undo", () => {
	assert.match(
		panel,
		/enqueuePlan\.action !== "finish"[\s\S]*?variant: "error"[\s\S]*?return;[\s\S]*?enqueuePlan\.title/,
	);
	assert.match(panel, /canUndo: enqueuePlan\.canUndo/);
	assert.match(
		panel,
		/trackSend\(\{[\s\S]*?deliveryId: result\.deliveryId[\s\S]*?emailId: result\.id[\s\S]*?mailboxId,/,
		"the draft-send path must hand the send to the mailbox-level watcher",
	);
	assert.doesNotMatch(
		panel,
		/useCancelOutboundDelivery/,
		"this panel closes on send, so it must not own the undo callbacks",
	);
	assert.match(
		panel,
		/enqueuePlan\.action !== "finish"[\s\S]*?return;[\s\S]*?if \(isDraftFolder\) closePanel\(\)/,
	);
});
