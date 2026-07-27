// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	useMutation,
	useQuery,
	useQueryClient,
	type QueryClient,
} from "@tanstack/react-query";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";
import {
	isPushHealthAccessRevoked,
	pushHealthKey,
} from "~/lib/push-health-cache.ts";
import {
	fetchPushHealth,
	type PushHealthResponse,
} from "~/services/push-health.ts";

/** App config (domains, addresses, VAPID public key). Static per deploy. */
export function useAppConfig() {
	return useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Number.POSITIVE_INFINITY,
	});
}

/**
 * The signed-in account: header chrome, admin affordances, and the push-health
 * key all read identity from here. Including the actor email in the in-memory
 * health key prevents a browser identity transition from reusing another
 * actor's device response, so identity is refreshed on refocus rather than
 * cached for the session. Push-health queries are never persisted.
 */
export function useCurrentActor() {
	return useQuery({
		queryKey: queryKeys.currentActor,
		queryFn: () => api.getCurrentActor(),
		staleTime: 5 * 60_000,
		refetchOnWindowFocus: true,
	});
}

export { pushHealthKey } from "~/lib/push-health-cache.ts";

type PushHealthRequest = (
	mailboxId: string,
	signal?: AbortSignal,
) => Promise<PushHealthResponse>;

function requestPushHealth(mailboxId: string, signal?: AbortSignal) {
	return fetchPushHealth(mailboxId, fetch, signal);
}

export function buildPushHealthQueryOptions(
	mailboxId: string,
	actorScope: string,
	request: PushHealthRequest = requestPushHealth,
	onAccessRevoked?: (mailboxId: string) => void,
) {
	return {
		queryKey: pushHealthKey(mailboxId, actorScope),
		queryFn: async ({ signal }: { signal: AbortSignal }) => {
			try {
				return await request(mailboxId, signal);
			} catch (error) {
				if (isPushHealthAccessRevoked(error)) {
					onAccessRevoked?.(mailboxId);
				}
				throw error;
			}
		},
		staleTime: 0,
		refetchOnWindowFocus: true,
		refetchOnReconnect: true,
		retry: (failureCount: number, error: unknown) =>
			!isPushHealthAccessRevoked(error) && failureCount < 2,
	};
}

export function usePushHealth(
	mailboxId: string | undefined,
	actorScope: string | undefined,
	onAccessRevoked?: (mailboxId: string) => void,
) {
	const enabled = Boolean(mailboxId && actorScope);
	return useQuery({
		...(enabled
			? buildPushHealthQueryOptions(
					mailboxId!,
					actorScope!,
					requestPushHealth,
					onAccessRevoked,
				)
			: {
					queryKey: ["push", mailboxId ?? "", "health", actorScope ?? ""] as const,
					queryFn: async (): Promise<PushHealthResponse> => {
						throw new Error("A Mailbox and actor are required for push health");
					},
				}),
		enabled,
	});
}

function invalidatePushHealth(
	queryClient: QueryClient,
	mailboxId: string,
	actorScope: string,
) {
	return queryClient.invalidateQueries({
		queryKey: pushHealthKey(mailboxId, actorScope),
		exact: true,
	});
}

export function useRegisterPushDevice(
	mailboxId: string | undefined,
	actorScope: string | undefined,
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (subscription: {
			endpoint: string;
			keys: { p256dh: string; auth: string };
		}) => {
			if (!mailboxId) throw new Error("A Mailbox is required to register a push device");
			return api.registerPushSubscription(mailboxId, subscription);
		},
		onSuccess: () => {
			if (mailboxId && actorScope) {
				void invalidatePushHealth(queryClient, mailboxId, actorScope);
			}
		},
	});
}

export function useDeletePushDevice(
	mailboxId: string | undefined,
	actorScope: string | undefined,
) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => {
			if (!mailboxId) throw new Error("A Mailbox is required to remove a push device");
			return api.deletePushSubscription(mailboxId, id);
		},
		onSuccess: () => {
			if (mailboxId && actorScope) {
				void invalidatePushHealth(queryClient, mailboxId, actorScope);
			}
		},
	});
}
