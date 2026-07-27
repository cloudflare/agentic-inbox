// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { updateEmailFailureTitle } from "~/lib/conversation-actions";
import { resolveEmailListRefetchInterval } from "~/lib/email-list-read-state";
import {
	countDeliveriesNeedingAttention,
	SEND_OUTCOME_POLL_MS,
} from "~/lib/send-outcome";
import api from "~/services/api";
import type { Email, AttachmentRef, OutboundDelivery } from "~/types";
import type { BatchTriageCommand } from "../../shared/batch-triage";
import type { AiComposeDraftRequest } from "../../shared/ai-drafting";
import { queryKeys } from "./keys";

// ---------- Types ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

// ---------- Queries ----------

export function useEmails(
	mailboxId: string | undefined,
	params: Record<string, string>,
	options?: { enabled?: boolean; refetchInterval?: number },
) {
	const queryParams = params.folder
		? { ...params, threaded: "true" }
		: params;

	return useQuery<EmailListResponse>({
		queryKey: mailboxId
			? queryKeys.emails.list(mailboxId, queryParams)
			: ["emails", "_disabled"],
		queryFn: async () => {
			const data = await api.listEmails(mailboxId!, queryParams) as
				| EmailListResponse
				| Email[];
			if (data && typeof data === "object" && "emails" in data) {
				return {
					emails: (data as EmailListResponse).emails ?? [],
					totalCount: (data as EmailListResponse).totalCount ?? 0,
				};
			}
			const arr = Array.isArray(data) ? data : [];
			return { emails: arr, totalCount: arr.length };
		},
		enabled: !!mailboxId && (options?.enabled ?? true),
		refetchInterval: (query) =>
			resolveEmailListRefetchInterval({
				isError: query.state.status === "error",
				interval: options?.refetchInterval,
			}),
	});
}

export function useEmail(
	mailboxId: string | undefined,
	emailId: string | undefined,
) {
	return useQuery<Email>({
		queryKey: mailboxId && emailId
			? queryKeys.emails.detail(mailboxId, emailId)
			: ["emails", "_disabled_detail"],
		queryFn: ({ signal }) =>
			api.getEmail(mailboxId!, emailId!, { signal }) as Promise<Email>,
		enabled: !!mailboxId && !!emailId,
	});
}

export function useOutboundDeliveries(
	mailboxId: string | undefined,
	emails: Array<Email | string> = [],
	enabled = true,
	includeThreadHighlights = false,
) {
	const emailIds = emails.map((email) => typeof email === "string" ? email : email.id);
	const threadIds = includeThreadHighlights
		? [...new Set(emails.flatMap((email) =>
			typeof email !== "string" && email.thread_id ? [email.thread_id] : [],
		))]
		: [];
	const emailIdsKey = [...new Set(emailIds)].sort().join(",");
	const threadIdsKey = [...threadIds].sort().join(",");
	return useQuery<OutboundDelivery[]>({
		queryKey: mailboxId
			? queryKeys.outbound.list(mailboxId, `${emailIdsKey}|${threadIdsKey}`)
			: ["outbound", "_disabled"],
		queryFn: async () =>
			(await api.listOutboundDeliveries(mailboxId!, emailIds, threadIds)).deliveries,
		enabled: Boolean(mailboxId) && enabled && emailIds.length > 0,
		refetchInterval: (query) =>
			resolveEmailListRefetchInterval({
				isError: query.state.status === "error",
				interval: enabled ? SEND_OUTCOME_POLL_MS : undefined,
			}),
	});
}

/**
 * Mailbox-wide delivery snapshot backing ambient failure surfacing. Deliberately
 * slow: the send toast owns the fast path, this only has to notice a delivery
 * that failed while the user was elsewhere.
 */
export function useOutboundAttentionCount(mailboxId: string | undefined) {
	const { data = [] } = useQuery<OutboundDelivery[]>({
		queryKey: mailboxId
			? queryKeys.outbound.list(mailboxId, "mailbox")
			: ["outbound", "_disabled_mailbox"],
		queryFn: async () =>
			(await api.listOutboundDeliveries(mailboxId!)).deliveries,
		enabled: Boolean(mailboxId),
		refetchInterval: (query) =>
			resolveEmailListRefetchInterval({
				isError: query.state.status === "error",
				interval: 60_000,
			}),
	});
	return countDeliveriesNeedingAttention(data);
}

