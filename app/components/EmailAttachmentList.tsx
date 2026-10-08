// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { PaperclipIcon, FileIcon, ImageIcon } from "@phosphor-icons/react";
import { formatBytes, getAttachmentUrl, getNonInlineAttachments } from "~/lib/utils";
import type { Attachment } from "~/types";

const chipClassName =
	"flex min-w-0 items-center gap-2 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-left no-underline transition-colors hover:bg-kumo-tint";

interface EmailAttachmentListProps {
	mailboxId?: string;
	emailId: string;
	attachments?: Attachment[];
	onPreviewImage?: (url: string, filename: string) => void;
	className?: string;
	showHeading?: boolean;
}

export default function EmailAttachmentList({
	mailboxId,
	emailId,
	attachments,
	onPreviewImage,
	className,
	showHeading = false,
}: EmailAttachmentListProps) {
	if (!mailboxId) return null;

	const files = getNonInlineAttachments(attachments);
	if (files.length === 0) return null;

	return (
		<div className={className}>
			{showHeading && (
				<div className="mb-2 flex items-center gap-1.5">
					<PaperclipIcon size={14} className="text-kumo-subtle" />
					<span className="text-xs font-medium text-kumo-subtle tabular-nums">
						{files.length} attachment{files.length !== 1 ? "s" : ""}
					</span>
				</div>
			)}
			<div className="flex flex-wrap gap-2">
				{files.map((attachment) => {
					const url = getAttachmentUrl(mailboxId, emailId, attachment.id);
					const isImage = attachment.mimetype?.startsWith("image/");

					if (isImage && onPreviewImage) {
						return (
							<button
								key={attachment.id}
								type="button"
								onClick={() => onPreviewImage(url, attachment.filename)}
								className={chipClassName}
							>
								<ImageIcon size={16} className="text-kumo-subtle shrink-0" />
								<span className="max-w-[160px] truncate text-sm text-kumo-default">
									{attachment.filename}
								</span>
								<span className="shrink-0 text-xs text-kumo-subtle tabular-nums">{formatBytes(attachment.size)}</span>
							</button>
						);
					}

					return (
						<a
							key={attachment.id}
							href={url}
							target="_blank"
							rel="noopener noreferrer"
							className={chipClassName}
						>
							<FileIcon size={16} className="text-kumo-subtle shrink-0" />
							<span className="max-w-[160px] truncate text-sm text-kumo-default">
								{attachment.filename}
							</span>
							<span className="shrink-0 text-xs text-kumo-subtle tabular-nums">{formatBytes(attachment.size)}</span>
						</a>
					);
				})}
			</div>
		</div>
	);
}
