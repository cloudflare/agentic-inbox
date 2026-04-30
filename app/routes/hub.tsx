// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { GearSixIcon, GraphIcon, WarningIcon } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
	useHubContributions,
	useHubDestroylist,
	useHubSharingGroups,
} from "~/queries/hub";
import type {
	HubContribution,
	HubContributionsResponse,
	HubDestroylistResponse,
	HubSharingGroup,
	HubSharingGroupsResponse,
} from "~/types";

export default function HubRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const contributions = useHubContributions(mailboxId);
	const destroylist = useHubDestroylist(mailboxId);
	const sharingGroups = useHubSharingGroups(mailboxId);

	// All three endpoints share the same `configured: false` state. If any
	// reports unconfigured, the whole screen renders the setup hint —
	// individual panels never disagree about whether the hub is wired up.
	const anyUnconfigured =
		contributions.data?.configured === false ||
		destroylist.data?.configured === false ||
		sharingGroups.data?.configured === false;

	return (
		<div className="px-6 md:px-10 py-8 max-w-[1280px] space-y-6">
			<HubHeader />

			{anyUnconfigured ? (
				<NotConfiguredHint mailboxId={mailboxId} />
			) : (
				<div className="grid gap-4 lg:grid-cols-2">
					<ContributionsPanel query={contributions} />
					<DestroylistPanel query={destroylist} />
					<SharingGroupsPanel query={sharingGroups} />
				</div>
			)}
		</div>
	);
}

function HubHeader() {
	return (
		<div>
			<div className="text-[11px] uppercase tracking-[0.08em] text-ink-3 mb-1">
				Community defense
			</div>
			<h1 className="pp-serif text-[40px] leading-none text-ink mb-2">
				Threat-intel hub
			</h1>
			<p className="text-[13px] text-ink-3 max-w-2xl">
				Pull corroborated indicators from MISP-compatible feeds. Push your
				own confirmed phishing back. Trust-weighted so one org can't
				single-handedly promote its own finding.
			</p>
		</div>
	);
}

function NotConfiguredHint({ mailboxId }: { mailboxId: string | undefined }) {
	return (
		<div className="pp-card p-10 flex flex-col items-center text-center gap-3">
			<span className="flex h-12 w-12 items-center justify-center rounded-full bg-paper-2 text-ink-3">
				<GraphIcon size={22} />
			</span>
			<div className="pp-serif text-[20px] text-ink">Hub not configured</div>
			<p className="text-[12.5px] text-ink-3 max-w-md leading-relaxed">
				Connect this mailbox to a MISP-compatible hub to see your
				contributions, the corroborated destroylist, and the sharing groups
				you belong to.
			</p>
			{mailboxId ? (
				<Link
					to={`/mailbox/${mailboxId}/settings`}
					className="inline-flex items-center gap-1.5 text-[12px] text-accent hover:opacity-80 underline"
				>
					<GearSixIcon size={14} /> Open settings
				</Link>
			) : null}
		</div>
	);
}

interface PanelShellProps {
	title: string;
	children: ReactNode;
	footnote?: string;
}

function PanelShell({ title, children, footnote }: PanelShellProps) {
	return (
		<div className="pp-card p-5 flex flex-col gap-3">
			<div className="text-[10.5px] uppercase tracking-[0.06em] text-ink-3">
				{title}
			</div>
			{children}
			{footnote ? (
				<p className="text-[11.5px] text-ink-3 mt-auto">{footnote}</p>
			) : null}
		</div>
	);
}

function PanelLoader() {
	return (
		<div className="flex justify-center py-6">
			<Loader size="base" />
		</div>
	);
}

function PanelError({ onRetry }: { onRetry: () => void }) {
	return (
		<div className="flex items-start gap-2 text-[12.5px] text-ink-3">
			<WarningIcon size={14} className="mt-[2px] shrink-0" />
			<div>
				Couldn't reach the hub.{" "}
				<button
					type="button"
					onClick={onRetry}
					className="underline text-accent hover:opacity-80"
				>
					Retry
				</button>
			</div>
		</div>
	);
}

