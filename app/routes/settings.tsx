// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader } from "@cloudflare/kumo";
import { RobotIcon, ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useFeedback } from "~/lib/feedback";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import { SecuritySettingsPanel } from "~/components/SecuritySettingsPanel";
import type { SecuritySettings } from "~/types";
import { TEXT_MODELS } from "shared/mailbox-settings";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const feedback = useFeedback();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [security, setSecurity] = useState<SecuritySettings | undefined>(undefined);
	const [autoDraftEnabled, setAutoDraftEnabled] = useState(true);
	const [modelChoice, setModelChoice] = useState<string>(TEXT_MODELS[0]);
	const [customModel, setCustomModel] = useState("");
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
			setSecurity(mailbox.settings?.security);

			const behavior = mailbox.settings as
				| { autoDraft?: { enabled?: boolean }; agentModel?: string }
				| undefined;
			const enabled = behavior?.autoDraft?.enabled;
			setAutoDraftEnabled(enabled === undefined ? true : enabled);

			const m = behavior?.agentModel ?? TEXT_MODELS[0];
			if (TEXT_MODELS.includes(m as (typeof TEXT_MODELS)[number])) {
				setModelChoice(m);
				setCustomModel("");
			} else {
				setModelChoice("__custom__");
				setCustomModel(m);
			}
		}
	}, [mailbox]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;

		const resolvedModel =
			modelChoice === "__custom__" ? customModel.trim() : modelChoice;
		if (modelChoice === "__custom__" && !resolvedModel) {
			feedback.error("Custom model cannot be empty");
			return;
		}
		if (resolvedModel && !resolvedModel.startsWith("@cf/")) {
			feedback.error("Model must start with @cf/");
			return;
		}

		setIsSaving(true);
		const settings = {
			...mailbox.settings,
			fromName: displayName,
			agentSystemPrompt: agentPrompt.trim() || undefined,
			security,
			autoDraft: { enabled: autoDraftEnabled },
			agentModel: resolvedModel || TEXT_MODELS[0],
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			feedback.success("Settings saved!");
		} catch {
			feedback.error("Failed to save settings");
		} finally {
			setIsSaving(false);
		}
	};

	const handleResetPrompt = () => {
		setAgentPrompt("");
	};

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="pp-serif text-ink mb-6">Settings</h1>

			<div className="space-y-6">
				{/* Account */}
				<div className="pp-card p-5">
					<div className="text-sm font-medium text-ink mb-4">
						Account
					</div>
					<div className="space-y-3">
						<Input
							label="Display Name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="Email" type="email" value={mailbox.email} disabled />
					</div>
				</div>

				{/* Agent System Prompt */}
				<div className="pp-card p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<RobotIcon size={16} weight="duotone" className="text-ink-3" />
							<span className="text-sm font-medium text-ink">
								AI Agent Prompt
							</span>
							{isCustomPrompt ? (
								<Badge variant="primary">Custom</Badge>
							) : (
								<Badge variant="secondary">Default</Badge>
							)}
						</div>
						{isCustomPrompt && (
							<Button
								variant="ghost"
								size="xs"
								icon={<ArrowCounterClockwiseIcon size={14} />}
								onClick={handleResetPrompt}
							>
								Reset to default
							</Button>
						)}
					</div>
					<p className="text-xs text-ink-3 mb-3">
						Customize how the AI agent behaves for this mailbox.
						Leave empty to use the built-in default prompt.
					</p>
					<textarea
						value={agentPrompt}
						onChange={(e) => setAgentPrompt(e.target.value)}
						placeholder={PROMPT_PLACEHOLDER}
						rows={12}
						className="w-full resize-y rounded-lg border border-line bg-paper-2 px-3 py-2 text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-accent font-mono leading-relaxed"
					/>
					<p className="text-xs text-ink-3 mt-2">
						The prompt is sent as the system message to the AI model.
						It controls the agent's personality, writing style, and behavior rules.
					</p>
				</div>

				{/* Behavior — auto-draft toggle + agent model picker */}
				<div className="pp-card p-5">
					<div className="text-sm font-medium text-ink mb-4">Behavior</div>

					<label className="flex items-start justify-between gap-3 mb-5">
						<span className="flex flex-col">
							<span className="text-sm text-ink">Auto-draft replies</span>
							<span className="text-xs text-ink-3 mt-1 max-w-md">
								Generate a draft reply automatically when new mail arrives.
								Drafts are never sent without explicit confirmation.
							</span>
						</span>
						<input
							type="checkbox"
							checked={autoDraftEnabled}
							onChange={(e) => setAutoDraftEnabled(e.target.checked)}
							className="mt-1 h-4 w-4 accent-accent shrink-0"
							aria-label="Auto-draft replies"
						/>
					</label>

					<div>
						<label htmlFor="agent-model-select" className="block text-sm text-ink mb-1.5">
							Agent model
						</label>
						<select
							id="agent-model-select"
							value={modelChoice}
							onChange={(e) => setModelChoice(e.target.value)}
							className="w-full rounded-md border border-line bg-paper-2 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent"
						>
							{TEXT_MODELS.map((m) => (
								<option key={m} value={m}>{m}</option>
							))}
							<option value="__custom__">Custom…</option>
						</select>
						{modelChoice === "__custom__" && (
							<input
								type="text"
								placeholder="@cf/your/model"
								value={customModel}
								onChange={(e) => setCustomModel(e.target.value)}
								className="mt-2 w-full rounded-md border border-line bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-accent"
							/>
						)}
						<p className="text-xs text-ink-3 mt-2">
							Used for chat and auto-draft. Custom values must start with{" "}
							<code className="pp-mono">@cf/</code>.
						</p>
					</div>
				</div>

				{/* Security */}
				<SecuritySettingsPanel value={security} onChange={setSecurity} />

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
