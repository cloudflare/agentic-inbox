// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import { RobotIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useNavigate, useParams } from "react-router";
import AgentSidebar from "~/components/AgentSidebar";
import Header from "~/components/Header";
import LazyLoadBoundary from "~/components/LazyLoadBoundary";
import MailKeyboardController from "~/components/MailKeyboardController";
import MailCommandPalette from "~/components/MailCommandPalette";
import Sidebar from "~/components/Sidebar";
import { useMailNotifications } from "~/hooks/useMailNotifications";
import { useRebindExistingPushSubscription } from "~/hooks/pwa/usePushSubscription";
import {
	exitRevokedMailbox,
	resolveMailboxChangeFeedStorage,
	useMailboxChangeFeed,
} from "~/queries/mailbox-change-feed";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";
import { hasComposeRecovery } from "~/lib/compose-recovery";

function confirmDiscardPendingCompose(hasValuableSeed: boolean): boolean {
	return !hasValuableSeed && !hasComposeRecovery() || window.confirm(
		"Discard this unsaved message? This cannot be undone.",
	);
}

function ComposeLoadingFallback({
	onCancel,
	hasValuableSeed,
}: {
	onCancel: () => void;
	hasValuableSeed: boolean;
}) {
	useEffect(() => {
		const handleEscape = (event: KeyboardEvent) => {
			if (
				event.key === "Escape" &&
				confirmDiscardPendingCompose(hasValuableSeed)
			) {
				onCancel();
			}
		};
		document.addEventListener("keydown", handleEscape);
		return () => document.removeEventListener("keydown", handleEscape);
	}, [hasValuableSeed, onCancel]);

	return (
		<div
			className="fixed inset-0 z-50 grid place-items-center bg-kumo-contrast/20 p-4"
			role="status"
			aria-live="polite"
		>
			<div className="flex flex-col items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base px-5 py-4 text-sm text-kumo-subtle shadow-lg">
				<span>Opening composer...</span>
					<Button
						variant="secondary"
						onClick={() => {
							if (confirmDiscardPendingCompose(hasValuableSeed)) onCancel();
						}}
						className="min-h-11"
					>
						Discard and close
					</Button>
			</div>
		</div>
	);
}

function ComposeLoadError({
	onClose,
	onRetry,
	hasValuableSeed,
}: {
	onClose: () => void;
	onRetry: () => void;
	hasValuableSeed: boolean;
}) {
	return (
		<div className="fixed inset-0 z-50 grid place-items-center bg-kumo-contrast/20 p-4">
			<div
				className="w-full max-w-sm rounded-lg border border-kumo-line bg-kumo-base p-5 shadow-lg"
				role="alert"
			>
				<h2 className="font-semibold text-kumo-default">Composer could not open</h2>
				<p className="mt-2 text-sm text-kumo-subtle">
					Your message is held in this tab. Retry the composer, or explicitly discard it.
				</p>
				<div className="mt-4 flex flex-wrap justify-end gap-2">
						<Button
							variant="secondary"
							onClick={() => {
								if (confirmDiscardPendingCompose(hasValuableSeed)) onClose();
							}}
							className="min-h-11"
						>
							Discard and close
						</Button>
						<Button onClick={onRetry} className="min-h-11">
							Retry composer
					</Button>
				</div>
			</div>
		</div>
	);
}

