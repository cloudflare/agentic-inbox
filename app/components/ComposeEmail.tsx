// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Banner, Button, Dialog, Input } from "@cloudflare/kumo";
import { FloppyDiskIcon, PaperPlaneTiltIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { useParams } from "react-router";
import { useComposeForm } from "~/hooks/useComposeForm";
import RichTextEditor from "./RichTextEditor";
import { useUIStore } from "~/hooks/useUIStore";

// Hairline-separated field rows with borderless inputs (same as ComposePanel).
const FIELD_ROW =
	"group flex h-11 shrink-0 items-center gap-3 border-b border-kumo-line px-4";
const FIELD_LABEL =
	"w-14 shrink-0 text-xs text-kumo-subtle transition-colors group-focus-within:text-kumo-strong";
const FIELD_INPUT =
	"h-full min-w-0 flex-1 rounded-none bg-transparent px-0 text-sm text-kumo-default ring-0 shadow-none placeholder:text-kumo-subtle focus:outline-none";
const FOOTER_BUTTON = "h-8 gap-1.5 rounded-lg px-3 text-sm";

export default function ComposeEmail() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();

	const { isComposeModalOpen, closeComposeModal } = useUIStore();

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
		error,
		isSavingDraft,
		isSending,
		formTitle,
		handleSaveDraft,
		handleSend,
	} = useComposeForm(mailboxId, folder);

	return (
		<Dialog.Root
			open={isComposeModalOpen}
			onOpenChange={(open) => !open && !isSending && closeComposeModal()}
		>
			{/* shadow-float! beats the inline --tw-shadow kumo's Dialog sets. */}
			<Dialog
				size="lg"
				className="flex max-h-[85vh] min-w-0 flex-col p-0 shadow-float! sm:min-w-[32rem]"
			>
				<div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
					<Dialog.Title className="truncate text-sm font-medium text-kumo-default">
						{formTitle}
					</Dialog.Title>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<XIcon size={18} />}
						onClick={closeComposeModal}
						disabled={isSending}
						aria-label="Close compose"
						className="-mr-1.5 size-8 rounded-lg text-kumo-subtle hover:text-kumo-default"
					/>
				</div>
				<form
					onSubmit={(e) => handleSend(e, closeComposeModal)}
					className="flex flex-col flex-1 min-h-0"
				>
					<div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
						{error && (
							<div className="shrink-0 border-b border-kumo-line px-4 py-3">
								<Banner variant="error" text={error} />
							</div>
						)}
						<div className={FIELD_ROW}>
							<label htmlFor="compose-modal-to" className={FIELD_LABEL}>To</label>
							<Input
								id="compose-modal-to"
								aria-label="To"
								type="text"
								placeholder="recipient@example.com, another@example.com"
								size="sm"
								value={to}
								onChange={(e) => setTo(e.target.value)}
								required
								className={FIELD_INPUT}
							/>
							{!showCcBcc && (
								<button
									type="button"
									onClick={() => setShowCcBcc(true)}
									className="-mr-1.5 h-7 shrink-0 rounded-md px-2 text-xs text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
								>
									CC / BCC
								</button>
							)}
						</div>
						{showCcBcc && (
							<div className={FIELD_ROW}>
								<label htmlFor="compose-modal-cc" className={FIELD_LABEL}>CC</label>
								<Input
									id="compose-modal-cc"
									aria-label="CC"
									type="text"
									size="sm"
									value={cc}
									onChange={(e) => setCc(e.target.value)}
									placeholder="Separate multiple addresses with commas"
									className={FIELD_INPUT}
								/>
							</div>
						)}
						{showCcBcc && (
							<div className={FIELD_ROW}>
								<label htmlFor="compose-modal-bcc" className={FIELD_LABEL}>BCC</label>
								<Input
									id="compose-modal-bcc"
									aria-label="BCC"
									type="text"
									size="sm"
									value={bcc}
									onChange={(e) => setBcc(e.target.value)}
									placeholder="Separate multiple addresses with commas"
									className={FIELD_INPUT}
								/>
							</div>
						)}
						<div className={FIELD_ROW}>
							<label htmlFor="compose-modal-subject" className={FIELD_LABEL}>Subject</label>
							<Input
								id="compose-modal-subject"
								aria-label="Subject"
								type="text"
								placeholder="Email subject"
								size="sm"
								value={subject}
								onChange={(e) => setSubject(e.target.value)}
								required
								className={FIELD_INPUT}
							/>
						</div>
						<span className="sr-only">Message</span>
						<RichTextEditor value={body} onChange={setBody} />
					</div>
					<div className="flex h-14 shrink-0 items-center gap-2 border-t border-kumo-line px-4">
						<Button
							type="submit"
							variant="primary"
							size="sm"
							loading={isSending}
							disabled={isSavingDraft || isSending}
							icon={<PaperPlaneTiltIcon size={16} />}
							className={FOOTER_BUTTON}
						>
							{isSending ? "Sending..." : "Send"}
						</Button>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							loading={isSavingDraft}
							disabled={isSending}
							icon={<FloppyDiskIcon size={16} />}
							onClick={handleSaveDraft}
							className={FOOTER_BUTTON}
						>
							{isSavingDraft ? "Saving..." : "Save as Draft"}
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							icon={<TrashIcon size={16} />}
							onClick={closeComposeModal}
							disabled={isSending}
							className={`ml-auto ${FOOTER_BUTTON} text-kumo-subtle hover:text-kumo-default`}
						>
							Discard
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}
