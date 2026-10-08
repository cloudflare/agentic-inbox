// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader, Tooltip } from "@cloudflare/kumo";
import {
	ArrowUpIcon,
	RobotIcon,
	TrashIcon,
	EnvelopeSimpleIcon,
	MagnifyingGlassIcon,
	PaperPlaneTiltIcon,
	EyeIcon,
	ArrowBendUpLeftIcon,
	WrenchIcon,
	CheckCircleIcon,
	StopIcon,
	PencilSimpleIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useUIStore } from "~/hooks/useUIStore";
import type { UIMessage } from "ai";

const TOOL_LABELS: Record<string, { label: string; icon: React.ReactNode }> = {
	list_emails: {
		label: "Fetching emails",
		icon: <EnvelopeSimpleIcon size={13} />,
	},
	get_email: {
		label: "Reading email",
		icon: <EyeIcon size={13} />,
	},
	get_thread: {
		label: "Loading thread",
		icon: <ArrowBendUpLeftIcon size={13} />,
	},
	search_emails: {
		label: "Searching",
		icon: <MagnifyingGlassIcon size={13} />,
	},
	draft_email: {
		label: "Drafting email",
		icon: <PaperPlaneTiltIcon size={13} />,
	},
	draft_reply: {
		label: "Drafting reply",
		icon: <PaperPlaneTiltIcon size={13} />,
	},
	discard_draft: {
		label: "Discarding draft",
		icon: <TrashIcon size={13} />,
	},
	mark_email_read: {
		label: "Updating status",
		icon: <CheckCircleIcon size={13} />,
	},
	move_email: {
		label: "Moving email",
		icon: <EnvelopeSimpleIcon size={13} />,
	},
};

function ToolCallBadge({
	toolName,
	state,
}: {
	toolName: string;
	state: string;
}) {
	const info = TOOL_LABELS[toolName] || {
		label: toolName,
		icon: <WrenchIcon size={13} />,
	};
	const isDone =
		state === "output-available" ||
		state === "result" ||
		state === "output-error";

	return (
		<div className="inline-flex items-center gap-1.5 rounded-full bg-kumo-fill px-2.5 py-1 text-xs text-kumo-strong">
			<span className="flex text-kumo-subtle">{info.icon}</span>
			<span>{info.label}</span>
			{isDone ? (
				<CheckCircleIcon
					size={12}
					weight="fill"
					className="text-kumo-success"
				/>
			) : (
				<Loader size="sm" />
			)}
		</div>
	);
}

const AUTO_TRIGGER_PREFIX = "[Auto-triggered]";

function AgentAvatar() {
	return (
		<div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-kumo-accent-soft text-kumo-accent">
			<RobotIcon size={13} />
		</div>
	);
}

function getToolNameFromPart(part: UIMessage["parts"][number]): string | null {
	if (part.type === "dynamic-tool") return (part as any).toolName ?? null;
	if (part.type.startsWith("tool-")) return part.type.replace("tool-", "");
	return null;
}

function hasDraftReplyTool(message: UIMessage): boolean {
	return message.parts.some((part) => {
		const toolName = getToolNameFromPart(part);
		return toolName === "draft_reply";
	});
}

function DraftActions({
	onEdit,
	disabled,
}: {
	onEdit: () => void;
	disabled: boolean;
}) {
	return (
		<div className="flex gap-1.5 mt-1">
			<Button
				variant="primary"
				size="sm"
				className="rounded-lg"
				icon={<PencilSimpleIcon size={14} />}
				onClick={onEdit}
				disabled={disabled}
			>
				Edit & send in composer
			</Button>
		</div>
	);
}

