// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Folders } from "shared/folders";
import { useOutboundDeliveries } from "~/queries/emails";
import {
	canUndoSend,
	resolveSendOutcome,
	SEND_OUTCOME_WATCH_MS,
	sendOutcomeToast,
	sendPendingToast,
	type SendOutcome,
} from "~/lib/send-outcome";

interface SendWatch {
	toastId: string;
	deliveryId: string;
	emailId: string;
	startedAt: number;
	showsUndo: boolean;
}

export interface BeginSendWatchInput {
	deliveryId: string;
	/** The message the delivery will place in Sent; used to scope the poll. */
	emailId: string;
	scheduledFor?: string | null;
	/** Replay copy from the enqueue policy, when it supersedes "Sending…". */
	title?: string;
	canUndo: boolean;
	onUndo: () => void;
}

/**
 * Owns the whole send toast lifecycle: it opens one toast on acceptance and
 * resolves that same toast in place once the delivery reaches a terminal state,
 * so the outcome is visible from any folder rather than only the Outbox.
 */
export function useSendOutcomeToast(mailboxId: string | undefined) {
	const toastManager = useKumoToastManager();
	const navigate = useNavigate();
	const [watch, setWatch] = useState<SendWatch | null>(null);
	const { data: deliveries = [] } = useOutboundDeliveries(
		mailboxId,
		watch ? [watch.emailId] : [],
		Boolean(watch),
	);
	const watchedStatus = watch
		? deliveries.find((delivery) => delivery.id === watch.deliveryId)?.status
		: undefined;

	useEffect(() => {
		if (!watch) return;
		const outboxAction = {
			children: "Open Outbox",
			variant: "secondary" as const,
			size: "sm" as const,
			onClick: () =>
				navigate(`/mailbox/${mailboxId}/emails/${Folders.OUTBOX}`),
		};
		const settle = (outcome: SendOutcome) => {
			setWatch(null);
			if (outcome === "cancelled") {
				// The cancel mutation raises its own confirmation toast.
				toastManager.close(watch.toastId);
				return;
			}
			if (outcome === "pending") return;
			const copy = sendOutcomeToast(outcome);
			toastManager.update(watch.toastId, {
				title: copy.title,
				variant: copy.variant,
				timeout: copy.timeout,
				actions: copy.openOutbox ? [outboxAction] : undefined,
			});
		};

		const outcome = resolveSendOutcome({
			status: watchedStatus,
			elapsedMs: Date.now() - watch.startedAt,
		});
		if (outcome !== "pending") {
			settle(outcome);
			return;
		}
		// ponytail: the poll drives Undo removal, so the button can outlive its
		// window by up to one poll. Status is authoritative where a client-side
		// undoUntil timer would drift; the server rejects a late undo cleanly.
		if (watch.showsUndo && watchedStatus && !canUndoSend(watchedStatus)) {
			toastManager.update(watch.toastId, { actions: undefined });
			setWatch({ ...watch, showsUndo: false });
			return;
		}
		const timer = setTimeout(
			() => settle("timeout"),
			Math.max(0, watch.startedAt + SEND_OUTCOME_WATCH_MS - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [mailboxId, navigate, toastManager, watch, watchedStatus]);

	const beginSendWatch = ({
		deliveryId,
		emailId,
		scheduledFor,
		title,
		canUndo,
		onUndo,
	}: BeginSendWatchInput) => {
		const pending = sendPendingToast(scheduledFor ?? undefined);
		const undoAction = {
			children: "Undo",
			variant: "secondary" as const,
			size: "sm" as const,
			onClick: onUndo,
		};
		const toastId = toastManager.add({
			title: title ?? pending.title,
			timeout: pending.timeout,
			actions: canUndo ? [undoAction] : undefined,
		});
		// A scheduled send is settled at acceptance; there is nothing to watch yet.
		if (scheduledFor) return;
		setWatch({
			toastId,
			deliveryId,
			emailId,
			startedAt: Date.now(),
			showsUndo: canUndo,
		});
	};

	return { beginSendWatch };
}
