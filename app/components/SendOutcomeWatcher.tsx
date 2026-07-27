// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Folders } from "shared/folders";
import { useCancelOutboundDelivery, useOutboundDeliveries } from "~/queries/emails";
import { useUIStore, type PendingSend } from "~/hooks/useUIStore";
import {
	canUndoSend,
	resolveSendOutcome,
	SEND_OUTCOME_WATCH_MS,
	sendOutcomeToast,
	sendPendingToast,
	type SendOutcome,
} from "~/lib/send-outcome";

/**
 * Watches every accepted send through to a truthful outcome.
 *
 * Mounted once at the app root, inside the toast and query providers it needs.
 * Nothing here is route-scoped - the in-flight sends live in the store and each
 * watch reads only `send.*` - and anywhere lower unmounts mid-send: the
 * composer closes on acceptance, and the mailbox route unmounts the moment the
 * reader steps out to /mailboxes. Either one strands the permanent "Sending…"
 * toast with no owner and raises a second one on the way back.
 */
export default function SendOutcomeWatcher() {
	const pendingSends = useUIStore((state) => state.pendingSends);
	return (
		<>
			{pendingSends.map((send) => (
				<SendWatch key={send.deliveryId} send={send} />
			))}
		</>
	);
}

function SendWatch({ send }: { send: PendingSend }) {
	const toastManager = useKumoToastManager();
	const navigate = useNavigate();
	const resolveSend = useUIStore((state) => state.resolveSend);
	const cancelOutbound = useCancelOutboundDelivery();
	// A scheduled send is already settled at acceptance; there is nothing to poll.
	const [settled, setSettled] = useState(Boolean(send.scheduledFor));
	const [showsUndo, setShowsUndo] = useState(send.canUndo);
	const toastIdRef = useRef<string | null>(null);
	const startedAtRef = useRef(Date.now());

	const { data: deliveries = [] } = useOutboundDeliveries(
		send.mailboxId,
		settled ? [] : [send.emailId],
		!settled,
	);
	const status = deliveries.find(
		(delivery) => delivery.id === send.deliveryId,
	)?.status;

	useEffect(() => {
		if (toastIdRef.current) return;
		const pending = sendPendingToast(send.scheduledFor);
		toastIdRef.current = toastManager.add({
			title: send.title ?? pending.title,
			timeout: pending.timeout,
			actions: send.canUndo
				? [
						{
							children: "Undo",
							variant: "secondary" as const,
							size: "sm" as const,
							onClick: () =>
								cancelOutbound.mutate(
									{
										mailboxId: send.mailboxId,
										deliveryId: send.deliveryId,
									},
									{
										onSuccess: () =>
											toastManager.add({ title: "Send cancelled" }),
										onError: (error) =>
											toastManager.add({
												title:
													error instanceof Error
														? error.message
														: "Could not cancel send",
												variant: "error",
											}),
									},
								),
						},
					]
				: undefined,
			// The watch outlives the composer but not its own toast: dismissing the
			// toast is what releases this watcher.
			onClose: () => resolveSend(send.deliveryId),
		});
	}, [cancelOutbound, resolveSend, send, toastManager]);

	useEffect(() => {
		const toastId = toastIdRef.current;
		if (settled || !toastId) return;
		const settle = (outcome: SendOutcome) => {
			setSettled(true);
			if (outcome === "cancelled") {
				// The cancel mutation raises its own confirmation toast.
				toastManager.close(toastId);
				return;
			}
			if (outcome === "pending") return;
			const copy = sendOutcomeToast(outcome);
			toastManager.update(toastId, {
				title: copy.title,
				variant: copy.variant,
				timeout: copy.timeout,
				actions: copy.openOutbox
					? [
							{
								children: "Open Outbox",
								variant: "secondary" as const,
								size: "sm" as const,
								onClick: () =>
									navigate(
										`/mailbox/${send.mailboxId}/emails/${Folders.OUTBOX}`,
									),
							},
						]
					: undefined,
			});
		};

		const outcome = resolveSendOutcome({
			status,
			elapsedMs: Date.now() - startedAtRef.current,
		});
		if (outcome !== "pending") {
			settle(outcome);
			return;
		}
		// ponytail: the poll drives Undo removal, so the button can outlive its
		// window by up to one poll. Status is authoritative where a client-side
		// undoUntil timer would drift; the server rejects a late undo cleanly.
		if (showsUndo && status && !canUndoSend(status)) {
			toastManager.update(toastId, { actions: undefined });
			setShowsUndo(false);
			return;
		}
		const timer = setTimeout(
			() => settle("timeout"),
			Math.max(0, startedAtRef.current + SEND_OUTCOME_WATCH_MS - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [navigate, send, settled, showsUndo, status, toastManager]);

	return null;
}
