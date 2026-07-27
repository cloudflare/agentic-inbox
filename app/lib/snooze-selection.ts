import { Folders } from "../../shared/folders.ts";
import type { SnoozeScope } from "../../shared/snooze.ts";

/**
 * Snoozing only makes sense for mail that is waiting on the user. Sent, draft,
 * outbound, discarded, and already-snoozed mail is excluded, as are the
 * synthetic "_" views that are not folders at all.
 */
export function canSnoozeFromFolder(folderId: string | undefined): boolean {
	return Boolean(
		folderId &&
			!folderId.startsWith("_") &&
			!new Set<string>([
				Folders.SNOOZED,
				Folders.SENT,
				Folders.DRAFT,
				Folders.OUTBOX,
				Folders.TRASH,
				Folders.SPAM,
			]).has(folderId),
	);
}

export interface SnoozeSelectableRow {
	id: string;
	conversation_id?: string | null;
	thread_id?: string | null;
}

export function snoozeScopeAffectsRow(
	scope: SnoozeScope,
	row: SnoozeSelectableRow,
): boolean {
	if (row.id === scope.emailId) return true;
	if (scope.kind === "message") return false;
	return (row.conversation_id ?? row.thread_id) === scope.conversationId;
}

export interface SnoozedSelectionTracker {
	contextKey: string;
	selectedId: string;
	wasVisible: boolean;
}

export interface SnoozedSelectionSnapshot {
	contextKey: string;
	folderId: string | undefined;
	selectedId: string | null;
	visibleIds: readonly string[];
	isFetching: boolean;
	hasResolvedData: boolean;
}

export function reconcileSnoozedSelection(
	tracker: SnoozedSelectionTracker | null,
	snapshot: SnoozedSelectionSnapshot,
): { tracker: SnoozedSelectionTracker | null; shouldClose: boolean } {
	if (snapshot.folderId !== "snoozed" || !snapshot.selectedId) {
		return { tracker: null, shouldClose: false };
	}
	const isVisible = snapshot.visibleIds.includes(snapshot.selectedId);
	const sameSelection =
		tracker?.contextKey === snapshot.contextKey &&
		tracker.selectedId === snapshot.selectedId;
	if (!sameSelection) {
		return {
			tracker: {
				contextKey: snapshot.contextKey,
				selectedId: snapshot.selectedId,
				wasVisible:
					snapshot.hasResolvedData && !snapshot.isFetching && isVisible,
			},
			shouldClose: false,
		};
	}
	if (snapshot.isFetching || !snapshot.hasResolvedData) {
		return { tracker, shouldClose: false };
	}
	if (tracker.wasVisible && !isVisible) {
		return { tracker: null, shouldClose: true };
	}
	return {
		tracker: { ...tracker, wasVisible: tracker.wasVisible || isVisible },
		shouldClose: false,
	};
}
