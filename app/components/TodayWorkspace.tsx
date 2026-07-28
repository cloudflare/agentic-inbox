import { Button, DropdownMenu, Loader } from "@cloudflare/kumo";
import {
	ArrowClockwiseIcon,
	ArrowSquareOutIcon,
	CalendarBlankIcon,
	CheckCircleIcon,
	CheckIcon,
	ClockIcon,
	LockSimpleIcon,
	SunHorizonIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useMemo } from "react";
import TodayBriefCard from "~/components/TodayBriefCard";
import type { TodayBriefResponse } from "~/services/today-brief";
import {
	groupFollowUpReminders,
	type FollowUpReminderView,
} from "../../shared/follow-up-reminders";
import {
	activeReminderCount,
	nextLocalMidnight,
	reminderAccessibleContext,
	reminderRescheduleTime,
} from "~/lib/today-workspace";

export type TodayReminderAction =
	| { action: "complete" | "dismiss"; reminder: FollowUpReminderView }
	| {
			action: "snooze";
			reminder: FollowUpReminderView;
			remindAt: string;
		};

export interface TodayMutationFeedback {
	kind: "pending" | "error" | "success";
	reminderId: string;
	message: string;
}

interface TodayWorkspaceProps {
	brief: TodayBriefResponse | undefined;
	briefIsLoading: boolean;
	briefError: Error | null;
	reminders: readonly FollowUpReminderView[];
	isLoading: boolean;
	error: Error | null;
	isMutating: boolean;
	mutationReminderId?: string | null;
	mutationFeedback?: TodayMutationFeedback | null;
	now?: Date;
	onOpenConversation(reminder: FollowUpReminderView): void;
	onOpenBriefSource(messageId: string): void;
	onAction(action: TodayReminderAction): void;
	onRetry(): void;
	onRetryBrief(): void;
	onDismissFeedback(): void;
}

function formatDueDate(value: string, group: "overdue" | "today" | "upcoming") {
	const date = new Date(value);
	if (group === "today") {
		return new Intl.DateTimeFormat(undefined, {
			hour: "numeric",
			minute: "2-digit",
		}).format(date);
	}
	return new Intl.DateTimeFormat(undefined, {
			weekday: "short",
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
	}).format(date);
}

function formatBaseline(value: string) {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: new Date(value).getFullYear() === new Date().getFullYear()
			? undefined
			: "numeric",
	}).format(new Date(value));
}

export function ReminderRow({
	reminder,
	group,
	mailboxContext,
	mutationsDisabled,
	isPendingOrigin,
	onOpenConversation,
	onAction,
}: {
	reminder: FollowUpReminderView;
	group: "overdue" | "today" | "upcoming";
	mailboxContext?: { address: string; type: "PERSONAL" | "SHARED" };
	mutationsDisabled: boolean;
	isPendingOrigin: boolean;
	onOpenConversation(reminder: FollowUpReminderView): void;
	onAction(action: TodayReminderAction): void;
}) {
	const subject = reminder.preview?.subject.trim() || "Conversation unavailable";
	const counterparty = reminder.preview?.counterparty.trim() || "Original message unavailable";
	const actionContext = reminderAccessibleContext(
		reminder,
		formatDueDate(reminder.remindAt, group),
	);
	return (
		<li className="group border-t border-kumo-line first:border-t-0">
			<div className="grid gap-3 px-1 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-5">
					<div className="min-w-0">
						{mailboxContext && (
							<div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-kumo-subtle">
								<span className="font-medium text-kumo-default">{mailboxContext.address}</span>
								<span>{mailboxContext.type === "PERSONAL" ? "Personal" : "Shared"}</span>
								<span className="inline-flex items-center gap-1"><LockSimpleIcon size={13} aria-hidden="true" /> Private to you</span>
							</div>
						)}
					<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
						<h3 className="truncate font-medium text-kumo-default" title={subject}>
							{subject}
						</h3>
						<time
							dateTime={reminder.remindAt}
							className={`text-xs font-medium ${
								group === "overdue" ? "text-kumo-danger" : "text-kumo-subtle"
							}`}
						>
							{group === "overdue" ? "Overdue · " : ""}
							{formatDueDate(reminder.remindAt, group)}
						</time>
					</div>
					<p className="mt-1 truncate text-sm text-kumo-subtle" title={counterparty}>
						{counterparty} · tracked {formatBaseline(reminder.baselineMessageDate)}
					</p>
				</div>

				<div className="flex flex-wrap items-center gap-1 sm:justify-end">
					<Button
						variant="ghost"
						size="sm"
						className="min-h-11"
						icon={<ArrowSquareOutIcon size={16} />}
						onClick={() => onOpenConversation(reminder)}
						disabled={mutationsDisabled}
						aria-label={`Open ${actionContext}`}
					>
						Open
					</Button>
					<Button
						variant="secondary"
						size="sm"
						className="min-h-11"
						icon={<CheckIcon size={16} />}
						onClick={() => onAction({ action: "complete", reminder })}
						disabled={mutationsDisabled}
						aria-label={`Complete follow-up for ${actionContext}`}
					>
						{isPendingOrigin ? "Updating…" : "Complete"}
					</Button>
					<DropdownMenu>
						<DropdownMenu.Trigger
							render={
								<Button
									variant="ghost"
									size="sm"
									className="min-h-11"
									icon={<ClockIcon size={16} />}
									disabled={mutationsDisabled}
									aria-label={`Remind later for ${actionContext}`}
								>
									Remind later
								</Button>
							}
						/>
						<DropdownMenu.Content>
							<DropdownMenu.Group>
								<DropdownMenu.Label>Reschedule reminder</DropdownMenu.Label>
								<DropdownMenu.Item
									icon={SunHorizonIcon}
									className="min-h-11"
									onClick={() =>
										onAction({
											action: "snooze",
											reminder,
											remindAt: reminderRescheduleTime("tomorrow").toISOString(),
										})
									}
								>
									Tomorrow at 9:00 AM
								</DropdownMenu.Item>
								<DropdownMenu.Item
									icon={CalendarBlankIcon}
									className="min-h-11"
									onClick={() =>
										onAction({
											action: "snooze",
											reminder,
											remindAt: reminderRescheduleTime("next_week").toISOString(),
										})
									}
								>
									Next Monday at 9:00 AM
								</DropdownMenu.Item>
							</DropdownMenu.Group>
						</DropdownMenu.Content>
					</DropdownMenu>
					<Button
						variant="ghost"
						size="sm"
						className="min-h-11"
						icon={<XIcon size={16} />}
						onClick={() => onAction({ action: "dismiss", reminder })}
						disabled={mutationsDisabled}
						aria-label={`Dismiss follow-up for ${actionContext}`}
					>
						Dismiss
					</Button>
				</div>
			</div>
		</li>
	);
}

