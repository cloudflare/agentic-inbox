// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, Popover } from "@cloudflare/kumo";
import { NoteIcon, SparkleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { textToHtml } from "~/lib/utils";
import { useTemplateList } from "~/queries/templates";
import { useMemoryContext } from "~/queries/memory";
import api from "~/services/api";

interface ComposeAIBarProps {
	mailboxId: string;
	body: string;
	subject?: string;
	to?: string;
	onRewrite: (newBody: string) => void;
}

const QUICK_ACTIONS = [
	{ action: "polish", label: "Polish" },
	{ action: "formalize", label: "Formalize" },
	{ action: "friendly", label: "Friendly" },
	{ action: "shorten", label: "Shorten" },
] as const;

/** Whether the current body is empty or just an empty paragraph placeholder. */
function isBodyEmpty(body: string): boolean {
	return !body || body.trim() === "" || body.trim() === "<p><br></p>";
}

/** AI compose bar with custom instruction input, quick-action buttons, and a template inserter. */
export function ComposeAIBar({ mailboxId, body, subject = "", to = "", onRewrite }: ComposeAIBarProps) {
	const [instruction, setInstruction] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [activeAction, setActiveAction] = useState<string | null>(null);
	const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
	const { data: templates = [] } = useTemplateList(mailboxId);
	const contextQuery = [subject, to, body.replace(/<[^>]*>/g, " ")].join(" ").trim();
	const { data: context, isFetching: isContextLoading } = useMemoryContext(mailboxId, contextQuery);

	const handleRewrite = async (action: string, customInstruction?: string) => {
		if (!body.trim() || isLoading) return;
		setIsLoading(true);
		setActiveAction(action);
		try {
			const result = await api.rewriteEmailBody(
				mailboxId,
				body,
				action,
				customInstruction,
			);
			onRewrite(result.body);
			if (action === "custom") setInstruction("");
		} finally {
			setIsLoading(false);
			setActiveAction(null);
		}
	};

	const handleCustomSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!instruction.trim()) return;
		handleRewrite("custom", instruction.trim());
	};

	const handleInsertTemplate = (templateBody: string) => {
		const html = textToHtml(templateBody);
		onRewrite(isBodyEmpty(body) ? html : `${body}${html}`);
		setIsTemplatesOpen(false);
	};

	return (
		<div className="flex items-center gap-2 px-3 py-2 border-t border-kumo-line bg-kumo-fill/30">
			<SparkleIcon size={14} className="text-kumo-subtle shrink-0" />
			<form onSubmit={handleCustomSubmit} className="flex items-center gap-2 flex-1 min-w-0">
				<div className="flex-1 min-w-0">
					<Input
						size="sm"
						placeholder="Describe your change..."
						value={instruction}
						onChange={(e) => setInstruction(e.target.value)}
						disabled={isLoading}
					/>
				</div>
				{QUICK_ACTIONS.map(({ action, label }) => (
					<Button
						key={action}
						type="button"
						variant="ghost"
						size="sm"
						disabled={isLoading || !body.trim()}
						onClick={() => handleRewrite(action)}
					>
						{isLoading && activeAction === action ? <Loader size="sm" /> : label}
					</Button>
				))}
			</form>
			<Popover open={isTemplatesOpen} onOpenChange={setIsTemplatesOpen}>
				<Popover.Trigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						icon={<NoteIcon size={14} />}
						className="shrink-0"
					>
						Templates
					</Button>
				</Popover.Trigger>
				<Popover.Content side="top" align="end" className="w-64 p-1">
					{templates.length === 0 ? (
						<p className="text-xs text-kumo-subtle px-2 py-1.5">No templates yet.</p>
					) : (
						<div className="max-h-64 overflow-y-auto">
							{templates.map((template) => (
								<button
									key={template.id}
									type="button"
									onClick={() => handleInsertTemplate(template.body)}
									className="w-full text-left px-2 py-1.5 rounded text-xs text-kumo-default hover:bg-kumo-tint bg-transparent border-0 cursor-pointer truncate"
								>
									{template.title}
								</button>
							))}
						</div>
					)}
				</Popover.Content>
			</Popover>
			<Popover>
				<Popover.Trigger asChild>
					<Button type="button" variant="ghost" size="sm" className="shrink-0">
						Sources{context?.sources.length ? ` (${context.sources.length})` : ""}
					</Button>
				</Popover.Trigger>
				<Popover.Content side="top" align="end" className="w-80 p-3">
					<div className="flex items-center justify-between mb-2">
						<span className="text-xs font-semibold text-kumo-default">Memory context</span>
						{isContextLoading && <Loader size="sm" />}
					</div>
					{context?.warnings.map((warning) => <p key={warning} className="text-xs text-kumo-warning mb-2">{warning}</p>)}
					{context?.sources.length ? context.sources.map((source) => (
						<div key={`${source.id}-${source.citation}`} className="border-t border-kumo-line pt-2 mt-2">
							<div className="flex items-center gap-2 mb-1">
								<span className="text-xs font-medium text-kumo-default truncate">{source.citation}</span>
								<Badge variant={source.source === "semantic" ? "primary" : "secondary"}>{source.source}</Badge>
							</div>
							<p className="text-xs text-kumo-subtle line-clamp-3">{source.excerpt}</p>
						</div>
					)) : <p className="text-xs text-kumo-subtle">No relevant memory found yet.</p>}
				</Popover.Content>
			</Popover>
		</div>
	);
}
