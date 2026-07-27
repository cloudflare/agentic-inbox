// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import { useEffect, useRef, useState } from "react";
import {
	ArrowBendUpLeftIcon,
	ArrowBendUpRightIcon,
	ArrowCounterClockwiseIcon,
	ArrowLeftIcon,
	ChatCircleIcon,
	ClockIcon,
	CodeIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FolderSimpleIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	SparkleIcon,
	StarIcon,
	TrashIcon,
	XIcon,
} from "@phosphor-icons/react";
import type { Folder, Email } from "~/types";

interface EmailPanelToolbarProps {
	email: Email;
	mailboxId?: string;
	isDraftFolder: boolean;
	isOutboxFolder: boolean;
	isSnoozedFolder: boolean;
	canSnooze: boolean;
	isUnsnoozing: boolean;
	isSending: boolean;
	isDrafting: boolean;
	moveToFolders: Folder[];
	lastReceivedMessage?: Email;
	onBack: () => void;
	onSendDraft: () => void;
	onEditDraft: () => void;
	onReply: () => void;
	onReplyAll: () => void;
	onForward: () => void;
	canReply: boolean;
	replyUnavailableReason: string;
	canForward: boolean;
	forwardUnavailableReason: string;
	onAiDraft: () => void;
	onToggleStar: () => void;
	onToggleRead: () => void;
	onMove: (folderId: string) => void;
	onSnooze: () => void;
	onUnsnooze: () => void;
	onViewSource: () => void;
	onDelete: () => void;
	onRestore: () => void;
	isTrashFolder: boolean;
}

