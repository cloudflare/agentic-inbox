// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Dialog, Input, Loader, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import { NoteIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useParams } from "react-router";
import {
	useCreateTemplate,
	useDeleteTemplate,
	useTemplateList,
	useUpdateTemplate,
} from "~/queries/templates";
import type { Template } from "~/types";

export default function TemplatesRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: templates = [], isLoading } = useTemplateList(mailboxId);
	const createTemplateMutation = useCreateTemplate();
	const updateTemplateMutation = useUpdateTemplate();
	const deleteTemplateMutation = useDeleteTemplate();

	const [isEditOpen, setIsEditOpen] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [tags, setTags] = useState("");

	const resetForm = () => {
		setEditingId(null);
		setTitle("");
		setBody("");
		setTags("");
	};

	const openCreate = () => {
		resetForm();
		setIsEditOpen(true);
	};

	const openEdit = (template: Template) => {
		setEditingId(template.id);
		setTitle(template.title);
		setBody(template.body);
		setTags(template.tags || "");
		setIsEditOpen(true);
	};

	const handleSave = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!mailboxId || !title.trim() || !body.trim()) return;
		try {
			if (editingId) {
				await updateTemplateMutation.mutateAsync({
					mailboxId,
					id: editingId,
					title: title.trim(),
					body: body.trim(),
					tags: tags.trim() || undefined,
				});
				toastManager.add({ title: "Template updated" });
			} else {
				await createTemplateMutation.mutateAsync({
					mailboxId,
					title: title.trim(),
					body: body.trim(),
					tags: tags.trim() || undefined,
				});
				toastManager.add({ title: "Template added" });
			}
			resetForm();
			setIsEditOpen(false);
		} catch {
			toastManager.add({ title: "Failed to save template", variant: "error" });
		}
	};

	const handleDelete = async (id: string) => {
		if (!mailboxId) return;
		try {
			await deleteTemplateMutation.mutateAsync({ mailboxId, id });
			toastManager.add({ title: "Template deleted" });
		} catch {
			toastManager.add({ title: "Failed to delete template", variant: "error" });
		}
	};

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<div className="flex items-center justify-between mb-6">
				<div className="flex items-center gap-2">
					<NoteIcon size={20} weight="duotone" className="text-kumo-subtle" />
					<h1 className="text-lg font-semibold text-kumo-default">Templates</h1>
				</div>
				<Button variant="primary" icon={<PlusIcon size={16} />} onClick={openCreate}>
					Add Template
				</Button>
			</div>

			<p className="text-xs text-kumo-subtle mb-4">
				Canned responses you can insert into replies from the compose panel.
			</p>

			{isLoading ? (
				<div className="flex justify-center py-20">
					<Loader size="lg" />
				</div>
			) : (
				<div className="border border-kumo-line rounded-lg divide-y divide-kumo-line">
					{templates.length === 0 ? (
						<div className="px-4 py-6 text-sm text-kumo-subtle text-center">
							No templates yet.
						</div>
					) : (
						templates.map((template) => (
							<div key={template.id} className="flex items-center gap-2.5 px-4 py-3">
								<div className="min-w-0 flex-1">
									<span className="text-sm font-medium text-kumo-default block truncate">
										{template.title}
									</span>
									<p className="text-xs text-kumo-subtle line-clamp-1">{template.body}</p>
									{template.tags && (
										<span className="text-xs text-kumo-subtle">{template.tags}</span>
									)}
								</div>
								<Tooltip content="Edit" asChild>
									<Button
										variant="ghost"
										shape="square"
										size="sm"
										icon={<PencilSimpleIcon size={16} />}
										onClick={() => openEdit(template)}
										aria-label="Edit template"
									/>
								</Tooltip>
								<Tooltip content="Delete" asChild>
									<Button
										variant="ghost"
										shape="square"
										size="sm"
										icon={<TrashIcon size={16} />}
										onClick={() => handleDelete(template.id)}
										aria-label="Delete template"
									/>
								</Tooltip>
							</div>
						))
					)}
				</div>
			)}

			<Dialog.Root
				open={isEditOpen}
				onOpenChange={(open) => {
					setIsEditOpen(open);
					if (!open) resetForm();
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						{editingId ? "Edit template" : "Add template"}
					</Dialog.Title>
					<form onSubmit={handleSave} className="space-y-4">
						<Input
							label="Title"
							placeholder="e.g. Office hours reminder"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							required
						/>
						<div>
							<label className="text-xs font-medium text-kumo-default mb-1 block">
								Body
							</label>
							<textarea
								value={body}
								onChange={(e) => setBody(e.target.value)}
								placeholder="Write the template content..."
								rows={6}
								required
								className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring"
							/>
						</div>
						<Input
							label="Tags (optional)"
							placeholder="e.g. office-hours, deadline"
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
								disabled={!title.trim() || !body.trim()}
								loading={createTemplateMutation.isPending || updateTemplateMutation.isPending}
							>
								{editingId ? "Save" : "Add"}
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
