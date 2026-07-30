import type { FollowUpReminder } from "../../shared/follow-up-reminders.ts";
import { GLOBAL_TODAY_BRIEF_AI_CONFIG, type GlobalTodayBriefCounts } from "../../shared/global-today-brief.ts";
import { GLOBAL_TODAY_LIMITS } from "../../shared/global-today.ts";
import { buildAiCacheKey } from "./ai-cost-control.ts";
import { resolveAiCostControlConfig } from "./ai-cost-control.ts";
import { followUpReminderD1Store } from "./follow-up-reminders-d1.ts";
import {
	prepareGlobalTodayBriefCandidates,
	selectGlobalTodayBriefCandidates,
	type GlobalTodayBriefMailboxCandidateSource,
	type PreparedGlobalTodayBriefCandidates,
} from "./global-today-brief-candidates.ts";
import type { GlobalTodayBriefEvidenceRequest, GlobalTodayBriefMailboxEvidence, GlobalTodayBriefMailboxMetadata } from "./today-brief-candidates.ts";
import type { TodayBriefDayBoundary } from "./today-brief-timezone.ts";
import { mailboxAccess } from "./mailbox-access.ts";
import type { FollowUpReminderStoreCursor } from "./follow-up-reminders.ts";
import type { Env } from "../types.ts";

export type GlobalTodayBriefRosterMailbox = {
	mailboxId: string;
	address: string;
	type: "PERSONAL" | "SHARED";
};

export type GlobalTodayBriefFreshness = {
	roster: GlobalTodayBriefRosterMailbox[];
	reminders: Array<Pick<FollowUpReminder, "id" | "mailboxAddress" | "conversationKey" | "baselineMessageId" | "remindAt" | "state" | "version" | "updatedAt">>;
	sequences: Array<{ mailboxId: string; sequence: number }>;
};

export type GlobalTodayBriefFreshnessStatus = "current" | "changed" | "access_changed" | "unavailable";

export type GlobalTodayBriefSnapshot = {
	prepared: PreparedGlobalTodayBriefCandidates;
	fingerprint: string;
	cacheKey: string;
	freshness: GlobalTodayBriefFreshness;
	counts: GlobalTodayBriefCounts;
};

export type GlobalTodayBriefSnapshotResult =
	| { state: "ready"; snapshot: GlobalTodayBriefSnapshot }
	| { state: "access_changed" }
	| { state: "overview_incomplete" };

export type GlobalTodayBriefSnapshotDependencies = {
	model: string;
	listRoster(actorUserId: string): Promise<GlobalTodayBriefRosterMailbox[]>;
	listReminders(actorUserId: string, roster: readonly GlobalTodayBriefRosterMailbox[]): Promise<{ reminders: FollowUpReminder[]; overflow: boolean }>;
	canAccessMailbox(actorUserId: string, mailboxId: string): Promise<boolean>;
	readMetadata(input: {
		mailbox: GlobalTodayBriefRosterMailbox;
		reminders: FollowUpReminder[];
		boundaries: { now: string; tomorrowStart: string };
	}): Promise<GlobalTodayBriefMailboxMetadata>;
	readEvidence(input: {
		mailbox: GlobalTodayBriefRosterMailbox;
		requests: GlobalTodayBriefEvidenceRequest[];
	}): Promise<GlobalTodayBriefMailboxEvidence>;
	readSequence(mailbox: GlobalTodayBriefRosterMailbox): Promise<number>;
	now(): number;
	timeoutMs?: number;
};

class SnapshotTimeoutError extends Error {}

type ReadBudget = { unsettled: number };

async function withBudget<T>(
	budget: ReadBudget,
	timeoutMs: number,
	read: () => Promise<T>,
): Promise<T> {
	if (budget.unsettled >= GLOBAL_TODAY_LIMITS.concurrency) throw new SnapshotTimeoutError();
	budget.unsettled += 1;
	const work = read();
	void work.finally(() => { budget.unsettled -= 1; }).catch(() => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new SnapshotTimeoutError()), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function mapConcurrent<T, TResult>(
	items: readonly T[],
	worker: (item: T) => Promise<TResult>,
) {
	const results = new Array<TResult>(items.length);
	let next = 0;
	async function run() {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index]!);
		}
	}
	await Promise.all(Array.from({ length: Math.min(items.length, GLOBAL_TODAY_LIMITS.concurrency) }, run));
	return results;
}

