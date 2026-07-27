// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowClockwiseIcon,
	CheckCircleIcon,
	ClockCountdownIcon,
	DeviceMobileIcon,
	TrashIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { formatListDate } from "shared/dates";
import { usePushSubscription } from "~/hooks/pwa/usePushSubscription";
import {
	useAppConfig,
	useCurrentActor,
	useDeletePushDevice,
	usePushHealth,
} from "~/queries/push";
import { ApiError } from "~/services/api";
import type { PushDeviceHealth } from "~/services/push-health.ts";
import { detectPwaInstallEnvironment } from "~/utils/pwa/detectPlatform";
import { Guidance } from "./Guidance";
import { InstallGuidance } from "./InstallGuidance";
import { NotificationCard } from "./NotificationCard";
import {
	pushDeviceHealthPresentation,
	pushHealthPresentation,
	type PushHealthTone,
} from "./push-health-view.ts";
import { derivePushSetupState } from "./push-setup-state";

type BeforeInstallPromptEvent = Event & {
	prompt: () => Promise<void>;
};

function isBeforeInstallPromptEvent(event: Event): event is BeforeInstallPromptEvent {
	return "prompt" in event && typeof event.prompt === "function";
}

function isStandaloneNavigator(value: Navigator): value is Navigator & { standalone: boolean } {
	return "standalone" in value;
}

function isStandalone(): boolean {
	if (typeof window === "undefined") return false;
	return (
		window.matchMedia("(display-mode: standalone)").matches ||
		(isStandaloneNavigator(navigator) && navigator.standalone === true)
	);
}

const TONE_CLASSES: Record<PushHealthTone, string> = {
	neutral: "text-kumo-subtle",
	positive: "text-kumo-success",
	warning: "text-kumo-warning",
	danger: "text-kumo-danger",
};

function HealthIcon({ tone }: { tone: PushHealthTone }) {
	const className = `shrink-0 ${TONE_CLASSES[tone]}`;
	if (tone === "positive") {
		return <CheckCircleIcon size={17} weight="fill" className={className} aria-hidden="true" />;
	}
	if (tone === "warning") {
		return <ClockCountdownIcon size={17} weight="fill" className={className} aria-hidden="true" />;
	}
	if (tone === "danger") {
		return <WarningCircleIcon size={17} weight="fill" className={className} aria-hidden="true" />;
	}
	return <DeviceMobileIcon size={17} className={className} aria-hidden="true" />;
}

function TruthBoundary() {
	return (
		<div className="space-y-2 border-y border-kumo-line py-3 text-xs leading-relaxed text-kumo-subtle">
			<p>
				Push notifications are best effort. Accepted means the browser&apos;s push service
				accepted our request. It does not confirm that your device or operating system
				displayed it. Your Inbox is the source of truth.
			</p>
			<p>
				Notifications may show sender, subject, and a short preview on your lock screen.
				Your device controls whether previews are visible.
			</p>
		</div>
	);
}

function DeviceRow({
	device,
	isRemoving,
	buttonRef,
	onRemove,
}: {
	device: PushDeviceHealth;
	isRemoving: boolean;
	buttonRef: (node: HTMLButtonElement | null) => void;
	onRemove: () => void;
}) {
	const state = pushDeviceHealthPresentation(device);
	const timestampLabel = state.timestamp
		? `${device.health === "accepted" ? "Accepted" : "Attempted"} ${formatListDate(state.timestamp)}`
		: null;
	return (
		<li className="grid min-h-20 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-t border-kumo-line py-3 first:border-t-0">
			<DeviceMobileIcon size={18} className="mt-0.5 shrink-0 text-kumo-subtle" aria-hidden="true" />
			<div className="min-w-0">
				<p className="truncate text-sm font-medium text-kumo-default">{device.label}</p>
				<div className="mt-1 flex min-w-0 items-start gap-1.5">
					<HealthIcon tone={state.tone} />
					<div className="min-w-0 text-xs leading-relaxed">
						<p className={`font-medium ${TONE_CLASSES[state.tone]}`}>{state.title}</p>
						<p className="text-kumo-subtle">{state.description}</p>
						<p className="mt-1 text-kumo-subtle">
							{timestampLabel && state.timestamp ? (
								<>
									<time dateTime={state.timestamp}>{timestampLabel}</time>
									<span aria-hidden="true"> · </span>
								</>
							) : null}
							<span>Registered </span>
							<time dateTime={device.registeredAt}>{formatListDate(device.registeredAt)}</time>
						</p>
					</div>
				</div>
			</div>
			<Button
				ref={buttonRef}
				variant="ghost"
				size="sm"
				className="min-h-11"
				icon={<TrashIcon size={14} />}
				onClick={onRemove}
				loading={isRemoving}
				aria-label={`Remove ${device.label}`}
			>
				Remove
			</Button>
		</li>
	);
}

