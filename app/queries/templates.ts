// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { Template } from "~/types";
import { queryKeys } from "./keys";

export function useTemplateList(mailboxId: string | undefined) {
	return useQuery<Template[]>({
		queryKey: mailboxId
			? queryKeys.templates.list(mailboxId)
			: ["templates", "_disabled"],
		queryFn: () => api.listTemplates(mailboxId!),
		enabled: !!mailboxId,
	});
}

export function useCreateTemplate() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			title,
			body,
			tags,
		}: { mailboxId: string; title: string; body: string; tags?: string }) =>
			api.createTemplate(mailboxId, { title, body, tags }),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.templates.list(mailboxId) });
		},
	});
}

export function useUpdateTemplate() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			title,
			body,
			tags,
		}: { mailboxId: string; id: string; title?: string; body?: string; tags?: string }) =>
			api.updateTemplate(mailboxId, id, { title, body, tags }),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.templates.list(mailboxId) });
		},
	});
}

export function useDeleteTemplate() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, id }: { mailboxId: string; id: string }) =>
			api.deleteTemplate(mailboxId, id),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.templates.list(mailboxId) });
		},
	});
}
