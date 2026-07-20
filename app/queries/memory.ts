// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { DraftContextPack, MemoryEntry, MemoryFileDetail, MemoryFact, MemorySearchResponse } from "~/types";
import { queryKeys } from "./keys";

export function useMemoryList(mailboxId: string | undefined) {
	return useQuery<MemoryEntry[]>({
		queryKey: mailboxId
			? queryKeys.memory.list(mailboxId)
			: ["memory", "_disabled"],
		queryFn: () => api.listMemory(mailboxId!),
		enabled: !!mailboxId,
		refetchInterval: (query) => {
			const hasProcessing = query.state.data?.some((e) => e.status === "processing");
			return hasProcessing ? 3_000 : false;
		},
	});
}

export function useAddMemory() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			title,
			content,
			tags,
		}: { mailboxId: string; title: string; content: string; tags?: string }) =>
			api.addMemory(mailboxId, { title, content, tags }),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.memory.list(mailboxId) });
		},
	});
}

export function useUploadMemory() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			file,
			title,
			tags,
		}: { mailboxId: string; file: File; title?: string; tags?: string }) =>
			api.uploadMemory(mailboxId, file, title, tags),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.memory.list(mailboxId) });
		},
	});
}

export function useMemoryDetail(mailboxId: string | undefined, id: string | undefined) {
	return useQuery<MemoryFileDetail>({
		queryKey: mailboxId && id
			? queryKeys.memory.detail(mailboxId, id)
			: ["memory", "_disabled"],
		queryFn: () => api.getMemory(mailboxId!, id!),
		enabled: !!mailboxId && !!id,
	});
}

export function useUpdateMemory() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			title,
			tags,
			draft_eligible,
		}: { mailboxId: string; id: string; title?: string; tags?: string; draft_eligible?: boolean }) =>
			api.updateMemory(mailboxId, id, { title, tags, draft_eligible }),
		onSuccess: (_data, { mailboxId, id }) => {
			qc.invalidateQueries({ queryKey: queryKeys.memory.list(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.memory.detail(mailboxId, id) });
		},
	});
}

export function useSummarizeMemory() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, id }: { mailboxId: string; id: string }) =>
			api.summarizeMemory(mailboxId, id),
		onSuccess: (_data, { mailboxId, id }) => {
			qc.invalidateQueries({ queryKey: queryKeys.memory.list(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.memory.detail(mailboxId, id) });
		},
	});
}

export function useDeleteMemory() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, id }: { mailboxId: string; id: string }) =>
			api.deleteMemory(mailboxId, id),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.memory.list(mailboxId) });
		},
	});
}

export function useSearchMemory(mailboxId: string | undefined, query: string) {
	return useQuery<MemorySearchResponse>({
		queryKey: mailboxId
			? queryKeys.memory.search(mailboxId, query)
			: ["memory", "_disabled"],
		queryFn: () => api.searchMemory(mailboxId!, query),
		enabled: !!mailboxId && query.trim().length > 0,
	});
}

export function useMemoryContext(mailboxId: string | undefined, query: string) {
	return useQuery<DraftContextPack>({
		queryKey: mailboxId ? queryKeys.memory.context(mailboxId, query) : ["memory", "_disabled"],
		queryFn: () => api.getMemoryContext(mailboxId!, query),
		enabled: !!mailboxId && query.trim().length > 0,
	});
}

export function useMemoryFacts(mailboxId: string | undefined, status?: string) {
	return useQuery<MemoryFact[]>({
		queryKey: mailboxId ? queryKeys.memory.facts(mailboxId, status) : ["memory", "_disabled"],
		queryFn: () => api.listMemoryFacts(mailboxId!, status),
		enabled: !!mailboxId,
	});
}

export function useUpdateMemoryFactStatus() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, id, status }: { mailboxId: string; id: string; status: MemoryFact["status"] }) =>
			api.updateMemoryFactStatus(mailboxId, id, status),
		onSuccess: (_data, { mailboxId }) => qc.invalidateQueries({ queryKey: ["memory", mailboxId, "facts"] }),
	});
}
