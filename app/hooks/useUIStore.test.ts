import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { composeDraftLifecycle } from "../lib/compose-draft-lifecycle.ts";
import {
	clearComposeRecovery,
	hasComposeRecovery,
	writeComposeRecovery,
} from "../lib/compose-recovery.ts";
import { useUIStore } from "./useUIStore.ts";

function openComposerWithUnsavedWork(body: string) {
	useUIStore.setState({
		selectedEmailId: "email-1",
		isComposing: false,
		_previousEmailId: null,
		queuedCompose: null,
		composeOptions: { mode: "new", originalEmail: null },
	});
	useUIStore.getState().startCompose({ mode: "new", originalEmail: null });
	writeComposeRecovery({
		mailboxId: "mailbox-1",
		to: "",
		cc: "",
		bcc: "",
		subject: "",
		body,
		identity: null,
		createKey: "create-key",
		attachments: [],
		lifecycle: composeDraftLifecycle(),
	});
}

test("closing a message panel never silently closes an active composer", () => {
	useUIStore.setState({
		selectedEmailId: "email-1",
		isComposing: false,
		_previousEmailId: null,
		composeOptions: { mode: "new", originalEmail: null },
	});
	useUIStore.getState().startCompose();
	useUIStore.getState().closePanel();

	assert.equal(useUIStore.getState().isComposing, true);
	assert.equal(useUIStore.getState().selectedEmailId, null);
});

test("selecting another message never silently closes an active composer", () => {
	useUIStore.setState({
		selectedEmailId: null,
		isComposing: false,
		_previousEmailId: null,
		composeOptions: { mode: "new", originalEmail: null },
	});
	useUIStore.getState().startCompose();
	useUIStore.getState().selectEmail("email-2");

	assert.equal(useUIStore.getState().isComposing, true);
	assert.equal(useUIStore.getState().selectedEmailId, "email-2");
});

test("a new compose target never silently discards unsaved work", () => {
	clearComposeRecovery();
	openComposerWithUnsavedWork("<p>half-written thought</p>");

	useUIStore
		.getState()
		.startCompose({ mode: "reply", originalEmail: { id: "email-9" } as never });

	const state = useUIStore.getState();
	assert.equal(state.composeOptions.mode, "new");
	assert.deepEqual(state.queuedCompose?.mode, "reply");
	assert.equal(hasComposeRecovery(), true);
});

test("the queued compose target replaces the composer once it is released", () => {
	clearComposeRecovery();
	openComposerWithUnsavedWork("<p>half-written thought</p>");
	useUIStore
		.getState()
		.startCompose({ mode: "reply", originalEmail: { id: "email-9" } as never });

	useUIStore.getState().applyQueuedCompose();

	const state = useUIStore.getState();
	assert.equal(state.composeOptions.mode, "reply");
	assert.equal(state.composeOptions.originalEmail?.id, "email-9");
	assert.equal(state.queuedCompose, null);
	assert.equal(hasComposeRecovery(), false);
});

test("cancelling the queued target leaves the open composer untouched", () => {
	clearComposeRecovery();
	openComposerWithUnsavedWork("<p>half-written thought</p>");
	useUIStore
		.getState()
		.startCompose({ mode: "reply", originalEmail: { id: "email-9" } as never });

	useUIStore.getState().cancelQueuedCompose();

	const state = useUIStore.getState();
	assert.equal(state.composeOptions.mode, "new");
	assert.equal(state.queuedCompose, null);
	assert.equal(hasComposeRecovery(), true);
});

test("re-requesting the composer that is already open is ignored", () => {
	clearComposeRecovery();
	openComposerWithUnsavedWork("<p>half-written thought</p>");
	const optionsBefore = useUIStore.getState().composeOptions;

	useUIStore.getState().startCompose({ mode: "new", originalEmail: null });

	const state = useUIStore.getState();
	assert.equal(state.composeOptions, optionsBefore);
	assert.equal(state.queuedCompose, null);
	assert.equal(hasComposeRecovery(), true);
});

test("a clean composer hands over to the next target without a prompt", () => {
	clearComposeRecovery();
	useUIStore.setState({
		selectedEmailId: "email-1",
		isComposing: false,
		_previousEmailId: null,
		queuedCompose: null,
		composeOptions: { mode: "new", originalEmail: null },
	});
	useUIStore.getState().startCompose({ mode: "new", originalEmail: null });

	useUIStore
		.getState()
		.startCompose({ mode: "reply", originalEmail: { id: "email-9" } as never });

	const state = useUIStore.getState();
	assert.equal(state.composeOptions.mode, "reply");
	assert.equal(state.queuedCompose, null);
});

test("a second freshly drafted reply is offered, never swallowed as a repeat", () => {
	clearComposeRecovery();
	openComposerWithUnsavedWork("<p>first AI draft, since edited</p>");
	const seeded = {
		mode: "reply" as const,
		originalEmail: { id: "email-9" } as never,
		draftEmail: { id: "", body: "<p>second AI draft</p>" } as never,
	};
	useUIStore.getState().startCompose(seeded);

	// It must reach the discard prompt rather than being dropped on the floor.
	assert.equal(useUIStore.getState().queuedCompose, seeded);
});

test("persisted UI preferences are keyed to the portal, not to one brand", () => {
	const source = readFileSync(new URL("./useUIStore.ts", import.meta.url), "utf8");
	assert.match(source, /AGENT_PANEL_STORAGE_KEY = "mail-portal\.agent-panel-open"/);
	assert.doesNotMatch(source, /whispyr|wiser/i);
});
