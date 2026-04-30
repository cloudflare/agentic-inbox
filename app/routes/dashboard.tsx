// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { WarningIcon } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo";
import { Link, useParams } from "react-router";
import Sparkline from "~/components/phishsoc/Sparkline";
import { useDashboardSummary } from "~/queries/dashboard";
import type { DashboardCase, DashboardSummary } from "~/types";

export default function DashboardRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data, isLoading, isError, refetch } = useDashboardSummary(mailboxId);

	return (
		<div className="px-6 md:px-10 py-8 max-w-[1280px] space-y-6">
			<DashboardHeader />

			{isLoading ? (
				<div className="flex justify-center py-20">
					<Loader size="lg" />
				</div>
			) : isError ? (
				<DashboardError onRetry={() => refetch()} />
			) : data ? (
				<DashboardBody mailboxId={mailboxId!} data={data} />
			) : null}
		</div>
	);
}

function DashboardHeader() {
	return (
		<div>
			<div className="text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-1">
				Operations · last 24 hours
			</div>
			<h1 className="pp-serif text-[40px] leading-none text-ink mb-2">
				Good morning.
			</h1>
			<p className="pp-serif text-[24px] leading-tight text-ink-3 max-w-2xl">
				Here's what changed overnight.
			</p>
		</div>
	);
}

function DashboardError({ onRetry }: { onRetry: () => void }) {
	return (
		<div className="pp-card p-6 flex items-start gap-3">
			<span className="flex h-8 w-8 items-center justify-center rounded-full bg-paper-2 text-ink-3 shrink-0">
				<WarningIcon size={18} />
			</span>
			<div>
				<div className="text-[14px] font-medium text-ink mb-1">
					Couldn't load the dashboard
				</div>
				<p className="text-[12.5px] text-ink-3 leading-relaxed mb-2">
					The dashboard endpoint didn't respond. Check the worker logs and retry.
				</p>
				<button
					type="button"
					onClick={onRetry}
					className="text-[12px] underline text-accent hover:opacity-80"
				>
					Retry
				</button>
			</div>
		</div>
	);
}

function DashboardBody({
	mailboxId,
	data,
}: { mailboxId: string; data: DashboardSummary }) {
	return (
		<>
			<KpiGrid data={data} />

			<div className="grid gap-4 lg:grid-cols-3">
				<ThreatPressureCard values={data.threatPressure} />
				<RecentCasesCard mailboxId={mailboxId} cases={data.recentCases} />
			</div>
		</>
	);
}

interface Kpi {
	label: string;
	value: string;
}

function KpiGrid({ data }: { data: DashboardSummary }) {
	const kpis: Kpi[] = [
		{ label: "Threats blocked · 24h", value: String(data.threatsBlocked) },
		{ label: "Open cases", value: String(data.openCases) },
		{
			label: "Pipeline success · 24h",
			value:
				data.pipelineSuccess === null
					? "—"
					: `${Math.round(data.pipelineSuccess * 100)}%`,
		},
		{
			label: "Hub contributions · 24h",
			value: String(data.hubContributions),
		},
	];

	return (
		<div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
			{kpis.map((k) => (
				<div key={k.label} className="pp-card p-4">
					<div className="text-[10.5px] uppercase tracking-[0.06em] text-ink-3 mb-2">
						{k.label}
					</div>
					<div className="pp-serif text-[36px] leading-none text-ink">
						{k.value}
					</div>
				</div>
			))}
		</div>
	);
}

function ThreatPressureCard({ values }: { values: number[] }) {
	const total = values.reduce((a, b) => a + b, 0);
	return (
		<div className="pp-card p-5 lg:col-span-2 flex flex-col gap-3">
			<div className="flex items-baseline justify-between gap-3">
				<div className="text-[10.5px] uppercase tracking-[0.06em] text-ink-3">
					Threat pressure · 24h
				</div>
				<div className="text-[12px] text-ink-3">
					{total} actioned
				</div>
			</div>
			<Sparkline values={values} width={480} height={56} />
			<p className="text-[11.5px] text-ink-3">
				Per-2-hour count of emails the pipeline tagged, quarantined, or blocked.
			</p>
		</div>
	);
}

function RecentCasesCard({
	mailboxId,
	cases,
}: { mailboxId: string; cases: DashboardCase[] }) {
	return (
		<div className="pp-card p-5">
			<div className="text-[10.5px] uppercase tracking-[0.06em] text-ink-3 mb-3">
				Recent cases
			</div>
			{cases.length === 0 ? (
				<p className="text-[12.5px] text-ink-3">No cases yet.</p>
			) : (
				<ul className="space-y-2">
					{cases.map((c) => (
						<li key={c.id}>
							<Link
								to={`/mailbox/${mailboxId}/cases/${c.id}`}
								className="block group"
							>
								<div className="text-[13px] text-ink truncate group-hover:text-accent">
									{c.title}
								</div>
								<div className="text-[11px] text-ink-3">
									{c.status} · {formatRelative(c.updated_at)}
								</div>
							</Link>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function formatRelative(iso: string): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	const diffMs = Date.now() - t;
	const diffMin = Math.round(diffMs / 60_000);
	if (diffMin < 1) return "just now";
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHr = Math.round(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h ago`;
	const diffDay = Math.round(diffHr / 24);
	return `${diffDay}d ago`;
}
