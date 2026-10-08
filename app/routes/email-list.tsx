// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Pagination, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	ArrowBendUpLeftIcon,
	ArrowsClockwiseIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FileIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	StarIcon,
	TrashIcon,
	TrayIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { Folders } from "shared/folders";
import { formatListDate } from "shared/dates";
import MailboxSplitView from "~/components/MailboxSplitView";
import { getSnippetText } from "~/lib/utils";
import {
	useDeleteEmail,
	useEmails,
	useMarkThreadRead,
	useMoveEmail,
	useUpdateEmail,
} from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { queryKeys } from "~/queries/keys";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email } from "~/types";

const PAGE_SIZE = 25;

const FOLDER_EMPTY_STATES: Record<
	string,
	{
		icon: React.ReactNode;
		title: string;
		description: string;
		showCompose?: boolean;
	}
> = {
	[Folders.INBOX]: {
		icon: <TrayIcon size={40} weight="thin" className="text-kumo-inactive" />,
		title: "Your inbox is empty",
		description:
			"New emails will appear here when they arrive. Send an email to get the conversation started.",
		showCompose: true,
	},
	[Folders.SENT]: {
		icon: (
			<PaperPlaneTiltIcon size={40} weight="thin" className="text-kumo-inactive" />
		),
		title: "No sent emails",
		description: "Emails you send will show up here.",
		showCompose: true,
	},
	[Folders.DRAFT]: {
		icon: <FileIcon size={40} weight="thin" className="text-kumo-inactive" />,
		title: "No drafts",
		description: "Emails you're still working on will be saved here.",
		showCompose: true,
	},
	[Folders.ARCHIVE]: {
		icon: <ArchiveIcon size={40} weight="thin" className="text-kumo-inactive" />,
		title: "Archive is empty",
		description:
			"Move emails here to keep your inbox clean without deleting them.",
	},
	[Folders.TRASH]: {
		icon: <TrashIcon size={40} weight="thin" className="text-kumo-inactive" />,
		title: "Trash is empty",
		description:
			"Deleted emails will appear here. You can restore them or permanently delete them.",
	},
};

function EmailListSkeleton() {
	return (
		<div className="animate-pulse">
			{Array.from({ length: 8 }).map((_, i) => (
				<div key={i} className="flex items-start gap-2 px-4 py-3 border-b border-kumo-line">
					<div className="flex items-center gap-2 h-5 shrink-0">
						<span className="w-1.5" />
						<span className="size-4 m-0.5 rounded bg-kumo-fill" />
					</div>
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2 h-5">
							<div className="h-3 w-28 rounded bg-kumo-fill" />
							<div className="h-3 w-10 ml-auto rounded bg-kumo-fill" />
						</div>
						<div className="h-3 w-3/5 mt-1.5 rounded bg-kumo-fill" />
						<div className="h-2.5 w-4/5 mt-2 rounded bg-kumo-fill" />
					</div>
				</div>
			))}
		</div>
	);
}

function FolderEmptyState({
	folder,
	onCompose,
}: {
	folder?: string;
	onCompose: () => void;
}) {
	const config = (folder && FOLDER_EMPTY_STATES[folder]) || {
		icon: (
			<EnvelopeSimpleIcon size={40} weight="thin" className="text-kumo-inactive" />
		),
		title: "No emails",
		description: "This folder is empty.",
	};

	return (
		<div className="flex flex-col items-center justify-center gap-2 py-24 px-6 text-center">
			<div className="mb-1">{config.icon}</div>
			<h3 className="text-[15px] font-medium text-kumo-default">
				{config.title}
			</h3>
			<p className="text-sm text-kumo-subtle max-w-xs">
				{config.description}
			</p>
			{"showCompose" in config && config.showCompose && (
				<Button
					variant="primary"
					size="sm"
					icon={<PencilSimpleIcon size={16} />}
					onClick={onCompose}
					className="mt-3 rounded-lg"
				>
					Compose
				</Button>
			)}
		</div>
	);
}

