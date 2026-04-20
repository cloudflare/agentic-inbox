import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
import { queryKeys } from "./keys";

export function useSetupStatus() {
	return useQuery({
		queryKey: queryKeys.setupStatus,
		queryFn: () => api.getSetupStatus(),
		staleTime: 0,
	});
}
