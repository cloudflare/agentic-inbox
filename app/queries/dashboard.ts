// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import type { DashboardSummary } from "~/types";
import { queryKeys } from "./keys";

export function useDashboardSummary(mailboxId: string | undefined) {
	return useQuery<DashboardSummary>({
		queryKey: mailboxId ? queryKeys.dashboard(mailboxId) : ["dashboard", "_disabled"],
		queryFn: ({ signal }) =>
			api.getDashboardSummary(mailboxId!, { signal }) as Promise<DashboardSummary>,
		enabled: !!mailboxId,
		staleTime: 30_000,
	});
}
