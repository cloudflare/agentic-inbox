import type { RecipientSuggestion } from "../../shared/recipient-suggestions.ts";

export type RecipientField = "to" | "cc" | "bcc";

export type RecipientFieldValues = Record<RecipientField, string>;

export type ActiveRecipientSegment = {
	start: number;
	end: number;
	raw: string;
	token: string;
};

export function activeRecipientSegment(
	value: string,
	cursor = value.length,
): ActiveRecipientSegment {
	const caret = Math.min(Math.max(cursor, 0), value.length);
	const priorComma = value.lastIndexOf(",", Math.max(0, caret - 1));
	const nextComma = value.indexOf(",", caret);
	const start = priorComma < 0 ? 0 : priorComma + 1;
	const end = nextComma < 0 ? value.length : nextComma;
	const raw = value.slice(start, end);
	return { start, end, raw, token: raw.trim().toLowerCase() };
}

export function replaceActiveRecipientSegment(
	value: string,
	cursor: number,
	replacement: string,
): string {
	const segment = activeRecipientSegment(value, cursor);
	const prefix = value.slice(0, segment.start);
	const suffix = value.slice(segment.end);
	const separator = prefix.length > 0 ? " " : "";
	return `${prefix}${separator}${replacement.trim()}${suffix}`;
}

export function replaceActiveRecipientSegmentWithCursor(
	value: string,
	cursor: number,
	replacement: string,
): { value: string; cursor: number } {
	const segment = activeRecipientSegment(value, cursor);
	const normalized = replacement.trim();
	const leadingSpace = segment.start > 0 ? 1 : 0;
	return {
		value: replaceActiveRecipientSegment(value, cursor, normalized),
		cursor: segment.start + leadingSpace + normalized.length,
	};
}

export function splitRecipientValues(value: string): string[] {
	return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

/** Compare addresses by the bare mailbox part, so `A Name <a@x>` equals `a@x`. */
export function normalizedAddress(value: string): string {
	const trimmed = value.trim();
	const bracketed = trimmed.match(/<([^<>]+)>\s*$/)?.[1];
	return (bracketed ?? trimmed).trim().toLowerCase();
}

function appendUniqueRecipient(
	addresses: string[],
	seen: Set<string>,
	address: string,
	mailboxAddress: string,
) {
	const trimmed = address.trim();
	if (!trimmed) return;
	const normalized = normalizedAddress(trimmed);
	if (!normalized || normalized === mailboxAddress || seen.has(normalized)) return;
	seen.add(normalized);
	addresses.push(trimmed);
}

export function replyAllRecipientFields(input: {
	sender: string;
	to: string;
	cc?: string | null;
	mailboxAddress: string;
}): { to: string; cc: string; showCcBcc: boolean } {
	const mailboxAddress = normalizedAddress(input.mailboxAddress);
	const toRecipients: string[] = [];
	const toSeen = new Set<string>();
	appendUniqueRecipient(
		toRecipients,
		toSeen,
		input.sender,
		mailboxAddress,
	);
	for (const recipient of splitRecipientValues(input.to)) {
		appendUniqueRecipient(toRecipients, toSeen, recipient, mailboxAddress);
	}

	const ccRecipients: string[] = [];
	const ccSeen = new Set<string>();
	for (const recipient of splitRecipientValues(input.cc ?? "")) {
		const normalized = normalizedAddress(recipient);
		if (
			!normalized ||
			normalized === mailboxAddress ||
			toSeen.has(normalized) ||
			ccSeen.has(normalized)
		) continue;
		ccSeen.add(normalized);
		ccRecipients.push(recipient);
	}

	return {
		to: toRecipients.join(", "),
		cc: ccRecipients.join(", "),
		showCcBcc: ccRecipients.length > 0,
	};
}

export function filterRecipientSuggestions(
	suggestions: readonly RecipientSuggestion[],
	input: RecipientFieldValues & {
		mailboxAddress: string;
	},
): RecipientSuggestion[] {
	const excluded = new Set<string>([normalizedAddress(input.mailboxAddress)]);
	for (const field of ["to", "cc", "bcc"] as const) {
		for (const address of splitRecipientValues(input[field])) {
			excluded.add(normalizedAddress(address));
		}
	}
	return suggestions.filter(({ address }) => !excluded.has(normalizedAddress(address)));
}

export type RecipientComboboxAction =
	| { kind: "move"; index: number }
	| { kind: "accept"; index: number }
	| { kind: "close" }
	| { kind: "ignored" };

export function applyRecipientComboboxKeyEvent(
	event: {
		key: string;
		preventDefault: () => void;
		stopPropagation: () => void;
	},
	currentIndex: number,
	optionCount: number,
	isOpen: boolean,
): RecipientComboboxAction {
	const action = nextRecipientComboboxAction(
		event.key,
		currentIndex,
		optionCount,
		isOpen,
	);
	if (action.kind === "close") {
		event.preventDefault();
		event.stopPropagation();
	} else if (action.kind === "move" ||
		(action.kind === "accept" && event.key !== "Tab")) {
		event.preventDefault();
	}
	return action;
}

export function nextRecipientComboboxAction(
	key: string,
	currentIndex: number,
	optionCount: number,
	isOpen = optionCount > 0,
): RecipientComboboxAction {
	if (key === "Escape") return isOpen ? { kind: "close" } : { kind: "ignored" };
	if (optionCount <= 0) return { kind: "ignored" };
	if (key === "ArrowDown") {
		return { kind: "move", index: (currentIndex + 1 + optionCount) % optionCount };
	}
	if (key === "ArrowUp") {
		return {
			kind: "move",
			index: currentIndex <= 0 ? optionCount - 1 : currentIndex - 1,
		};
	}
	if ((key === "Enter" || key === "Tab") && currentIndex >= 0) {
		return { kind: "accept", index: currentIndex };
	}
	return { kind: "ignored" };
}
