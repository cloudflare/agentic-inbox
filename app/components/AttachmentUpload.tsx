// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button } from "@cloudflare/kumo";
import { PaperclipIcon, XIcon } from "@phosphor-icons/react";
import { useRef } from "react";
import { formatBytes } from "~/lib/utils";

export interface AttachmentFile {
	file: File;
	id: string; // temporary id for display
}

interface AttachmentUploadProps {
	attachments: AttachmentFile[];
	onAdd: (files: File[]) => void;
	onRemove: (id: string) => void;
	maxSize?: number; // in bytes, default 25MB
	disabled?: boolean;
}

const DEFAULT_MAX_SIZE = 25 * 1024 * 1024; // 25MB

export default function AttachmentUpload({
	attachments,
	onAdd,
	onRemove,
	maxSize = DEFAULT_MAX_SIZE,
	disabled = false,
}: AttachmentUploadProps) {
	const inputRef = useRef<HTMLInputElement>(null);

	const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(e.target.files || []);
		
		// Validate files
		const validFiles: File[] = [];
		for (const file of files) {
			if (file.size > maxSize) {
				console.warn(`File ${file.name} exceeds size limit (${formatBytes(file.size)} > ${formatBytes(maxSize)})`);
				continue;
			}
			validFiles.push(file);
		}

		if (validFiles.length > 0) {
			onAdd(validFiles);
		}

		// Reset input so the same file can be selected again
		if (inputRef.current) {
			inputRef.current.value = "";
		}
	};

	const handleClick = () => {
		inputRef.current?.click();
	};

	return (
		<div className="space-y-2">
			<div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					icon={<PaperclipIcon size={14} />}
					onClick={handleClick}
					disabled={disabled}
				>
					Add Attachment
				</Button>
				<input
					ref={inputRef}
					type="file"
					multiple
					onChange={handleFileSelect}
					disabled={disabled}
					className="hidden"
					aria-label="Select files to attach"
				/>
			</div>

			{attachments.length > 0 && (
				<div className="bg-kumo-tint rounded p-3">
					<div className="text-xs font-medium text-kumo-subtle mb-2">
						{attachments.length} attachment{attachments.length !== 1 ? "s" : ""}
					</div>
					<div className="space-y-1.5">
						{attachments.map((att) => (
							<div
								key={att.id}
								className="flex items-center justify-between bg-kumo-base rounded px-2 py-1.5"
							>
								<div className="flex items-center gap-2 min-w-0 flex-1">
									<PaperclipIcon size={12} className="text-kumo-subtle shrink-0" />
									<div className="min-w-0 flex-1">
										<div className="text-xs text-kumo-default truncate font-medium">
											{att.file.name}
										</div>
										<div className="text-xs text-kumo-subtle">
											{formatBytes(att.file.size)}
										</div>
									</div>
								</div>
								<button
									type="button"
									onClick={() => onRemove(att.id)}
									disabled={disabled}
									className="ml-2 p-1 text-kumo-subtle hover:text-kumo-default transition-colors shrink-0"
									aria-label={`Remove ${att.file.name}`}
								>
									<XIcon size={12} />
								</button>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
