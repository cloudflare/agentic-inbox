import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { GlobalTodayBriefResponse } from "../../shared/global-today-brief.ts";
import { getGlobalTodayBrief } from "../services/global-today-brief.ts";
import { ApiError } from "../services/api.ts";

export const globalTodayBriefKeys = {
	all: ["global-today-brief"] as const,
	detail: (timeZone: string) => ["global-today-brief", timeZone] as const,
};

function retry(failureCount: number, error: unknown) {
	if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false;
	return failureCount < 1;
}

export function markGlobalTodayBriefStale(queryClient: QueryClient, timeZone: string) {
	queryClient.setQueryData<GlobalTodayBriefResponse>(globalTodayBriefKeys.detail(timeZone), (current) => {
		// A brief that failed to generate stays failed: mail changing underneath it
		// is not why it is missing, and staling it would offer the wrong recovery.
		if (!current || !("counts" in current) || current.state === "stale" || current.state === "brief_unavailable") return current;
		return { state: "stale", counts: current.counts, omittedCount: current.omittedCount };
	});
}

export function useGlobalTodayBrief(timeZone: string, deterministicTodayIsComplete: boolean) {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: globalTodayBriefKeys.detail(timeZone),
		queryFn: ({ signal }) => getGlobalTodayBrief({ timeZone, signal }),
		enabled: Boolean(timeZone && deterministicTodayIsComplete),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		refetchInterval: (state) => state.state.data?.state === "preparing" ? 3_000 : false,
		retry,
	});
	const refresh = useMutation({
		mutationFn: () => getGlobalTodayBrief({ timeZone, refresh: true }),
		onSuccess: (response) => queryClient.setQueryData(globalTodayBriefKeys.detail(timeZone), response),
	});
	return { ...query, refresh: refresh.mutateAsync, isExplicitlyRefreshing: refresh.isPending, refreshError: refresh.error };
}
