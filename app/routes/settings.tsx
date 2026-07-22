// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { RobotIcon, ArrowCounterClockwiseIcon, BrainIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "~/queries/keys";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import type { AiProviderSetting } from "~/types";

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
	const [aiProviderType, setAiProviderType] = useState<AiProviderSetting["type"]>("workers-ai");
	const [aiModel, setAiModel] = useState("");
	const [useAutoRag, setUseAutoRag] = useState(false);
	const [urgentDetection, setUrgentDetection] = useState(false);
	const [phishingDetection, setPhishingDetection] = useState(false);
	const [sensitiveInfoWarning, setSensitiveInfoWarning] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity,
	});
	const { data: connectedAccounts = [] } = useQuery({
		queryKey: queryKeys.productivity.accounts(mailboxId || ""),
		queryFn: () => api.listConnectedAccounts(mailboxId!),
		enabled: Boolean(mailboxId),
	});
	const openRouterConfigured = configData?.openRouterConfigured ?? false;

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
			setAiProviderType(mailbox.settings?.aiProvider?.type || "workers-ai");
			setAiModel(mailbox.settings?.aiProvider?.model || "");
			setUseAutoRag(mailbox.settings?.memory?.useAutoRag ?? false);
			setUrgentDetection(mailbox.settings?.safety?.urgentDetection ?? false);
			setPhishingDetection(mailbox.settings?.safety?.phishingDetection ?? false);
			setSensitiveInfoWarning(mailbox.settings?.safety?.sensitiveInfoWarning ?? false);
		}
	}, [mailbox]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		setIsSaving(true);
		const aiProvider: AiProviderSetting | undefined =
			aiModel.trim()
				? { type: aiProviderType, model: aiModel.trim() }
				: undefined;
		const settings = {
			...mailbox.settings,
			fromName: displayName,
			agentSystemPrompt: agentPrompt.trim() || undefined,
			aiProvider,
			memory: { useAutoRag },
			safety: { urgentDetection, phishingDetection, sensitiveInfoWarning },
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
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			<div className="space-y-6">
				{/* Account */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">
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

				{/* Provider connections */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between gap-3 mb-2">
						<div className="text-sm font-medium text-kumo-default">Connected providers</div>
						{configData?.microsoftConfigured && <Button size="sm" variant="secondary" onClick={() => api.startMicrosoftConnect(mailboxId!)}>Connect Outlook</Button>}
					</div>
					<p className="text-xs text-kumo-subtle mb-3">Outlook stays authoritative; this deployment caches selected mail and productivity context for search and briefing.</p>
					{connectedAccounts.length === 0 ? <div className="text-sm text-kumo-subtle">No Microsoft account connected.</div> : connectedAccounts.map((account) => (
						<div key={account.id} className="flex items-center justify-between rounded-md bg-kumo-recessed px-3 py-2 text-sm">
							<span className="text-kumo-default">{account.displayName || account.email || account.provider}</span>
							<Badge variant="secondary">{account.status}</Badge>
						</div>
					))}
				</div>

				{/* AI Model Provider */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center gap-2 mb-4">
						<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-medium text-kumo-default">
							AI Model
						</span>
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						Choose which AI provider and model to use for this mailbox.
					</p>
					<div className="space-y-3">
						<div>
							<label className="text-xs font-medium text-kumo-default mb-1 block">
								Provider
							</label>
							<select
								value={aiProviderType}
								onChange={(e) => setAiProviderType(e.target.value as AiProviderSetting["type"])}
								className="w-full rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring"
							>
								<option value="workers-ai">Cloudflare Workers AI</option>
								<option value="openrouter" disabled={!openRouterConfigured}>
									OpenRouter{!openRouterConfigured ? " (API key not configured)" : ""}
								</option>
							</select>
						</div>
						<Input
							label="Model ID"
							value={aiModel}
							onChange={(e) => setAiModel(e.target.value)}
							placeholder={aiProviderType === "workers-ai" ? "@cf/moonshotai/kimi-k2.5" : "anthropic/claude-sonnet-4"}
						/>
						<p className="text-xs text-kumo-subtle">
							{aiProviderType === "workers-ai"
								? "Enter a Workers AI model ID (e.g. @cf/moonshotai/kimi-k2.5). Leave empty for the default."
								: "Enter an OpenRouter model ID (e.g. anthropic/claude-sonnet-4, google/gemini-2.5-flash)."}
						</p>
					</div>
				</div>

				{/* Memory */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center gap-2 mb-4">
						<BrainIcon size={16} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-medium text-kumo-default">
							Memory
						</span>
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						The AI agent can search stored memory notes (policies, reference info) when drafting replies.
					</p>
					<label className="flex items-start gap-2 cursor-pointer">
						<input
							type="checkbox"
							checked={useAutoRag}
							onChange={(e) => setUseAutoRag(e.target.checked)}
							className="mt-0.5"
						/>
						<span className="text-sm text-kumo-default">
							Enable semantic search using Cloudflare AI Search
							<span className="block text-xs text-kumo-subtle">
								Requires an AI Search instance to be configured for this deployment. Keyword search always works regardless of this setting.
							</span>
						</span>
					</label>
					<div className="mt-3">
						<Link
							to={`/mailbox/${mailboxId}/memory`}
							className="text-xs text-kumo-brand hover:underline"
						>
							Manage memory notes →
						</Link>
					</div>
				</div>

				{/* Safety */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center gap-2 mb-4">
						<ShieldCheckIcon size={16} weight="duotone" className="text-kumo-subtle" />
						<span className="text-sm font-medium text-kumo-default">
							Safety
						</span>
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						AI classifiers that run on incoming and outgoing email. All are off by default — enabling
						these may skip auto-drafting for some emails, requiring you to reply manually.
					</p>
					<div className="space-y-3">
						<label className="flex items-start gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={urgentDetection}
								onChange={(e) => setUrgentDetection(e.target.checked)}
								className="mt-0.5"
							/>
							<span className="text-sm text-kumo-default">
								Detect urgent or distressed emails
								<span className="block text-xs text-kumo-subtle">
									Skips auto-draft for emails that seem to need your personal, immediate attention.
								</span>
							</span>
						</label>
						<label className="flex items-start gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={phishingDetection}
								onChange={(e) => setPhishingDetection(e.target.checked)}
								className="mt-0.5"
							/>
							<span className="text-sm text-kumo-default">
								Detect phishing or impersonation
								<span className="block text-xs text-kumo-subtle">
									Skips auto-draft for emails that look like phishing or impersonation attempts.
								</span>
							</span>
						</label>
						<label className="flex items-start gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={sensitiveInfoWarning}
								onChange={(e) => setSensitiveInfoWarning(e.target.checked)}
								className="mt-0.5"
							/>
							<span className="text-sm text-kumo-default">
								Warn before sending grades or student IDs
								<span className="block text-xs text-kumo-subtle">
									Flags outgoing replies that mention a specific grade, GPA, score, or student ID
									before you send — it does not block sending.
								</span>
							</span>
						</label>
					</div>
				</div>

				{/* Agent System Prompt */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">
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
					<p className="text-xs text-kumo-subtle mb-3">
						Customize how the AI agent behaves for this mailbox.
						Leave empty to use the built-in default prompt.
					</p>
					<textarea
						value={agentPrompt}
						onChange={(e) => setAgentPrompt(e.target.value)}
						placeholder={PROMPT_PLACEHOLDER}
						rows={12}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
					/>
					<p className="text-xs text-kumo-subtle mt-2">
						The prompt is sent as the system message to the AI model.
						It controls the agent's personality, writing style, and behavior rules.
					</p>
				</div>

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
