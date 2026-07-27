import type {
	OutboundDeliveryStatus,
	OutboundEnqueueResponse,
} from "../types";

export type ComposeEnqueuePlan =
	| { action: "finish"; title?: string; canUndo: boolean }
	| { action: "renew_revision_and_resend" }
	| { action: "block"; message: string };

const activeReplayTitles: Partial<Record<OutboundDeliveryStatus, string>> = {
	queued: "This email is already sending",
	sending: "This email is already sending",
	retrying: "This email is already retrying",
};

export function planComposeEnqueueResult(
	result: Pick<OutboundEnqueueResponse, "outcome" | "status">,
): ComposeEnqueuePlan {
	const canUndo = result.status === "queued" || result.status === "retrying";
	if (result.outcome === "enqueued") return { action: "finish", canUndo };
	if (result.outcome === "active_replay") {
		return {
			action: "finish",
			title: activeReplayTitles[result.status] ?? "Email is already active",
			canUndo,
		};
	}
	if (result.status === "cancelled" || result.status === "failed") {
		return { action: "renew_revision_and_resend" };
	}
	if (result.status === "unknown") {
		return {
			action: "block",
			message:
				"An earlier send has an unknown outcome. Review it in Outbox before explicitly retrying the duplicate risk.",
		};
	}
	if (result.status === "sent") {
		return {
			action: "block",
			message: "This draft revision was already sent. It was not sent again.",
		};
	}
	if (result.status === "bounced") {
		return {
			action: "block",
			message:
				"This draft revision already produced a bounced delivery. Review it before sending again.",
		};
	}
	return {
		action: "block",
		message: `This draft revision already has a ${result.status} delivery. It was not sent again.`,
	};
}
