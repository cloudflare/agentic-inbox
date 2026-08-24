// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file and at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { RobotIcon, ArrowCounterClockwiseIcon, PaperPlaneTiltIcon, TelegramLogoIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";

const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [forwardEnabled, setForwardEnabled] = useState(false);
	const [forwardEmail, setForwardEmail] = useState("");
	const [forwardInternal, setForwardInternal] = useState(true);
	const [telegramEnabled, setTelegramEnabled] = useState(false);
	const [telegramToken, setTelegramToken] = useState("");
	const [telegramChatId, setTelegramChatId] = useState("");
	const [telegramInternal, setTelegramInternal] = useState(true);
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (!mailbox) return;
		setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
		setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
		setForwardEnabled(mailbox.settings?.forwarding?.enabled === true);
		setForwardEmail(mailbox.settings?.forwarding?.email || "");
		setForwardInternal(mailbox.settings?.forwarding?.includeInternal !== false);
		setTelegramEnabled(mailbox.settings?.telegram?.enabled === true);
		setTelegramToken(mailbox.settings?.telegram?.botToken || "");
		setTelegramChatId(mailbox.settings?.telegram?.chatId || "");
		setTelegramInternal(mailbox.settings?.telegram?.includeInternal !== false);
	}, [mailbox]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		if (forwardEnabled && !forwardEmail.trim()) {
			toastManager.add({ title: "Enter a forwarding email address", variant: "error" });
			return;
		}
		if (telegramEnabled && (!telegramToken.trim() || !telegramChatId.trim())) {
			toastManager.add({ title: "Enter the Telegram Bot Token and Chat ID", variant: "error" });
			return;
		}
		setIsSaving(true);
		const settings = {
			...mailbox.settings,
			fromName: displayName,
			agentSystemPrompt: agentPrompt.trim() || undefined,
			forwarding: {
				...mailbox.settings?.forwarding,
				enabled: forwardEnabled,
				email: forwardEmail.trim().toLowerCase(),
				includeInternal: forwardInternal,
			},
			telegram: {
				...mailbox.settings?.telegram,
				enabled: telegramEnabled,
				botToken: telegramToken.trim(),
				chatId: telegramChatId.trim(),
				includeInternal: telegramInternal,
			},
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved!" });
		} catch {
			toastManager.add({ title: "Failed to save settings", variant: "error" });
		} finally {
			setIsSaving(false);
		}
	};

	const handleResetPrompt = () => setAgentPrompt("");

	if (!mailbox) {
		return <div className="flex justify-center py-20"><Loader size="lg" /></div>;
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>
			<div className="space-y-6">
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">Account</div>
					<div className="space-y-3">
						<Input label="Display Name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
						<Input label="Email" type="email" value={mailbox.email} disabled />
					</div>
				</div>

				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">AI Agent Prompt</span>
							{isCustomPrompt ? <Badge variant="primary">Custom</Badge> : <Badge variant="secondary">Default</Badge>}
						</div>
						{isCustomPrompt && <Button variant="ghost" size="xs" icon={<ArrowCounterClockwiseIcon size={14} />} onClick={handleResetPrompt}>Reset to default</Button>}
					</div>
					<p className="text-xs text-kumo-subtle mb-3">Customize how the AI agent behaves for this mailbox. Leave empty to use the built-in default prompt.</p>
					<textarea value={agentPrompt} onChange={(e) => setAgentPrompt(e.target.value)} placeholder={PROMPT_PLACEHOLDER} rows={12} className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed" />
				</div>

				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center gap-2 mb-2">
						<PaperPlaneTiltIcon size={17} className="text-kumo-subtle" />
						<div className="text-sm font-medium text-kumo-default">Third-party email forwarding</div>
					</div>
					<p className="text-xs text-kumo-subtle mb-4">Forward newly delivered messages to another email address. Internal mail can use the same pipeline.</p>
					<label className="flex items-center gap-2 text-sm text-kumo-default mb-3">
						<input type="checkbox" checked={forwardEnabled} onChange={(e) => setForwardEnabled(e.target.checked)} /> Enable forwarding
					</label>
					<Input label="Forward to" type="email" value={forwardEmail} onChange={(e) => setForwardEmail(e.target.value)} disabled={!forwardEnabled} placeholder="backup@example.com" />
					<label className="flex items-center gap-2 text-xs text-kumo-subtle mt-3">
						<input type="checkbox" checked={forwardInternal} onChange={(e) => setForwardInternal(e.target.checked)} disabled={!forwardEnabled} /> Also forward internal mail
					</label>
				</div>

				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center gap-2 mb-2">
						<TelegramLogoIcon size={17} className="text-kumo-subtle" />
						<div className="text-sm font-medium text-kumo-default">Telegram notifications</div>
					</div>
					<p className="text-xs text-kumo-subtle mb-4">Send a compact notification to a Telegram bot when a message arrives.</p>
					<label className="flex items-center gap-2 text-sm text-kumo-default mb-3">
						<input type="checkbox" checked={telegramEnabled} onChange={(e) => setTelegramEnabled(e.target.checked)} /> Enable Telegram notifications
					</label>
					<div className="space-y-3">
						<Input label="Bot Token" type="password" value={telegramToken} onChange={(e) => setTelegramToken(e.target.value)} disabled={!telegramEnabled} placeholder="123456:ABC..." />
						<Input label="Chat ID" value={telegramChatId} onChange={(e) => setTelegramChatId(e.target.value)} disabled={!telegramEnabled} placeholder="123456789" />
					</div>
					<label className="flex items-center gap-2 text-xs text-kumo-subtle mt-3">
						<input type="checkbox" checked={telegramInternal} onChange={(e) => setTelegramInternal(e.target.checked)} disabled={!telegramEnabled} /> Also notify for internal mail
					</label>
				</div>

				<div className="flex justify-end">
					<Button variant="primary" onClick={handleSave} loading={isSaving}>Save Changes</Button>
				</div>
			</div>
		</div>
	);
}