function orderedRoster(roster: readonly GlobalTodayBriefRosterMailbox[]) {
	return [...roster].sort((left, right) =>
		(left.type === right.type ? 0 : left.type === "PERSONAL" ? -1 : 1) || left.address.localeCompare(right.address));
}

function rosterFingerprint(roster: readonly GlobalTodayBriefRosterMailbox[]) {
	return JSON.stringify(orderedRoster(roster));
}

function dueReminders(reminders: readonly FollowUpReminder[], endAt: string) {
	const end = Date.parse(endAt);
	return reminders.filter((reminder) => reminder.state === "active" && Date.parse(reminder.remindAt) < end)
		.sort((left, right) => Date.parse(left.remindAt) - Date.parse(right.remindAt) || left.mailboxAddress.localeCompare(right.mailboxAddress) || left.id.localeCompare(right.id));
}

function reminderFreshness(reminders: readonly FollowUpReminder[]) {
	return reminders.map(({ id, mailboxAddress, conversationKey, baselineMessageId, remindAt, state, version, updatedAt }) =>
		({ id, mailboxAddress, conversationKey, baselineMessageId, remindAt, state, version, updatedAt }));
}

async function fingerprint(input: unknown) {
	const bytes = new TextEncoder().encode(JSON.stringify(input));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readGlobalTodayBriefSnapshotAttempt(
	dependencies: GlobalTodayBriefSnapshotDependencies,
	input: { actorUserId: string; day: TodayBriefDayBoundary },
): Promise<GlobalTodayBriefSnapshotResult> {
	const roster = orderedRoster(await dependencies.listRoster(input.actorUserId));
	if (roster.length > GLOBAL_TODAY_LIMITS.mailboxes) return { state: "overview_incomplete" };
	const reminderResult = await dependencies.listReminders(input.actorUserId, roster);
	if (reminderResult.overflow) return { state: "overview_incomplete" };
	const reminders = dueReminders(reminderResult.reminders, input.day.endAt);
	const remindersByMailbox = new Map<string, FollowUpReminder[]>();
	for (const reminder of reminders) {
		const rows = remindersByMailbox.get(reminder.mailboxAddress) ?? [];
		rows.push(reminder);
		remindersByMailbox.set(reminder.mailboxAddress, rows);
	}
	const budget: ReadBudget = { unsettled: 0 };
	const timeoutMs = dependencies.timeoutMs ?? GLOBAL_TODAY_LIMITS.mailboxTimeoutMs;
	const now = new Date(dependencies.now()).toISOString();
	let accessChanged = false;
	const metadataOutcomes = await mapConcurrent(roster, async (mailbox) => {
		try {
			const metadata = await withBudget(budget, timeoutMs, () => dependencies.readMetadata({
				mailbox,
				reminders: remindersByMailbox.get(mailbox.address) ?? [],
				boundaries: { now, tomorrowStart: input.day.endAt },
			}));
			if (!(await dependencies.canAccessMailbox(input.actorUserId, mailbox.mailboxId))) {
				accessChanged = true;
				return null;
			}
			return { ...mailbox, metadata } satisfies GlobalTodayBriefMailboxCandidateSource;
		} catch {
			return null;
		}
	});
	if (accessChanged) return { state: "access_changed" };
	if (metadataOutcomes.some((outcome) => outcome === null)) return { state: "overview_incomplete" };
	const metadataSources = metadataOutcomes as GlobalTodayBriefMailboxCandidateSource[];
	const rosterAfterMetadata = orderedRoster(await dependencies.listRoster(input.actorUserId));
	if (rosterFingerprint(rosterAfterMetadata) !== rosterFingerprint(roster)) return { state: "access_changed" };
	const selected = selectGlobalTodayBriefCandidates(metadataSources);
	const selectedByMailbox = new Map<string, GlobalTodayBriefEvidenceRequest[]>();
	for (const item of selected) {
		const requests = selectedByMailbox.get(item.mailbox.mailboxId) ?? [];
		requests.push({ conversationKey: item.candidate.conversationKey, sourceEmailId: item.candidate.sourceEmailId });
		selectedByMailbox.set(item.mailbox.mailboxId, requests);
	}
	const evidenceMailboxes = roster.filter((mailbox) => selectedByMailbox.has(mailbox.mailboxId));
	const evidenceOutcomes = await mapConcurrent(evidenceMailboxes, async (mailbox) => {
		try {
			const evidence = await withBudget(budget, timeoutMs, () => dependencies.readEvidence({
				mailbox,
				requests: selectedByMailbox.get(mailbox.mailboxId)!,
			}));
			if (!(await dependencies.canAccessMailbox(input.actorUserId, mailbox.mailboxId))) {
				accessChanged = true;
				return null;
			}
			return { mailboxId: mailbox.mailboxId, evidence };
		} catch {
			return null;
		}
	});
	if (accessChanged) return { state: "access_changed" };
	if (evidenceOutcomes.some((outcome) => outcome === null)) return { state: "overview_incomplete" };
	const evidenceByMailbox = new Map(evidenceOutcomes.map((outcome) => [outcome!.mailboxId, outcome!.evidence]));
	let prepared: PreparedGlobalTodayBriefCandidates;
	try {
		prepared = prepareGlobalTodayBriefCandidates({
			localDate: input.day.localDate,
			timezone: input.day.timeZone,
			mailboxes: metadataSources,
			evidenceByMailbox,
		});
	} catch {
		return { state: "overview_incomplete" };
	}
	const rosterAfterEvidence = orderedRoster(await dependencies.listRoster(input.actorUserId));
	if (rosterFingerprint(rosterAfterEvidence) !== rosterFingerprint(roster)) return { state: "access_changed" };
	const reminderCheck = await dependencies.listReminders(input.actorUserId, rosterAfterEvidence);
	if (reminderCheck.overflow || JSON.stringify(reminderFreshness(dueReminders(reminderCheck.reminders, input.day.endAt))) !== JSON.stringify(reminderFreshness(reminders))) {
		return { state: "overview_incomplete" };
	}
	const freshness: GlobalTodayBriefFreshness = {
		roster,
		reminders: reminderFreshness(reminders),
		sequences: metadataSources.map((mailbox) => ({ mailboxId: mailbox.mailboxId, sequence: mailbox.metadata.sequence })),
	};
	const authorityHash = await fingerprint({
		actorUserId: input.actorUserId,
		day: input.day,
		freshness,
		model: dependencies.model,
		input: prepared.input,
		authority: prepared.authorityFingerprintInput,
	});
	const cacheKey = await buildAiCacheKey({
		feature: GLOBAL_TODAY_BRIEF_AI_CONFIG.feature,
		tier: GLOBAL_TODAY_BRIEF_AI_CONFIG.requestedTier,
		model: dependencies.model,
		promptVersion: GLOBAL_TODAY_BRIEF_AI_CONFIG.promptVersion,
		sourceVersion: GLOBAL_TODAY_BRIEF_AI_CONFIG.sourceVersion,
		input: { actorUserId: input.actorUserId, localDate: input.day.localDate, timezone: input.day.timeZone, authorityHash },
	});
	return {
		state: "ready",
		snapshot: {
			prepared,
			fingerprint: `gtbf:v1:${authorityHash}`,
			cacheKey,
			freshness,
			counts: prepared.counts,
		},
	};
}

export async function readGlobalTodayBriefSnapshot(
	dependencies: GlobalTodayBriefSnapshotDependencies,
	input: { actorUserId: string; day: TodayBriefDayBoundary },
): Promise<GlobalTodayBriefSnapshotResult> {
	try {
		return await readGlobalTodayBriefSnapshotAttempt(dependencies, input);
	} catch {
		return { state: "overview_incomplete" };
	}
}

async function globalTodayBriefFreshnessStatusAttempt(
	dependencies: GlobalTodayBriefSnapshotDependencies,
	input: { actorUserId: string; day: TodayBriefDayBoundary; expected: GlobalTodayBriefFreshness },
): Promise<GlobalTodayBriefFreshnessStatus> {
	const roster = orderedRoster(await dependencies.listRoster(input.actorUserId));
	if (rosterFingerprint(roster) !== rosterFingerprint(input.expected.roster)) return "access_changed";
	const reminderResult = await dependencies.listReminders(input.actorUserId, roster);
	if (reminderResult.overflow) return "unavailable";
	const reminders = reminderFreshness(dueReminders(reminderResult.reminders, input.day.endAt));
	if (JSON.stringify(reminders) !== JSON.stringify(input.expected.reminders)) return "changed";
	const budget: ReadBudget = { unsettled: 0 };
	const timeoutMs = dependencies.timeoutMs ?? GLOBAL_TODAY_LIMITS.mailboxTimeoutMs;
	const sequences = await mapConcurrent(roster, async (mailbox) => {
		try {
			const sequence = await withBudget(budget, timeoutMs, () => dependencies.readSequence(mailbox));
			if (!(await dependencies.canAccessMailbox(input.actorUserId, mailbox.mailboxId))) return { state: "access_changed" as const };
			return { state: "success" as const, mailboxId: mailbox.mailboxId, sequence };
		} catch {
			return { state: "unavailable" as const };
		}
	});
	if (sequences.some((sequence) => sequence.state === "access_changed")) return "access_changed";
	if (sequences.some((sequence) => sequence.state === "unavailable")) return "unavailable";
	const current = sequences.map((sequence) => sequence.state === "success"
		? { mailboxId: sequence.mailboxId, sequence: sequence.sequence }
		: null);
	return JSON.stringify(current) === JSON.stringify(input.expected.sequences) ? "current" : "changed";
}

export async function globalTodayBriefFreshnessStatus(
	dependencies: GlobalTodayBriefSnapshotDependencies,
	input: { actorUserId: string; day: TodayBriefDayBoundary; expected: GlobalTodayBriefFreshness },
): Promise<GlobalTodayBriefFreshnessStatus> {
	try {
		return await globalTodayBriefFreshnessStatusAttempt(dependencies, input);
	} catch {
		return "unavailable";
	}
}

export async function globalTodayBriefFreshnessMatches(
	dependencies: GlobalTodayBriefSnapshotDependencies,
	input: { actorUserId: string; day: TodayBriefDayBoundary; expected: GlobalTodayBriefFreshness },
) {
	return (await globalTodayBriefFreshnessStatus(dependencies, input)) === "current";
}

export function createGlobalTodayBriefSnapshotDependencies(env: Env): GlobalTodayBriefSnapshotDependencies {
	const access = mailboxAccess(env);
	const reminderStore = followUpReminderD1Store(env);
	const config = resolveAiCostControlConfig(env);
	return {
		// Must track the tier the brief actually runs on, or the cache key would
		// name a model that never produced the entry.
		model: config.strongModel,
		listRoster: async (actorUserId) => (await access.listAccessibleMailboxes(actorUserId)).map((row) => ({
			mailboxId: row.address,
			address: row.address,
			type: row.type,
		})),
		listReminders: async (actorUserId, roster) => {
			const reminders: FollowUpReminder[] = [];
			for (const mailbox of roster) {
				let cursor: FollowUpReminderStoreCursor | null = null;
				do {
					const page = await reminderStore.list({
						ownerUserId: actorUserId,
						mailboxAddress: mailbox.address,
						limit: GLOBAL_TODAY_LIMITS.reminderPageSize,
						cursor,
					});
					reminders.push(...page.reminders);
					if (reminders.length > GLOBAL_TODAY_LIMITS.reminders) {
						return { reminders, overflow: true };
					}
					cursor = page.nextCursor;
				} while (cursor);
			}
			return { reminders, overflow: false };
		},
		canAccessMailbox: (actorUserId, mailboxId) => access.canAccessMailbox(actorUserId, mailboxId),
		readMetadata: ({ mailbox, reminders, boundaries }) => {
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox.address));
			return stub.getGlobalTodayBriefMetadata(mailbox.address, reminders, boundaries);
		},
		readEvidence: ({ mailbox, requests }) => {
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox.address));
			return stub.getGlobalTodayBriefEvidence(requests);
		},
		readSequence: (mailbox) => {
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox.address));
			return stub.getGlobalTodayBriefSequence();
		},
		timeoutMs: GLOBAL_TODAY_LIMITS.mailboxTimeoutMs,
		now: Date.now,
	};
}
