// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
	buildQuotedReplyBlock,
	escapeHtml,
	formatComposeDate,
	getSignatureBlock,
	htmlToPlainText,
	splitEmailList,
	stripHtml,
	toEmailListValue,
} from "~/lib/utils";
import { displaySenderName } from "shared/sender";
import { useDeleteEmail, useForwardEmail, useReplyToEmail, useSaveDraft, useSendEmail } from "~/queries/emails";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";

function appendUniqueAddress(
	addresses: string[],
	seen: Set<string>,
	address: string,
	exclude?: string,
) {
	const trimmed = address.trim();
	if (!trimmed) return;

	const normalized = trimmed.toLowerCase();
	if (normalized === exclude || seen.has(normalized)) return;

	seen.add(normalized);
	addresses.push(trimmed);
}

interface ComposeFormFields {
	to: string;
	cc: string;
	bcc: string;
	showCcBcc: boolean;
	subject: string;
	body: string;
}

const EMPTY_FIELDS: ComposeFormFields = {
	to: "",
	cc: "",
	bcc: "",
	showCcBcc: false,
	subject: "",
	body: "",
};

function getPrefixedSubject(subject: string, prefix: "Re" | "Fwd") {
	const expectedPrefix = `${prefix}: `;
	return subject.startsWith(expectedPrefix)
		? subject
		: `${expectedPrefix}${subject}`;
}

function buildForwardBody(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	sigBlock: string,
) {
	const senderLabel = displaySenderName(original);
	const safeSender = escapeHtml(
		senderLabel !== original.sender
			? `${senderLabel} <${original.sender}>`
			: original.sender,
	);
	const safeSubject = escapeHtml(original.subject);
	const safeBody = escapeHtml(stripHtml(original.body || "")).replace(/\n/g, "<br>");

	return `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}<div style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><strong>Forwarded message:</strong><br><strong>From:</strong> ${safeSender}<br><strong>Date:</strong> ${formatComposeDate(original.date)}<br><strong>Subject:</strong> ${safeSubject}<br><br>${safeBody}</div>`;
}

function buildReplyAllFields(
	original: NonNullable<ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]>,
	selfAddress?: string,
) {
	const toRecipients: string[] = [];
	const toSeen = new Set<string>();
	appendUniqueAddress(toRecipients, toSeen, original.sender, selfAddress);

	for (const recipient of splitEmailList(original.recipient)) {
		appendUniqueAddress(toRecipients, toSeen, recipient, selfAddress);
	}

	const ccRecipients: string[] = [];
	const ccSeen = new Set<string>();
	for (const recipient of splitEmailList(original.cc)) {
		const normalized = recipient.toLowerCase();
		if (
			normalized === selfAddress ||
			toSeen.has(normalized) ||
			ccSeen.has(normalized)
		) {
			continue;
		}
		ccSeen.add(normalized);
		ccRecipients.push(recipient);
	}

	return {
		to: toRecipients.join(", "),
		cc: ccRecipients.join(", "),
		showCcBcc: ccRecipients.length > 0,
	};
}

function buildInitialComposeFields(
	composeOptions: ReturnType<typeof useUIStore.getState>["composeOptions"],
	mailboxEmail: string | undefined,
	sigBlock: string,
): ComposeFormFields {
	const { draftEmail: draft, originalEmail: original, mode } = composeOptions;

	if (draft) {
		return {
			to: draft.recipient || "",
			cc: draft.cc || "",
			bcc: draft.bcc || "",
			showCcBcc: Boolean(draft.cc || draft.bcc),
			subject: draft.subject || "",
			body: draft.body || "",
		};
	}

	if (!original) {
		return {
			...EMPTY_FIELDS,
			body: sigBlock ? `<p><br></p>${sigBlock}` : "",
		};
	}

	if (mode === "reply") {
		return {
			...EMPTY_FIELDS,
			to: original.sender,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, displaySenderName(original), original.body || "")}`,
		};
	}

	if (mode === "reply-all") {
		const recipients = buildReplyAllFields(original, mailboxEmail?.toLowerCase());
		return {
			...EMPTY_FIELDS,
			...recipients,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}${buildQuotedReplyBlock(original.date, displaySenderName(original), original.body || "")}`,
		};
	}

	if (mode === "forward") {
		return {
			...EMPTY_FIELDS,
			subject: getPrefixedSubject(original.subject, "Fwd"),
			body: buildForwardBody(original, sigBlock),
		};
	}

	return {
		...EMPTY_FIELDS,
		body: sigBlock ? `<p><br></p>${sigBlock}` : "",
	};
}

