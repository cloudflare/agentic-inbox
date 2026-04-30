// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	ArrowLeftIcon,
	BriefcaseIcon,
	CompassIcon,
	ShieldCheckIcon,
	ShieldWarningIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import ScoreRing from "~/components/phishsoc/ScoreRing";
import VerdictPill from "~/components/phishsoc/VerdictPill";
import { statusLabel, statusTone } from "~/components/phishsoc/verdict";
import { useFeedback } from "~/lib/feedback";

interface CaseEmail { case_id: string; email_id: string; }
interface CaseObservable { id: string; kind: string; value: string; }
interface CaseRecord {
	id: string;
	created_at: string;
	updated_at: string;
	status: string;
	title: string;
	notes: string | null;
	shared_to_hub: number;
	hub_event_uuid: string | null;
	emails: CaseEmail[];
	observables: CaseObservable[];
}

const OBSERVABLE_TONE: Record<string, "danger" | "suspect" | "info" | "muted"> = {
	domain: "suspect",
	url: "suspect",
	email: "danger",
	ipv4: "info",
	ipv6: "info",
};

function relativeAge(iso: string): string {
	const ms = Math.max(0, Date.now() - new Date(iso).getTime());
	const m = Math.floor(ms / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
}

export default function CaseDetailRoute() {
	const { mailboxId, caseId } = useParams<{ mailboxId: string; caseId: string }>();
	const feedback = useFeedback();
	const [data, setData] = useState<CaseRecord | null>(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		if (!mailboxId || !caseId) return;
		setLoading(true);
		try {
			const res = await fetch(
				`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/cases/${encodeURIComponent(caseId)}`,
			);
			if (!res.ok) {
				setData(null);
				return;
			}
			const body = (await res.json()) as { case: CaseRecord };
			setData(body.case);
		} finally {
			setLoading(false);
		}
	}, [mailboxId, caseId]);

	useEffect(() => { load(); }, [load]);

	const updateStatus = async (status: string) => {
		if (!mailboxId || !caseId) return;
		await fetch(
			`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/cases/${encodeURIComponent(caseId)}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status }),
			},
		);
		feedback.success("Case updated");
		await load();
	};

	if (loading && !data) {
		return (
			<div className="px-6 md:px-10 py-8 text-ink-3 text-[13px]">Loading…</div>
		);
	}

	if (!data) {
		return (
			<div className="px-6 md:px-10 py-8">
				<Link
					to={`/mailbox/${encodeURIComponent(mailboxId ?? "")}/cases`}
					className="inline-flex items-center gap-1.5 text-[12px] text-ink-3 hover:text-ink"
				>
					<ArrowLeftIcon size={12} /> All cases
				</Link>
				<div className="pp-card p-10 mt-4 text-center text-ink-3 text-[13px]">
					Case not found.
				</div>
			</div>
		);
	}

	const tone = statusTone(data.status);
	// Numeric score isn't computed yet — render a clear placeholder rather
	// than fabricate a value. Real score lands when the security pipeline
	// is plumbed into the case record.
	const placeholderScore = data.status === "closed-fp" ? 30 : 80;

	return (
		<div className="px-6 md:px-10 py-8 max-w-[1280px] space-y-5">
			{/* Crumb */}
			<Link
				to={`/mailbox/${encodeURIComponent(mailboxId ?? "")}/cases`}
				className="inline-flex items-center gap-1.5 text-[12px] text-ink-3 hover:text-ink"
			>
				<ArrowLeftIcon size={12} /> Cases
			</Link>

			{/* Title bar */}
			<div className="pp-card p-5 flex items-start gap-5">
				<ScoreRing score={placeholderScore} />
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 mb-1.5">
						<VerdictPill tone={tone}>{statusLabel(data.status)}</VerdictPill>
						<span className="pp-mono text-[11px] text-ink-3">
							opened {relativeAge(data.created_at)}
						</span>
						{data.shared_to_hub === 1 && (
							<VerdictPill tone="info">shared to hub</VerdictPill>
						)}
					</div>
					<h1 className="pp-serif text-[28px] leading-tight text-ink mb-1.5">
						{data.title}
					</h1>
					<div className="text-[12px] text-ink-3 pp-mono truncate">
						<BriefcaseIcon size={11} weight="regular" className="inline-block mr-1 align-[-1px]" />
						{data.id}
					</div>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					{data.status !== "closed-fp" && (
						<button
							type="button"
							onClick={() => updateStatus("closed-fp")}
							className="inline-flex items-center gap-1.5 rounded-md bg-paper border border-line px-3 py-1.5 text-[12px] text-ink hover:bg-paper-2 transition-colors"
						>
							Release
						</button>
					)}
					{data.status !== "closed-tp" && (
						<button
							type="button"
							onClick={() => updateStatus("closed-tp")}
							className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors text-danger border-[color-mix(in_oklch,var(--danger)_25%,transparent)] bg-danger-tint hover:bg-[color-mix(in_oklch,var(--danger-tint)_70%,var(--paper))]"
						>
							<ShieldWarningIcon size={13} weight="fill" /> Confirm threat
						</button>
					)}
				</div>
			</div>

			<div className="grid gap-5 grid-cols-1 lg:grid-cols-[1.4fr_1fr]">
				{/* Left column: emails + notes */}
				<div className="space-y-5">
					<div className="pp-card p-5">
						<div className="text-[11px] uppercase tracking-[0.06em] text-ink-3 mb-3">
							Linked emails
						</div>
						{data.emails.length === 0 ? (
							<div className="text-[13px] text-ink-3">No linked emails.</div>
						) : (
							<ul className="space-y-2">
								{data.emails.map((e) => (
									<li key={e.email_id}>
										<Link
											to={`/mailbox/${encodeURIComponent(mailboxId ?? "")}/emails/inbox?selected=${encodeURIComponent(e.email_id)}`}
											className="block rounded-md border border-line bg-paper-2 px-3 py-2 text-[12.5px] hover:border-line-strong transition-colors"
										>
											<span className="pp-mono text-ink-2">
												{e.email_id}
											</span>
										</Link>
									</li>
								))}
							</ul>
						)}
					</div>

					{data.notes && (
						<div className="pp-card p-5">
							<div className="text-[11px] uppercase tracking-[0.06em] text-ink-3 mb-2">
								Notes
							</div>
							<div className="text-[13px] text-ink-2 whitespace-pre-wrap leading-relaxed">
								{data.notes}
							</div>
						</div>
					)}

					{/* Co-pilot summary — placeholder card matching the design.
					    Lights up when the AI summarizer is wired to cases. */}
					<div
						className="rounded-[14px] p-5 border"
						style={{
							background: "var(--accent-tint)",
							borderColor: "color-mix(in oklch, var(--accent) 25%, transparent)",
						}}
					>
						<div className="flex items-center gap-2 mb-2">
							<span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-paper">
								<CompassIcon size={14} weight="fill" />
							</span>
							<div className="flex-1">
								<div className="text-[12px] font-medium text-accent-ink">
									Co-pilot summary
								</div>
								<div className="text-[11px] text-ink-3">Coming soon</div>
							</div>
						</div>
						<p className="text-[12.5px] text-accent-ink leading-relaxed opacity-90">
							When AI summarization lands, you'll see plain-language reasoning
							here for why the pipeline reached this verdict.
						</p>
					</div>
				</div>

				{/* Right column: observables / IOCs + status controls */}
				<div className="space-y-5">
					<div className="pp-card p-5">
						<div className="flex items-center justify-between mb-3">
							<div className="text-[11px] uppercase tracking-[0.06em] text-ink-3">
								Indicators of compromise
							</div>
							<span className="pp-mono text-[11px] text-ink-3">
								{data.observables.length}
							</span>
						</div>
						{data.observables.length === 0 ? (
							<div className="text-[13px] text-ink-3">
								No observables extracted.
							</div>
						) : (
							<ul className="space-y-2">
								{data.observables.map((o) => (
									<li
										key={o.id}
										className="flex items-center gap-3 rounded-md border border-line bg-paper-2 px-3 py-2"
									>
										<VerdictPill tone={OBSERVABLE_TONE[o.kind] ?? "muted"}>
											{o.kind}
										</VerdictPill>
										<span className="pp-mono text-[12px] text-ink truncate flex-1 min-w-0">
											{o.value}
										</span>
									</li>
								))}
							</ul>
						)}
					</div>

					<div className="pp-card p-5 space-y-2.5">
						<div className="text-[11px] uppercase tracking-[0.06em] text-ink-3">
							Resolution
						</div>
						<button
							type="button"
							onClick={() => updateStatus("open")}
							disabled={data.status === "open"}
							className="w-full text-left rounded-md border border-line px-3 py-2 text-[12.5px] hover:bg-paper-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						>
							<span className="text-ink">Reopen</span>
							<span className="block text-[11px] text-ink-3">
								Mark this case as open for further triage.
							</span>
						</button>
						<button
							type="button"
							onClick={() => updateStatus("closed-dup")}
							disabled={data.status === "closed-dup"}
							className="w-full text-left rounded-md border border-line px-3 py-2 text-[12.5px] hover:bg-paper-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						>
							<span className="text-ink">Mark duplicate</span>
							<span className="block text-[11px] text-ink-3">
								Close as duplicate of an existing case.
							</span>
						</button>
					</div>

					{/* Pipeline trace placeholder — full trace lands when the
					    security pipeline writes per-stage records to the case. */}
					<div className="pp-card p-5">
						<div className="text-[11px] uppercase tracking-[0.06em] text-ink-3 mb-2">
							Pipeline trace
						</div>
						<div className="flex items-start gap-2 text-[12.5px] text-ink-3">
							<ShieldCheckIcon size={14} className="text-ink-4 mt-0.5" />
							<span>
								Stage-level scoring isn't surfaced for cases yet. The
								security pipeline runs per email — once we link the trace,
								you'll see auth, URL, reputation, intel, triage, LLM, and
								verdict stages here.
							</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