export default function MailboxRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
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
				onExit: () => navigate("/mailboxes", { replace: true }),
		});
	}, [mailboxId, navigate, queryClient]);

	useEffect(() => {
		revokedExitStartedRef.current = false;
		setRevokedByFeature(false);
	}, [mailboxId]);
	// Prefetch mailbox data for child components
	useMailbox(mailboxId);
	// New-mail toasts + unread tab-title counter, scoped to this mailbox.
	useMailNotifications(mailboxId);
	useRebindExistingPushSubscription(mailboxId, exitForRevokedAccess);
	useMailboxChangeFeed(mailboxId);
	const prevMailboxIdRef = useRef<string | undefined>(undefined);
	const [composeRetryKey, setComposeRetryKey] = useState(0);
	const ComposeEmail = useMemo(
		() => lazy(() => import("~/components/ComposeEmail")),
		[composeRetryKey],
	);
	const {
		isSidebarOpen,
		closeSidebar,
		isComposing,
		closeCompose,
		composeOptions,
		isAgentPanelOpen,
		toggleAgentPanel,
		hydrateAgentPanel,
		hydrateWorkspacePreferences,
		closePanel,
	} = useUIStore();
	const hasValuableComposeSeed = Boolean(
		composeOptions.initialTo ||
		composeOptions.draftEmail &&
			(!composeOptions.draftEmail.id ||
				composeOptions.draftEmail.subject ||
				composeOptions.draftEmail.recipient ||
				composeOptions.draftEmail.body ||
				composeOptions.draftEmail.attachments?.length),
	);

	// Load the persisted agent-panel preference once on the client.
	useEffect(() => {
		hydrateAgentPanel();
		hydrateWorkspacePreferences();
	}, [hydrateAgentPanel, hydrateWorkspacePreferences]);

	useEffect(() => {
		if (
			prevMailboxIdRef.current &&
			mailboxId &&
			prevMailboxIdRef.current !== mailboxId
		) {
			closePanel();
			closeSidebar();
		}

		prevMailboxIdRef.current = mailboxId;
	}, [mailboxId, closePanel, closeSidebar]);

	if (revokedByFeature) {
		return (
			<div
				className="grid h-full place-items-center px-4 text-center text-sm text-kumo-subtle"
				role="status"
				aria-live="assertive"
			>
				Mailbox access changed. Returning to your mailboxes…
			</div>
		);
	}

	return (
		<div className="flex h-screen overflow-hidden">
			<MailKeyboardController />
			<MailCommandPalette />
			{/* Mobile sidebar overlay backdrop */}
			{isSidebarOpen && (
				<div
					className="fixed inset-0 z-30 bg-kumo-contrast/30 md:hidden"
					onClick={closeSidebar}
					onKeyDown={(e) => e.key === "Escape" && closeSidebar()}
					role="button"
					tabIndex={-1}
					aria-label="Close sidebar"
				/>
			)}

			{/* Sidebar: hidden on mobile by default, shown as overlay when open */}
			<div
				className={`fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 md:z-0 ${
					isSidebarOpen ? "translate-x-0" : "-translate-x-full"
				}`}
			>
				<Sidebar />
			</div>

			{/* Main content */}
			<div className="flex-1 flex flex-col min-w-0 bg-kumo-base">
				<Header />
				<main className="flex-1 overflow-hidden">
					<Outlet />
				</main>
			</div>

			{/* Agent + MCP sidebar — inline collapsible rail on desktop, full-height
			    right drawer (with backdrop) on mobile / tablet. */}
			{isAgentPanelOpen ? (
				<>
					{/* Mobile/tablet backdrop */}
					<div
						className="fixed inset-0 z-30 bg-kumo-contrast/30 lg:hidden"
						onClick={toggleAgentPanel}
						onKeyDown={(e) => e.key === "Escape" && toggleAgentPanel()}
						role="button"
						tabIndex={-1}
						aria-label="Close AI assistant"
					/>
					<div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] shrink-0 flex-col border-l border-kumo-line bg-kumo-base overflow-hidden lg:static lg:z-0 lg:w-[360px] lg:max-w-none">
						<AgentSidebar />
					</div>
				</>
			) : (
				// Slim re-open rail so the assistant is always one click away (desktop).
				<div className="hidden lg:flex w-11 shrink-0 border-l border-kumo-line flex-col items-center bg-kumo-base pt-3">
					<Tooltip content="Open AI assistant" side="left" asChild>
						<Button
							variant="ghost"
							shape="square"
							icon={<RobotIcon size={20} />}
							onClick={toggleAgentPanel}
							aria-label="Open AI assistant"
						/>
					</Tooltip>
				</div>
			)}

			{isComposing ? (
					<LazyLoadBoundary
						fallback={
							<ComposeLoadError
								onClose={closeCompose}
								onRetry={() => setComposeRetryKey((key) => key + 1)}
								hasValuableSeed={hasValuableComposeSeed}
							/>
						}
						resetKey={`${isComposing}:${composeRetryKey}`}
					>
						<Suspense
							fallback={
								<ComposeLoadingFallback
									onCancel={closeCompose}
									hasValuableSeed={hasValuableComposeSeed}
								/>
							}
						>
						<ComposeEmail />
					</Suspense>
				</LazyLoadBoundary>
			) : null}
		</div>
	);
}