function ContributionsPanel({
	query,
}: { query: ReturnType<typeof useHubContributions> }) {
	return (
		<PanelShell
			title="My contributions"
			footnote="The 25 most recent events your org pushed to the hub."
		>
			{renderListPanel<HubContributionsResponse, HubContribution>({
				query,
				extract: (envelope) => (envelope.configured ? envelope.data : []),
				empty:
					"No contributions yet — report a phish to push your first event.",
				render: (events) => (
					<ul className="space-y-2">
						{events.map((e) => (
							<li key={e.uuid} className="flex flex-col">
								<div className="text-[13px] text-ink truncate">{e.info}</div>
								<div className="text-[11px] text-ink-3">
									{e.date} · {e.attribute_count} attribute
									{e.attribute_count === 1 ? "" : "s"}
									{e.sharing_group_uuid ? " · shared" : " · own org only"}
								</div>
							</li>
						))}
					</ul>
				),
			})}
		</PanelShell>
	);
}

function DestroylistPanel({
	query,
}: { query: ReturnType<typeof useHubDestroylist> }) {
	return (
		<PanelShell
			title="Destroylist preview"
			footnote="Promoted indicators visible to this org across all sharing groups it belongs to."
		>
			{renderListPanel<HubDestroylistResponse, string>({
				query,
				extract: (envelope) => (envelope.configured ? envelope.data.values : []),
				empty: "Destroylist is empty for this org's visibility.",
				render: (values) => (
					<>
						<div className="text-[12px] text-ink-3 mb-2">
							{values.length} indicator{values.length === 1 ? "" : "s"}
						</div>
						<ul className="space-y-1 max-h-72 overflow-y-auto pp-mono text-[12px]">
							{values.slice(0, 100).map((v) => (
								<li key={v} className="text-ink truncate">
									{v}
								</li>
							))}
						</ul>
						{values.length > 100 ? (
							<div className="text-[11px] text-ink-3 mt-2">
								+ {values.length - 100} more
							</div>
						) : null}
					</>
				),
			})}
		</PanelShell>
	);
}

function SharingGroupsPanel({
	query,
}: { query: ReturnType<typeof useHubSharingGroups> }) {
	return (
		<PanelShell title="Sharing groups">
			{renderListPanel<HubSharingGroupsResponse, HubSharingGroup>({
				query,
				extract: (envelope) =>
					envelope.configured ? envelope.data.groups : [],
				empty:
					"This org isn't a member of any sharing groups yet. Ask your hub admin for an invite.",
				render: (groups) => (
					<ul className="space-y-2">
						{groups.map((g) => (
							<li key={g.uuid} className="flex flex-col">
								<div className="text-[13px] text-ink">{g.name}</div>
								{g.description ? (
									<div className="text-[11px] text-ink-3 truncate">
										{g.description}
									</div>
								) : null}
								{g.role ? (
									<div className="text-[10.5px] uppercase tracking-[0.06em] text-ink-3 mt-0.5">
										{g.role}
									</div>
								) : null}
							</li>
						))}
					</ul>
				),
			})}
		</PanelShell>
	);
}

interface ListPanelArgs<TResp, TItem> {
	query: {
		data?: TResp;
		isLoading: boolean;
		isError: boolean;
		refetch: () => void;
	};
	extract: (resp: TResp) => TItem[];
	empty: string;
	render: (items: TItem[]) => ReactNode;
}

function renderListPanel<TResp, TItem>(args: ListPanelArgs<TResp, TItem>) {
	const { query, extract, empty, render } = args;
	if (query.isLoading) return <PanelLoader />;
	if (query.isError) return <PanelError onRetry={() => query.refetch()} />;
	if (!query.data) return null;
	const items = extract(query.data);
	if (items.length === 0) {
		return <p className="text-[12.5px] text-ink-3">{empty}</p>;
	}
	return render(items);
}
