// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader, Pagination, Tooltip } from "@cloudflare/kumo";
import {
	ArrowLeftIcon,
	MagnifyingGlassIcon,
	PaperclipIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import MailboxSplitView from "~/components/MailboxSplitView";
import EmailRow from "~/components/EmailRow";
import AiSearchWorkspace from "~/components/AiSearchWorkspace";
import LabelChip from "~/components/labels/LabelChip";
import SaveCurrentViewButton from "~/components/SaveCurrentViewButton";
import { definitionFromSearchView } from "~/lib/saved-view-navigation";
import { useUpdateEmail } from "~/queries/emails";
import { useSearchEmails, SEARCH_PAGE_SIZE } from "~/queries/search";
import { useLabels } from "~/queries/labels";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email } from "~/types";
import { MAIL_COMMAND_EVENT } from "~/components/MailKeyboardController";
import type { MailCommand } from "~/lib/mail-keyboard";
import { parseSearchQuery, searchHighlightTerms } from "~/lib/search-parser";

function highlightTerms(text: string, query: string): React.ReactNode {
	if (!query || !text) return text;
	try {
		const terms = searchHighlightTerms(parseSearchQuery(query));
		if (!terms.length) return text;
		const escaped = terms.map((term) =>
			term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		);
		const regex = new RegExp(`(${escaped.join("|")})`, "gi");
		const parts = text.split(regex);
		if (parts.length === 1) return text;
		const highlights = new Set(terms.map((term) => term.toLowerCase()));
		return parts.map((part, i) =>
			highlights.has(part.toLowerCase()) ? (
				<mark
					key={i}
					className="bg-kumo-warning-tint text-kumo-default rounded-sm px-0.5"
				>
					{part}
				</mark>
			) : (
				part
			),
		);
	} catch {
		return text;
	}
}

