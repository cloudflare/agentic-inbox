// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import EmailAttachmentList from "~/components/EmailAttachmentList";
import EmailIframe from "~/components/EmailIframe";
import SecurityVerdictPanel from "~/components/email-panel/SecurityVerdictPanel";
import { formatDetailDate, rewriteInlineImages } from "~/lib/utils";
import type { Email } from "~/types";

interface SingleMessageViewProps {
	email: Email;
	mailboxId?: string;
	onPreviewImage: (url: string, filename: string) => void;
}

export default function SingleMessageView({
	email,
	mailboxId,
	onPreviewImage,
}: SingleMessageViewProps) {
	return (
		<div className="flex flex-col h-full">
			<div className="px-4 py-4 border-b border-line md:px-6">
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-2.5 min-w-0">
						<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-paper-3 text-xs font-bold text-ink">
							{email.sender.charAt(0).toUpperCase()}
						</div>
						<div className="min-w-0">
							<div className="text-sm font-medium text-ink truncate">
								{email.sender}
							</div>
							<div className="text-xs text-ink-3">To: {email.recipient}</div>
						</div>
					</div>
					<span className="text-xs text-ink-3 shrink-0">
						{formatDetailDate(email.date)}
					</span>
				</div>
			</div>

			<SecurityVerdictPanel email={email} />

			<div className="flex-1 min-h-0">
				<EmailIframe
					body={rewriteInlineImages(
						email.body || "",
						mailboxId || "",
						email.id,
						email.attachments,
					)}
				/>
			</div>

			<EmailAttachmentList
				mailboxId={mailboxId}
				emailId={email.id}
				attachments={email.attachments}
				onPreviewImage={onPreviewImage}
				className="px-4 py-3 border-t border-line shrink-0 md:px-6"
				showHeading
			/>
		</div>
	);
}
