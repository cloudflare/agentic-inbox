// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Dialog, Input, Loader, Tabs, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import {
	BrainIcon,
	CloudArrowUpIcon,
	FileDocIcon,
	FileImageIcon,
	FilePdfIcon,
	FileTextIcon,
	MagnifyingGlassIcon,
	PlusIcon,
	SparkleIcon,
	TrashIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useParams } from "react-router";
import { formatCount } from "~/lib/text-metrics";
import api from "~/services/api";
import {
	useAddMemory,
	useDeleteMemory,
	useMemoryDetail,
	useMemoryFacts,
	useMemoryList,
	useSearchMemory,
	useSummarizeMemory,
	useUpdateMemory,
	useUpdateMemoryFact,
	useUpdateMemoryFactStatus,
	useUploadMemory,
} from "~/queries/memory";
import { queryKeys } from "~/queries/keys";
import type { MemoryEntry, MemoryHit } from "~/types";

const SOURCE_TYPE_ICONS: Record<MemoryEntry["source_type"], React.ReactNode> = {
	text: <FileTextIcon size={16} className="text-kumo-subtle" />,
	markdown: <FileTextIcon size={16} className="text-kumo-subtle" />,
	pdf: <FilePdfIcon size={16} className="text-kumo-subtle" />,
	docx: <FileDocIcon size={16} className="text-kumo-subtle" />,
	image: <FileImageIcon size={16} className="text-kumo-subtle" />,
};

interface StagedFile {
	file: File;
	title: string;
}

