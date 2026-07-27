import type { ComposeAttachmentRecord } from "./compose-attachment-policy";
import {
	composeDraftIsDirty,
	composeDraftTransition,
	type ComposeDraftLifecycle,
} from "./compose-draft-lifecycle.ts";

export interface ComposeRecoverySnapshot {
	mailboxId: string;
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	body: string;
	identity: { id: string; version: number } | null;
	createKey: string;
	attachments: ComposeAttachmentRecord[];
	lifecycle: ComposeDraftLifecycle;
}

let recovery: ComposeRecoverySnapshot | null = null;

export function writeComposeRecovery(value: ComposeRecoverySnapshot): void {
	recovery = value;
}

export function readComposeRecovery(
	mailboxId: string | undefined,
): ComposeRecoverySnapshot | null {
	return mailboxId && recovery?.mailboxId === mailboxId ? recovery : null;
}

export function peekComposeRecovery(): ComposeRecoverySnapshot | null {
	return recovery;
}

export function restoredComposeLifecycle(
	lifecycle: ComposeDraftLifecycle,
): ComposeDraftLifecycle {
	const unconfirmed =
		lifecycle.phase !== "saved" ||
		lifecycle.localRevision !== lifecycle.savedRevision;
	if (!unconfirmed) {
		return { ...lifecycle, phase: "saved", activeSave: null, error: null };
	}
	return {
		localRevision: Math.max(
			lifecycle.localRevision,
			lifecycle.savedRevision + 1,
		),
		savedRevision: lifecycle.savedRevision,
		phase: lifecycle.phase === "failed" ? "failed" : "pending",
		activeSave: null,
		error: lifecycle.phase === "failed" ? lifecycle.error : null,
	};
}

export function composeRecoveryLifecycleForRender(
	lifecycle: ComposeDraftLifecycle,
	snapshotChanged: boolean,
): ComposeDraftLifecycle {
	return snapshotChanged
		? composeDraftTransition(lifecycle, { type: "edited" })
		: lifecycle;
}

export function hasComposeRecovery(): boolean {
	if (!recovery) return false;
	// Unsaved work is not the same as non-empty work. Clearing a persisted draft
	// down to nothing IS an edit, and autosave is debounced, so judging by
	// content alone replaced the composer and threw the deletion away. A pristine
	// composer starts "saved" with matching revisions, so this stays quiet until
	// the reader actually changes something.
	if (composeDraftIsDirty(recovery.lifecycle)) return true;
	return Boolean(
		recovery &&
			(recovery.to.trim() ||
				recovery.cc.trim() ||
				recovery.bcc.trim() ||
				recovery.subject.trim() ||
				recovery.body.trim() ||
				recovery.attachments.length > 0),
	);
}

export function clearComposeRecovery(): void {
	recovery = null;
}