export default function EmailListRoute() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();
	const {
		selectedEmailId,
		isComposing,
		selectEmail,
		closePanel,
		startCompose,
	} = useUIStore();
	const [page, setPage] = useState(1);

	const queryClient = useQueryClient();
	const updateEmail = useUpdateEmail();
	const markThreadRead = useMarkThreadRead();
	const deleteEmail = useDeleteEmail();
	const moveEmail = useMoveEmail();
	const toastManager = useKumoToastManager();

	const params = useMemo(
		() => ({
			folder: folder || "",
			page: String(page),
			limit: String(PAGE_SIZE),
		}),
		[folder, page],
	);

	const {
		data: emailData,
		isFetching: isRefreshing,
	} = useEmails(mailboxId, params, { refetchInterval: 30_000 });

	const emails = emailData?.emails ?? [];
	const totalCount = emailData?.totalCount ?? 0;

	const { data: folders = [] } = useFolders(mailboxId);

	const folderName = useMemo(() => {
		const found = folders.find((f) => f.id === folder);
		if (found) return found.name;
		return folder ? folder.charAt(0).toUpperCase() + folder.slice(1) : "Inbox";
	}, [folders, folder]);

	const isPanelOpen = selectedEmailId !== null || isComposing;

	// Track folder identity to detect folder changes vs page changes
	const prevFolderRef = useRef<string | undefined>(undefined);

	useEffect(() => {
		const folderChanged = prevFolderRef.current !== `${mailboxId}/${folder}`;
		prevFolderRef.current = `${mailboxId}/${folder}`;

		if (folderChanged) {
			closePanel();
			setPage(1);
		}
	}, [mailboxId, folder, closePanel]);

	const toggleStar = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		if (mailboxId)
			updateEmail.mutate({
				mailboxId,
				id: email.id,
				data: { starred: !email.starred },
			});
	};

	// Deleting moves to Trash; only Trash and Drafts delete permanently.
	const deletesPermanently = folder === Folders.TRASH || folder === Folders.DRAFT;

	const handleDelete = (e: React.MouseEvent, emailId: string) => {
		e.preventDefault();
		e.stopPropagation();
		if (mailboxId) {
			if (deletesPermanently) {
				const confirmed = window.confirm("Permanently delete this email? This cannot be undone.");
				if (!confirmed) return;
				deleteEmail.mutate({ mailboxId, id: emailId });
			} else {
				if (selectedEmailId === emailId && isComposing && !window.confirm("Move to Trash? The reply you're writing will be discarded.")) return;
				moveEmail.mutate({ mailboxId, id: emailId, folderId: Folders.TRASH });
				toastManager.add({ title: "Moved to Trash" });
			}
			if (selectedEmailId === emailId) closePanel();
		}
	};

	const handleRefresh = () => {
		if (mailboxId) {
			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			queryClient.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		}
	};

	// Thread-aware helpers
	const hasUnread = (email: Email): boolean => {
		if (email.thread_unread_count !== undefined) {
			return email.thread_unread_count > 0;
		}
		return !email.read;
	};

	const handleRowClick = (email: Email) => {
		selectEmail(email.id);
		if (mailboxId && hasUnread(email)) {
			if (email.thread_id && email.thread_count && email.thread_count > 1) {
				markThreadRead.mutate({
					mailboxId,
					threadId: email.thread_id,
				});
			} else {
				updateEmail.mutate({
					mailboxId,
					id: email.id,
					data: { read: true },
				});
			}
		}
	};

	const formatParticipants = (email: Email): string => {
		if (email.participants) {
			const names = email.participants
				.split(",")
				.map((p) => p.trim().split("@")[0])
				.filter((name, idx, arr) => arr.indexOf(name) === idx);
			if (names.length <= 3) return names.join(", ");
			return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
		}
		return email.sender.split("@")[0];
	};

	// Wide list (no reading pane) gets a little more horizontal room on desktop.
	const padX = isPanelOpen ? "px-4" : "px-4 md:px-6";

	return (
		<MailboxSplitView
			selectedEmailId={selectedEmailId}
			isComposing={isComposing}
		>
				{/* Folder header */}
				<div className={`flex items-center justify-between gap-3 h-12 border-b border-kumo-line shrink-0 ${padX}`}>
					<div className="flex items-baseline gap-2 min-w-0">
						<h1 className="text-[15px] font-medium text-kumo-default truncate">
							{folderName}
						</h1>
						{totalCount > 0 && (
							<span className="text-xs text-kumo-subtle tabular-nums shrink-0 hidden sm:inline">
								{totalCount} conversation{totalCount !== 1 ? "s" : ""}
							</span>
						)}
					</div>
					<Tooltip
						content={isRefreshing ? "Refreshing..." : "Refresh"}
						side="bottom"
						asChild
					>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={
								<ArrowsClockwiseIcon
									size={18}
									className={isRefreshing ? "animate-spin" : ""}
								/>
							}
							onClick={handleRefresh}
							disabled={isRefreshing}
							aria-label="Refresh"
							className="-mr-1.5 size-8 rounded-lg text-kumo-subtle hover:text-kumo-default"
						/>
					</Tooltip>
				</div>

				{/* Email rows */}
				<div className="flex-1 overflow-y-auto">
				{isRefreshing && emails.length === 0 ? (
					<EmailListSkeleton />
				) : emails.length > 0 ? (
						<div>
							{emails.map((email) => {
								const isSelected = selectedEmailId === email.id;
								const unread = hasUnread(email);
								const snippet = getSnippetText(email.snippet);
								return (
									<div
										key={email.id}
										role="button"
										tabIndex={0}
										onClick={() => handleRowClick(email)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												handleRowClick(email);
											}
										}}
										className={`group relative flex items-start gap-2 w-full text-left py-3 border-b border-kumo-line cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring ${padX} ${
											isSelected ? "bg-kumo-selected" : "hover:bg-kumo-tint"
										}`}
									>
										{/* Unread dot + star, aligned with the first line */}
										<div className="flex items-center gap-2 h-5 shrink-0">
											<span className="flex w-1.5 justify-center">
												{unread && (
													<span className="size-1.5 rounded-full bg-kumo-brand" />
												)}
											</span>
											<button
												type="button"
												className="flex items-center justify-center p-0.5 rounded bg-transparent border-0 cursor-pointer"
												onClick={(e) => {
													e.stopPropagation();
													toggleStar(e, email);
												}}
											>
												<StarIcon
													size={16}
													weight={email.starred ? "fill" : "regular"}
													className={
														email.starred
															? "text-kumo-warning"
															: "text-kumo-subtle hover:text-kumo-warning transition-colors"
													}
												/>
											</button>
										</div>

										{/* Content */}
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2 h-5">
												<span
													className={`truncate text-sm ${unread ? "font-medium text-kumo-default" : "text-kumo-strong"}`}
												>
													{formatParticipants(email)}
												</span>
												{(email.thread_count ?? 1) > 1 && (
													<span className={`shrink-0 text-[11px] leading-4 tabular-nums px-1.5 rounded-full text-kumo-subtle ${isSelected ? "bg-kumo-base" : "bg-kumo-fill"}`}>
														{email.thread_count}
													</span>
												)}
												{email.has_draft && (
													<span className={`shrink-0 text-[11px] leading-4 font-medium px-1.5 rounded-full text-kumo-accent ${isSelected ? "bg-kumo-base" : "bg-kumo-accent-soft"}`}>
														Draft
													</span>
												)}
												{email.needs_reply && !email.has_draft && (
													<Tooltip content="Needs reply" asChild>
														<span className="shrink-0 flex text-kumo-brand">
															<ArrowBendUpLeftIcon size={14} weight="bold" />
														</span>
													</Tooltip>
												)}
												<span className="ml-auto shrink-0 text-xs text-kumo-subtle tabular-nums group-hover:invisible">
													{formatListDate(email.date)}
												</span>
											</div>
											<div
												className={`truncate text-sm mt-0.5 ${unread ? "font-medium text-kumo-default" : "text-kumo-strong"}`}
											>
												{email.subject}
											</div>
											{snippet && (
												<div className="truncate text-xs text-kumo-subtle mt-0.5">
													{snippet}
												</div>
											)}
										</div>

										{/* Hover actions float over the row's right edge */}
										<div className="absolute right-3 top-1.5 hidden group-hover:flex items-center gap-0.5 p-0.5 rounded-lg border border-kumo-line bg-kumo-base">
											<Tooltip content={email.read ? "Mark unread" : "Mark read"} asChild>
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													icon={email.read ? <EnvelopeSimpleIcon size={16} /> : <EnvelopeOpenIcon size={16} />}
													onClick={(e) => {
														e.stopPropagation();
														if (mailboxId)
															updateEmail.mutate({
																mailboxId,
																id: email.id,
																data: { read: !email.read },
															});
													}}
													aria-label={email.read ? "Mark unread" : "Mark read"}
													className="size-7 rounded-md text-kumo-subtle hover:text-kumo-default"
												/>
											</Tooltip>
											<Tooltip content={deletesPermanently ? "Delete permanently" : "Move to Trash"} asChild>
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													icon={<TrashIcon size={16} />}
													onClick={(e) => handleDelete(e, email.id)}
													aria-label={deletesPermanently ? "Delete permanently" : "Move to Trash"}
													className="size-7 rounded-md text-kumo-subtle hover:text-kumo-danger"
												/>
											</Tooltip>
										</div>
									</div>
								);
							})}
						</div>
					) : (
						<FolderEmptyState
							folder={folder}
							onCompose={() => startCompose()}
						/>
					)}
				</div>

				{/* Pagination */}
				{totalCount > PAGE_SIZE && (
					<div className={`flex items-center h-12 border-t border-kumo-line shrink-0 text-xs text-kumo-subtle tabular-nums ${padX}`}>
						<Pagination
							page={page}
							setPage={setPage}
							perPage={PAGE_SIZE}
							totalCount={totalCount}
						>
							<Pagination.Info className="grow text-xs text-kumo-subtle tabular-nums" />
							<Pagination.Controls />
						</Pagination>
					</div>
				)}
		</MailboxSplitView>
	);
}
