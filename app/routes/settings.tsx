// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Input, Loader, Select, useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { htmlToPlainText } from "~/lib/utils";
import {
	useAiSettings,
	useCreateTemplate,
	useDeleteMembership,
	useDeleteTemplate,
	useMailboxMemberships,
	useTemplates,
	useUpdateAiSettings,
	useUpdateMembership,
	useUpdateTemplate,
} from "~/queries/mailbox-access";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import type { MailboxMembership, ResponseTemplate } from "~/types";

const MAILBOX_ROLES: MailboxMembership["role"][] = ["manager", "responder", "viewer"];

function removeRetiredSettings(settings: object | undefined): Record<string, unknown> {
	const next = { ...(settings ?? {}) } as Record<string, unknown>;
	delete next.agentSystemPrompt;
	return next;
}

function Section({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section className="rounded-lg border border-kumo-line bg-kumo-base p-5">
			<div className="text-sm font-medium text-kumo-default mb-4">
				{title}
			</div>
			{children}
		</section>
	);
}

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const capabilities = mailbox?.capabilities;
	const canManageMailbox = !!capabilities?.manageMailbox;
	const canManageMembers = !!capabilities?.manageMembers;
	const canUseTemplates = !!capabilities?.useTemplates;
	const canManageTemplates = !!capabilities?.manageTemplates;
	const canManageAi = !!capabilities?.manageAi;

	const { data: memberships = [] } = useMailboxMemberships(mailboxId, canManageMembers);
	const updateMembership = useUpdateMembership();
	const deleteMembership = useDeleteMembership();
	const { data: templates = [] } = useTemplates(mailboxId, canUseTemplates);
	const createTemplate = useCreateTemplate();
	const updateTemplate = useUpdateTemplate();
	const deleteTemplate = useDeleteTemplate();
	const { data: aiSettings } = useAiSettings(mailboxId, !!capabilities?.readMail);
	const updateAiSettings = useUpdateAiSettings();

	const [displayName, setDisplayName] = useState("");
	const [isSavingAccount, setIsSavingAccount] = useState(false);
	const [memberEmail, setMemberEmail] = useState("");
	const [memberRole, setMemberRole] = useState<MailboxMembership["role"]>("viewer");
	const [templateId, setTemplateId] = useState<string | null>(null);
	const [templateName, setTemplateName] = useState("");
	const [templateSubject, setTemplateSubject] = useState("");
	const [templateBody, setTemplateBody] = useState("");
	const [aiEnabled, setAiEnabled] = useState(false);
	const [aiModel, setAiModel] = useState("");
	const [aiPrompt, setAiPrompt] = useState("");

	useEffect(() => {
		if (mailbox) setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
	}, [mailbox]);

	useEffect(() => {
		if (!aiSettings) return;
		setAiEnabled(aiSettings.enabled);
		setAiModel(aiSettings.model || "");
		setAiPrompt(aiSettings.systemPrompt || "");
	}, [aiSettings]);

	const editingTemplate = useMemo(
		() => templates.find((template) => template.id === templateId) ?? null,
		[templateId, templates],
	);

	const resetTemplateForm = () => {
		setTemplateId(null);
		setTemplateName("");
		setTemplateSubject("");
		setTemplateBody("");
	};

	const editTemplate = (template: ResponseTemplate) => {
		setTemplateId(template.id);
		setTemplateName(template.name);
		setTemplateSubject(template.subject);
		setTemplateBody(template.bodyHtml);
	};

	const handleSaveAccount = async () => {
		if (!mailbox || !mailboxId || !canManageMailbox) return;
		setIsSavingAccount(true);
		const settings = {
			...removeRetiredSettings(mailbox.settings),
			fromName: displayName,
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved" });
		} catch {
			toastManager.add({ title: "Failed to save settings", variant: "error" });
		} finally {
			setIsSavingAccount(false);
		}
	};

	const handleGrantMember = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!mailboxId || !memberEmail.trim()) return;
		try {
			await updateMembership.mutateAsync({
				mailboxId,
				userIdOrEmail: memberEmail.trim(),
				role: memberRole,
			});
			setMemberEmail("");
			toastManager.add({ title: "Access updated" });
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to update access";
			toastManager.add({ title: message, variant: "error" });
		}
	};

	const handleSaveTemplate = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!mailboxId || !templateName.trim() || !templateBody.trim()) return;
		const template = {
			name: templateName.trim(),
			subject: templateSubject.trim(),
			bodyHtml: templateBody,
			bodyText: htmlToPlainText(templateBody),
		};
		try {
			if (editingTemplate) {
				await updateTemplate.mutateAsync({
					mailboxId,
					templateId: editingTemplate.id,
					template,
				});
			} else {
				await createTemplate.mutateAsync({ mailboxId, template });
			}
			resetTemplateForm();
			toastManager.add({ title: "Template saved" });
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to save template";
			toastManager.add({ title: message, variant: "error" });
		}
	};

	const handleSaveAi = async () => {
		if (!mailboxId || !canManageAi) return;
		try {
			await updateAiSettings.mutateAsync({
				mailboxId,
				settings: {
					enabled: aiEnabled,
					model: aiModel.trim() || null,
					systemPrompt: aiPrompt.trim() || null,
				},
			});
			toastManager.add({ title: "AI settings saved" });
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to save AI settings";
			toastManager.add({ title: message, variant: "error" });
		}
	};

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	return (
		<div className="max-w-3xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			<div className="space-y-6">
				<Section title="Account">
					<div className="space-y-3">
						<Input
							label="Display Name"
							value={displayName}
							disabled={!canManageMailbox}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="Email" type="email" value={mailbox.email} disabled />
						<div className="flex items-center justify-between gap-3">
							<div className="text-sm text-kumo-subtle">
								Role: {mailbox.role || "viewer"}
							</div>
							<Button
								variant="primary"
								onClick={handleSaveAccount}
								loading={isSavingAccount}
								disabled={!canManageMailbox}
							>
								Save Account
							</Button>
						</div>
					</div>
				</Section>

				{canManageMembers && (
					<Section title="Access">
						<form onSubmit={handleGrantMember} className="grid gap-3 md:grid-cols-[1fr_160px_auto]">
							<Input
								label="User email"
								type="email"
								value={memberEmail}
								onChange={(e) => setMemberEmail(e.target.value)}
								placeholder="teammate@example.com"
							/>
							<div>
								<span className="text-sm font-medium text-kumo-default mb-1.5 block">
									Role
								</span>
								<Select
									value={memberRole}
									onValueChange={(value) => {
										if (value && MAILBOX_ROLES.includes(value as MailboxMembership["role"])) {
											setMemberRole(value as MailboxMembership["role"]);
										}
									}}
								>
									{MAILBOX_ROLES.map((role) => (
										<Select.Option key={role} value={role}>
											{role}
										</Select.Option>
									))}
								</Select>
							</div>
							<div className="flex items-end">
								<Button type="submit" variant="primary" disabled={!memberEmail.trim()}>
									Grant
								</Button>
							</div>
						</form>

						<div className="mt-5 rounded-md border border-kumo-line overflow-hidden">
							{memberships.length === 0 ? (
								<div className="px-4 py-5 text-sm text-kumo-subtle">
									No direct grants yet.
								</div>
							) : (
								memberships.map((membership, idx) => (
									<div
										key={membership.userId}
										className={`grid gap-3 px-4 py-3 md:grid-cols-[1fr_130px_auto] md:items-center ${
											idx > 0 ? "border-t border-kumo-line" : ""
										}`}
									>
										<div className="min-w-0">
											<div className="truncate text-sm font-medium text-kumo-default">
												{membership.displayName || membership.email}
											</div>
											<div className="truncate text-sm text-kumo-subtle">
												{membership.email} · {membership.status}
											</div>
										</div>
										<Select
											value={membership.role}
											onValueChange={(value) => {
												if (value && MAILBOX_ROLES.includes(value as MailboxMembership["role"]) && mailboxId) {
													updateMembership.mutate({
														mailboxId,
														userIdOrEmail: membership.userId,
														role: value as MailboxMembership["role"],
													});
												}
											}}
										>
											{MAILBOX_ROLES.map((role) => (
												<Select.Option key={role} value={role}>
													{role}
												</Select.Option>
											))}
										</Select>
										<Button
											variant="ghost"
											size="sm"
											onClick={() => {
												if (mailboxId) {
													deleteMembership.mutate({
														mailboxId,
														userIdOrEmail: membership.userId,
													});
												}
											}}
										>
											Remove
										</Button>
									</div>
								))
							)}
						</div>
					</Section>
				)}

				{canUseTemplates && (
					<Section title="Templates">
						{canManageTemplates && (
							<form onSubmit={handleSaveTemplate} className="space-y-3">
								<Input
									label="Name"
									value={templateName}
									onChange={(e) => setTemplateName(e.target.value)}
									placeholder="Refund approved"
								/>
								<Input
									label="Subject"
									value={templateSubject}
									onChange={(e) => setTemplateSubject(e.target.value)}
									placeholder="Optional subject"
								/>
								<div>
									<label className="text-sm font-medium text-kumo-default mb-1.5 block">
										Body HTML
									</label>
									<textarea
										aria-label="Body HTML"
										value={templateBody}
										onChange={(e) => setTemplateBody(e.target.value)}
										rows={6}
										className="w-full rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default outline-none focus:border-kumo-primary"
										placeholder="<p>Thanks for reaching out...</p>"
									/>
								</div>
								<div className="flex justify-end gap-2">
									{editingTemplate && (
										<Button type="button" variant="secondary" onClick={resetTemplateForm}>
											Cancel Edit
										</Button>
									)}
									<Button
										type="submit"
										variant="primary"
										disabled={!templateName.trim() || !templateBody.trim()}
										loading={createTemplate.isPending || updateTemplate.isPending}
									>
										{editingTemplate ? "Update Template" : "Save Template"}
									</Button>
								</div>
							</form>
						)}

						<div className="mt-5 rounded-md border border-kumo-line overflow-hidden">
							{templates.length === 0 ? (
								<div className="px-4 py-5 text-sm text-kumo-subtle">
									No templates saved.
								</div>
							) : (
								templates.map((template, idx) => (
									<div
										key={template.id}
										className={`flex items-center gap-3 px-4 py-3 ${
											idx > 0 ? "border-t border-kumo-line" : ""
										}`}
									>
										<div className="min-w-0 flex-1">
											<div className="truncate text-sm font-medium text-kumo-default">
												{template.name}
											</div>
											<div className="truncate text-sm text-kumo-subtle">
												{template.subject || "No subject"}
											</div>
										</div>
										{canManageTemplates && (
											<>
												<Button variant="ghost" size="sm" onClick={() => editTemplate(template)}>
													Edit
												</Button>
												<Button
													variant="ghost"
													size="sm"
													onClick={() => {
														if (mailboxId) deleteTemplate.mutate({ mailboxId, templateId: template.id });
													}}
												>
													Delete
												</Button>
											</>
										)}
									</div>
								))
							)}
						</div>
					</Section>
				)}

				<Section title="AI">
					<div className="space-y-3">
						<label className="flex items-center gap-2 text-sm text-kumo-default">
							<input
								type="checkbox"
								checked={aiEnabled}
								disabled={!canManageAi}
								onChange={(e) => setAiEnabled(e.target.checked)}
							/>
							Enable explicit AI draft generation
						</label>
						<Input
							label="Model"
							value={aiModel}
							disabled={!canManageAi}
							onChange={(e) => setAiModel(e.target.value)}
							placeholder="@cf/meta/llama-3.1-8b-instruct"
						/>
						<div>
							<label className="text-sm font-medium text-kumo-default mb-1.5 block">
								System prompt
							</label>
							<textarea
								aria-label="System prompt"
								value={aiPrompt}
								disabled={!canManageAi}
								onChange={(e) => setAiPrompt(e.target.value)}
								rows={4}
								className="w-full rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default outline-none focus:border-kumo-primary disabled:opacity-60"
							/>
						</div>
						<div className="flex justify-end">
							<Button
								variant="primary"
								onClick={handleSaveAi}
								disabled={!canManageAi}
								loading={updateAiSettings.isPending}
							>
								Save AI Settings
							</Button>
						</div>
					</div>
				</Section>
			</div>
		</div>
	);
}
