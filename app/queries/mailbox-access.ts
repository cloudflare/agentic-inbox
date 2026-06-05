import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { AiDraftSettings, MailboxMembership, ResponseTemplate } from "~/types";
import { queryKeys } from "./keys";

export function useMailboxMemberships(mailboxId: string | undefined, enabled: boolean) {
	return useQuery<MailboxMembership[]>({
		queryKey: mailboxId
			? queryKeys.mailboxes.memberships(mailboxId)
			: ["mailboxes", "_disabled_memberships"],
		queryFn: () => api.listMemberships(mailboxId!),
		enabled: !!mailboxId && enabled,
	});
}

export function useUpdateMembership() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			userIdOrEmail,
			role,
		}: {
			mailboxId: string;
			userIdOrEmail: string;
			role: MailboxMembership["role"];
		}) => api.updateMembership(mailboxId, userIdOrEmail, role),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.memberships(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useDeleteMembership() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			userIdOrEmail,
		}: {
			mailboxId: string;
			userIdOrEmail: string;
		}) => api.deleteMembership(mailboxId, userIdOrEmail),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.memberships(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useTemplates(mailboxId: string | undefined, enabled: boolean) {
	return useQuery<ResponseTemplate[]>({
		queryKey: mailboxId
			? queryKeys.mailboxes.templates(mailboxId)
			: ["mailboxes", "_disabled_templates"],
		queryFn: () => api.listTemplates(mailboxId!),
		enabled: !!mailboxId && enabled,
	});
}

export function useCreateTemplate() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			template,
		}: {
			mailboxId: string;
			template: { name: string; subject?: string; bodyHtml: string; bodyText?: string | null };
		}) => api.createTemplate(mailboxId, template),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.templates(mailboxId) });
		},
	});
}

export function useUpdateTemplate() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			templateId,
			template,
		}: {
			mailboxId: string;
			templateId: string;
			template: { name: string; subject?: string; bodyHtml: string; bodyText?: string | null };
		}) => api.updateTemplate(mailboxId, templateId, template),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.templates(mailboxId) });
		},
	});
}

export function useDeleteTemplate() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			templateId,
		}: {
			mailboxId: string;
			templateId: string;
		}) => api.deleteTemplate(mailboxId, templateId),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.templates(mailboxId) });
		},
	});
}

export function useAiSettings(mailboxId: string | undefined, enabled: boolean) {
	return useQuery<AiDraftSettings>({
		queryKey: mailboxId
			? queryKeys.mailboxes.aiSettings(mailboxId)
			: ["mailboxes", "_disabled_ai_settings"],
		queryFn: () => api.getAiSettings(mailboxId!),
		enabled: !!mailboxId && enabled,
	});
}

export function useUpdateAiSettings() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			settings,
		}: {
			mailboxId: string;
			settings: { enabled: boolean; model?: string | null; systemPrompt?: string | null };
		}) => api.updateAiSettings(mailboxId, settings),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.aiSettings(mailboxId) });
		},
	});
}

export function useGenerateAiDraft() {
	return useMutation({
		mutationFn: ({
			mailboxId,
			emailId,
			templateId,
		}: {
			mailboxId: string;
			emailId: string;
			templateId?: string;
		}) => api.generateAiDraft(mailboxId, emailId, templateId),
	});
}
