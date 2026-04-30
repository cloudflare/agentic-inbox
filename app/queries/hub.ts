// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import type {
	HubContributionsResponse,
	HubDestroylistResponse,
	HubSharingGroupsResponse,
} from "~/types";
import { queryKeys } from "./keys";

// Hub data doesn't change minute-to-minute — keep it warm for a minute so
// switching between panels in the same screen doesn't refetch.
const STALE_MS = 60_000;

export function useHubContributions(mailboxId: string | undefined) {
	return useQuery<HubContributionsResponse>({
		queryKey: mailboxId
			? queryKeys.hub.contributions(mailboxId)
			: ["hub", "_disabled", "contributions"],
		queryFn: ({ signal }) =>
			api.getHubContributions(mailboxId!, { signal }) as Promise<HubContributionsResponse>,
		enabled: !!mailboxId,
		staleTime: STALE_MS,
	});
}

export function useHubDestroylist(mailboxId: string | undefined) {
	return useQuery<HubDestroylistResponse>({
		queryKey: mailboxId
			? queryKeys.hub.destroylist(mailboxId)
			: ["hub", "_disabled", "destroylist"],
		queryFn: ({ signal }) =>
			api.getHubDestroylist(mailboxId!, { signal }) as Promise<HubDestroylistResponse>,
		enabled: !!mailboxId,
		staleTime: STALE_MS,
	});
}

export function useHubSharingGroups(mailboxId: string | undefined) {
	return useQuery<HubSharingGroupsResponse>({
		queryKey: mailboxId
			? queryKeys.hub.sharingGroups(mailboxId)
			: ["hub", "_disabled", "sharing-groups"],
		queryFn: ({ signal }) =>
			api.getHubSharingGroups(mailboxId!, { signal }) as Promise<HubSharingGroupsResponse>,
		enabled: !!mailboxId,
		staleTime: STALE_MS,
	});
}