export default function MemoryRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const queryClient = useQueryClient();
	const { data: entries = [], isLoading } = useMemoryList(mailboxId);
	const addMemoryMutation = useAddMemory();
	const uploadMemoryMutation = useUploadMemory();
	const deleteMemoryMutation = useDeleteMemory();
	const updateMemoryMutation = useUpdateMemory();
	const summarizeMemoryMutation = useSummarizeMemory();
	const { data: facts = [] } = useMemoryFacts(mailboxId, "suggested");
	const updateFactMutation = useUpdateMemoryFact();
	const updateFactStatusMutation = useUpdateMemoryFactStatus();

	const [searchQuery, setSearchQuery] = useState("");
	const { data: searchData } = useSearchMemory(mailboxId, searchQuery);

	const [isAddOpen, setIsAddOpen] = useState(false);
	const [addTab, setAddTab] = useState<"text" | "file" | "drive">("text");
	const [title, setTitle] = useState("");
	const [content, setContent] = useState("");
	const [tags, setTags] = useState("");
	const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
	const [isDragging, setIsDragging] = useState(false);
	const [isUploadingBatch, setIsUploadingBatch] = useState(false);
	const [driveFileIds, setDriveFileIds] = useState("");
	const fileInputRef = useRef<HTMLInputElement>(null);

	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [isBulkTagsOpen, setIsBulkTagsOpen] = useState(false);
	const [bulkTags, setBulkTags] = useState("");
	const [isBulkSaving, setIsBulkSaving] = useState(false);
	const [editingFactId, setEditingFactId] = useState<string | null>(null);
	const [factDraft, setFactDraft] = useState("");

	const [previewId, setPreviewId] = useState<string | null>(null);
	const { data: previewDetail } = useMemoryDetail(mailboxId, previewId ?? undefined);

	const resetAddForm = () => {
		setTitle("");
		setContent("");
		setTags("");
		setStagedFiles([]);
		setDriveFileIds("");
		setAddTab("text");
	};

	const addFiles = (files: FileList | File[]) => {
		const newEntries = Array.from(files).map((f) => ({ file: f, title: f.name }));
		setStagedFiles((prev) => [...prev, ...newEntries]);
	};

	const updateStagedTitle = (index: number, value: string) => {
		setStagedFiles((prev) => prev.map((sf, i) => (i === index ? { ...sf, title: value } : sf)));
	};

	const removeStaged = (index: number) => {
		setStagedFiles((prev) => prev.filter((_, i) => i !== index));
	};

	const handleAdd = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!mailboxId) return;

		if (addTab === "file") {
			if (stagedFiles.length === 0) return;
			setIsUploadingBatch(true);
			const results = await Promise.allSettled(
				stagedFiles.map((sf) =>
					uploadMemoryMutation.mutateAsync({
						mailboxId,
						file: sf.file,
						title: sf.title.trim() || undefined,
						tags: tags.trim() || undefined,
					}),
				),
			);
			setIsUploadingBatch(false);
			const failed = results.filter((r) => r.status === "rejected").length;
			resetAddForm();
			setIsAddOpen(false);
			if (failed === 0) {
				toastManager.add({ title: `${results.length} file(s) uploaded, processing in background` });
			} else {
				toastManager.add({
					title: `${results.length - failed} of ${results.length} file(s) uploaded, ${failed} failed`,
					variant: "error",
				});
			}
			return;
		}

		if (addTab === "drive") {
			if (!driveFileIds.trim()) return;
			try {
				await api.importGoogleDrive(mailboxId, driveFileIds.split(/[\s,]+/).filter(Boolean));
				await queryClient.invalidateQueries({ queryKey: queryKeys.memory.list(mailboxId) });
				resetAddForm();
				setIsAddOpen(false);
				toastManager.add({ title: "Google Drive import completed" });
			} catch {
				toastManager.add({ title: "Google Drive import failed", variant: "error" });
			}
			return;
		}

		if (!title.trim() || !content.trim()) return;
		try {
			await addMemoryMutation.mutateAsync({
				mailboxId,
				title: title.trim(),
				content: content.trim(),
				tags: tags.trim() || undefined,
			});
			resetAddForm();
			setIsAddOpen(false);
			toastManager.add({ title: "Memory note added" });
		} catch {
			toastManager.add({ title: "Failed to add memory note", variant: "error" });
		}
	};

	const handleDelete = async (id: string) => {
		if (!mailboxId) return;
		try {
			await deleteMemoryMutation.mutateAsync({ mailboxId, id });
			setSelectedIds((prev) => {
				const next = new Set(prev);
				next.delete(id);
				return next;
			});
			toastManager.add({ title: "Memory note deleted" });
		} catch {
			toastManager.add({ title: "Failed to delete memory note", variant: "error" });
		}
	};

	const toggleSelect = (id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const handleBulkTagsSave = async () => {
		if (!mailboxId) return;
		setIsBulkSaving(true);
		const ids = [...selectedIds];
		const results = await Promise.allSettled(
			ids.map((id) => updateMemoryMutation.mutateAsync({ mailboxId, id, tags: bulkTags.trim() || undefined })),
		);
		setIsBulkSaving(false);
		setIsBulkTagsOpen(false);
		setBulkTags("");
		setSelectedIds(new Set());
		const failed = results.filter((r) => r.status === "rejected").length;
		if (failed === 0) {
			toastManager.add({ title: `Updated tags for ${ids.length} item(s)` });
		} else {
			toastManager.add({ title: `${failed} of ${ids.length} update(s) failed`, variant: "error" });
		}
	};

	const handleGenerateSummary = () => {
		if (!mailboxId || !previewId) return;
		summarizeMemoryMutation.mutate({ mailboxId, id: previewId });
	};

	const isSearching = searchQuery.trim().length > 0;
	const searchResults: MemoryHit[] = searchData?.results ?? [];

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<div className="flex items-center justify-between mb-6">
				<div className="flex items-center gap-2">
					<BrainIcon size={20} weight="duotone" className="text-kumo-subtle" />
					<h1 className="text-lg font-semibold text-kumo-default">Memory</h1>
				</div>
				<Button
					variant="primary"
					icon={<PlusIcon size={16} />}
					onClick={() => setIsAddOpen(true)}
				>
					Add Memory
				</Button>
			</div>

			<p className="text-xs text-kumo-subtle mb-4">
				Store notes (policies, reference info) the AI agent can search when drafting replies.
			</p>

			<div className="relative mb-4">
				<MagnifyingGlassIcon
					size={16}
					className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-subtle"
				/>
				<Input
					className="w-full pl-9"
					placeholder="Search memory notes..."
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
				/>
			</div>

			{facts.length > 0 && (
				<section className="rounded-lg border border-kumo-line bg-kumo-fill/20 mb-4 p-3">
					<div className="flex items-center justify-between mb-2">
						<div>
							<h2 className="text-sm font-semibold text-kumo-default">Review extracted facts</h2>
							<p className="text-xs text-kumo-subtle">Confirm facts before the agent can use them in drafts.</p>
						</div>
						<Badge variant="secondary">{facts.length} suggested</Badge>
					</div>
					<div className="space-y-2">
						{facts.map((fact) => (
							<div key={fact.id} className="rounded-md border border-kumo-line bg-kumo-base p-2">
								{editingFactId === fact.id ? (
									<div className="space-y-2">
										<textarea value={factDraft} onChange={(e) => setFactDraft(e.target.value)} rows={2} className="w-full resize-y rounded border border-kumo-line bg-kumo-recessed px-2 py-1.5 text-xs text-kumo-default" />
										<div className="flex justify-end gap-2">
											<Button size="xs" variant="ghost" onClick={() => setEditingFactId(null)}>Cancel</Button>
											<Button size="xs" variant="primary" loading={updateFactMutation.isPending} onClick={async () => { await updateFactMutation.mutateAsync({ mailboxId: mailboxId!, id: fact.id, value: factDraft }); setEditingFactId(null); }}>Save</Button>
										</div>
									</div>
								) : (
									<div className="flex items-start gap-2">
										<div className="min-w-0 flex-1">
											<div className="text-xs font-medium text-kumo-default">{fact.kind}</div>
											<p className="text-xs text-kumo-subtle">{fact.value}</p>
											{fact.confidence != null && <span className="text-[11px] text-kumo-subtle">Confidence {fact.confidence}%</span>}
										</div>
										<Button size="xs" variant="ghost" onClick={() => { setEditingFactId(fact.id); setFactDraft(fact.value); }}>Edit</Button>
										<Button size="xs" variant="secondary" loading={updateFactStatusMutation.isPending} onClick={() => updateFactStatusMutation.mutate({ mailboxId: mailboxId!, id: fact.id, status: "confirmed" })}>Confirm</Button>
										<Button size="xs" variant="ghost" onClick={() => updateFactStatusMutation.mutate({ mailboxId: mailboxId!, id: fact.id, status: "rejected" })}>Reject</Button>
									</div>
								)}
							</div>
						))}
					</div>
				</section>
			)}

			{!isSearching && selectedIds.size > 0 && (
				<div className="flex items-center gap-2 mb-2">
					<span className="text-xs text-kumo-subtle">{selectedIds.size} selected</span>
					<Button size="xs" variant="secondary" onClick={() => setIsBulkTagsOpen(true)}>
						Edit tags
					</Button>
					<Button size="xs" variant="ghost" onClick={() => setSelectedIds(new Set())}>
						Clear
					</Button>
				</div>
			)}

			{isLoading ? (
				<div className="flex justify-center py-20">
					<Loader size="lg" />
				</div>
			) : isSearching ? (
				<div className="border border-kumo-line rounded-lg divide-y divide-kumo-line">
					{searchResults.length === 0 ? (
						<div className="px-4 py-6 text-sm text-kumo-subtle text-center">
							No matches found.
						</div>
					) : (
						searchResults.map((hit) => (
							<div key={hit.id} className="px-4 py-3">
								<div className="flex items-center gap-2 mb-1">
									<span className="text-sm font-medium text-kumo-default">
										{hit.title || "Untitled"}
									</span>
									<Badge variant={hit.source === "semantic" ? "primary" : "secondary"}>
										{hit.source}
									</Badge>
								</div>
								<p className="text-xs text-kumo-subtle line-clamp-2">{hit.snippet}</p>
							</div>
						))
					)}
				</div>
			) : (
				<div className="border border-kumo-line rounded-lg divide-y divide-kumo-line">
					{entries.length === 0 ? (
						<div className="px-4 py-6 text-sm text-kumo-subtle text-center">
							No memory notes yet.
						</div>
					) : (
						entries.map((entry: MemoryEntry) => (
							<div key={entry.id} className="flex items-center gap-2.5 px-4 py-3">
								<input
									type="checkbox"
									checked={selectedIds.has(entry.id)}
									onChange={() => toggleSelect(entry.id)}
									onClick={(e) => e.stopPropagation()}
									aria-label="Select memory note"
								/>
								<button
									type="button"
									onClick={() => setPreviewId(entry.id)}
									className="flex items-center gap-2.5 flex-1 min-w-0 text-left bg-transparent border-0 p-0 cursor-pointer"
								>
									<div className="shrink-0">{SOURCE_TYPE_ICONS[entry.source_type]}</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="text-sm font-medium text-kumo-default block truncate">
												{entry.title || "Untitled"}
											</span>
											{entry.status === "processing" && (
												<Badge variant="secondary">Processing…</Badge>
											)}
											{entry.status === "error" && (
												<Tooltip content={entry.error_message || "Processing failed"} asChild>
													<Badge variant="destructive">Failed</Badge>
												</Tooltip>
											)}
											<Badge variant="secondary">{entry.source_kind.replace("_", " ")}</Badge>
										</div>
										<div className="flex items-center gap-2">
											{entry.tags && (
												<span className="text-xs text-kumo-subtle">{entry.tags}</span>
											)}
											{entry.word_count != null && (
												<span className="text-xs text-kumo-subtle">
													{formatCount(entry.word_count)} words
												</span>
											)}
										</div>
										<span className="text-[11px] text-kumo-subtle">
											{entry.draft_eligible ? "Available to drafts" : "Excluded from drafts"}
										</span>
									</div>
								</button>
								<Button
									variant="ghost"
									size="xs"
									onClick={() => updateMemoryMutation.mutate({ mailboxId: mailboxId!, id: entry.id, draft_eligible: !entry.draft_eligible })}
								>
									{entry.draft_eligible ? "Exclude" : "Include"}
								</Button>
								<Tooltip content="Delete" asChild>
									<Button
										variant="ghost"
										shape="square"
										size="sm"
										icon={<TrashIcon size={16} />}
										onClick={() => handleDelete(entry.id)}
										aria-label="Delete memory note"
									/>
								</Tooltip>
							</div>
						))
					)}
				</div>
			)}

			{/* Add Memory dialog */}
			<Dialog.Root
				open={isAddOpen}
				onOpenChange={(open) => {
					setIsAddOpen(open);
					if (!open) resetAddForm();
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						Add memory
					</Dialog.Title>
					<Tabs
						tabs={[
							{ value: "text", label: "Type note" },
							{ value: "file", label: "Upload file" },
							{ value: "drive", label: "Google Drive" },
						]}
						value={addTab}
						onValueChange={(v) => setAddTab(v as "text" | "file" | "drive")}
						className="mb-4"
					/>
					<form onSubmit={handleAdd} className="space-y-4">
						{addTab === "text" ? (
							<>
								<Input
									label="Title"
									placeholder="e.g. Refund policy"
									value={title}
									onChange={(e) => setTitle(e.target.value)}
									required
								/>
								<div>
									<label className="text-xs font-medium text-kumo-default mb-1 block">
										Content
									</label>
									<textarea
										value={content}
										onChange={(e) => setContent(e.target.value)}
										placeholder="Write the note content..."
										rows={6}
										required
										className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring"
									/>
								</div>
							</>
						) : addTab === "drive" ? (
							<div className="space-y-2">
								<label className="text-xs font-medium text-kumo-default">Google Drive file IDs</label>
								<textarea
									value={driveFileIds}
									onChange={(e) => setDriveFileIds(e.target.value)}
									placeholder="Paste file IDs separated by spaces or commas"
									rows={4}
									className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default"
								/>
								<p className="text-xs text-kumo-subtle">Files must be shared with the configured service account.</p>
							</div>
						) : (
							<div className="space-y-3">
								<div
									onDragOver={(e) => {
										e.preventDefault();
										setIsDragging(true);
									}}
									onDragLeave={() => setIsDragging(false)}
									onDrop={(e) => {
										e.preventDefault();
										setIsDragging(false);
										if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
									}}
									className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
										isDragging ? "border-kumo-brand bg-kumo-brand/5" : "border-kumo-line"
									}`}
								>
									<CloudArrowUpIcon size={24} className="mx-auto mb-2 text-kumo-subtle" />
									<input
										type="file"
										multiple
										hidden
										ref={fileInputRef}
										accept=".pdf,.docx,.txt,.md,.markdown,image/*"
										onChange={(e) => {
											if (e.target.files?.length) addFiles(e.target.files);
											e.target.value = "";
										}}
									/>
									<Button
										type="button"
										variant="secondary"
										size="sm"
										onClick={() => fileInputRef.current?.click()}
									>
										Choose files
									</Button>
									<p className="text-xs text-kumo-subtle mt-2">
										or drag and drop PDF, DOCX, text, markdown, or images here
									</p>
								</div>

								{stagedFiles.length > 0 && (
									<div className="space-y-2">
										{stagedFiles.map((sf, i) => (
											<div key={`${sf.file.name}-${i}`} className="flex items-center gap-2">
												<Input
													value={sf.title}
													onChange={(e) => updateStagedTitle(i, e.target.value)}
													className="flex-1"
												/>
												<Button
													type="button"
													variant="ghost"
													shape="square"
													size="sm"
													icon={<XIcon size={14} />}
													onClick={() => removeStaged(i)}
													aria-label="Remove file"
												/>
											</div>
										))}
									</div>
								)}
							</div>
						)}
						<Input
							label={addTab === "file" ? "Tags (applies to all files)" : "Tags (optional)"}
							placeholder="e.g. billing, policy"
							value={tags}
							onChange={(e) => setTags(e.target.value)}
						/>
						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								disabled={
									addTab === "text"
										? !title.trim() || !content.trim()
										: addTab === "drive" ? !driveFileIds.trim() : stagedFiles.length === 0
								}
								loading={addMemoryMutation.isPending || isUploadingBatch}
							>
								{addTab === "file" && stagedFiles.length > 1
									? `Add ${stagedFiles.length} files`
									: "Add"}
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* Bulk tag edit dialog */}
			<Dialog.Root open={isBulkTagsOpen} onOpenChange={setIsBulkTagsOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						Edit tags for {selectedIds.size} item(s)
					</Dialog.Title>
					<div className="space-y-4">
						<Input
							label="Tags"
							placeholder="e.g. billing, policy"
							value={bulkTags}
							onChange={(e) => setBulkTags(e.target.value)}
						/>
						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary">
										Cancel
									</Button>
								)}
							/>
							<Button variant="primary" loading={isBulkSaving} onClick={handleBulkTagsSave}>
								Save
							</Button>
						</div>
					</div>
				</Dialog>
			</Dialog.Root>

			{/* Preview dialog */}
			<Dialog.Root open={!!previewId} onOpenChange={(open) => !open && setPreviewId(null)}>
				<Dialog size="xl" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">
						{previewDetail?.title || "Untitled"}
					</Dialog.Title>
					<div className="flex items-center gap-3 text-xs text-kumo-subtle mb-4">
						<span>{formatCount(previewDetail?.word_count ?? null)} words</span>
						<span>{formatCount(previewDetail?.token_count ?? null)} tokens</span>
						{previewDetail?.source_kind && <span>{previewDetail.source_kind.replace("_", " ")}</span>}
						{previewDetail?.source_uri && (
							<a href={previewDetail.source_uri} target="_blank" rel="noreferrer" className="text-kumo-link hover:underline">
								Open source
							</a>
						)}
					</div>

					{previewDetail?.summary ? (
						<div className="rounded-lg bg-kumo-tint p-3 mb-4 text-sm text-kumo-default">
							{previewDetail.summary}
						</div>
					) : (
						<Button
							size="sm"
							variant="secondary"
							icon={<SparkleIcon size={14} />}
							loading={summarizeMemoryMutation.isPending}
							disabled={!previewDetail?.content?.trim()}
							onClick={handleGenerateSummary}
							className="mb-4"
						>
							Generate AI summary
						</Button>
					)}

					<div className="max-h-[60vh] overflow-y-auto rounded-lg border border-kumo-line p-4">
						<div className="prose prose-sm max-w-none">
							<Markdown remarkPlugins={[remarkGfm]}>{previewDetail?.content || ""}</Markdown>
						</div>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
