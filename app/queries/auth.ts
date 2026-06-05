import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { AppUser, CurrentUser } from "~/types";
import { queryKeys } from "./keys";

export function useMe() {
	return useQuery<CurrentUser>({
		queryKey: queryKeys.me,
		queryFn: () => api.getMe(),
	});
}

export function useRegister() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api.register(),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.me });
		},
	});
}

export function useUsers(enabled: boolean) {
	return useQuery<AppUser[]>({
		queryKey: queryKeys.users.all,
		queryFn: () => api.listUsers(),
		enabled,
	});
}

export function useUpdateUser() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			userId,
			data,
		}: {
			userId: string;
			data: { status?: AppUser["status"]; globalRole?: AppUser["globalRole"]; displayName?: string | null };
		}) => api.updateUser(userId, data),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.users.all });
			qc.invalidateQueries({ queryKey: queryKeys.me });
		},
	});
}
