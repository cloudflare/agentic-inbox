// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { PaperclipIcon, FileIcon, ImageIcon } from "@phosphor-icons/react";
import { formatBytes, getAttachmentUrl, getNonInlineAttachments } from "~/lib/utils";
import type { Attachment } from "~/types";

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
				<div className="flex items-center gap-2 mb-2">
					<PaperclipIcon size={14} className="text-ink-3" />
					<span className="text-sm font-medium text-ink">
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
								className="flex items-center gap-2 rounded-md border border-line px-3 py-2 transition-colors hover:bg-paper-2 text-sm text-left"
							>
								<ImageIcon size={16} className="text-ink-3 shrink-0" />
								<span className="text-ink font-medium truncate max-w-[140px]">
									{attachment.filename}
								</span>
								<span className="text-ink-3">{formatBytes(attachment.size)}</span>
							</button>
						);
					}

					return (
						<a
							key={attachment.id}
							href={url}
							target="_blank"
							rel="noopener noreferrer"
							className="flex items-center gap-2 rounded-md border border-line px-3 py-2 no-underline transition-colors hover:bg-paper-2 text-sm"
						>
							<FileIcon size={16} className="text-ink-3 shrink-0" />
							<span className="text-ink font-medium truncate max-w-[140px]">
								{attachment.filename}
							</span>
							<span className="text-ink-3">{formatBytes(attachment.size)}</span>
						</a>
					);
				})}
			</div>
		</div>
	);
}
