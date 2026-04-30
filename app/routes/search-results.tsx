// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Pagination, Tooltip } from "@cloudflare/kumo";
import { ArrowLeftIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import MailboxSplitView from "~/components/MailboxSplitView";
import { useFeedback } from "~/lib/feedback";
import { formatListDate, getSnippetText } from "~/lib/utils";
import { useUpdateEmail } from "~/queries/emails";
import { useSearchEmails, SEARCH_PAGE_SIZE } from "~/queries/search";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email } from "~/types";

function highlightTerms(text: string, query: string): React.ReactNode {
	if (!query || !text) return text;
	const freeText = query.replace(/\b(?:from|to|subject|in|is|has|before|after):"[^"]*"/gi, "").replace(/\b(?:from|to|subject|in|is|has|before|after):\S+/gi, "").trim();
	if (!freeText) return text;
	try {
		const escaped = freeText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const regex = new RegExp(`(${escaped})`, "gi");
		const parts = text.split(regex);
		if (parts.length === 1) return text;
		// Use case-insensitive string comparison instead of regex.test() with g flag,
		// which has stateful lastIndex causing alternating true/false results.
		const lowerEscaped = escaped.toLowerCase();
		return parts.map((part, i) => part.toLowerCase() === lowerEscaped ? <mark key={i} className="bg-accent-tint text-accent-ink rounded-sm px-0.5">{part}</mark> : part);
	} catch { return text; }
}

export default function SearchResultsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const { selectedEmailId, isComposing, selectEmail, closePanel } = useUIStore();
	const updateEmail = useUpdateEmail();
	const urlQuery = searchParams.get("q") || "";
	const [page, setPage] = useState(1);
	const searchKey = useMemo(
		() => `${mailboxId ?? ""}::${urlQuery}`,
		[mailboxId, urlQuery],
	);
	const prevSearchKeyRef = useRef(searchKey);
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

	const { data: searchData, isLoading, isError } = useSearchEmails(
		mailboxId,
		urlQuery,
		currentPage,
	);
	const results = searchData?.results ?? [];
	const totalCount = searchData?.totalCount ?? 0;
	const isPanelOpen = selectedEmailId !== null || isComposing;

	const feedback = useFeedback();
	useEffect(() => {
		if (isError) feedback.error("Search failed. Try again.");
		// feedback identity changes every render (returns a fresh object), so we
		// gate the effect on isError alone to avoid spamming toasts.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isError]);

	const handleRowClick = (email: Email) => {
		selectEmail(email.id);
		if (!email.read && mailboxId) {
			updateEmail.mutate(
				{ mailboxId, id: email.id, data: { read: true } },
				{ onError: () => feedback.error("Couldn't update email.") },
			);
		}
	};
	const folderDisplayName = (name: string | null | undefined): string => { if (!name) return ""; const map: Record<string, string> = { inbox: "Inbox", sent: "Sent", draft: "Drafts", archive: "Archive", trash: "Trash", quarantine: "Quarantine" }; return map[name.toLowerCase()] || name; };

	return (
		<MailboxSplitView
			selectedEmailId={selectedEmailId}
			isComposing={isComposing}
		>
			<>
				<div className="flex items-center gap-2 px-4 py-3.5 border-b border-line shrink-0 md:px-5">
					<Tooltip content="Back to inbox" side="bottom" asChild><Button variant="ghost" shape="square" size="sm" icon={<ArrowLeftIcon size={18} />} onClick={() => navigate(`/mailbox/${mailboxId}/emails/inbox`)} aria-label="Back to inbox" /></Tooltip>
					<div className="min-w-0 flex-1"><h1 className="pp-serif text-ink truncate">Search Results</h1>{!isLoading && <span className="text-sm text-ink-3">{totalCount} result{totalCount !== 1 ? "s" : ""}{urlQuery ? ` for "${urlQuery}"` : ""}</span>}</div>
				</div>
				<div className="flex-1 overflow-y-auto">
					{isLoading ? (
						<div className="divide-y divide-line">
							{Array.from({ length: 5 }).map((_, i) => (
								<div key={i} className="flex items-center gap-3 px-4 py-2.5 md:px-5 md:py-3 animate-pulse">
									<div className="w-2.5 shrink-0" />
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2">
											<div className="h-3 w-24 rounded bg-paper-3" />
											<div className="h-3 flex-1 rounded bg-paper-3" />
											<div className="h-3 w-12 rounded bg-paper-3 ml-auto" />
										</div>
										<div className="h-2.5 w-3/4 rounded bg-paper-3 mt-2" />
									</div>
								</div>
							))}
						</div>
					) : results.length === 0 ? (
						<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
							<div className="mb-4"><MagnifyingGlassIcon size={48} weight="thin" className="text-ink-3" /></div>
							<h3 className="text-base font-semibold text-ink mb-1.5">No results found</h3>
							<p className="text-sm text-ink-3 max-w-xs">{urlQuery ? `Nothing matched "${urlQuery}". Try different keywords or check your spelling.` : "Enter a search term to find emails by subject, sender, or content."}</p>
							{urlQuery && <p className="text-xs text-ink-3 mt-3 max-w-sm">Tip: Use operators like <code className="bg-paper-3 px-1 rounded pp-mono">from:name</code>, <code className="bg-paper-3 px-1 rounded pp-mono">is:unread</code>, <code className="bg-paper-3 px-1 rounded pp-mono">has:attachment</code>, <code className="bg-paper-3 px-1 rounded pp-mono">before:2025-01-01</code></p>}
						</div>
					) : (
						<div>{results.map((email) => {
							const isSelected = selectedEmailId === email.id;
							const snippet = getSnippetText(email.snippet, 120);
							const folderName = (email as Email & { folder_name?: string }).folder_name;
							return (
								<div key={email.id} role="button" tabIndex={0} onClick={() => handleRowClick(email)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleRowClick(email); } }} className={`group flex items-center gap-3 w-full text-left cursor-pointer transition-colors border-b border-line px-4 py-2.5 md:px-5 md:py-3 ${isPanelOpen ? "md:px-4 md:py-2.5" : ""} ${isSelected ? "bg-paper-3" : "hover:bg-paper-2"}`}>
									<div className="w-2.5 shrink-0 flex justify-center">{!email.read && <div className="h-2 w-2 rounded-full bg-accent" />}</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2"><span className={`truncate text-sm ${!email.read ? "font-semibold text-ink" : "text-ink"}`}>{highlightTerms(email.sender.split("@")[0], urlQuery)}</span>{folderName && <Badge variant="outline">{folderDisplayName(folderName)}</Badge>}<span className="text-sm text-ink-3 shrink-0 ml-auto">{formatListDate(email.date)}</span></div>
										<div className={`truncate text-sm mt-0.5 ${!email.read ? "font-medium text-ink" : "text-ink-3"}`}>{highlightTerms(email.subject, urlQuery)}</div>
										{snippet && <div className="truncate text-xs text-ink-3 mt-0.5">{highlightTerms(snippet, urlQuery)}</div>}
									</div>
								</div>
							);
						})}</div>
					)}
				</div>
				{totalCount > SEARCH_PAGE_SIZE && <div className="flex justify-center py-3 border-t border-line shrink-0"><Pagination page={currentPage} setPage={setPage} perPage={SEARCH_PAGE_SIZE} totalCount={totalCount} /></div>}
			</>
		</MailboxSplitView>
	);
}
