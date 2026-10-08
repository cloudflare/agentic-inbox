// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader, Pagination, Tooltip } from "@cloudflare/kumo";
import { ArrowLeftIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import MailboxSplitView from "~/components/MailboxSplitView";
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
		return parts.map((part, i) => part.toLowerCase() === lowerEscaped ? <mark key={i} className="bg-kumo-warning-tint text-kumo-default rounded-sm px-0.5">{part}</mark> : part);
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

	const { data: searchData, isLoading } = useSearchEmails(
		mailboxId,
		urlQuery,
		currentPage,
	);
	const results = searchData?.results ?? [];
	const totalCount = searchData?.totalCount ?? 0;
	const isPanelOpen = selectedEmailId !== null || isComposing;

	const handleRowClick = (email: Email) => { selectEmail(email.id); if (!email.read && mailboxId) updateEmail.mutate({ mailboxId, id: email.id, data: { read: true } }); };
	const folderDisplayName = (name: string | null | undefined): string => { if (!name) return ""; const map: Record<string, string> = { inbox: "Inbox", sent: "Sent", draft: "Drafts", archive: "Archive", trash: "Trash" }; return map[name.toLowerCase()] || name; };

	// Wide list (no reading pane) gets a little more horizontal room on desktop.
	const padX = isPanelOpen ? "px-4" : "px-4 md:px-6";

	return (
		<MailboxSplitView
			selectedEmailId={selectedEmailId}
			isComposing={isComposing}
		>
			<>
				<div className={`flex items-center gap-1.5 h-12 border-b border-kumo-line shrink-0 ${padX}`}>
					<Tooltip content="Back to inbox" side="bottom" asChild><Button variant="ghost" shape="square" size="sm" icon={<ArrowLeftIcon size={18} />} onClick={() => navigate(`/mailbox/${mailboxId}/emails/inbox`)} aria-label="Back to inbox" className="-ml-2 shrink-0 size-8 rounded-lg text-kumo-subtle hover:text-kumo-default" /></Tooltip>
					<div className="min-w-0 flex-1 flex items-baseline gap-2"><h1 className="text-[15px] font-medium text-kumo-default shrink-0">Search Results</h1>{!isLoading && <span className="text-xs text-kumo-subtle tabular-nums truncate">{totalCount} result{totalCount !== 1 ? "s" : ""}{urlQuery ? ` for "${urlQuery}"` : ""}</span>}</div>
				</div>
				<div className="flex-1 overflow-y-auto">
					{isLoading ? <div className="flex justify-center py-16"><Loader size="lg" /></div> : results.length === 0 ? (
						<div className="flex flex-col items-center justify-center gap-2 py-24 px-6 text-center">
							<div className="mb-1"><MagnifyingGlassIcon size={40} weight="thin" className="text-kumo-inactive" /></div>
							<h3 className="text-[15px] font-medium text-kumo-default">No results found</h3>
							<p className="text-sm text-kumo-subtle max-w-xs">{urlQuery ? `Nothing matched "${urlQuery}". Try different keywords or check your spelling.` : "Enter a search term to find emails by subject, sender, or content."}</p>
							{urlQuery && <p className="text-xs text-kumo-subtle mt-2 max-w-sm leading-relaxed">Tip: Use operators like <code className="font-mono text-[11px] text-kumo-strong bg-kumo-fill px-1 py-0.5 rounded">from:name</code>, <code className="font-mono text-[11px] text-kumo-strong bg-kumo-fill px-1 py-0.5 rounded">is:unread</code>, <code className="font-mono text-[11px] text-kumo-strong bg-kumo-fill px-1 py-0.5 rounded">has:attachment</code>, <code className="font-mono text-[11px] text-kumo-strong bg-kumo-fill px-1 py-0.5 rounded">before:2025-01-01</code></p>}
						</div>
					) : (
						<div>{results.map((email) => {
							const isSelected = selectedEmailId === email.id;
							const snippet = getSnippetText(email.snippet, 120);
							const folderName = (email as Email & { folder_name?: string }).folder_name;
							return (
								<div key={email.id} role="button" tabIndex={0} onClick={() => handleRowClick(email)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleRowClick(email); } }} className={`group relative flex items-start gap-2 w-full text-left py-3 border-b border-kumo-line cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring ${padX} ${isSelected ? "bg-kumo-selected" : "hover:bg-kumo-tint"}`}>
									<div className="flex items-center h-5 w-1.5 shrink-0 justify-center">{!email.read && <span className="size-1.5 rounded-full bg-kumo-brand" />}</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2 h-5"><span className={`truncate text-sm ${!email.read ? "font-medium text-kumo-default" : "text-kumo-strong"}`}>{highlightTerms(email.sender.split("@")[0], urlQuery)}</span>{folderName && <span className={`shrink-0 text-[11px] leading-4 px-1.5 rounded-full text-kumo-subtle ${isSelected ? "bg-kumo-base" : "bg-kumo-fill"}`}>{folderDisplayName(folderName)}</span>}<span className="ml-auto shrink-0 text-xs text-kumo-subtle tabular-nums">{formatListDate(email.date)}</span></div>
										<div className={`truncate text-sm mt-0.5 ${!email.read ? "font-medium text-kumo-default" : "text-kumo-strong"}`}>{highlightTerms(email.subject, urlQuery)}</div>
										{snippet && <div className="truncate text-xs text-kumo-subtle mt-0.5">{highlightTerms(snippet, urlQuery)}</div>}
									</div>
								</div>
							);
						})}</div>
					)}
				</div>
				{totalCount > SEARCH_PAGE_SIZE && <div className={`flex items-center h-12 border-t border-kumo-line shrink-0 text-xs text-kumo-subtle tabular-nums ${padX}`}><Pagination page={currentPage} setPage={setPage} perPage={SEARCH_PAGE_SIZE} totalCount={totalCount}><Pagination.Info className="grow text-xs text-kumo-subtle tabular-nums" /><Pagination.Controls /></Pagination></div>}
			</>
		</MailboxSplitView>
	);
}
