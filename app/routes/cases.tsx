// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { CaretRightIcon, PlusIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import VerdictPill from "~/components/phishsoc/VerdictPill";
import { statusLabel, statusTone } from "~/components/phishsoc/verdict";

interface CaseRow {
	id: string;
	created_at: string;
	updated_at: string;
	status: string;
	title: string;
	shared_to_hub: number;
}

const STATUS_TABS: Array<{ id: string; label: string }> = [
	{ id: "open", label: "Open" },
	{ id: "closed-tp", label: "True positive" },
	{ id: "closed-fp", label: "False positive" },
	{ id: "all", label: "All" },
];

function relativeAge(iso: string): string {
	const now = Date.now();
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "—";
	const ms = Math.max(0, now - then);
	const m = Math.floor(ms / 60_000);
	if (m < 1) return "now";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.floor(h / 24);
	return `${d}d`;
}

export default function CasesRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [cases, setCases] = useState<CaseRow[] | null>(null);
	const [tab, setTab] = useState<string>("open");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!mailboxId) return;
		setError(null);
		const q = tab === "all" ? "" : `?status=${tab}`;
		fetch(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/cases${q}`)
			.then((r) => {
				if (!r.ok) throw new Error(`${r.status}`);
				return r.json() as Promise<{ cases: CaseRow[] }>;
			})
			.then((r) => setCases(r.cases))
			.catch((e) => {
				console.error("cases fetch failed", e);
				setError("Failed to load cases");
				setCases([]);
			});
	}, [mailboxId, tab]);

	// Counts for the tab strip — derived from a separate fetch of the full list
	// so the counts don't drop to zero when the user filters.
	const [allCases, setAllCases] = useState<CaseRow[]>([]);
	useEffect(() => {
		if (!mailboxId) return;
		fetch(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/cases`)
			.then((r) => r.json() as Promise<{ cases: CaseRow[] }>)
			.then((r) => setAllCases(r.cases))
			.catch(() => setAllCases([]));
	}, [mailboxId, cases]);

	const counts = useMemo(() => {
		const out: Record<string, number> = { open: 0, "closed-tp": 0, "closed-fp": 0, all: allCases.length };
		for (const c of allCases) {
			if (c.status in out) out[c.status] = (out[c.status] ?? 0) + 1;
		}
		return out;
	}, [allCases]);

	return (
		<div className="px-6 md:px-10 py-8 max-w-[1280px]">
			<div className="flex items-start gap-6 mb-6">
				<div className="flex-1 min-w-0">
					<div className="text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-1">
						Triage
					</div>
					<h1 className="pp-serif text-[40px] leading-none text-ink mb-2">Cases</h1>
					<p className="text-[13px] text-ink-3 max-w-xl">
						Every quarantine, block, and tag verdict opens a case. Confirm or release.
					</p>
				</div>
				<button
					type="button"
					className="inline-flex items-center gap-1.5 rounded-md bg-paper border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-paper-2 transition-colors"
				>
					<PlusIcon size={14} />
					Manual case
				</button>
			</div>

			{/* Filter bar — segmented status tabs. */}
			<div className="flex items-center gap-1 mb-5 border-b border-line">
				{STATUS_TABS.map((t) => {
					const active = tab === t.id;
					return (
						<button
							key={t.id}
							type="button"
							onClick={() => setTab(t.id)}
							className={`relative px-3 py-2 text-[13px] transition-colors ${
								active
									? "text-ink"
									: "text-ink-3 hover:text-ink-2"
							}`}
						>
							{t.label}{" "}
							<span className="pp-mono text-[11px] text-ink-3 ml-0.5">
								{counts[t.id] ?? 0}
							</span>
							{active && (
								<span className="absolute left-2 right-2 -bottom-px h-[2px] bg-accent" />
							)}
						</button>
					);
				})}
			</div>

			{cases === null ? (
				<div className="pp-card p-10 text-center text-ink-3 text-[13px]">Loading…</div>
			) : error ? (
				<div className="pp-card p-10 text-center text-danger text-[13px]">{error}</div>
			) : cases.length === 0 ? (
				<div className="pp-card p-10 text-center text-ink-3 text-[13px]">
					No cases yet. Report a phish from any email in your inbox to open one.
				</div>
			) : (
				<div className="pp-card overflow-hidden">
					{/* Header row */}
					<div className="grid grid-cols-[140px_1fr_120px_110px_60px] items-center gap-4 px-4 py-2.5 border-b border-line bg-paper-2 text-[10.5px] uppercase tracking-[0.06em] text-ink-3">
						<span>Case</span>
						<span>Subject</span>
						<span>Status</span>
						<span>Age</span>
						<span />
					</div>
					<ul>
						{cases.map((c) => (
							<li key={c.id}>
								<Link
									to={`/mailbox/${encodeURIComponent(mailboxId ?? "")}/cases/${encodeURIComponent(c.id)}`}
									className="grid grid-cols-[140px_1fr_120px_110px_60px] items-center gap-4 px-4 py-3 border-b border-line last:border-b-0 hover:bg-paper-2 transition-colors"
								>
									<span className="pp-mono text-[12px] text-ink-2 truncate">
										{c.id.slice(0, 12)}
									</span>
									<span className="text-[13px] text-ink truncate">
										{c.title}
									</span>
									<VerdictPill tone={statusTone(c.status)}>
										{statusLabel(c.status)}
									</VerdictPill>
									<span className="pp-mono text-[12px] text-ink-3">
										{relativeAge(c.created_at)}
									</span>
									<CaretRightIcon size={14} className="text-ink-3 justify-self-end" />
								</Link>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
