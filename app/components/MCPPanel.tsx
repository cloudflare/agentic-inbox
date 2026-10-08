// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import {
	CheckIcon,
	CopyIcon,
	PlugsIcon,
	WrenchIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useParams } from "react-router";

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard API unavailable or permission denied — ignore silently
		}
	};

	return (
		<Tooltip content={copied ? "Copied!" : "Copy"} asChild>
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				className="rounded-lg text-kumo-subtle hover:bg-kumo-fill-hover hover:text-kumo-default"
				icon={
					copied ? (
						<CheckIcon size={14} weight="bold" className="text-kumo-success" />
					) : (
						<CopyIcon size={14} />
					)
				}
				onClick={handleCopy}
				aria-label="Copy to clipboard"
			/>
		</Tooltip>
	);
}

const TOOLS = [
	{ name: "list_mailboxes", desc: "List all mailboxes" },
	{ name: "list_emails", desc: "List emails in a folder" },
	{ name: "get_email", desc: "Read a full email with body" },
	{ name: "get_thread", desc: "Load a conversation thread" },
	{ name: "search_emails", desc: "Search emails by query" },
	{ name: "draft_reply", desc: "Draft a reply to an email" },
	{ name: "send_reply", desc: "Send a reply" },
	{ name: "send_email", desc: "Send a new email" },
	{ name: "mark_email_read", desc: "Mark email as read/unread" },
	{ name: "move_email", desc: "Move email to a folder" },
];

export default function MCPPanel() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const baseUrl =
		typeof window !== "undefined" ? window.location.origin : "https://your-app.workers.dev";
	const mcpUrl = `${baseUrl}/mcp`;

	return (
		<div className="flex flex-col h-full">
			{/* Content */}
			<div className="flex-1 overflow-y-auto p-3 space-y-3">
				{/* Intro */}
				<div className="rounded-xl border border-kumo-line bg-kumo-base p-4 space-y-3">
					<div className="flex items-center gap-3">
						<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-kumo-accent-soft text-kumo-accent">
							<PlugsIcon size={18} />
						</div>
						<div className="min-w-0">
							<h3 className="text-sm font-medium text-kumo-default">
								Connect via MCP
							</h3>
							<p className="text-xs text-kumo-subtle">
								Model Context Protocol
							</p>
						</div>
					</div>
					<p className="text-xs text-kumo-subtle leading-relaxed">
						This email agent exposes an MCP server so AI coding
						assistants can manage your inbox directly — read emails,
						search, draft replies, and send messages using natural
						language.
					</p>
				</div>

				{/* MCP URL */}
				<div className="rounded-xl border border-kumo-line bg-kumo-base p-4 space-y-2">
					<label className="text-xs font-medium text-kumo-strong block">
						Server URL
					</label>
					<div className="relative group">
						<div className="absolute right-1 top-1/2 -translate-y-1/2">
							<CopyButton text={mcpUrl} />
						</div>
						<div className="rounded-lg bg-kumo-tint font-mono text-xs text-kumo-default px-3 py-2 pr-10 break-all leading-relaxed">
							{mcpUrl}
						</div>
					</div>
				</div>

				{/* Available tools */}
				<div className="rounded-xl border border-kumo-line bg-kumo-base p-4">
					<h4 className="text-xs font-medium text-kumo-subtle mb-1">
						Available Tools
					</h4>
					<div className="divide-y divide-kumo-line">
						{TOOLS.map((tool) => (
							<div
								key={tool.name}
								className="flex items-center gap-2.5 py-2 last:pb-0"
							>
								<WrenchIcon
									size={12}
									className="text-kumo-subtle shrink-0"
								/>
								<span className="shrink-0 text-xs font-mono text-kumo-default">
									{tool.name}
								</span>
								<span className="ml-auto min-w-0 truncate text-right text-xs text-kumo-subtle">
									{tool.desc}
								</span>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
