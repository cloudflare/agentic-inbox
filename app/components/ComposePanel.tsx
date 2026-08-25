// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Banner, Button, Input } from "@cloudflare/kumo";
import { FileIcon, FloppyDiskIcon, PaperclipIcon, PaperPlaneTiltIcon, XIcon } from "@phosphor-icons/react";
import { useParams } from "react-router";
import { useComposeForm } from "~/hooks/useComposeForm";
import RichTextEditor from "./RichTextEditor";

function formatSize(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ComposePanel() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();

	const {
		to,
		setTo,
		cc,
		setCc,
		bcc,
		setBcc,
		showCcBcc,
		setShowCcBcc,
		subject,
		setSubject,
		body,
		setBody,
		attachments,
		addAttachments,
		removeAttachment,
		error,
		isSavingDraft,
		isSending,
		formTitle,
		handleSaveDraft,
		handleSend,
		closeCompose,
		closePanel,
	} = useComposeForm(mailboxId, folder);

	return (
		<div className="flex flex-col h-full bg-kumo-base">
			<div className="flex items-center justify-between px-4 py-3 border-b border-kumo-line shrink-0 md:px-6">
				<h2 className="text-base font-semibold text-kumo-default">
					{formTitle}
				</h2>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<XIcon size={18} />}
						onClick={closeCompose}
						disabled={isSending}
						aria-label="Close compose"
					/>
				</div>
			</div>

			<form
				onSubmit={(e) => handleSend(e, closePanel)}
				className="flex flex-col flex-1 min-h-0 overflow-y-auto"
			>
				<div className="p-4 md:p-6 space-y-4">
					{error && <Banner variant="error" text={error} />}

					<div className="space-y-3">
						<div className="flex items-center gap-2">
							<label className="text-sm font-medium text-kumo-subtle w-14 shrink-0">
								To
							</label>
							<div className="flex-1 flex items-center gap-2 min-w-0">
								<Input
									type="text"
									placeholder="recipient@example.com"
									size="sm"
									value={to}
									onChange={(e) => setTo(e.target.value)}
									required
								/>
								{!showCcBcc && (
									<button
										type="button"
										onClick={() => setShowCcBcc(true)}
										className="shrink-0 text-xs text-kumo-link hover:text-kumo-link-hover font-medium"
									>
										CC / BCC
									</button>
								)}
							</div>
						</div>

						{showCcBcc && (
							<div className="flex items-center gap-2">
								<label className="text-sm font-medium text-kumo-subtle w-14 shrink-0">CC</label>
								<div className="flex-1">
									<Input type="text" size="sm" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="Separate multiple addresses with commas" />
								</div>
							</div>
						)}

						{showCcBcc && (
							<div className="flex items-center gap-2">
								<label className="text-sm font-medium text-kumo-subtle w-14 shrink-0">BCC</label>
								<div className="flex-1">
									<Input type="text" size="sm" value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="Separate multiple addresses with commas" />
								</div>
							</div>
						)}

						<div className="flex items-center gap-2">
							<label className="text-sm font-medium text-kumo-subtle w-14 shrink-0">Subject</label>
							<div className="flex-1">
								<Input type="text" placeholder="Email subject" size="sm" value={subject} onChange={(e) => setSubject(e.target.value)} required />
							</div>
						</div>
					</div>

					<div className="border border-kumo-line rounded-md overflow-hidden bg-kumo-base">
						<RichTextEditor value={body} onChange={setBody} />
					</div>

					<div className="space-y-2">
						<label className="inline-flex items-center gap-2 cursor-pointer text-sm text-kumo-default rounded-md border border-kumo-line px-3 py-2 hover:bg-kumo-tint">
							<PaperclipIcon size={16} />
							<span>Attach files</span>
							<input
								type="file"
								multiple
								className="hidden"
								onChange={(e) => { void addAttachments(e.target.files); e.currentTarget.value = ""; }}
								disabled={isSending}
							/>
						</label>
						{attachments.length > 0 && (
							<div className="space-y-1.5">
								{attachments.map((attachment, index) => (
									<div key={`${attachment.filename}-${index}`} className="flex items-center gap-2 rounded-md border border-kumo-line px-3 py-2 text-sm">
										<FileIcon size={16} className="text-kumo-subtle shrink-0" />
										<span className="truncate flex-1">{attachment.filename}</span>
										<span className="text-kumo-subtle shrink-0">{formatSize(attachment.size)}</span>
										<button type="button" title="Remove attachment" onClick={() => removeAttachment(index)} disabled={isSending} className="p-1 rounded hover:bg-kumo-tint">
											<XIcon size={14} />
										</button>
									</div>
								))}
							</div>
						)}
					</div>
				</div>

				<div className="mt-auto px-4 py-3 border-t border-kumo-line bg-kumo-fill/30 shrink-0 md:px-6">
					<div className="flex items-center justify-between">
						<Button type="button" variant="ghost" size="sm" onClick={closeCompose} disabled={isSending}>Discard</Button>
						<div className="flex items-center gap-2">
							<Button type="button" variant="secondary" size="sm" loading={isSavingDraft} disabled={isSending} icon={<FloppyDiskIcon size={14} />} onClick={handleSaveDraft}>
								{isSavingDraft ? "Saving..." : "Save as Draft"}
							</Button>
							<Button type="submit" variant="primary" size="sm" loading={isSending} disabled={isSavingDraft || isSending} icon={<PaperPlaneTiltIcon size={14} />}>
								{isSending ? "Sending..." : "Send"}
							</Button>
						</div>
					</div>
				</div>
			</form>
		</div>
	);
}