export function useCancelOutboundDelivery() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, deliveryId }: { mailboxId: string; deliveryId: string }) =>
			api.cancelOutboundDelivery(mailboxId, deliveryId),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: ["outbound", mailboxId] });
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		},
	});
}

export function useRetryOutboundDelivery() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			deliveryId,
			acknowledgeDuplicateRisk,
		}: {
			mailboxId: string;
			deliveryId: string;
			acknowledgeDuplicateRisk: boolean;
		}) =>
			api.retryOutboundDelivery(
				mailboxId,
				deliveryId,
				acknowledgeDuplicateRisk,
			),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: ["outbound", mailboxId] });
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		},
	});
}

export function useThreadReplies(
	mailboxId: string | undefined,
	threadId: string | undefined | null,
) {
	const qc = useQueryClient();

	return useQuery<Email[]>({
		queryKey: mailboxId && threadId
			? queryKeys.emails.thread(mailboxId, threadId)
			: ["emails", "_disabled_thread"],
		queryFn: async ({ signal }) => {
			// Single request returns every thread email with bounded body previews
			// and attachments. External full bodies load only while their message
			// is selected or expanded.
			const emails = await api.getThread(mailboxId!, threadId!, { signal }) as Email[];

			// Populate individual email detail caches so clicking a thread
			// message in the panel doesn't re-fetch.
			for (const email of emails) {
				if (email.body_external) continue;
				qc.setQueryData(
					queryKeys.emails.detail(mailboxId!, email.id),
					email,
				);
			}

			return emails;
		},
		enabled: !!mailboxId && !!threadId,
	});
}

// ---------- Mutations ----------

/** Invalidate both the email list and folder counts after any email mutation. */
function useInvalidateEmailData() {
	const qc = useQueryClient();
	return (mailboxId: string) => {
		qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		qc.invalidateQueries({
			queryKey: queryKeys.folders.list(mailboxId),
		});
	};
}

export function useSendEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			email,
		}: { mailboxId: string; email: unknown }) =>
			api.sendEmail(mailboxId, email),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useUpdateEmail() {
	const qc = useQueryClient();
	const toastManager = useKumoToastManager();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			data,
		}: { mailboxId: string; id: string; data: unknown }) =>
			api.updateEmail(mailboxId, id, data),
		onMutate: async ({ mailboxId, id, data }) => {
			// Only target list queries (3rd key element is an object = params),
			// NOT detail queries (string = emailId) or thread queries.
			const isListQuery = (query: { queryKey: readonly unknown[] }) =>
				query.queryKey[0] === "emails" &&
				query.queryKey[1] === mailboxId &&
				typeof query.queryKey[2] === "object" &&
				query.queryKey[2] !== null;

			// Cancel in-flight list queries so they don't overwrite our optimistic update
			await qc.cancelQueries({
				queryKey: ["emails", mailboxId],
				predicate: isListQuery,
			});

			// Snapshot current email list caches for rollback
			const listQueries = qc.getQueriesData<{ emails: Email[]; totalCount: number }>({
				queryKey: ["emails", mailboxId],
				predicate: isListQuery,
			});

			// Optimistically patch every cached email list that contains this email
			for (const [key, cached] of listQueries) {
				if (!cached?.emails) continue;
				qc.setQueryData(key, {
					...cached,
					emails: cached.emails.map((e) =>
						e.id === id ? { ...e, ...(data as Partial<Email>) } : e,
					),
				});
			}

			// Also patch the detail cache
			const detailKey = queryKeys.emails.detail(mailboxId, id);
			const prevDetail = qc.getQueryData<Email>(detailKey);
			if (prevDetail) {
				qc.setQueryData(detailKey, { ...prevDetail, ...(data as Partial<Email>) });
			}

			return { listQueries, prevDetail, detailKey };
		},
		onError: (_err, { data }, context) => {
			// Roll back optimistic updates on failure
			if (context?.listQueries) {
				for (const [key, cached] of context.listQueries) {
					qc.setQueryData(key, cached);
				}
			}
			if (context?.prevDetail) {
				qc.setQueryData(context.detailKey, context.prevDetail);
			}
			// The rollback is visible, so the reason has to be too. Owning this
			// here keeps every bare .mutate() call site honest.
			toastManager.add({
				title: updateEmailFailureTitle(data),
				variant: "error",
			});
		},
		onSettled: (_data, _err, { mailboxId }) => {
			// Always refetch to ensure server truth
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
			qc.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		},
	});
}