function ReminderSection({
	id,
	title,
	description,
	reminders,
	group,
	isMutating,
	mutationReminderId,
	onOpenConversation,
	onAction,
}: {
	id: string;
	title: string;
	description: string;
	reminders: FollowUpReminderView[];
	group: "overdue" | "today" | "upcoming";
	isMutating: boolean;
	mutationReminderId?: string | null;
	onOpenConversation(reminder: FollowUpReminderView): void;
	onAction(action: TodayReminderAction): void;
}) {
	if (reminders.length === 0) return null;
	return (
		<section aria-labelledby={id} className="pt-8 first:pt-0">
			<div className="flex items-end justify-between gap-4 pb-3">
				<div>
					<h2 id={id} className="text-base font-semibold text-kumo-default">
						{title}
					</h2>
					<p className="mt-0.5 text-sm text-kumo-subtle">{description}</p>
				</div>
				<span className="shrink-0 text-sm tabular-nums text-kumo-subtle">
					{reminders.length}
				</span>
			</div>
			<ul aria-label={`${title} reminders`} className="border-y border-kumo-line">
				{reminders.map((reminder) => (
					<ReminderRow
						key={reminder.id}
						reminder={reminder}
						group={group}
						mutationsDisabled={isMutating}
						isPendingOrigin={isMutating && mutationReminderId === reminder.id}
						onOpenConversation={onOpenConversation}
						onAction={onAction}
					/>
				))}
			</ul>
		</section>
	);
}