export default function SearchResultsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [searchParams, setSearchParams] = useSearchParams();
	const navigate = useNavigate();
	const location = useLocation();
	const queryClient = useQueryClient();
	const { selectedEmailId, selectEmail, closePanel, mailDensity } = useUIStore();
	const isCompact = mailDensity === "compact";
	const updateEmail = useUpdateEmail();
	const urlQuery = searchParams.get("q") || "";
	const draftIntent =
		typeof (location.state as { aiSearchDraft?: unknown } | null)?.aiSearchDraft === "string"
			? (location.state as { aiSearchDraft: string }).aiSearchDraft
			: "";
	const labelId = searchParams.get("label_id") || "";
	const sortColumn = searchParams.get("sortColumn") || "";
	const sortDirection = searchParams.get("sortDirection") || "";
	const {
		data: labels = [],
		isSuccess: labelsReady,
		isError: labelsError,
		refetch: refetchLabels,
	} = useLabels(mailboxId);
	const selectedLabel = labels.find((label) => label.id === labelId);
	const currentViewDefinition = useMemo(
		() => definitionFromSearchView({ query: urlQuery, searchParams }),
		[urlQuery, searchParams],
	);
	const [page, setPage] = useState(1);
	const searchKey = useMemo(
		() => `${mailboxId ?? ""}::${urlQuery}::${labelId}::${sortColumn}::${sortDirection}`,
		[mailboxId, urlQuery, labelId, sortColumn, sortDirection],
	);
	const prevSearchKeyRef = useRef(searchKey);
	const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
	const searchChanged = prevSearchKeyRef.current !== searchKey;
	const currentPage = searchChanged ? 1 : page;

	useEffect(() => {
		if (!searchChanged) {
			return;
		}

		prevSearchKeyRef.current = searchKey;
		setPage(1);
		closePanel();
	}, [closePanel, searchChanged, searchKey]);

	const {
		data: searchData,
		isLoading,
		isFetching,
		isError,
		error,
		refetch,
	} = useSearchEmails(
		mailboxId,
		urlQuery,
		currentPage,
		labelId,
		sortColumn,
		sortDirection,
	);
	const results = searchData?.results ?? [];
	const totalCount = searchData?.totalCount ?? 0;
	const isPanelOpen = selectedEmailId !== null;
	const hasCommittedSearch = Boolean(urlQuery || labelId);
	const hadCommittedSearchRef = useRef(hasCommittedSearch);

	useEffect(() => {
		if (!hadCommittedSearchRef.current && hasCommittedSearch) {
			requestAnimationFrame(() => resultsHeadingRef.current?.focus());
		}
		hadCommittedSearchRef.current = hasCommittedSearch;
	}, [hasCommittedSearch]);

	useEffect(() => {
		closePanel();
	}, [closePanel, mailboxId]);

	useEffect(() => {
		const onMailCommand = (event: Event) => {
			const command = (event as CustomEvent<MailCommand>).detail;
			if (command === "refresh" && mailboxId) {
				queryClient.invalidateQueries({ queryKey: ["search", mailboxId] });
			}
		};
		window.addEventListener(MAIL_COMMAND_EVENT, onMailCommand);
		return () => window.removeEventListener(MAIL_COMMAND_EVENT, onMailCommand);
	}, [mailboxId, queryClient]);

	const handleRowClick = (email: Email) => {
		selectEmail(email.id);
		if (!email.read && mailboxId)
			updateEmail.mutate({ mailboxId, id: email.id, data: { read: true } });
	};
	const runReviewedSearch = (query: string, nextLabelId: string | null) => {
		const next = new URLSearchParams();
		if (query) next.set("q", query);
		if (nextLabelId) next.set("label_id", nextLabelId);
		setPage(1);
		closePanel();
		setSearchParams(next);
	};
	const folderDisplayName = (name: string | null | undefined): string => {
		if (!name) return "";
		const map: Record<string, string> = {
			inbox: "Inbox",
			sent: "Sent",
			draft: "Drafts",
			archive: "Archive",
			trash: "Trash",
			outbox: "Outbox",
			snoozed: "Snoozed",
		};
		return map[name.toLowerCase()] || name;
	};

	return (
		<MailboxSplitView selectedEmailId={selectedEmailId}>
			<>
				<div className="flex flex-wrap items-center gap-2 px-4 py-3.5 border-b border-kumo-line shrink-0 md:px-5">
					<Tooltip content="Back to inbox" side="bottom" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowLeftIcon size={18} />}
							onClick={() => navigate(`/mailbox/${mailboxId}/emails/inbox`)}
							aria-label="Back to inbox"
						/>
					</Tooltip>
					<div className="min-w-0 flex-1">
						<h1
							ref={resultsHeadingRef}
							tabIndex={-1}
							className="text-lg font-semibold text-kumo-default truncate outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
						>
							{hasCommittedSearch ? "Search Results" : "Search"}
						</h1>
						{hasCommittedSearch && !isLoading && !isError && (
							<span className="text-sm text-kumo-subtle">
								{totalCount} result{totalCount !== 1 ? "s" : ""}
								{urlQuery ? ` for "${urlQuery}"` : ""}
							</span>
						)}
					</div>
					{hasCommittedSearch && <label className="flex items-center gap-2 text-sm text-kumo-subtle">
						<span className="sr-only">Filter search by label</span>
						<select
							className="min-h-11 rounded-md border border-kumo-line bg-kumo-base px-3 text-sm text-kumo-strong"
							value={labelId}
							onChange={(event) =>
								setSearchParams((current) => {
									const next = new URLSearchParams(current);
									if (event.target.value)
										next.set("label_id", event.target.value);
									else next.delete("label_id");
									return next;
								})
							}
						>
							<option value="">All labels</option>
							{labels.map((label) => (
								<option key={label.id} value={label.id}>
									{label.name}
								</option>
							))}
						</select>
					</label>}
					{selectedLabel && <LabelChip label={selectedLabel} />}
					{mailboxId && (urlQuery || labelId) && (
						<SaveCurrentViewButton
							mailboxId={mailboxId}
							definition={currentViewDefinition}
							defaultName={
								selectedLabel?.name ??
								(urlQuery ? `Search: ${urlQuery.slice(0, 50)}` : "Search")
							}
						/>
					)}
				</div>
				<div className="flex-1 overflow-y-auto">
					{mailboxId && !hasCommittedSearch && (
						<AiSearchWorkspace
							mailboxId={mailboxId}
							initialIntent={draftIntent}
							labels={labels}
							labelCatalogState={
								labelsError ? "error" : labelsReady ? "ready" : "loading"
							}
							onRetryLabels={() => void refetchLabels()}
							onRun={runReviewedSearch}
						/>
					)}
					{!hasCommittedSearch ? null : isLoading ? (
						<div className="flex justify-center py-16">
							<Loader size="lg" />
						</div>
					) : isError ? (
						<div
							role="alert"
							className="mx-auto flex max-w-md flex-col items-center px-6 py-20 text-center"
						>
							<MagnifyingGlassIcon
								size={44}
								weight="thin"
								className="text-kumo-subtle"
							/>
							<h2 className="mt-4 text-base font-semibold text-kumo-default">
								Search unavailable
							</h2>
							<p className="mt-2 text-sm text-kumo-subtle">
								{error instanceof Error
									? error.message
									: "We couldn't complete this search."}
							</p>
							<Button
								className="mt-4"
								variant="secondary"
								disabled={isFetching}
								onClick={() => refetch()}
							>
								{isFetching ? "Trying again…" : "Try again"}
							</Button>
						</div>
					) : results.length === 0 ? (
						<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
							<div className="mb-4">
								<MagnifyingGlassIcon
									size={48}
									weight="thin"
									className="text-kumo-subtle"
								/>
							</div>
							<h3 className="text-base font-semibold text-kumo-default mb-1.5">
								No results found
							</h3>
							<p className="text-sm text-kumo-subtle max-w-xs">
								{urlQuery
									? `Nothing matched "${urlQuery}". Try different keywords or check your spelling.`
									: "Enter a search term to find emails by subject, sender, or content."}
							</p>
							{urlQuery && (
								<p className="text-xs text-kumo-subtle mt-3 max-w-sm">
									Tip: Use operators like{" "}
									<code className="bg-kumo-tint px-1 rounded">from:name</code>,{" "}
									<code className="bg-kumo-tint px-1 rounded">is:unread</code>,{" "}
									<code className="bg-kumo-tint px-1 rounded">
										has:attachment
									</code>
									,{" "}
									<code className="bg-kumo-tint px-1 rounded">
										before:2025-01-01
									</code>
									, <code className="bg-kumo-tint px-1 rounded">filename:proposal.pdf</code>, or{" "}
									<code className="bg-kumo-tint px-1 rounded">"exact phrase"</code>
								</p>
							)}
						</div>
					) : (
						<div role="list" aria-label="Search results">
							{results.map((email) => {
								const folderName = (email as Email & { folder_name?: string })
									.folder_name;
								const matchedAttachment = (
									email as Email & { matched_attachment_filename?: string | null }
								).matched_attachment_filename;
								return (
									<EmailRow
										key={email.id}
										email={email}
										unread={!email.read}
										selected={selectedEmailId === email.id}
										compact={isCompact}
										dense={isPanelOpen && !isCompact}
										onOpen={() => handleRowClick(email)}
										highlight={(text) => highlightTerms(text, urlQuery)}
										meta={
											folderName ? (
												<span className="shrink-0">
													<Badge variant="outline">
														{folderDisplayName(folderName)}
													</Badge>
												</span>
											) : undefined
										}
										subjectMeta={(email.labels ?? [])
											.slice(0, 2)
											.map((label) => (
												<LabelChip key={label.id} label={label} />
											))}
										footer={
											matchedAttachment ? (
												<span className="flex w-full min-w-0 items-center gap-1 text-xs text-kumo-subtle">
													<PaperclipIcon size={13} className="shrink-0" />
													<span className="truncate">
														{highlightTerms(matchedAttachment, urlQuery)}
													</span>
												</span>
											) : undefined
										}
									/>
								);
							})}
						</div>
					)}
				</div>
				{hasCommittedSearch && !isError && totalCount > SEARCH_PAGE_SIZE && (
					<div className="flex justify-center py-3 border-t border-kumo-line shrink-0">
						<Pagination
							page={currentPage}
							setPage={setPage}
							perPage={SEARCH_PAGE_SIZE}
							totalCount={totalCount}
						/>
					</div>
				)}
			</>
		</MailboxSplitView>
	);
}
