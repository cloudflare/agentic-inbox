// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { Roster, Student } from "~/types";
import { queryKeys } from "./keys";

export function useRosterList(mailboxId: string | undefined) {
	return useQuery<Roster[]>({
		queryKey: mailboxId
			? queryKeys.rosters.list(mailboxId)
			: ["rosters", "_disabled"],
		queryFn: () => api.listRosters(mailboxId!),
		enabled: !!mailboxId,
	});
}

export function useStudentList(mailboxId: string | undefined, rosterId: string | undefined) {
	return useQuery<Student[]>({
		queryKey: mailboxId && rosterId
			? queryKeys.rosters.students(mailboxId, rosterId)
			: ["rosters", "_disabled"],
		queryFn: () => api.listStudents(mailboxId!, rosterId!),
		enabled: !!mailboxId && !!rosterId,
	});
}

export function useCreateRoster() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			name,
			students,
		}: { mailboxId: string; name: string; students: { name?: string; email: string }[] }) =>
			api.createRoster(mailboxId, { name, students }),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.rosters.list(mailboxId) });
		},
	});
}

export function useDeleteRoster() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, id }: { mailboxId: string; id: string }) =>
			api.deleteRoster(mailboxId, id),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.rosters.list(mailboxId) });
		},
	});
}
