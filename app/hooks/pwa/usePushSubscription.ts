// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useRef, useState } from "react";
import { decodeBase64Url } from "../../../shared/base64url";
import {
	useAppConfig,
	useCurrentActor,
	useRegisterPushDevice,
} from "~/queries/push";
import { ApiError } from "~/services/api";
import { rebindExistingPushSubscription } from "./push-rebind";

const SW_READY_TIMEOUT_MS = 10_000;

// navigator.serviceWorker.ready never rejects, so race it against a timeout.
async function waitForServiceWorkerReady(): Promise<ServiceWorkerRegistration | null> {
	if (!("serviceWorker" in navigator)) return null;
	return Promise.race([
		navigator.serviceWorker.ready,
		new Promise<null>((resolve) => setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS)),
	]);
}

/**
 * Subscribe this device to Web Push for `mailboxId` (WISER-240). `enable()`
 * requests permission (must be called from a user gesture), waits for the SW,
 * subscribes with the env's VAPID key, and stores the subscription.
 */
export type PushSubscriptionActionResult = "enabled" | "failed" | "revoked";

export function usePushSubscription(
	mailboxId: string | undefined,
	actorScope: string | undefined,
	onAccessRevoked?: (mailboxId: string) => void,
) {
	const { data: config } = useAppConfig();
	const register = useRegisterPushDevice(mailboxId, actorScope);
	const [isSubscribing, setIsSubscribing] = useState(false);

	const pushSupported =
		typeof window !== "undefined" &&
		"serviceWorker" in navigator &&
		"PushManager" in window &&
		"Notification" in window;

	const vapidKey = config?.vapidPublicKey ?? null;
	const canSubscribe = pushSupported && !!vapidKey && !!mailboxId;

	async function enable(): Promise<PushSubscriptionActionResult> {
		if (!canSubscribe || !vapidKey) return "failed";
		const applicationServerKey = decodeBase64Url(vapidKey);
		if (!applicationServerKey) return "failed";
		setIsSubscribing(true);
		try {
			const permission = await Notification.requestPermission();
			if (permission !== "granted") return "failed";

			const registration = await waitForServiceWorkerReady();
			if (!registration) return "failed";

			const subscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey,
			});
			const json = subscription.toJSON();
			await register.mutateAsync({
				endpoint: json.endpoint ?? "",
				keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
			});
			return "enabled";
		} catch (err) {
			if (err instanceof ApiError && err.status === 403 && mailboxId) {
				onAccessRevoked?.(mailboxId);
				return "revoked";
			}
			console.error("[pwa] push subscribe failed", err);
			return "failed";
		} finally {
			setIsSubscribing(false);
		}
	}

	return {
		enable,
		canSubscribe,
		isSubscribing,
		pushSupported,
		hasVapidKey: !!vapidKey,
	};
}

/**
 * Bind a pre-migration browser subscription to the live mailbox user on the
 * next authenticated mailbox visit. No permission prompt is shown.
 */
export function useRebindExistingPushSubscription(
	mailboxId: string | undefined,
	onAccessRevoked?: (mailboxId: string) => void,
) {
	const { data: config } = useAppConfig();
	const actorQuery = useCurrentActor();
	const register = useRegisterPushDevice(mailboxId, actorQuery.data?.email);
	const registerRef = useRef(register.mutateAsync);
	registerRef.current = register.mutateAsync;
	const vapidKey = config?.vapidPublicKey ?? null;

	useEffect(() => {
		if (
			!mailboxId ||
			!actorQuery.data?.email ||
			!vapidKey ||
			typeof window === "undefined" ||
			!("serviceWorker" in navigator) ||
			typeof Notification === "undefined" ||
			Notification.permission !== "granted"
		) {
			return;
		}

		let cancelled = false;
		void waitForServiceWorkerReady()
			.then(async (registration) => {
				if (!registration || cancelled) return;
				await rebindExistingPushSubscription(
					registration,
					(payload) => registerRef.current(payload),
				);
			})
			.catch((error) => {
				if (cancelled) return;
				if (error instanceof ApiError && error.status === 403 && mailboxId) {
					onAccessRevoked?.(mailboxId);
					return;
				}
				console.error("[pwa] push rebind failed", error);
			});
		return () => {
			cancelled = true;
		};
	}, [actorQuery.data?.email, mailboxId, onAccessRevoked, vapidKey]);
}
