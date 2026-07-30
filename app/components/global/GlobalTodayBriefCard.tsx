import { Badge, Button, Loader } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, ArrowSquareOutIcon, LockSimpleIcon, SparkleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { GlobalTodayBriefCounts, GlobalTodayBriefResponse } from "../../../shared/global-today-brief.ts";

function countSummary(counts: GlobalTodayBriefCounts, mailboxCount: number) {
	return `${counts.privateRemindersDue} private follow-up${counts.privateRemindersDue === 1 ? "" : "s"} due · ${counts.unreadConversations} unread conversation${counts.unreadConversations === 1 ? "" : "s"} across ${mailboxCount} Mailbox${mailboxCount === 1 ? "" : "es"}`;
}

function preparedLabel(value: string) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

export default function GlobalTodayBriefCard({ brief, mailboxCount, isLoading, isRefreshing, error, isOnline, onRefresh, onRefreshOverview, onOpenSource }: {
	brief: GlobalTodayBriefResponse | undefined;
	mailboxCount: number;
	isLoading: boolean;
	isRefreshing: boolean;
	error: Error | null;
	isOnline: boolean;
	onRefresh(): void;
	onRefreshOverview(): void;
	onOpenSource(mailboxId: string, messageId: string): void;
}) {
	const preparedAt = brief && (brief.state === "generated" || brief.state === "cached") ? preparedLabel(brief.generatedAt) : null;
	const canRefresh = isOnline && !isLoading && !isRefreshing && !error && brief?.state !== "overview_incomplete" && brief?.state !== "preparing" && brief?.state !== "budget_paused";
	return (
		<section className="mb-8 overflow-hidden rounded-xl border border-kumo-line bg-kumo-base" aria-labelledby="global-today-ai-heading">
			<header className="grid gap-3 bg-kumo-recessed px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:px-5">
				<div className="flex min-w-0 items-start gap-3"><SparkleIcon size={19} weight="fill" className="mt-0.5 shrink-0 text-kumo-brand" aria-hidden="true" /><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 id="global-today-ai-heading" className="font-semibold text-kumo-default">AI focus brief</h2><Badge variant="outline">AI guidance</Badge><Badge variant="outline">Human review required</Badge></div><p className="mt-1 max-w-2xl text-sm leading-5 text-kumo-subtle">A cited, read-only view of what may deserve attention across your Mailboxes. Today below stays authoritative.</p></div></div>
				<div className="flex min-h-11 flex-wrap items-center gap-2 ps-8 sm:ps-0">{preparedAt && <span className="text-xs text-kumo-subtle">{brief?.state === "cached" ? "Cached ·" : "Prepared"} {preparedAt}</span>}{canRefresh && <Button type="button" variant="ghost" size="sm" className="min-h-11 w-full sm:w-auto" icon={<ArrowClockwiseIcon size={15} />} onClick={onRefresh}>Refresh brief</Button>}</div>
			</header>
			{!isOnline ? <State title="AI guidance is unavailable while you are offline." detail="The verified Today snapshot remains visible and will reauthorize when you reconnect." />
				: isLoading ? <div className="flex min-h-36 items-center gap-3 px-4 py-8 text-sm text-kumo-subtle sm:px-5" role="status"><Loader size="sm" /> <div><p className="font-medium text-kumo-default">Preparing a private brief across your Mailboxes…</p><p className="mt-1">Today remains fully available while AI guidance is prepared.</p></div></div>
				: error ? <State title="The AI focus brief could not be prepared." detail="Today remains fully available." role="alert" action={<Button className="mt-3 min-h-11 w-full sm:w-auto" variant="secondary" icon={<ArrowClockwiseIcon size={16} />} onClick={onRefresh} loading={isRefreshing}>Try again</Button>} />
				: brief?.state === "overview_incomplete" ? <State icon={<LockSimpleIcon size={18} />} title="AI guidance needs every Mailbox to be current." detail="Today is showing only verified mail below. Refresh the overview to try again." action={<Button className="mt-3 min-h-11 w-full sm:w-auto" variant="secondary" icon={<ArrowClockwiseIcon size={16} />} onClick={onRefreshOverview}>Refresh overview</Button>} />
				: brief?.state === "preparing" ? <State title="Your private brief is already being prepared." detail="Another open tab started the same brief. Today remains fully available, and this view will check again automatically." />
				: brief?.state === "stale" ? <State title="Mail changed after this brief was prepared." detail="Outdated guidance was not shown. Refresh the brief to prepare guidance from the current snapshot." action={<Button className="mt-3 min-h-11 w-full sm:w-auto" variant="secondary" icon={<ArrowClockwiseIcon size={16} />} onClick={onRefresh} loading={isRefreshing}>Refresh brief</Button>} />
				: brief?.state === "budget_paused" ? <State title="AI guidance is paused by the team’s budget controls." detail={`Today remains fully available. ${countSummary(brief.counts, mailboxCount)}.`} />
				: brief?.state === "no_attention" ? <State title="No additional focus items right now." detail={`${countSummary(brief.counts, mailboxCount)}. Attention now and Mailbox pulse below remain authoritative.`} />
				: brief?.state === "brief_unavailable" ? <State title="The AI focus brief could not be prepared." detail="Today remains fully available." role="alert" action={<Button className="mt-3 min-h-11 w-full sm:w-auto" variant="secondary" icon={<ArrowClockwiseIcon size={16} />} onClick={onRefresh} loading={isRefreshing}>Try again</Button>} />
				: brief && (brief.state === "generated" || brief.state === "cached") ? <div><div className="border-b border-kumo-line px-4 py-3 text-sm text-kumo-subtle sm:px-5">{countSummary(brief.counts, mailboxCount)}{brief.omittedCount > 0 ? ` · ${brief.omittedCount} lower-priority candidate${brief.omittedCount === 1 ? "" : "s"} omitted` : ""}</div><ol aria-label="AI focus items across Mailboxes">{brief.items.map((item, index) => <li key={item.candidate.candidateId} className="grid gap-4 border-t border-kumo-line px-4 py-5 first:border-t-0 sm:grid-cols-[2.25rem_minmax(0,1fr)] sm:px-5"><span className="hidden pt-0.5 text-sm font-semibold tabular-nums text-kumo-subtle sm:block" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><article className="min-w-0"><div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 break-all text-sm font-medium text-kumo-default">{item.candidate.mailboxAddress}</span><span className="text-xs text-kumo-subtle">{item.candidate.mailboxType === "PERSONAL" ? "Personal" : "Shared"}</span></div><h3 className="mt-2 min-w-0 break-words font-semibold text-kumo-default">{item.candidate.subject || "Conversation"}</h3><p className="mt-1 break-words text-sm text-kumo-subtle">{item.candidate.counterparty || "Unknown sender"}</p><div className="mt-4 grid gap-4 md:grid-cols-2 md:gap-6"><BriefText label="Why now" text={item.whyNow} /><BriefText label="Suggested next step" text={item.suggestedNextStep} /></div><div className="mt-4 flex min-w-0 flex-wrap items-center gap-1.5" aria-label={`Source evidence from ${item.candidate.mailboxAddress}`}><span className="me-1 text-xs font-medium text-kumo-subtle">Evidence</span>{item.sources.map((source, sourceIndex) => <Button key={`${source.mailboxId}:${source.messageId}`} type="button" variant="ghost" size="sm" className="min-h-11 max-w-full whitespace-normal break-all text-start" icon={<ArrowSquareOutIcon size={14} />} onClick={() => onOpenSource(source.mailboxId, source.messageId)} aria-label={`Open cited source ${sourceIndex + 1} in ${item.candidate.mailboxAddress} for ${item.candidate.subject || "conversation"}`}>Source {sourceIndex + 1} · {item.candidate.mailboxAddress}</Button>)}</div><p className="mt-2 text-xs font-medium text-kumo-subtle">Review before acting.</p></article></li>)}</ol></div>
				: null}
		</section>
	);
}

function State({ title, detail, action, icon, role = "status" }: { title: string; detail: string; action?: ReactNode; icon?: ReactNode; role?: "status" | "alert" }) {
	return <div className="flex items-start gap-3 px-4 py-6 sm:px-5" role={role}>{icon && <span className="mt-0.5 shrink-0 text-kumo-subtle">{icon}</span>}<div><p className="text-sm font-medium text-kumo-default">{title}</p><p className="mt-1 text-sm leading-5 text-kumo-subtle">{detail}</p>{action}</div></div>;
}

function BriefText({ label, text }: { label: string; text: string }) {
	return <div><p className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">{label}</p><p className="mt-1.5 text-sm leading-6 text-kumo-strong">{text}</p></div>;
}
