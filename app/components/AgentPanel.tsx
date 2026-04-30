// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Loader, Tooltip } from "@cloudflare/kumo";
import {
	ArrowUpIcon,
	RobotIcon,
	TrashIcon,
	UserIcon,
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
import { useFeedback } from "~/lib/feedback";
import type { UIMessage } from "ai";

const TOOL_LABELS: Record<string, { label: string; icon: React.ReactNode }> = {
	list_emails: {
		label: "Fetching emails",
		icon: <EnvelopeSimpleIcon size={14} weight="bold" />,
	},
	get_email: {
		label: "Reading email",
		icon: <EyeIcon size={14} weight="bold" />,
	},
	get_thread: {
		label: "Loading thread",
		icon: <ArrowBendUpLeftIcon size={14} weight="bold" />,
	},
	search_emails: {
		label: "Searching",
		icon: <MagnifyingGlassIcon size={14} weight="bold" />,
	},
	draft_email: {
		label: "Drafting email",
		icon: <PaperPlaneTiltIcon size={14} weight="bold" />,
	},
	draft_reply: {
		label: "Drafting reply",
		icon: <PaperPlaneTiltIcon size={14} weight="bold" />,
	},
	discard_draft: {
		label: "Discarding draft",
		icon: <TrashIcon size={14} weight="bold" />,
	},
	mark_email_read: {
		label: "Updating status",
		icon: <CheckCircleIcon size={14} weight="bold" />,
	},
	move_email: {
		label: "Moving email",
		icon: <EnvelopeSimpleIcon size={14} weight="bold" />,
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
		icon: <WrenchIcon size={14} weight="bold" />,
	};
	const isDone =
		state === "output-available" ||
		state === "result" ||
		state === "output-error";

	return (
		<div className="flex items-center gap-1.5 py-1 px-2 rounded bg-paper-3/50 text-xs">
			<span className="text-accent">{info.icon}</span>
			<span className="text-ink">{info.label}</span>
			{isDone ? (
				<CheckCircleIcon
					size={12}
					weight="fill"
					className="text-safe ml-auto"
				/>
			) : (
				<Loader size="sm" className="ml-auto" />
			)}
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
		<div
			className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}
		>
			<div
				className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
					isUser
						? "bg-accent text-accent-ink"
						: "bg-paper-3 text-ink"
				}`}
			>
				{isUser ? (
					<UserIcon size={12} weight="bold" />
				) : (
					<RobotIcon size={12} weight="bold" />
				)}
			</div>
			<div
				className={`flex flex-col gap-1 max-w-[85%] min-w-0 ${
					isUser ? "items-end" : "items-start"
				}`}
			>
				{message.parts.map((part, i) => {
					const key = `${message.id}-part-${i}`;
					if (part.type === "text" && part.text.trim()) {
						return (
							<div
								key={key}
								className={`rounded-lg px-3 py-2 text-[13px] leading-relaxed break-words overflow-wrap-anywhere ${
									isUser
										? "bg-accent text-accent-ink rounded-br-sm"
										: "bg-paper-3 text-ink border border-line rounded-bl-sm overflow-hidden"
								}`}
							>
								{isUser ? (
									part.text
								) : (
									<Markdown
										remarkPlugins={[remarkGfm]}
										components={{
											a: ({ href, children }) => (
												<a
													href={href}
													target="_blank"
													rel="noopener noreferrer"
													style={{
														color: "var(--color-link)",
														textDecoration: "underline",
													}}
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
												<strong className="font-semibold">
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
												<h3 className="font-semibold text-sm mb-1">
													{children}
												</h3>
											),
											h2: ({ children }) => (
												<h4 className="font-semibold text-[13px] mb-1">
													{children}
												</h4>
											),
											h3: ({ children }) => (
												<h5 className="font-semibold text-[13px] mb-0.5">
													{children}
												</h5>
											),
											code: ({ children }) => (
												<code className="bg-paper-3 pp-mono px-1 py-0.5 rounded text-[12px]">
													{children}
												</code>
											),
											table: ({ children }) => (
												<div className="overflow-x-auto my-2">
													<table className="w-full text-xs border-collapse">
														{children}
													</table>
												</div>
											),
											thead: ({ children }) => (
												<thead className="border-b border-line bg-paper-3/30">
													{children}
												</thead>
											),
											th: ({ children }) => (
												<th className="text-left px-2 py-1 font-semibold text-ink">
													{children}
												</th>
											),
											td: ({ children }) => (
												<td className="px-2 py-1 border-b border-line/50">
													{children}
												</td>
											),
										}}
									>
										{part.text}
									</Markdown>
								)}
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
	const feedback = useFeedback();

	const agent = useAgent({ agent: "EmailAgent", name: mailboxId });
	const { messages, sendMessage, status, setMessages, stop } =
		useAgentChat({
			agent,
			onError: (error) => {
				console.error("agent chat error:", error);
				feedback.error("Agent request failed. Try again.");
			},
		});
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
			<div className="flex items-center justify-between px-3 py-1.5 border-b border-line shrink-0">
				<div className="flex items-center gap-2">
					<Badge variant="beta">AI</Badge>
					<span className="text-xs text-ink-3">
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
			<div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4">
				{messages.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-full gap-4">
						<div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10">
							<RobotIcon
								size={24}
								weight="duotone"
								className="text-accent"
							/>
						</div>
						<p className="text-xs text-ink-3 text-center leading-relaxed px-4">
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
									className="text-left px-3 py-2 rounded-lg border border-line text-xs text-ink hover:bg-paper-2 hover:border-line-strong transition-colors cursor-pointer bg-transparent"
								>
									{prompt}
								</button>
							))}
						</div>
					</div>
				) : (
					<div className="flex flex-col gap-3">
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
							<div className="flex gap-2">
								<div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-paper-3 text-ink">
									<RobotIcon size={12} weight="bold" />
								</div>
								<div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-paper-3 border border-line rounded-bl-sm">
									<Loader size="sm" />
									<span className="text-xs text-ink-3">
										Thinking...
									</span>
								</div>
							</div>
						)}
					</div>
				)}
			</div>

			{/* Input */}
			<div className="shrink-0 border-t border-line px-3 py-2">
				{isStreaming ? (
					<div className="flex justify-center">
						<Button
							variant="secondary"
							size="sm"
							icon={<StopIcon size={14} weight="fill" />}
							onClick={() => stop()}
						>
							Stop generating
						</Button>
					</div>
				) : (
					<div className="flex items-end gap-1.5">
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
							className="flex-1 resize-none rounded-lg border border-line bg-paper-2 px-3 py-2 text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-accent min-h-[36px] max-h-[100px]"
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
				<span className="text-xs text-danger">{loadError}</span>
			</div>
		);
	}

	if (!hooks) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2">
				<Loader size="base" />
				<span className="text-xs text-ink-3">
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
