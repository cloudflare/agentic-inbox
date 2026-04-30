// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Tooltip } from "@cloudflare/kumo";
import {
	CaretDownIcon,
	CaretUpIcon,
	CodeIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import EmailAttachmentList from "~/components/EmailAttachmentList";
import EmailIframe from "~/components/EmailIframe";
import {
	formatDetailDate,
	formatShortDate,
	rewriteInlineImages,
	stripHtml,
} from "~/lib/utils";
import type { Email } from "~/types";

interface ThreadMessageProps {
	email: Email;
	mailboxId?: string;
	mailboxEmail?: string;
	isLast: boolean;
	isDraft?: boolean;
	isSending?: boolean;
	isExpanded: boolean;
	onToggleExpand: () => void;
	onSendDraft?: () => void;
	onEditDraft?: () => void;
	onDeleteDraft?: () => void;
	onViewSource?: () => void;
	onPreviewImage?: (url: string, filename: string) => void;
}

function Avatar({ isDraft, isSelf, sender }: { isDraft?: boolean; isSelf: boolean; sender: string }) {
	return (
		<div
			className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
				isDraft
					? "bg-paper-3 text-ink-3"
					: isSelf
						? "bg-accent text-accent-ink"
						: "bg-paper-3 text-ink"
			}`}
		>
			{isDraft ? "D" : sender.charAt(0).toUpperCase()}
		</div>
	);
}

export default function ThreadMessage({
	email,
	mailboxId,
	mailboxEmail,
	isLast,
	isDraft,
	isSending,
	isExpanded,
	onToggleExpand,
	onSendDraft,
	onEditDraft,
	onDeleteDraft,
	onViewSource,
	onPreviewImage,
}: ThreadMessageProps) {
	const isSelf = email.sender === mailboxEmail;
	const containerClassName = `${!isLast ? "border-b border-line" : ""} ${isDraft ? "border-l-2 border-l-suspect bg-suspect/[0.02]" : ""}`;
	const senderLabel = isDraft ? "Draft reply" : isSelf ? "You" : email.sender;

	if (!isExpanded) {
		return (
			<div className={containerClassName}>
				<button
					type="button"
					onClick={onToggleExpand}
					className="w-full flex items-center gap-3 px-4 py-3 hover:bg-paper-2 rounded-lg text-left"
				>
					<Avatar isDraft={isDraft} isSelf={isSelf} sender={email.sender} />
					<div className="flex-1 min-w-0">
						<div className="flex items-center justify-between">
							<span className="text-sm font-medium text-ink truncate">
								{senderLabel}
							</span>
							<span className="text-xs text-ink-3 shrink-0">
								{formatDetailDate(email.date)}
							</span>
						</div>
						<p className="text-xs text-ink-3 truncate">
							{stripHtml(email.body || "").slice(0, 80)}
						</p>
					</div>
					<CaretDownIcon size={14} className="text-ink-3 shrink-0" />
				</button>
			</div>
		);
	}

	return (
		<div className={`group/thread-msg ${containerClassName}`}>
			<div className="px-4 py-4 md:px-6">
				<div className="flex items-center justify-between gap-3 mb-3">
					<div className="flex items-center gap-2.5 min-w-0">
						<button
							type="button"
							onClick={onToggleExpand}
							className="shrink-0"
							aria-label="Collapse message"
						>
							<div className="cursor-pointer hover:ring-2 hover:ring-accent/30 transition-shadow rounded-full">
								<Avatar isDraft={isDraft} isSelf={isSelf} sender={email.sender} />
							</div>
						</button>
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<span className="text-sm font-medium text-ink truncate">
									{senderLabel}
								</span>
								{isDraft && <Badge variant="outline">Draft</Badge>}
							</div>
							<div className="text-xs text-ink-3">To: {email.recipient}</div>
						</div>
					</div>
					<div className="flex items-center gap-1 shrink-0">
						<span className="text-xs text-ink-3">
							{formatShortDate(email.date)}
						</span>
						{onViewSource && (
							<Tooltip content="View source" side="bottom" asChild>
								<Button
									variant="ghost"
									shape="square"
									size="sm"
									icon={<CodeIcon size={14} />}
									onClick={onViewSource}
									aria-label="View source"
									className="transition-opacity !h-6 !w-6"
								/>
							</Tooltip>
						)}
						<button
							type="button"
							onClick={onToggleExpand}
							className="ml-1"
							aria-label="Collapse message"
						>
							<CaretUpIcon
								size={14}
								className="text-ink-3 hover:text-ink transition-colors"
							/>
						</button>
					</div>
				</div>

				<div className="md:ml-[42px]">
					<EmailIframe
						body={rewriteInlineImages(
							email.body || "",
							mailboxId || "",
							email.id,
							email.attachments,
						)}
						autoSize
					/>
				</div>

				{isDraft && (onSendDraft || onEditDraft || onDeleteDraft) && (
					<div className="flex gap-2 mt-3 md:ml-[42px]">
						{onSendDraft && (
							<Button
								variant="primary"
								size="sm"
								icon={<PaperPlaneTiltIcon size={14} />}
								onClick={onSendDraft}
								loading={isSending}
								disabled={isSending}
							>
								{isSending ? "Sending..." : "Send"}
							</Button>
						)}
						{onEditDraft && (
							<Button
								variant="secondary"
								size="sm"
								icon={<PencilSimpleIcon size={14} />}
								onClick={onEditDraft}
								disabled={isSending}
							>
								Edit
							</Button>
						)}
						{onDeleteDraft && (
							<Button
								variant="ghost"
								size="sm"
								icon={<TrashIcon size={14} />}
								onClick={onDeleteDraft}
								disabled={isSending}
							>
								Discard
							</Button>
						)}
					</div>
				)}

				<EmailAttachmentList
					mailboxId={mailboxId}
					emailId={email.id}
					attachments={email.attachments}
					onPreviewImage={onPreviewImage}
					className="mt-3 md:ml-[42px]"
				/>
			</div>
		</div>
	);
}
