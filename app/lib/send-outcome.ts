// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { OutboundDeliveryStatus } from "~/types";
import { formatScheduledTime } from "./send-later.ts";

/**
 * A dispatch runs once the undo window closes, so a truthful outcome normally
 * lands within seconds. Past this cap we stop the dedicated poll and hand the
 * user to the Outbox rather than claim an outcome we do not have.
 */
export const SEND_OUTCOME_WATCH_MS = 90_000;
export const SEND_OUTCOME_POLL_MS = 2_000;

export type SendOutcome =
	| "pending"
	| "sent"
	| "failed"
	| "unclear"
	| "cancelled"
	| "timeout";

export type ResolvedSendOutcome = Exclude<SendOutcome, "pending" | "cancelled">;

export interface SendToastCopy {
	title: string;
	variant?: "error";
	/** A zero timeout keeps the toast up until the user dismisses it. */
	timeout: number;
	/** Whether the toast should offer the Outbox as the recovery route. */
	openOutbox: boolean;
}

export function resolveSendOutcome({
	status,
	elapsedMs,
}: {
	status: OutboundDeliveryStatus | undefined;
	elapsedMs: number;
}): SendOutcome {
	switch (status) {
		case "sent":
			return "sent";
		case "failed":
		case "bounced":
			return "failed";
		case "unknown":
			return "unclear";
		case "cancelled":
			return "cancelled";
		default:
			return elapsedMs >= SEND_OUTCOME_WATCH_MS ? "timeout" : "pending";
	}
}

/** Undo is only honoured while the delivery has not been handed to the provider. */
export function canUndoSend(status: OutboundDeliveryStatus | undefined): boolean {
	return status === "queued" || status === "retrying";
}

export function deliveryNeedsAttention(
	status: OutboundDeliveryStatus,
): boolean {
	return status === "failed" || status === "bounced" || status === "unknown";
}

export function countDeliveriesNeedingAttention(
	deliveries: ReadonlyArray<{ status: OutboundDeliveryStatus }>,
): number {
	return deliveries.filter((delivery) => deliveryNeedsAttention(delivery.status))
		.length;
}

export function sendPendingToast(scheduledFor?: string): SendToastCopy {
	return scheduledFor
		? {
				title: `Scheduled for ${formatScheduledTime(new Date(scheduledFor))}`,
				timeout: 15_000,
				openOutbox: false,
			}
		: { title: "Sending…", timeout: 0, openOutbox: false };
}

export function sendOutcomeToast(outcome: ResolvedSendOutcome): SendToastCopy {
	switch (outcome) {
		case "sent":
			return { title: "Sent", timeout: 4_000, openOutbox: false };
		case "failed":
			return {
				title: "Couldn't send — open Outbox",
				variant: "error",
				timeout: 0,
				openOutbox: true,
			};
		case "unclear":
			return {
				title: "Send status unclear — open Outbox",
				variant: "error",
				timeout: 0,
				openOutbox: true,
			};
		case "timeout":
			return {
				title: "Still sending — check Outbox",
				timeout: 8_000,
				openOutbox: true,
			};
	}
}