export type DraftSaveStatus = "idle" | "saving" | "saved" | "error";

export function useComposeForm(mailboxId?: string, _folder?: string) {
	const toastManager = useKumoToastManager();
	const { composeOptions, closePanel, closeCompose } = useUIStore();
	const { data: currentMailbox } = useMailbox(mailboxId);
	const sendEmailMutation = useSendEmail();
	const saveDraftMutation = useSaveDraft();
	const replyMutation = useReplyToEmail();
	const forwardMutation = useForwardEmail();
	const deleteEmailMutation = useDeleteEmail();

	const [to, setTo] = useState("");
	const [cc, setCc] = useState("");
	const [bcc, setBcc] = useState("");
	const [showCcBcc, setShowCcBcc] = useState(false);
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSavingDraft, setIsSavingDraft] = useState(false);
	const [isSending, setIsSending] = useState(false);
	const [saveStatus, setSaveStatus] = useState<DraftSaveStatus>("idle");
	const [savedDraftId, setSavedDraftId] = useState<string | undefined>(composeOptions.draftEmail?.id);
	const lastInitializedOptionsRef = useRef<typeof composeOptions | null>(null);
	const lastSavedSnapshotRef = useRef<string>("");
	const isDraftEdit = !!composeOptions.draftEmail;

	const formTitle = useMemo(() => {
		if (isDraftEdit) return "Edit Draft";
		switch (composeOptions.mode) { case "reply": return "Reply"; case "reply-all": return "Reply All"; case "forward": return "Forward"; default: return "New Message"; }
	}, [composeOptions.mode, isDraftEdit]);

	const sigBlock = useMemo(() => getSignatureBlock(currentMailbox?.settings), [currentMailbox]);

	useEffect(() => {
		if (lastInitializedOptionsRef.current === composeOptions) return;
		lastInitializedOptionsRef.current = composeOptions;

		const initialFields = buildInitialComposeFields(
			composeOptions,
			currentMailbox?.email,
			sigBlock,
		);
		setError(null);
		setTo(initialFields.to);
		setCc(initialFields.cc);
		setBcc(initialFields.bcc);
		setShowCcBcc(initialFields.showCcBcc);
		setSubject(initialFields.subject);
		setBody(initialFields.body);
		setSavedDraftId(composeOptions.draftEmail?.id);
		lastSavedSnapshotRef.current = `${initialFields.to}|${initialFields.cc}|${initialFields.bcc}|${initialFields.subject}|${initialFields.body}`;
		setSaveStatus("idle");
	}, [composeOptions, currentMailbox?.email, sigBlock]);

	// Debounced auto-save effect (3.0s)
	const consecutiveFailuresRef = useRef(0);

	useEffect(() => {
		if (!mailboxId || isSending) return;
		const currentSnapshot = `${to}|${cc}|${bcc}|${subject}|${body}`;
		const isEmpty = !to.trim() && !cc.trim() && !bcc.trim() && !subject.trim() && !body.trim();

		if (isEmpty || currentSnapshot === lastSavedSnapshotRef.current) {
			return;
		}

		const timer = setTimeout(async () => {
			setIsSavingDraft(true);
			setSaveStatus("saving");
			try {
				const res = await saveDraftMutation.mutateAsync({
					mailboxId,
					draft: {
						to: to || undefined,
						cc: cc || undefined,
						bcc: bcc || undefined,
						subject: subject || undefined,
						body,
						in_reply_to: composeOptions.originalEmail?.id || composeOptions.draftEmail?.in_reply_to || undefined,
						thread_id: composeOptions.originalEmail?.thread_id || composeOptions.draftEmail?.thread_id || undefined,
						draft_id: savedDraftId || composeOptions.draftEmail?.id || undefined,
					},
				});
				lastSavedSnapshotRef.current = currentSnapshot;
				if (res?.draft_id) {
					setSavedDraftId(res.draft_id);
				}
				consecutiveFailuresRef.current = 0;
				setSaveStatus("saved");
			} catch {
				consecutiveFailuresRef.current += 1;
				setSaveStatus("error");
				if (consecutiveFailuresRef.current >= 3) {
					toastManager.add({ title: "Failed to save draft.", variant: "error" });
				}
			} finally {
				setIsSavingDraft(false);
			}
		}, 3000);

		return () => clearTimeout(timer);
	}, [to, cc, bcc, subject, body, mailboxId, isSending, savedDraftId, composeOptions, saveDraftMutation]);

	const handleSaveDraft = async () => {
		if (!mailboxId || isSending) return;
		setIsSavingDraft(true);
		setSaveStatus("saving");
		setError(null);
		const currentSnapshot = `${to}|${cc}|${bcc}|${subject}|${body}`;
		try {
			const res = await saveDraftMutation.mutateAsync({
				mailboxId,
				draft: {
					to: to || undefined,
					cc: cc || undefined,
					bcc: bcc || undefined,
					subject,
					body,
					in_reply_to: composeOptions.originalEmail?.id || composeOptions.draftEmail?.in_reply_to || undefined,
					thread_id: composeOptions.originalEmail?.thread_id || composeOptions.draftEmail?.thread_id || undefined,
					draft_id: savedDraftId || composeOptions.draftEmail?.id || undefined,
				},
			});
			lastSavedSnapshotRef.current = currentSnapshot;
			if (res?.draft_id) {
				setSavedDraftId(res.draft_id);
			}
			setSaveStatus("saved");
			toastManager.add({ title: "Draft saved!" });
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to save draft.";
			setError(message);
			setSaveStatus("error");
			toastManager.add({ title: message, variant: "error" });
		} finally {
			setIsSavingDraft(false);
		}
	};

	const handleDiscard = (onClose: () => void) => {
		const draftId = savedDraftId || composeOptions.draftEmail?.id;
		if (draftId && mailboxId) {
			deleteEmailMutation.mutate({ mailboxId, id: draftId });
		}
		onClose();
	};

	const handleSend = async (e: FormEvent, onClose: () => void) => {
		e.preventDefault(); if (isSending) return; setError(null);
		if (!currentMailbox || !mailboxId) { setError("No mailbox selected."); return; }
		const toRecipients = splitEmailList(to);
		if (toRecipients.length === 0) { setError("Add at least one recipient."); return; }
		const ccRecipients = splitEmailList(cc); const bccRecipients = splitEmailList(bcc);
		const fromName = currentMailbox.settings?.fromName || currentMailbox.name;
		const from = fromName && fromName !== currentMailbox.email ? { email: currentMailbox.email, name: fromName } : currentMailbox.email;
		const emailData = {
			to: toEmailListValue(toRecipients),
			cc: toEmailListValue(ccRecipients),
			bcc: toEmailListValue(bccRecipients),
			from,
			subject,
			html: body,
			text: htmlToPlainText(body),
		};
		const draftId = savedDraftId || composeOptions.draftEmail?.id; const mode = composeOptions.mode; const originalId = composeOptions.originalEmail?.id || composeOptions.draftEmail?.in_reply_to;
		setIsSending(true); toastManager.add({ title: "Sending email..." });
		try {
			if ((mode === "reply" || mode === "reply-all") && originalId) await replyMutation.mutateAsync({ mailboxId, emailId: originalId, email: emailData });
			else if (mode === "forward" && originalId) await forwardMutation.mutateAsync({ mailboxId, emailId: originalId, email: emailData });
			else await sendEmailMutation.mutateAsync({ mailboxId, email: emailData });
			if (draftId) deleteEmailMutation.mutate({ mailboxId, id: draftId });
			toastManager.add({ title: "Email sent!" });
			onClose();
		} catch (err: unknown) { const message = (err instanceof Error ? err.message : null) || "Failed to send email."; setError(message); toastManager.add({ title: message, variant: "error" }); }
		finally { setIsSending(false); }
	};

	return {
		to,
		setTo,
		cc,
		setCc,
		bcc,
		setBcc,
		showCcBcc,
		setShowCcBcc,
		subject,
		setSubject,
		body,
		setBody,
		error,
		setError,
		isSavingDraft,
		isSending,
		saveStatus,
		formTitle,
		handleSaveDraft,
		handleDiscard,
		handleSend,
		closeCompose,
		closePanel,
	};
}