export default function TodayWorkspace({
	brief,
	briefIsLoading,
	briefError,
	reminders,
	isLoading,
	error,
	isMutating,
	mutationReminderId,
	mutationFeedback,
	now = new Date(),
	onOpenConversation,
	onOpenBriefSource,
	onAction,
	onRetry,
	onRetryBrief,
	onDismissFeedback,
}: TodayWorkspaceProps) {
	const groups = useMemo(
		() =>
			groupFollowUpReminders(reminders, {
				now: now.toISOString(),
				tomorrowStart: nextLocalMidnight(now).toISOString(),
			}),
		[reminders, now],
	);
	const activeCount = activeReminderCount(reminders);
	const dueCount = groups.overdue.length + groups.today.length;

	return (
		<div className="h-full overflow-y-auto bg-kumo-base">
			<div className="mx-auto w-full max-w-5xl px-4 py-7 sm:px-7 sm:py-10 lg:px-10 lg:py-12">
				<header className="grid gap-6 border-b border-kumo-line pb-7 md:grid-cols-[minmax(0,1fr)_minmax(15rem,20rem)] md:items-end">
					<div>
						<div className="flex items-center gap-2 text-sm font-medium text-kumo-subtle">
							<SunHorizonIcon size={18} aria-hidden="true" />
							<span>Your daily workspace</span>
						</div>
						<h1 className="mt-3 text-3xl font-semibold tracking-tight text-kumo-default sm:text-4xl">
							Today
						</h1>
						<p className="mt-3 max-w-2xl text-base leading-7 text-kumo-strong">
							{dueCount > 0
								? `${dueCount} follow-up${dueCount === 1 ? "" : "s"} need your attention.`
								: "No personal follow-ups are due right now."}
						</p>
					</div>
					<div className="flex items-start gap-3 rounded-lg bg-kumo-recessed px-4 py-3.5">
						<LockSimpleIcon size={18} className="mt-0.5 shrink-0 text-kumo-subtle" aria-hidden="true" />
						<div>
							<p className="text-sm font-medium text-kumo-default">Private to you</p>
							<p className="mt-1 text-sm leading-5 text-kumo-subtle">
								Follow-ups are your personal reminder state, even in a shared mailbox. They never assign work to teammates.
							</p>
						</div>
					</div>
				</header>

				<main className="py-8 sm:py-10">
					{mutationFeedback && (
						<div
							role={mutationFeedback.kind === "error" ? "alert" : "status"}
							className={`mb-7 flex items-start gap-3 rounded-lg px-4 py-3.5 text-sm ${
								mutationFeedback.kind === "error"
									? "bg-kumo-danger/10 text-kumo-danger"
									: mutationFeedback.kind === "success"
										? "bg-kumo-success/10 text-kumo-strong"
										: "bg-kumo-recessed text-kumo-strong"
							}`}
						>
							{mutationFeedback.kind === "success" ? (
								<CheckCircleIcon size={18} className="mt-0.5 shrink-0 text-kumo-success" aria-hidden="true" />
							) : (
								<ClockIcon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
							)}
							<p className="min-w-0 flex-1 leading-5">{mutationFeedback.message}</p>
							{mutationFeedback.kind !== "pending" && (
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									className="min-h-11 min-w-11 shrink-0"
									icon={<XIcon size={16} />}
									aria-label="Dismiss reminder update"
									onClick={onDismissFeedback}
								/>
							)}
						</div>
					)}
					{!isLoading && !error && (
						<TodayBriefCard
							brief={brief}
							isLoading={briefIsLoading}
							error={briefError}
							onRetry={onRetryBrief}
							onOpenSource={onOpenBriefSource}
						/>
					)}
					{isLoading ? (
						<div role="status" className="flex min-h-72 flex-col items-center justify-center gap-3 text-center">
							<Loader size="lg" />
							<p className="text-sm text-kumo-subtle">Gathering your follow-ups…</p>
						</div>
					) : error ? (
						<div role="alert" className="mx-auto flex min-h-72 max-w-md flex-col items-center justify-center text-center">
							<ClockIcon size={38} weight="thin" className="text-kumo-subtle" aria-hidden="true" />
							<h2 className="mt-4 text-lg font-semibold text-kumo-default">Today could not be loaded</h2>
							<p className="mt-2 text-sm leading-6 text-kumo-subtle">
								Your reminders are still safe. Check your connection and try again.
							</p>
							<Button className="mt-5" variant="secondary" icon={<ArrowClockwiseIcon size={16} />} onClick={onRetry}>
								Try again
							</Button>
						</div>
					) : activeCount === 0 ? (
						<div className="mx-auto flex min-h-72 max-w-lg flex-col items-center justify-center text-center">
							<SunHorizonIcon size={48} weight="thin" className="text-kumo-subtle" aria-hidden="true" />
							<h2 className="mt-5 text-xl font-semibold text-kumo-default">No personal follow-ups</h2>
							<p className="mt-2 max-w-md text-sm leading-6 text-kumo-subtle">
								Follow-ups you create from conversations will appear here. Use them for the mail you want to return to, without creating team tasks or changing the mailbox.
							</p>
						</div>
					) : (
						<div aria-live="polite">
							<ReminderSection
								id="overdue-follow-ups"
								title="Overdue"
								description="Start here, then clear what no longer matters."
								reminders={groups.overdue}
								group="overdue"
								isMutating={isMutating}
								mutationReminderId={mutationReminderId}
								onOpenConversation={onOpenConversation}
								onAction={onAction}
							/>
							<ReminderSection
								id="today-follow-ups"
								title="Today"
								description="The conversations you chose to revisit today."
								reminders={groups.today}
								group="today"
								isMutating={isMutating}
								mutationReminderId={mutationReminderId}
								onOpenConversation={onOpenConversation}
								onAction={onAction}
							/>
							<ReminderSection
								id="upcoming-follow-ups"
								title="Upcoming"
								description="Later follow-ups, kept in chronological order."
								reminders={groups.upcoming}
								group="upcoming"
								isMutating={isMutating}
								mutationReminderId={mutationReminderId}
								onOpenConversation={onOpenConversation}
								onAction={onAction}
							/>
						</div>
					)}
				</main>
			</div>
		</div>
	);
}
