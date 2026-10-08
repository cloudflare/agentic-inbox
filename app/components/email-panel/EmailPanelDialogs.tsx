// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Dialog } from "@cloudflare/kumo";
import { downloadFile } from "~/lib/utils";
import type { Email } from "~/types";

interface PreviewImage {
	url: string;
	filename: string;
}

interface EmailPanelDialogsProps {
	sourceViewEmail: Email | null;
	previewImage: PreviewImage | null;
	onCloseSource: () => void;
	onClosePreview: () => void;
}

function getSourceHeaders(msg: Email): { key: string; value: string }[] {
	if (msg.raw_headers) {
		try {
			const parsed = JSON.parse(msg.raw_headers);
			if (Array.isArray(parsed)) {
				return parsed.map((header) => ({
					key: header.key || header.name || "",
					value: String(header.value || ""),
				}));
			}
			if (typeof parsed === "object" && parsed !== null) {
				return Object.entries(parsed).map(([key, value]) => ({
					key,
					value: String(value),
				}));
			}
		} catch {
			// Fall through to field-based headers.
		}
	}

	const headers: { key: string; value: string }[] = [];
	if (msg.sender) headers.push({ key: "From", value: msg.sender });
	if (msg.recipient) headers.push({ key: "To", value: msg.recipient });
	if (msg.cc) headers.push({ key: "Cc", value: msg.cc });
	if (msg.bcc) headers.push({ key: "Bcc", value: msg.bcc });
	if (msg.subject) headers.push({ key: "Subject", value: msg.subject });
	if (msg.date) headers.push({ key: "Date", value: msg.date });
	if (msg.message_id) headers.push({ key: "Message-ID", value: msg.message_id });
	if (msg.in_reply_to) headers.push({ key: "In-Reply-To", value: msg.in_reply_to });
	if (msg.email_references) {
		headers.push({ key: "References", value: msg.email_references });
	}
	if (msg.thread_id) headers.push({ key: "X-Thread-ID", value: msg.thread_id });
	return headers;
}

export default function EmailPanelDialogs({
	sourceViewEmail,
	previewImage,
	onCloseSource,
	onClosePreview,
}: EmailPanelDialogsProps) {
	const sourceHeaders = sourceViewEmail ? getSourceHeaders(sourceViewEmail) : [];

	return (
		<>
			<Dialog.Root
				open={sourceViewEmail !== null}
				onOpenChange={(open) => {
					if (!open) onCloseSource();
				}}
			>
				<Dialog size="lg" className="p-5">
					<Dialog.Title className="text-base font-medium text-kumo-default">
						Email Source Headers
						{sourceViewEmail && (
							<span className="text-sm font-normal text-kumo-subtle ml-2">
								{sourceViewEmail.subject}
							</span>
						)}
					</Dialog.Title>
					{sourceViewEmail && (
						<div className="mt-4 max-h-[60vh] overflow-y-auto rounded-lg border border-kumo-line">
							<table className="w-full text-xs border-collapse">
								<tbody>
									{sourceHeaders.map((header, idx) => (
										<tr
											key={`${header.key}-${idx}`}
											className="border-b border-kumo-line last:border-b-0"
										>
											<td className="py-2 px-3 font-mono font-medium text-kumo-strong whitespace-nowrap align-top w-[160px]">
												{header.key}
											</td>
											<td className="py-2 px-3 font-mono text-kumo-subtle break-all">
												{header.value}
											</td>
										</tr>
									))}
								</tbody>
							</table>
							{sourceHeaders.length === 0 && (
								<p className="text-sm text-kumo-subtle text-center py-8">
									No header data available for this email.
								</p>
							)}
						</div>
					)}
					<div className="flex justify-end mt-5">
						<Dialog.Close>
							<Button variant="secondary" size="sm">
								Close
							</Button>
						</Dialog.Close>
					</div>
				</Dialog>
			</Dialog.Root>

			<Dialog.Root
				open={previewImage !== null}
				onOpenChange={(open) => {
					if (!open) onClosePreview();
				}}
			>
				<Dialog size="lg" className="p-5">
					<Dialog.Title className="text-base font-medium text-kumo-default truncate">
						{previewImage?.filename}
					</Dialog.Title>
					{previewImage && (
						<div className="mt-4 flex flex-col items-center justify-center rounded-xl bg-kumo-tint p-4 min-h-[200px]">
							<img
								src={previewImage.url}
								alt={previewImage.filename}
								className="max-w-full max-h-[70vh] object-contain rounded-lg"
							/>
						</div>
					)}
					<div className="flex justify-between items-center gap-2 mt-5">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								if (previewImage) {
									downloadFile(previewImage.url, previewImage.filename);
								}
							}}
						>
							Download Original
						</Button>
						<Dialog.Close>
							<Button variant="primary" size="sm">
								Close
							</Button>
						</Dialog.Close>
					</div>
				</Dialog>
			</Dialog.Root>
		</>
	);
}