function MessageBubble({
	message,
	onAction,
	isStreaming,
}: {
	message: UIMessage;
	onAction?: (action: string) => void;
	isStreaming: boolean;
}) {
	const isUser = message.role === "user";

	return (
		<div className={`flex gap-2.5 ${isUser ? "justify-end" : ""}`}>
			{!isUser && <AgentAvatar />}
			<div
				className={`flex flex-col gap-1.5 min-w-0 ${
					isUser ? "w-full items-end" : "flex-1 items-start"
				}`}
			>
				{message.parts.map((part, i) => {
					const key = `${message.id}-part-${i}`;
					if (part.type === "text" && part.text.trim()) {
						if (isUser && part.text.startsWith(AUTO_TRIGGER_PREFIX)) {
							return (
								<div
									key={key}
									className="flex w-full items-start gap-2 text-xs text-kumo-subtle"
								>
									<span className="shrink-0 rounded-full bg-kumo-fill px-2 py-0.5 text-[11px] font-medium text-kumo-strong">
										Auto
									</span>
									<span className="min-w-0 pt-0.5 leading-relaxed break-words wrap-anywhere">
										{part.text
											.slice(AUTO_TRIGGER_PREFIX.length)
											.trim()}
									</span>
								</div>
							);
						}
						if (isUser) {
							return (
								<div
									key={key}
									className="ml-auto max-w-[85%] rounded-xl rounded-br-md bg-kumo-selected px-3.5 py-2.5 text-sm leading-relaxed text-kumo-default whitespace-pre-wrap break-words wrap-anywhere"
								>
									{part.text}
								</div>
							);
						}
						return (
							<div
								key={key}
								className="w-full min-w-0 pt-px text-sm leading-relaxed text-kumo-default break-words"
							>
								<Markdown
									remarkPlugins={[remarkGfm]}
									components={{
										a: ({ href, children }) => (
											<a
												href={href}
												target="_blank"
												rel="noopener noreferrer"
												className="text-kumo-link underline underline-offset-2"
											>
												{children}
											</a>
										),
										p: ({ children }) => (
											<p className="mb-2 last:mb-0">
												{children}
											</p>
										),
										strong: ({ children }) => (
											<strong className="font-medium">
												{children}
											</strong>
										),
										ul: ({ children }) => (
											<ul className="list-disc pl-4 mb-2 last:mb-0 space-y-0.5">
												{children}
											</ul>
										),
										ol: ({ children }) => (
											<ol className="list-decimal pl-4 mb-2 last:mb-0 space-y-0.5">
												{children}
											</ol>
										),
										li: ({ children }) => (
											<li>{children}</li>
										),
										h1: ({ children }) => (
											<h3 className="font-medium text-sm mb-1">
												{children}
											</h3>
										),
										h2: ({ children }) => (
											<h4 className="font-medium text-sm mb-1">
												{children}
											</h4>
										),
										h3: ({ children }) => (
											<h5 className="font-medium text-sm mb-0.5">
												{children}
											</h5>
										),
										pre: ({ children }) => (
											<pre className="my-2 overflow-x-auto rounded-lg bg-kumo-tint px-3 py-2 font-mono text-xs [&_code]:bg-transparent [&_code]:p-0">
												{children}
											</pre>
										),
										code: ({ children }) => (
											<code className="rounded-md bg-kumo-fill px-1 py-0.5 font-mono text-[12px]">
												{children}
											</code>
										),
										table: ({ children }) => (
											<div className="overflow-x-auto my-2 rounded-lg border border-kumo-line">
												<table className="w-full text-xs border-collapse [&_tbody_tr:last-child>td]:border-b-0">
													{children}
												</table>
											</div>
										),
										thead: ({ children }) => (
											<thead className="border-b border-kumo-line bg-kumo-tint">
												{children}
											</thead>
										),
										th: ({ children }) => (
											<th className="text-left px-2 py-1 font-medium text-kumo-strong">
												{children}
											</th>
										),
										td: ({ children }) => (
											<td className="px-2 py-1 border-b border-kumo-line">
												{children}
											</td>
										),
									}}
								>
									{part.text}
								</Markdown>
							</div>
						);
					}
					const toolName = getToolNameFromPart(part);
					if (toolName) {
						return (
							<ToolCallBadge
								key={key}
								toolName={toolName}
								state={(part as any).state ?? "running"}
							/>
						);
					}
					return null;
				})}
				{/* Show action buttons for draft replies */}
				{!isUser && hasDraftReplyTool(message) && onAction && (
					<DraftActions
						onEdit={() => onAction("edit")}
						disabled={isStreaming}
					/>
				)}
			</div>
		</div>
	);
}

