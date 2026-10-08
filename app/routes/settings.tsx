// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { RobotIcon, ArrowCounterClockwiseIcon, UserCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
		}
	}, [mailbox]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		setIsSaving(true);
		const settings = {
			...mailbox.settings,
			fromName: displayName,
			agentSystemPrompt: agentPrompt.trim() || undefined,
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved!" });
		} catch {
			toastManager.add({
				title: "Failed to save settings",
				variant: "error",
			});
		} finally {
			setIsSaving(false);
		}
	};

	const handleResetPrompt = () => {
		setAgentPrompt("");
	};

	if (!mailbox) {
		return (
			<div className="flex h-full justify-center bg-kumo-recessed py-20">
				<Loader size="lg" className="text-kumo-subtle" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;

	return (
		<div className="h-full overflow-y-auto bg-kumo-recessed">
			<div className="mx-auto max-w-2xl space-y-6 px-4 py-6 md:px-6 md:py-8">
				<h1 className="text-xl font-medium tracking-tight text-kumo-default">
					Settings
				</h1>

				{/* Account */}
				<section className="rounded-xl border border-kumo-line bg-kumo-base p-5">
					<div className="mb-4 flex items-center gap-2">
						<UserCircleIcon size={16} className="shrink-0 text-kumo-subtle" />
						<h2 className="text-sm font-medium text-kumo-default">
							Account
						</h2>
					</div>
					<div className="space-y-3">
						<Input
							label="Display Name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="Email" type="email" value={mailbox.email} disabled />
					</div>
				</section>

				{/* Agent System Prompt */}
				<section className="rounded-xl border border-kumo-line bg-kumo-base p-5">
					<div className="mb-4 flex items-start justify-between gap-3">
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<RobotIcon size={16} className="shrink-0 text-kumo-subtle" />
								<h2 className="text-sm font-medium text-kumo-default">
									AI Agent Prompt
								</h2>
								{isCustomPrompt ? (
									<span className="rounded-full bg-kumo-accent-soft px-2 py-0.5 text-[11px] font-medium text-kumo-accent">
										Custom
									</span>
								) : (
									<span className="rounded-full bg-kumo-fill px-2 py-0.5 text-[11px] font-medium text-kumo-strong">
										Default
									</span>
								)}
							</div>
							<p className="mt-1.5 text-xs text-kumo-subtle">
								Customize how the AI agent behaves for this mailbox.
								Leave empty to use the built-in default prompt.
							</p>
						</div>
						{isCustomPrompt && (
							<Button
								variant="ghost"
								size="xs"
								icon={<ArrowCounterClockwiseIcon size={14} />}
								onClick={handleResetPrompt}
								className="shrink-0"
							>
								Reset to default
							</Button>
						)}
					</div>
					<textarea
						value={agentPrompt}
						onChange={(e) => setAgentPrompt(e.target.value)}
						placeholder={PROMPT_PLACEHOLDER}
						rows={12}
						className="w-full resize-y rounded-lg bg-kumo-control px-3 py-2.5 font-mono text-xs leading-relaxed text-kumo-default ring ring-kumo-line transition-shadow placeholder:text-kumo-subtle focus:outline-none focus:ring-kumo-ring"
					/>
					<p className="mt-2 text-xs text-kumo-subtle">
						The prompt is sent as the system message to the AI model.
						It controls the agent's personality, writing style, and behavior rules.
					</p>
				</section>

				{/* Save */}
				<div className="flex justify-end">
					<Button variant="primary" onClick={handleSave} loading={isSaving}>
						Save Changes
					</Button>
				</div>
			</div>
		</div>
	);
}