export default function EmailPanelToolbar({
	email,
	mailboxId,
	isDraftFolder,
	isOutboxFolder,
	isSnoozedFolder,
	canSnooze,
	isUnsnoozing,
	isSending,
	isDrafting,
	moveToFolders,
	onBack,
	onSendDraft,
	onEditDraft,
	onReply,
	onReplyAll,
	onForward,
	canReply,
	replyUnavailableReason,
	canForward,
	forwardUnavailableReason,
	onAiDraft,
	onToggleStar,
	onToggleRead,
	onMove,
	onSnooze,
	onUnsnooze,
	onViewSource,
	onDelete,
	onRestore,
	isTrashFolder,
}: EmailPanelToolbarProps) {
	const destructiveActionLabel = isTrashFolder
		? "Restore"
		: isDraftFolder
			? "Discard draft"
			: "Move to Trash";
	return (
		<div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-kumo-line px-3 py-2 md:px-4">
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={<ArrowLeftIcon size={18} />}
				onClick={onBack}
				aria-label="Back to list"
				className="md:hidden shrink-0"
			/>

			{isOutboxFolder ? (
				<span className="px-2 text-sm font-medium text-kumo-subtle">
					Delivery details
				</span>
			) : isDraftFolder ? (
				<>
					<Button
						variant="primary"
						size="sm"
						icon={<PaperPlaneTiltIcon size={16} />}
						onClick={onSendDraft}
						loading={isSending}
					>
						{isSending ? "Sending..." : "Send"}
					</Button>
					<Button
						variant="secondary"
						size="sm"
						icon={<PencilSimpleIcon size={16} />}
						onClick={onEditDraft}
					>
						Edit
					</Button>
				</>
			) : (
				<>
					<Tooltip
						content={canReply ? "Reply" : replyUnavailableReason}
						side="bottom"
						asChild
					>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowBendUpLeftIcon size={18} />}
							onClick={onReply}
							disabled={!canReply}
							aria-label={canReply
								? "Reply"
								: `Reply unavailable: ${replyUnavailableReason}`}
						/>
					</Tooltip>
					<Tooltip
						content={canReply ? "Reply All" : replyUnavailableReason}
						side="bottom"
						asChild
					>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ChatCircleIcon size={18} />}
							onClick={onReplyAll}
							disabled={!canReply}
							aria-label={canReply
								? "Reply All"
								: `Reply All unavailable: ${replyUnavailableReason}`}
						/>
					</Tooltip>
					<Tooltip
						content={canForward ? "Forward" : forwardUnavailableReason}
						side="bottom"
						asChild
					>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<ArrowBendUpRightIcon size={18} />}
							onClick={onForward}
							disabled={!canForward}
							aria-label={canForward
								? "Forward"
								: `Forward unavailable: ${forwardUnavailableReason}`}
						/>
					</Tooltip>
					<div className="h-5 w-px bg-kumo-fill mx-0.5" />
					<Tooltip content="Draft a reply with AI" side="bottom" asChild>
						<Button
							variant="secondary"
							size="sm"
							icon={<SparkleIcon size={16} weight="fill" />}
							onClick={onAiDraft}
							loading={isDrafting}
							disabled={isDrafting}
						>
							{isDrafting ? "Drafting…" : "AI Reply"}
						</Button>
					</Tooltip>
				</>
			)}

			<div className="h-5 w-px bg-kumo-fill mx-0.5" />

			<Tooltip content={email.starred ? "Unstar" : "Star"} side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={
						<StarIcon
							size={18}
							weight={email.starred ? "fill" : "regular"}
							className={email.starred ? "text-kumo-warning" : ""}
						/>
					}
					onClick={onToggleStar}
					aria-label={email.starred ? "Unstar" : "Star"}
				/>
			</Tooltip>

			<Tooltip content={email.read ? "Mark as unread" : "Mark as read"} side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={email.read ? <EnvelopeSimpleIcon size={18} /> : <EnvelopeOpenIcon size={18} />}
					onClick={onToggleRead}
					aria-label={email.read ? "Mark as unread" : "Mark as read"}
				/>
			</Tooltip>

			{!isOutboxFolder && !isSnoozedFolder && (
				<MoveToFolderMenu folders={moveToFolders} onMove={onMove} />
			)}

			{isSnoozedFolder ? (
				<Tooltip content="Return now" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ArrowCounterClockwiseIcon size={18} />}
						onClick={onUnsnooze}
						disabled={isUnsnoozing}
						aria-label="Return snoozed mail now"
					/>
				</Tooltip>
			) : canSnooze ? (
				<Tooltip content="Snooze" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ClockIcon size={18} />}
						onClick={onSnooze}
						aria-label="Snooze mail"
					/>
				</Tooltip>
			) : null}

			<div className="ml-auto flex items-center gap-0.5">
				<Tooltip content="View source" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<CodeIcon size={18} />}
						onClick={onViewSource}
						aria-label="View source"
					/>
				</Tooltip>
				{!isOutboxFolder && !isSnoozedFolder && (
				<Tooltip content={destructiveActionLabel} side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={isTrashFolder ? <ArrowCounterClockwiseIcon size={18} /> : <TrashIcon size={18} />}
						onClick={isTrashFolder ? onRestore : onDelete}
						aria-label={destructiveActionLabel}
					/>
				</Tooltip>
				)}
				<Tooltip content="Close" side="bottom" asChild>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<XIcon size={18} />}
						onClick={onBack}
						aria-label="Close"
						className="hidden md:inline-flex"
					/>
				</Tooltip>
			</div>
		</div>
	);
}

function MoveToFolderMenu({ folders, onMove }: { folders: Folder[]; onMove: (id: string) => void }) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	return (
		<div ref={ref} className="relative">
			<Tooltip content="Move to folder" side="bottom" asChild>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					icon={<FolderSimpleIcon size={18} />}
					onClick={() => setOpen((o) => !o)}
					aria-label="Move to folder"
				/>
			</Tooltip>
			{open && (
				<div className="absolute top-full left-0 z-50 mt-1 min-w-[160px] rounded-lg border border-kumo-line bg-kumo-elevated shadow-lg py-1">
					<div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle">Move to</div>
					<div className="h-px bg-kumo-line my-1" />
					{folders.map((f) => (
						<button
							key={f.id}
							type="button"
							className="w-full text-left px-3 py-1.5 text-sm text-kumo-default hover:bg-kumo-overlay transition-colors"
							onClick={() => { onMove(f.id); setOpen(false); }}
						>
							{f.name}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
