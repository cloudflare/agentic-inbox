// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowCounterClockwiseIcon,
	ArrowRightIcon,
	LightningIcon,
	RobotIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBlocker, useNavigate, useParams } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import { PushNotificationsSection } from "~/components/settings/push-notifications/PushNotificationsSection";
import { SignatureSettingsCard } from "~/components/settings/SignatureSettingsCard";
import {
	exitRevokedMailbox,
	resolveMailboxChangeFeedStorage,
} from "~/queries/mailbox-change-feed";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [revokedByFeature, setRevokedByFeature] = useState(false);
	const revokedExitStartedRef = useRef(false);

	const exitForRevokedAccess = useCallback((revokedMailboxId: string) => {
		if (!mailboxId || revokedMailboxId !== mailboxId) {
			exitRevokedMailbox({
				queryClient,
				mailboxId: revokedMailboxId,
				storage: resolveMailboxChangeFeedStorage(() => window.localStorage),
			});
			return;
		}
		setRevokedByFeature(true);
		if (revokedExitStartedRef.current) return;
		revokedExitStartedRef.current = true;
		exitRevokedMailbox({
			queryClient,
			mailboxId,
			storage: resolveMailboxChangeFeedStorage(() => window.localStorage),
			onExit: () => navigate("/", { replace: true }),
		});
	}, [mailboxId, navigate, queryClient]);

	useEffect(() => {
		revokedExitStartedRef.current = false;
		setRevokedByFeature(false);
	}, [mailboxId]);

	const savedDisplayName = mailbox
		? mailbox.settings?.fromName || mailbox.name || ""
		: "";
	const savedAgentPrompt = mailbox?.settings?.agentSystemPrompt || "";
	// Save trims the prompt, so compare what would be sent, not what is typed.
	const isDirty = Boolean(mailbox) &&
		(displayName !== savedDisplayName ||
			agentPrompt.trim() !== savedAgentPrompt.trim());

	// Seed the form from the server, but never over edits in progress: the
	// change feed refetches this mailbox while the user is typing. Switching
	// mailbox always reseeds, because those edits belong to the other mailbox.
	const seededMailboxRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!mailbox) return;
		if (seededMailboxRef.current === mailbox.id && isDirty) return;
		seededMailboxRef.current = mailbox.id;
		setDisplayName(savedDisplayName);
		setAgentPrompt(savedAgentPrompt);
	}, [mailbox, isDirty, savedDisplayName, savedAgentPrompt]);

	// Leaving with unsaved edits asks first, in-app and on a full unload.
	const navigationBlocker = useBlocker(isDirty && !revokedByFeature);
	useEffect(() => {
		if (navigationBlocker.state !== "blocked") return;
		if (window.confirm("Discard your unsaved settings changes?")) {
			navigationBlocker.proceed();
		} else {
			navigationBlocker.reset();
		}
	}, [navigationBlocker]);
	useEffect(() => {
		if (!isDirty) return;
		const warnBeforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warnBeforeUnload);
		return () => window.removeEventListener("beforeunload", warnBeforeUnload);
	}, [isDirty]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		setIsSaving(true);
		const settings = {
			fromName: displayName,
			agentSystemPrompt: agentPrompt.trim(),
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved" });
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

	if (revokedByFeature) {
		return (
			<div
				className="flex h-full items-center justify-center gap-2 px-4 text-sm text-kumo-subtle"
				role="status"
				aria-live="assertive"
			>
				<Loader size="sm" />
				<span>Mailbox access changed. Returning to Mailboxes…</span>
			</div>
		);
	}

	if (!mailbox) {
		return (
			<div className="max-w-2xl space-y-6 px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
				<h1 className="text-lg font-semibold text-kumo-default">Settings</h1>
				{mailboxId ? <SignatureSettingsCard mailboxId={mailboxId} /> : <Loader size="lg" />}
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			<div className="space-y-6">
				{/* First-class destination; Settings provides a discoverability path. */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-start justify-between gap-4">
						<div className="flex min-w-0 gap-3">
							<div className="grid size-10 shrink-0 place-items-center rounded-md bg-kumo-tint text-kumo-default">
								<LightningIcon size={20} weight="duotone" aria-hidden="true" />
							</div>
							<div>
								<div className="text-sm font-medium text-kumo-default">Automations</div>
								<p className="mt-1 text-xs leading-5 text-kumo-subtle">
									Organize future incoming mail with ordered, explainable rules.
								</p>
							</div>
						</div>
						<Button
							variant="secondary"
							icon={<ArrowRightIcon size={16} aria-hidden="true" />}
							onClick={() => navigate(`/mailbox/${mailboxId}/automations`)}
							className="min-h-11 shrink-0"
						>
							Open
						</Button>
					</div>
				</div>

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

				<SignatureSettingsCard mailboxId={mailboxId ?? mailbox.id} />

				{/* Push notifications (WISER-240) — self-managed, independent of Save. */}
				<PushNotificationsSection
					mailboxId={mailboxId}
					onAccessRevoked={exitForRevokedAccess}
				/>

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
						It controls the agent’s personality, writing style, and behavior rules.
					</p>
				</div>

				{/* Save */}
				<div className="flex justify-end">
					<Button
						variant="primary"
						onClick={handleSave}
						loading={isSaving}
						disabled={!isDirty || isSaving}
					>
						Save Changes
					</Button>
				</div>
			</div>
		</div>
	);
}
