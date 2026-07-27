import { useEffect, useState } from "react";
import { useKumoToastManager } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, XCircleIcon } from "@phosphor-icons/react";
import { outboundDeliveryAction } from "~/lib/outbound-delivery-actions";
import {
	useCancelOutboundDelivery,
	useRetryOutboundDelivery,
} from "~/queries/emails";
import type { OutboundDelivery } from "~/types";

interface OutboundDeliveryActionsProps {
	mailboxId: string;
	delivery: OutboundDelivery;
	compact?: boolean;
}

export default function OutboundDeliveryActions({
	mailboxId,
	delivery,
	compact = false,
}: OutboundDeliveryActionsProps) {
	const toastManager = useKumoToastManager();
	const cancelMutation = useCancelOutboundDelivery();
	const retryMutation = useRetryOutboundDelivery();
	const [actionError, setActionError] = useState<string | null>(null);
	const action = outboundDeliveryAction(
		delivery.status,
		delivery.cancelRecoveryPending,
		delivery.storageIntegrityCode,
		delivery.lastErrorCode,
	);
	const isPending = cancelMutation.isPending || retryMutation.isPending;

	useEffect(() => {
		setActionError(null);
	}, [delivery.id, delivery.status]);

	const performAction = () => {
		if (!action || isPending) return;
		setActionError(null);
		if (
			action.requiresDuplicateRiskConfirmation &&
			!window.confirm(
				"The provider may already have accepted this email. Retrying could send a duplicate. Retry anyway?",
			)
		) {
			return;
		}

		const onError = (error: unknown) => {
			const message =
				error instanceof Error ? error.message : "The delivery action failed.";
			setActionError(message);
			toastManager.add({ title: message, variant: "error" });
		};
		if (action.kind === "cancel") {
			cancelMutation.mutate(
				{ mailboxId, deliveryId: delivery.id },
				{
					onSuccess: (result) =>
						toastManager.add({
							title: result.retryCancellationRestored
								? "Retry cancelled; previous delivery state restored"
								: "Send cancelled",
						}),
					onError,
				},
			);
			return;
		}
		retryMutation.mutate(
			{
				mailboxId,
				deliveryId: delivery.id,
				acknowledgeDuplicateRisk:
					action.requiresDuplicateRiskConfirmation,
			},
			{
				onSuccess: () =>
					toastManager.add({ title: "Retrying send" }),
				onError,
			},
		);
	};

	const providerError =
		delivery.lastErrorMessage?.trim() || delivery.lastErrorCode?.trim();
	const compactActionLabel = action?.kind === "cancel"
		? "Cancel"
		: action?.requiresDuplicateRiskConfirmation
			? "Retry anyway"
			: "Retry";
	return (
		<div
			className={`flex min-w-0 ${compact ? "max-w-full flex-col items-end gap-1 sm:flex-row sm:items-center" : "items-center justify-between gap-3"}`}
			onClick={(event) => event.stopPropagation()}
			onKeyDown={(event) => event.stopPropagation()}
			aria-busy={isPending}
		>
			<span role="status" aria-live="polite" className="sr-only">
				Delivery state: {deliveryStateLabel(delivery)}
				{isPending ? `; ${action?.label ?? "Action"} in progress` : ""}
			</span>
			<div className={`min-w-0 ${compact ? "max-w-40" : "flex-1"}`}>
				<span className={compact ? "sr-only" : "text-sm font-medium text-kumo-default"}>
					Delivery state: {deliveryStateLabel(delivery)}
				</span>
				{providerError && (
					<p
						className={`${compact ? "sr-only sm:not-sr-only sm:block" : ""} truncate text-xs text-kumo-danger`}
						title={providerError}
					>
						{providerError}
					</p>
				)}
				{actionError && (
					<p role="alert" className="text-xs font-medium text-kumo-danger">
						{actionError}
					</p>
				)}
			</div>
			{action && (
				<button
					type="button"
					aria-label={action.label}
					onClick={performAction}
					disabled={isPending}
					className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md border border-kumo-line bg-kumo-elevated px-3 text-xs font-semibold text-kumo-default shadow-sm transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
				>
					{action.kind === "cancel" ? (
						<XCircleIcon size={15} />
					) : (
						<ArrowClockwiseIcon size={15} />
					)}
					{isPending
						? action.kind === "cancel"
							? "Cancelling…"
							: "Retrying…"
						: compact
							? compactActionLabel
							: action.label}
				</button>
			)}
		</div>
	);
}

function deliveryStateLabel(delivery: OutboundDelivery): string {
	if (delivery.status === "queued" && delivery.scheduledFor) return "Scheduled";
	return {
		queued: "Sending, cancellation available",
		sending: "Sending",
		retrying: "Automatic retry in progress",
		sent: "Sent",
		bounced: "Bounced",
		failed: "Failed",
		unknown: "Delivery uncertain",
		cancelled: "Cancelled",
	}[delivery.status];
}