function AgentChatConnected({
	mailboxId,
	useAgent,
	useAgentChat,
}: {
	mailboxId: string;
	useAgent: typeof import("agents/react").useAgent;
	useAgentChat: typeof import("@cloudflare/ai-chat/react").useAgentChat;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const [inputValue, setInputValue] = useState("");
	const { startCompose } = useUIStore();

	const agent = useAgent({ agent: "EmailAgent", name: mailboxId });
	const { messages, sendMessage, status, setMessages, stop } =
		useAgentChat({ agent });
	const isStreaming = status === "streaming" || status === "submitted";

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const handleSend = () => {
		const text = inputValue.trim();
		if (!text || isStreaming) return;
		setInputValue("");
		sendMessage({ text });
		if (inputRef.current) inputRef.current.style.height = "auto";
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	const suggestedPrompts = [
		"Show me the latest inbox emails",
		"Any unread emails?",
		"Draft a response to the latest email",
	];

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex h-12 items-center justify-between px-3 border-b border-kumo-line shrink-0">
				<div className="flex items-center gap-2">
					<span className="rounded-full bg-kumo-accent-soft px-2 py-0.5 text-[11px] font-medium text-kumo-accent">
						AI
					</span>
					<span className="text-xs text-kumo-subtle">
						Email Agent
					</span>
				</div>
				<div className="flex items-center gap-1">
					{isStreaming && <Loader size="sm" />}
					{messages.length > 0 && (
						<Tooltip content="Clear chat" asChild>
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								icon={<TrashIcon size={14} />}
								onClick={() => {
									if (window.confirm("Clear chat history?")) {
										setMessages([]);
									}
								}}
								aria-label="Clear chat"
							/>
						</Tooltip>
					)}
				</div>
			</div>

			{/* Messages */}
			<div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
				{messages.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-full gap-4">
						<div className="flex size-10 items-center justify-center rounded-xl bg-kumo-accent-soft text-kumo-accent">
							<RobotIcon size={20} />
						</div>
						<p className="text-sm text-kumo-subtle text-center leading-relaxed px-4">
							I can read emails, search conversations, and draft
							replies.
						</p>
						<div className="flex flex-col gap-1.5 w-full">
							{suggestedPrompts.map((prompt) => (
								<button
									key={prompt}
									type="button"
									onClick={() =>
										sendMessage({ text: prompt })
									}
									className="text-left px-3 py-2 rounded-lg border border-kumo-line text-sm text-kumo-strong hover:bg-kumo-tint hover:text-kumo-default transition-colors cursor-pointer bg-transparent"
								>
									{prompt}
								</button>
							))}
						</div>
					</div>
				) : (
					<div className="flex flex-col gap-4">
						{messages.map((msg) => (
							<MessageBubble
								key={msg.id}
								message={msg}
								isStreaming={isStreaming}
							onAction={(action) => {
								if (action === "edit") {
										// Extract draft data from the draft_reply tool result
										let draftData: {
											to?: string;
											subject?: string;
											body?: string;
											id?: string;
										} | null = null;
										for (const part of msg.parts) {
											if (
												(part as any).toolName === "draft_reply" &&
												(part as any).result
											) {
												draftData = (part as any).result;
												break;
											}
										}
										if (draftData) {
											const draftEmail = {
												id: draftData.id || "",
												subject: draftData.subject || "",
												sender: mailboxId,
												recipient: draftData.to || "",
												date: new Date().toISOString(),
												read: true,
												starred: false,
												body: draftData.body || "",
											};
											startCompose({
												mode: "reply",
												originalEmail: null,
												draftEmail,
											});
										} else {
											sendMessage({
												text: "Let me edit this draft first. Show me what you have so I can modify it.",
											});
										}
									}
								}}
							/>
						))}
						{isStreaming && (
							<div className="flex items-center gap-2.5">
								<AgentAvatar />
								<div className="flex items-center gap-1.5">
									<Loader size="sm" />
									<span className="text-xs text-kumo-subtle">
										Thinking...
									</span>
								</div>
							</div>
						)}
					</div>
				)}
			</div>

			{/* Input */}
			<div className="shrink-0 border-t border-kumo-line p-3">
				{isStreaming ? (
					<div className="flex justify-center">
						<Button
							variant="secondary"
							size="sm"
							className="rounded-lg"
							icon={<StopIcon size={14} weight="fill" />}
							onClick={() => stop()}
						>
							Stop generating
						</Button>
					</div>
				) : (
					<div className="flex items-end gap-2 rounded-xl border border-transparent bg-kumo-tint py-1.5 pl-3 pr-1.5 transition-colors focus-within:border-kumo-ring focus-within:bg-kumo-base">
						<textarea
							ref={inputRef}
							id="agent-chat-input"
							name="agent-chat-input"
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Ask your email agent..."
							rows={1}
							aria-label="Chat message input"
							className="flex-1 resize-none border-0 bg-transparent py-1.5 text-sm leading-5 text-kumo-default placeholder:text-kumo-subtle focus:outline-none min-h-8 max-h-[100px]"
							style={{ height: "auto", overflow: "hidden" }}
							onInput={(e) => {
								const t = e.target as HTMLTextAreaElement;
								t.style.height = "auto";
								t.style.height = `${Math.min(t.scrollHeight, 100)}px`;
								t.style.overflow =
									t.scrollHeight > 100 ? "auto" : "hidden";
							}}
						/>
						<Button
							variant="primary"
							shape="square"
							size="sm"
							className="size-8 rounded-lg"
							disabled={!inputValue.trim()}
							icon={<ArrowUpIcon size={14} weight="bold" />}
							onClick={handleSend}
							aria-label="Send message"
						/>
					</div>
				)}
			</div>
		</div>
	);
}

export default function AgentPanel() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const [hooks, setHooks] = useState<{
		useAgent: typeof import("agents/react").useAgent;
		useAgentChat: typeof import("@cloudflare/ai-chat/react").useAgentChat;
	} | null>(null);

	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		Promise.all([
			import("agents/react"),
			import("@cloudflare/ai-chat/react"),
		]).then(([a, c]) =>
			setHooks({
				useAgent: a.useAgent,
				useAgentChat: c.useAgentChat,
			}),
		).catch((err) => {
			console.error("Failed to load agent modules:", err);
			setLoadError("Failed to connect to agent. Reload to retry.");
		});
	}, []);

	if (loadError) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
				<span className="text-xs text-kumo-danger">{loadError}</span>
			</div>
		);
	}

	if (!hooks) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2">
				<Loader size="base" />
				<span className="text-xs text-kumo-subtle">
					Connecting...
				</span>
			</div>
		);
	}

	return (
		<AgentChatConnected
			mailboxId={mailboxId ?? "default"}
			useAgent={hooks.useAgent}
			useAgentChat={hooks.useAgentChat}
		/>
	);
}
