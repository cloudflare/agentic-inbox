// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
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
	getSnippetText,
	rewriteInlineImages,
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

/** Up to two initials from a sender ("alex.smith@x.com" -> "AS", "Alex <a@x.com>" -> "A"). */
function getInitials(sender: string): string {
	const display = sender.replace(/<[^>]*>/g, "").replace(/["']/g, "").trim() || sender;
	const name = display.includes("@") ? display.split("@")[0] : display;
	const parts = name.split(/[\s._+-]+/).filter(Boolean);
	if (parts.length >= 2) return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
	return (parts[0]?.charAt(0) || sender.charAt(0) || "?").toUpperCase();
}

export function SenderAvatar({ sender, isDraft }: { sender: string; isDraft?: boolean }) {
	return (
		<div
			className={`flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
				isDraft ? "bg-kumo-base text-kumo-accent" : "bg-kumo-accent-soft text-kumo-accent"
			}`}
		>
			{isDraft ? "D" : getInitials(sender)}
		</div>
	);
}

function DraftPill() {
	return (
		<span className="shrink-0 rounded-full bg-kumo-base px-2 py-0.5 text-[11px] font-medium text-kumo-accent">
			Draft
		</span>
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
	const separatorClassName = !isLast ? "border-b border-kumo-line" : "";
	const senderLabel = isDraft ? "Draft reply" : isSelf ? "You" : email.sender;

	if (!isExpanded) {
		return (
			<div className={`px-2 py-1 md:px-4 ${separatorClassName}`}>
				<button
					type="button"
					onClick={onToggleExpand}
					className={`w-full flex items-center gap-3 px-2 py-2 text-left transition-colors ${
						isDraft
							? "rounded-xl border border-kumo-accent-line bg-kumo-accent-soft hover:border-kumo-brand/40"
							: "rounded-lg hover:bg-kumo-tint"
					}`}
				>
					<SenderAvatar isDraft={isDraft} sender={email.sender} />
					<div className="flex-1 min-w-0">
						<div className="flex items-center justify-between gap-3">
							<div className="flex items-center gap-2 min-w-0">
								<span className="text-sm font-medium text-kumo-default truncate">
									{senderLabel}
								</span>
								{isDraft && <DraftPill />}
							</div>
							<span className="text-xs text-kumo-subtle tabular-nums shrink-0">
								{formatDetailDate(email.date)}
							</span>
						</div>
						<p className="text-xs text-kumo-subtle truncate">
							{getSnippetText(email.body, 140)}
						</p>
					</div>
					<CaretDownIcon size={14} className="text-kumo-inactive shrink-0" />
				</button>
			</div>
		);
	}

	const content = (
		<>
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-3 min-w-0">
					<button
						type="button"
						onClick={onToggleExpand}
						className="shrink-0 cursor-pointer rounded-full transition-shadow hover:ring-2 hover:ring-kumo-ring"
						aria-label="Collapse message"
					>
						<SenderAvatar isDraft={isDraft} sender={email.sender} />
					</button>
					<div className="min-w-0">
						<div className="flex items-center gap-2 min-w-0">
							<span className="text-sm font-medium text-kumo-default truncate">
								{senderLabel}
							</span>
							{isDraft && <DraftPill />}
						</div>
						<div className="text-xs text-kumo-subtle truncate">To: {email.recipient}</div>
					</div>
				</div>
				<div className="flex items-center gap-0.5 shrink-0">
					<span className="mr-1 text-xs text-kumo-subtle tabular-nums">
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
								className="!h-6 !w-6 text-kumo-subtle hover:text-kumo-default"
							/>
						</Tooltip>
					)}
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<CaretUpIcon size={14} />}
						onClick={onToggleExpand}
						aria-label="Collapse message"
						className="!h-6 !w-6 text-kumo-subtle hover:text-kumo-default"
					/>
				</div>
			</div>

			<div className="mt-3 md:ml-12">
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
				<div className="flex flex-wrap gap-2 mt-4 md:ml-12">
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
				className="mt-3 md:ml-12"
			/>
		</>
	);

	return (
		<div className={`group/thread-msg px-4 py-4 md:px-6 ${separatorClassName}`}>
			{isDraft ? (
				<div className="rounded-xl border border-kumo-accent-line bg-kumo-accent-soft p-3 md:p-4">
					{content}
				</div>
			) : (
				content
			)}
		</div>
	);
}