export function useMarkThreadRead() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			threadId,
		}: { mailboxId: string; threadId: string }) =>
			api.markThreadRead(mailboxId, threadId),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
			qc.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		},
	});
}

function useConversationMutation<TVariables extends { mailboxId: string }>(
	mutationFn: (variables: TVariables) => Promise<unknown>,
) {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn,
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useSetConversationRead() {
	return useConversationMutation(
		({ mailboxId, conversationId, folderId, read }: {
			mailboxId: string;
			conversationId: string;
			folderId: string;
			read: boolean;
		}) => api.setConversationRead(mailboxId, conversationId, folderId, read),
	);
}

export function useArchiveConversation() {
	return useConversationMutation(
		({ mailboxId, conversationId, folderId, representativeEmailId }: {
			mailboxId: string;
			conversationId: string;
			folderId: string;
			representativeEmailId: string;
		}) => api.archiveConversation(
			mailboxId,
			conversationId,
			folderId,
			representativeEmailId,
		),
	);
}

export function useTrashConversation() {
	return useConversationMutation(
		({ mailboxId, conversationId, folderId, representativeEmailId }: {
			mailboxId: string;
			conversationId: string;
			folderId: string;
			representativeEmailId: string;
		}) => api.trashConversation(
			mailboxId,
			conversationId,
			folderId,
			representativeEmailId,
		),
	);
}

export function useBatchTriage() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			command,
		}: {
			mailboxId: string;
			command: BatchTriageCommand;
		}) => api.batchTriage(mailboxId, command),
		onSettled: (_data, _error, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useDeleteEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
		}: { mailboxId: string; id: string }) =>
			api.deleteEmail(mailboxId, id),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useRestoreEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
		}: { mailboxId: string; id: string }) => api.restoreEmail(mailboxId, id),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useDiscardDraft() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({ mailboxId, id, version }: { mailboxId: string; id: string; version: number }) =>
			api.discardDraft(mailboxId, id, version),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useMoveEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			folderId,
		}: { mailboxId: string; id: string; folderId: string }) =>
			api.moveEmail(mailboxId, id, folderId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useSaveDraft() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			draft,
		}: {
			mailboxId: string;
			draft: {
				to?: string;
				cc?: string;
				bcc?: string;
				subject?: string;
				body: string;
				in_reply_to?: string;
				thread_id?: string;
				draft_id?: string;
					draft_version?: number;
					draft_create_key?: string;
					draft_save_key?: string;
					attachments?: AttachmentRef[];
			};
		}) => api.saveDraft(mailboxId, draft),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useReplyToEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			emailId,
			email,
		}: { mailboxId: string; emailId: string; email: unknown }) =>
			api.replyToEmail(mailboxId, emailId, email),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useForwardEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			emailId,
			email,
		}: { mailboxId: string; emailId: string; email: unknown }) =>
			api.forwardEmail(mailboxId, emailId, email),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

/** One-shot AI reply draft for an email/thread. Returns { to, subject, body } to seed the composer. */
export function useAiDraftReply() {
	return useMutation({
		mutationFn: ({
			mailboxId,
			emailId,
		}: { mailboxId: string; emailId: string }) =>
			api.aiDraftReply(mailboxId, emailId),
	});
}

/** Generate or refine a new email while keeping the request pinned to its origin mailbox. */
export function useAiDraftCompose() {
	return useMutation({
		mutationFn: ({
			mailboxId,
			prompt,
			currentSubject,
			currentBody,
			preserveSignature,
		}: AiComposeDraftRequest & { mailboxId: string }) =>
			api.aiDraftCompose(mailboxId, {
				prompt,
				currentSubject,
				currentBody,
				preserveSignature,
			}),
	});
}
