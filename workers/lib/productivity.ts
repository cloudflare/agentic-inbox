// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export type ProductivityKind = "event" | "task" | "follow-up";

export interface Extraction {
	id: string;
	kind: ProductivityKind;
	title: string;
	dueAt: string | null;
	confidence: number;
	sourceEmailId: string;
	sourceThreadId: string | null;
	status: "suggested" | "committed" | "dismissed";
}

export interface BriefingItem {
	id: string;
	type: "email" | "event" | "task" | "follow-up";
	title: string;
	reason: string;
	priority: "high" | "medium" | "low";
	sourceId: string;
	sourceUrl: string;
	createdAt: string;
}

const DATE_PATTERNS = [
	/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/,
	/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/,
];

function parseDate(text: string): string | null {
	for (const pattern of DATE_PATTERNS) {
		const match = text.match(pattern);
		if (!match) continue;
		const parts = match.slice(1).map(Number);
		const [year, month, day] = parts[0] > 1000 ? parts : [parts[2], parts[1], parts[0]];
		const date = new Date(Date.UTC(year, month - 1, day, 9));
		if (!Number.isNaN(date.getTime())) return date.toISOString();
	}
	return null;
}

export function extractProductivityItems(email: {
	id: string;
	subject?: string | null;
	body?: string | null;
	thread_id?: string | null;
}): Extraction[] {
	const text = `${email.subject ?? ""}\n${email.body ?? ""}`.trim();
	if (!text) return [];
	const lower = text.toLowerCase();
	const dueAt = parseDate(text);
	const results: Extraction[] = [];

	if (/\b(meet|meeting|call|zoom|teams|calendar|会议|开会)\b/i.test(text)) {
		results.push({
			id: crypto.randomUUID(),
			kind: "event",
			title: email.subject?.trim() || "Meeting mentioned in email",
			dueAt,
			confidence: dueAt ? 0.86 : 0.62,
			sourceEmailId: email.id,
			sourceThreadId: email.thread_id ?? null,
			status: "suggested",
		});
	}

	if (/\b(due|deadline|todo|task|please send|请在|截止|待办)\b/i.test(text)) {
		results.push({
			id: crypto.randomUUID(),
			kind: "task",
			title: email.subject?.trim() || "Task mentioned in email",
			dueAt,
			confidence: dueAt ? 0.84 : 0.6,
			sourceEmailId: email.id,
			sourceThreadId: email.thread_id ?? null,
			status: "suggested",
		});
	}

	if (/\b(follow[ -]?up|remind|reply|respond|next step|跟进|回复)\b/i.test(lower)) {
		results.push({
			id: crypto.randomUUID(),
			kind: "follow-up",
			title: `Follow up: ${email.subject?.trim() || "email"}`,
			dueAt,
			confidence: 0.74,
			sourceEmailId: email.id,
			sourceThreadId: email.thread_id ?? null,
			status: "suggested",
		});
	}

	return results;
}

export function buildBriefing(items: Array<{
	id: string;
	type: "email" | "event" | "task" | "follow-up";
	title: string;
	date?: string | null;
	read?: boolean;
	threadId?: string | null;
	}>, now = new Date()): BriefingItem[] {
	return items
		.map((item) => {
			const age = item.date ? now.getTime() - new Date(item.date).getTime() : 0;
			const overdue = item.date ? age > 0 : false;
			const priority: BriefingItem["priority"] = item.type === "follow-up" || overdue || item.read === false ? "high" : item.type === "email" ? "medium" : "low";
			const reason = item.type === "follow-up"
				? "This conversation contains an explicit next step."
				: overdue ? "This item is past its due date."
				: item.read === false ? "This unread message may need your attention."
				: "This item is part of your current work context.";
			return {
				id: `briefing:${item.type}:${item.id}`,
				type: item.type,
				title: item.title || "Untitled item",
				reason,
				priority,
				sourceId: item.id,
				sourceUrl: item.type === "email" || item.type === "follow-up" ? `/mail/${item.id}` : `/${item.type}s/${item.id}`,
				createdAt: now.toISOString(),
			};
		})
		.sort((a, b) => rankPriority(a.priority) - rankPriority(b.priority));
}

function rankPriority(priority: BriefingItem["priority"]): number {
	return priority === "high" ? 0 : priority === "medium" ? 1 : 2;
}