/** Actor-private Web Push setup and delivery health for one Mailbox. */
export function PushNotificationsSection({
	mailboxId,
	onAccessRevoked,
}: {
	mailboxId: string | undefined;
	onAccessRevoked: (mailboxId: string) => void;
}) {
	const toast = useKumoToastManager();
	const configQuery = useAppConfig();
	const actorQuery = useCurrentActor();
	const actorScope = actorQuery.data?.email;
	const healthQuery = usePushHealth(mailboxId, actorScope, onAccessRevoked);
	const { enable, isSubscribing, pushSupported } = usePushSubscription(
		mailboxId,
		actorScope,
		onAccessRevoked,
	);
	const deleteDevice = useDeletePushDevice(mailboxId, actorScope);
	const statusHeadingRef = useRef<HTMLParagraphElement>(null);
	const removeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
	const [mounted, setMounted] = useState(false);
	const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
	const [statusAnnouncement, setStatusAnnouncement] = useState("");

	useEffect(() => setMounted(true), []);
	useEffect(() => {
		function onPrompt(event: Event) {
			if (!isBeforeInstallPromptEvent(event)) return;
			event.preventDefault();
			setInstallPrompt(event);
		}
		window.addEventListener("beforeinstallprompt", onPrompt);
		return () => window.removeEventListener("beforeinstallprompt", onPrompt);
	}, []);

	const hasVapidKey = !!configQuery.data?.vapidPublicKey;
	const permission = typeof Notification === "undefined" ? "default" : Notification.permission;
	const setupState = derivePushSetupState({
		mounted,
		configLoading:
			configQuery.isLoading ||
			actorQuery.isLoading ||
			Boolean(actorScope && healthQuery.isLoading),
		hasQueryError:
			configQuery.isError || actorQuery.isError || healthQuery.isError,
		hasVapidKey,
		installed: mounted && isStandalone(),
		pushSupported,
		permission,
	});

	async function handleEnable() {
		const result = await enable();
		if (result === "revoked") return;
		toast.add(
			result === "enabled"
				? { title: "Notifications enabled on this device" }
				: {
						title: "Couldn’t enable notifications",
						description: "Check that notifications are allowed, then try again.",
						variant: "error",
					},
		);
	}

	async function handleRemove(id: string, label: string) {
		try {
			const devices = healthQuery.data?.devices ?? [];
			const index = devices.findIndex((device) => device.id === id);
			const nextFocusId = index >= 0
				? devices[index + 1]?.id ?? devices[index - 1]?.id ?? null
				: null;
			await deleteDevice.mutateAsync(id);
			setStatusAnnouncement(`${label} removed.`);
			toast.add({ title: "Device removed" });
			if (nextFocusId) {
				removeButtonRefs.current.get(nextFocusId)?.focus();
			} else {
				statusHeadingRef.current?.focus();
			}
		} catch (error) {
			if (error instanceof ApiError && error.status === 403 && mailboxId) {
				onAccessRevoked(mailboxId);
				return;
			}
			toast.add({ title: "Couldn’t remove device", variant: "error" });
		}
	}

	async function handleInstall() {
		if (!installPrompt) return;
		await installPrompt.prompt();
		setInstallPrompt(null);
	}

	async function handleRefresh() {
		setStatusAnnouncement("");
		const result = await healthQuery.refetch();
		setStatusAnnouncement(
			result.isError
				? "Notification status could not be refreshed."
				: "Notification status refreshed.",
		);
	}

	async function handleRetry() {
		setStatusAnnouncement("");
		await Promise.all([
			configQuery.refetch(),
			actorQuery.refetch(),
			healthQuery.refetch(),
		]);
		setStatusAnnouncement("Notification settings refreshed.");
	}

	if (setupState === "loading") {
		return (
			<NotificationCard>
				<div className="flex justify-center py-4" role="status" aria-label="Loading notification status">
					<Loader size="sm" />
				</div>
			</NotificationCard>
		);
	}

	if (setupState === "error") {
		return (
			<NotificationCard>
				<div role="alert" className="space-y-3">
					<TruthBoundary />
					<p className="text-sm text-kumo-default">
						Notification settings could not be loaded. This does not affect mail in your Inbox.
					</p>
					<Button
						variant="secondary"
						size="sm"
						className="min-h-11"
						onClick={handleRetry}
						loading={configQuery.isFetching || actorQuery.isFetching || healthQuery.isFetching}
					>
						Retry
					</Button>
				</div>
			</NotificationCard>
		);
	}

	const health = healthQuery.data;
	const environment = detectPwaInstallEnvironment();
	const overall = health ? pushHealthPresentation(health) : null;
	const effectiveNotConfigured =
		setupState === "not_configured" || health?.state === "not_configured";
	return (
		<NotificationCard>
			<div className="space-y-4">
				<TruthBoundary />

				{overall ? (
					<div className="flex items-start gap-2.5" role="status">
						<HealthIcon tone={overall.tone} />
						<div className="min-w-0">
							<p
								ref={statusHeadingRef}
								tabIndex={-1}
								className={`text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${TONE_CLASSES[overall.tone]}`}
							>
								{overall.title}
							</p>
							<p className="mt-0.5 text-xs leading-relaxed text-kumo-subtle">
								{overall.description}
							</p>
						</div>
					</div>
				) : null}

				{health && health.devices.length > 0 ? (
					<ul aria-label="Your notification devices" className="border-y border-kumo-line">
						{health.devices.map((device) => (
							<DeviceRow
								key={device.id}
								device={device}
								isRemoving={deleteDevice.isPending && deleteDevice.variables === device.id}
								buttonRef={(node) => {
									if (node) removeButtonRefs.current.set(device.id, node);
									else removeButtonRefs.current.delete(device.id);
								}}
								onRemove={() => handleRemove(device.id, device.label)}
							/>
						))}
					</ul>
				) : null}

				{effectiveNotConfigured ? (
					<Guidance title="Notifications temporarily unavailable">
						Notification handoff is not configured for this portal. Mail remains available in your Inbox.
					</Guidance>
				) : setupState === "blocked" ? (
					<p className="text-xs text-kumo-danger" role="alert">
						Notifications are blocked for this app. Enable them in your device settings,
						then reopen the app.
					</p>
				) : setupState === "unsupported" ? (
					<Guidance title="Notifications unavailable">
						This installed app does not support push notifications on this device.
					</Guidance>
				) : setupState === "enable" ? (
					<div className="flex flex-wrap gap-2">
						<Button
							variant="primary"
							size="sm"
							className="min-h-11"
							onClick={handleEnable}
							loading={isSubscribing}
						>
							{health?.devices.length ? "Enable on this device" : "Enable notifications"}
						</Button>
					</div>
				) : (
					<InstallGuidance
						environment={environment}
						installPromptAvailable={!!installPrompt}
						onInstall={handleInstall}
					/>
				)}

				{health ? (
					<div className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-line pt-3">
						<p className="text-xs text-kumo-subtle">
							Status checked <time dateTime={health.refreshedAt}>{formatListDate(health.refreshedAt)}</time>
						</p>
						<Button
							variant="ghost"
							size="sm"
							className="min-h-11"
							icon={<ArrowClockwiseIcon size={15} />}
							onClick={handleRefresh}
							loading={healthQuery.isFetching}
						>
							Refresh status
						</Button>
					</div>
				) : null}

				<div className="sr-only" aria-live="polite" aria-atomic="true">
					{statusAnnouncement}
				</div>
			</div>
		</NotificationCard>
	);
}
