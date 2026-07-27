// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  htmlToPlainText,
  splitEmailList,
  toEmailListValue,
} from "~/lib/utils";
import {
  useDiscardDraft,
  useForwardEmail,
  useReplyToEmail,
  useSaveDraft,
  useSendEmail,
} from "~/queries/emails";
import { useMailbox } from "~/queries/mailboxes";
import { useMailboxSignatureSettings } from "~/queries/mailbox-signature-settings";
import { useUIStore } from "~/hooks/useUIStore";
import { useAttachments } from "~/hooks/useAttachments";
import type { AttachmentRef, OutboundEnqueueResponse } from "~/types";
import { LogicalSendIdentity } from "~/lib/compose-send-identity";
import { planComposeEnqueueResult } from "~/lib/outbound-enqueue-outcome";
import {
	composeDeliveryPersistenceKey,
	planComposeSend,
} from "~/lib/compose-delivery";
import {
  insertComposeSignatureManually,
  planDelayedComposeSignature,
  replaceAiAuthoredContent,
} from "~/lib/compose-signature";
import { ApiError } from "~/services/api";
import type { MailboxSignature } from "../../shared/mailbox-signature-settings";
import {
	composeRecoveryLifecycleForRender,
	peekComposeRecovery,
  readComposeRecovery,
	restoredComposeLifecycle,
  writeComposeRecovery,
} from "~/lib/compose-recovery";
import {
  evaluateComposeAttachments,
  evaluateStoredDraftAttachments,
  type ComposeAttachmentRecord,
} from "~/lib/compose-attachment-policy";
import { removeManagedInlineImageNodes } from "~/lib/compose-inline-images";
import {
  composeDraftFingerprint,
  composeDraftSaveKey,
  composeDraftIsDirty,
  composeDraftIsEmpty,
  composeDraftLifecycle,
  composeDraftTransition,
  planComposeClose,
  shouldCaptureProgrammaticComposeChange,
  type ComposeDraftLifecycle,
  type ComposeDraftLifecycleEvent,
  type ComposeDraftSnapshot,
} from "~/lib/compose-draft-lifecycle";
import { buildInitialComposeFields } from "~/lib/compose-initialization";

interface DraftIdentity {
  id: string;
  version: number;
}

interface ConfirmedDraft {
  identity: DraftIdentity | null;
  attachmentRefs: AttachmentRef[];
}

interface ComposeFormSnapshot extends Omit<ComposeDraftSnapshot, "attachments"> {
  attachments: ComposeAttachmentRecord[];
}

interface ComposeClosePrompt {
  reason: "unsaved" | "save-failed" | "discard" | "access-revoked";
  message?: string;
}

type PendingMissingAttachment = {
  fingerprint: string;
  scheduledFor?: string;
};

export function useComposeForm(mailboxId?: string, _folder?: string) {
  const toastManager = useKumoToastManager();
  const { composeOptions, closeCompose, trackSend } = useUIStore();
  const recoveryAtMountRef = useRef(peekComposeRecovery());
  const composeMailboxIdRef = useRef(
		recoveryAtMountRef.current?.mailboxId ?? mailboxId,
	);
  if (!composeMailboxIdRef.current && mailboxId) {
    composeMailboxIdRef.current = mailboxId;
  }
  const composeMailboxId = composeMailboxIdRef.current ?? mailboxId;
  const mailboxChanged = Boolean(
    composeMailboxId && mailboxId && composeMailboxId !== mailboxId,
  );
  const { data: currentMailbox } = useMailbox(composeMailboxId);
  const { data: signatureSettings } = useMailboxSignatureSettings(composeMailboxId);
  const signatureSnapshotRef = useRef<MailboxSignature | undefined>(
    signatureSettings?.signature
      ? { ...signatureSettings.signature }
      : undefined,
  );
  const signatureResolutionHandledRef = useRef(
    signatureSnapshotRef.current !== undefined,
  );
  const sendEmailMutation = useSendEmail();
  const saveDraftMutation = useSaveDraft();
  const discardDraftMutation = useDiscardDraft();
  const replyMutation = useReplyToEmail();
  const forwardMutation = useForwardEmail();
  const {
    attachments,
    addFiles,
		addInlineImages,
		inlineImagePreviews,
		removeAttachment: removeAttachmentRecord,
    retryAttachment,
    hydrateFromDraft,
    reconcileSavedDraft,
    reset: resetAttachments,
    restore: restoreAttachments,
    isUploading,
  } = useAttachments(composeMailboxId);

  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBodyState] = useState("");
  const [canInsertSignature, setCanInsertSignature] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [draftIdentity, setDraftIdentity] = useState<DraftIdentity | null>(null);
  const [lifecycle, setLifecycle] = useState<ComposeDraftLifecycle>(() =>
		recoveryAtMountRef.current
			? restoredComposeLifecycle(recoveryAtMountRef.current.lifecycle)
			: composeDraftLifecycle(),
	);
  const [closePrompt, setClosePrompt] =
    useState<ComposeClosePrompt | null>(null);
  const [pendingMissingAttachment, setPendingMissingAttachment] =
    useState<PendingMissingAttachment | null>(null);
  const [isResolvingClose, setIsResolvingClose] = useState(false);
  const lifecycleRef = useRef(lifecycle);
  const draftIdentityRef = useRef<DraftIdentity | null>(null);
  const savePromiseRef = useRef<Promise<ConfirmedDraft> | null>(null);
  const lastConfirmedDraftRef = useRef<ConfirmedDraft>({
    identity: null,
    attachmentRefs: [],
  });
  const nextSaveTokenRef = useRef(0);
  const draftCreateKeyRef = useRef<string>(crypto.randomUUID());
  const observedFingerprintRef = useRef<string | null>(null);
  const initializationFingerprintRef = useRef<string | null>(null);
  const initializationSequenceRef = useRef(0);
  const bodyUserDirtyRef = useRef(Boolean(recoveryAtMountRef.current));
  const recoveryAutosaveNeededRef = useRef(Boolean(recoveryAtMountRef.current));
  const sendIdentityRef = useRef(new LogicalSendIdentity());
  const closeCompletionRef = useRef<(() => void) | null>(null);
  const lastInitializedOptionsRef = useRef<typeof composeOptions | null>(null);
  const isDraftEdit = !!composeOptions.draftEmail;
  const hasUnpersistedInitialDraft = Boolean(
    composeOptions.draftEmail && !composeOptions.draftEmail.id,
  );
  const attachmentPolicy = useMemo(
    () => evaluateComposeAttachments(attachments, body),
    [attachments, body],
  );
  const snapshot = useMemo<ComposeFormSnapshot>(
    () => ({ to, cc, bcc, subject, body, attachments }),
    [attachments, bcc, body, cc, subject, to],
  );
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
	const renderFingerprint = composeDraftFingerprint(snapshot);
	// Mirrors every committed render into the in-memory recovery snapshot, so a
	// remount (lazy boundary, surface change, navigation) restores exactly what
	// was on screen. Intentionally unkeyed: it must track every commit.
	useEffect(() => {
		if (
			lastInitializedOptionsRef.current !== composeOptions ||
			!composeMailboxId
		) {
			return;
		}
		const baseline =
			observedFingerprintRef.current ?? initializationFingerprintRef.current;
		writeComposeRecovery({
			mailboxId: composeMailboxId,
			to,
			cc,
			bcc,
			subject,
			body,
			identity: draftIdentity,
			createKey: draftCreateKeyRef.current,
			attachments,
			lifecycle: composeRecoveryLifecycleForRender(
				lifecycleRef.current,
				baseline !== null && baseline !== renderFingerprint,
			),
		});
	});

  const applyLifecycleEvent = useCallback(
    (event: ComposeDraftLifecycleEvent) => {
      const next = composeDraftTransition(lifecycleRef.current, event);
      lifecycleRef.current = next;
      setLifecycle(next);
      return next;
    },
    [],
  );

  const handleBodyChange = useCallback((nextBody: string) => {
    bodyUserDirtyRef.current = true;
    setBodyState(nextBody);
  }, []);

  const setBodyProgrammatically = useCallback(
    (nextBody: string) => {
      const currentSnapshot = snapshotRef.current;
      if (currentSnapshot.body === nextBody) return;
      const currentFingerprint = composeDraftFingerprint(currentSnapshot);
      const nextSnapshot = { ...currentSnapshot, body: nextBody };
      const nextFingerprint = composeDraftFingerprint(nextSnapshot);
      const initializationFingerprint = initializationFingerprintRef.current;
      let hasUnobservedUserChange = false;
      if (initializationFingerprint !== null) {
        hasUnobservedUserChange =
          initializationFingerprint !== currentFingerprint;
        initializationFingerprintRef.current = nextFingerprint;
      } else {
        const observedFingerprint = observedFingerprintRef.current;
        hasUnobservedUserChange =
          observedFingerprint !== null &&
          observedFingerprint !== currentFingerprint;
        observedFingerprintRef.current = nextFingerprint;
      }
      if (shouldCaptureProgrammaticComposeChange({
        hasDraftIdentity: Boolean(draftIdentityRef.current),
        phase: lifecycleRef.current.phase,
        hasUnobservedUserChange,
      })) {
        applyLifecycleEvent({ type: "edited" });
      }
      snapshotRef.current = nextSnapshot;
      setBodyState(nextBody);
    },
    [applyLifecycleEvent],
  );

  const formTitle = useMemo(() => {
    if (isDraftEdit) return "Edit Draft";
    switch (composeOptions.mode) {
      case "reply":
        return "Reply";
      case "reply-all":
        return "Reply All";
      case "forward":
        return "Forward";
      default:
        return "New Message";
    }
  }, [composeOptions.mode, isDraftEdit]);

  useEffect(() => {
    if (lastInitializedOptionsRef.current === composeOptions) return;
    lastInitializedOptionsRef.current = composeOptions;

		const recovery = recoveryAtMountRef.current?.mailboxId === composeMailboxId
			? recoveryAtMountRef.current
			: readComposeRecovery(composeMailboxId);
		const initialFields = recovery
			? {
					to: recovery.to,
					cc: recovery.cc,
					bcc: recovery.bcc,
					showCcBcc: Boolean(recovery.cc || recovery.bcc),
					subject: recovery.subject,
					body: recovery.body,
				}
			: buildInitialComposeFields({
					composeOptions,
					mailboxEmail: composeMailboxId,
					signature: signatureSnapshotRef.current,
				});
	    const initialIdentity = recovery?.identity ?? (composeOptions.draftEmail?.id
	      ? {
	          id: composeOptions.draftEmail.id,
	          version: composeOptions.draftEmail.draft_version ?? 1,
	        }
	      : null);
    setError(null);
    setTo(initialFields.to);
    setCc(initialFields.cc);
    setBcc(initialFields.bcc);
    setShowCcBcc(initialFields.showCcBcc);
    setSubject(initialFields.subject);
    setBodyState(initialFields.body);
    bodyUserDirtyRef.current = Boolean(recovery || composeOptions.draftEmail);
    setCanInsertSignature(false);
    setPendingMissingAttachment(null);
    setDraftIdentity(initialIdentity);
    draftIdentityRef.current = initialIdentity;
    const initialAttachmentPolicy = initialIdentity
      ? evaluateStoredDraftAttachments(
          initialIdentity.id,
          composeOptions.draftEmail?.attachments,
					composeOptions.draftEmail?.body ?? "",
        )
      : null;
    lastConfirmedDraftRef.current = {
      identity: initialIdentity,
      attachmentRefs:
        initialAttachmentPolicy?.ok ? initialAttachmentPolicy.refs : [],
    };
    initializationFingerprintRef.current = composeDraftFingerprint({
      to: initialFields.to,
      cc: initialFields.cc,
      bcc: initialFields.bcc,
      subject: initialFields.subject,
      body: initialFields.body,
      attachments: (composeOptions.draftEmail?.attachments ?? []).map(
        (attachment) => ({
          filename: attachment.filename,
          mimetype: attachment.mimetype,
          size: attachment.size,
          status: "ready",
          disposition:
            attachment.disposition === "inline" ? "inline" : "attachment",
          contentId: attachment.content_id,
        }),
      ),
    });
    observedFingerprintRef.current = null;
    const initializationSequence = ++initializationSequenceRef.current;
    window.setTimeout(() => {
      if (initializationSequenceRef.current !== initializationSequence) return;
      observedFingerprintRef.current = composeDraftFingerprint(
        snapshotRef.current,
      );
      initializationFingerprintRef.current = null;
    }, 0);
		const initialLifecycle = recovery
			? restoredComposeLifecycle(recovery.lifecycle)
			: composeDraftLifecycle();
		lifecycleRef.current = initialLifecycle;
		setLifecycle(initialLifecycle);
		recoveryAutosaveNeededRef.current = Boolean(
			recovery && composeDraftIsDirty(initialLifecycle),
		);
    sendIdentityRef.current.reset();
    draftCreateKeyRef.current = recovery?.createKey ?? crypto.randomUUID();

		if (recovery) {
			restoreAttachments(recovery.attachments);
		} else {
	    const draftToHydrate = composeOptions.draftEmail;
	    if (draftToHydrate?.id) {
	      hydrateFromDraft(draftToHydrate.id, draftToHydrate.attachments);
	    } else {
	      resetAttachments();
	    }
		}
  }, [
    applyLifecycleEvent,
    composeOptions,
    currentMailbox?.email,
    hydrateFromDraft,
	    resetAttachments,
		restoreAttachments,
  ]);

  const fingerprint = renderFingerprint;
  useEffect(() => {
    if (initializationFingerprintRef.current !== null) {
      if (initializationFingerprintRef.current === fingerprint) {
        observedFingerprintRef.current = fingerprint;
        initializationFingerprintRef.current = null;
      }
      return;
    }
    if (observedFingerprintRef.current === null) {
      observedFingerprintRef.current = fingerprint;
      return;
    }
    if (observedFingerprintRef.current !== fingerprint) {
      observedFingerprintRef.current = fingerprint;
      applyLifecycleEvent({ type: "edited" });
    }
  }, [applyLifecycleEvent, fingerprint]);

  useEffect(() => {
    if (
      signatureResolutionHandledRef.current ||
      !signatureSettings?.signature ||
      initializationFingerprintRef.current !== null ||
      lastInitializedOptionsRef.current !== composeOptions
    ) {
      return;
    }
    const signature = { ...signatureSettings.signature };
    signatureSnapshotRef.current = signature;
    signatureResolutionHandledRef.current = true;
    const signatureMode = composeOptions.draftEmail
      ? "draft"
      : composeOptions.mode;
    const plan = planDelayedComposeSignature({
      bodyHtml: snapshotRef.current.body,
      signatureText: signature.text,
      enabled: signature.enabled,
      mode: signatureMode,
      pristine: !bodyUserDirtyRef.current,
    });
    if (plan.action === "insert") {
      setBodyProgrammatically(plan.bodyHtml);
      setCanInsertSignature(false);
    } else {
      setCanInsertSignature(plan.action === "offer-manual");
    }
  }, [composeOptions, fingerprint, setBodyProgrammatically, signatureSettings?.signature]);

  const insertSignature = useCallback(() => {
    const signature = signatureSnapshotRef.current;
    if (!signature?.enabled) return;
    const signatureMode = composeOptions.draftEmail
      ? "draft"
      : composeOptions.mode;
    const result = insertComposeSignatureManually(
      snapshotRef.current.body,
      signature.text,
      signatureMode,
    );
    setCanInsertSignature(false);
    if (!result.inserted) return;
    bodyUserDirtyRef.current = true;
    setBodyState(result.bodyHtml);
  }, [composeOptions.draftEmail, composeOptions.mode]);

  const applyAiBody = useCallback((nextAiBody: string) => {
    bodyUserDirtyRef.current = true;
    setBodyState(
      replaceAiAuthoredContent(snapshotRef.current.body, nextAiBody),
    );
  }, []);

	const removeAttachment = useCallback((localId: string) => {
		const attachment = snapshotRef.current.attachments.find(
			(candidate) => candidate.localId === localId,
		);
		if (attachment?.disposition === "inline" && attachment.contentId) {
			const nextBody = removeManagedInlineImageNodes(
				snapshotRef.current.body,
				attachment.contentId,
			);
			if (nextBody !== snapshotRef.current.body) handleBodyChange(nextBody);
		}
		removeAttachmentRecord(localId);
	}, [handleBodyChange, removeAttachmentRecord]);

  const observeLatestRevision = useCallback(() => {
    const latestFingerprint = composeDraftFingerprint(snapshotRef.current);
    if (observedFingerprintRef.current !== latestFingerprint) {
      observedFingerprintRef.current = latestFingerprint;
      return applyLifecycleEvent({ type: "edited" }).localRevision;
    }
    return lifecycleRef.current.localRevision;
  }, [applyLifecycleEvent]);

  const saveCurrentDraft = useCallback(
    async function saveLatest(force = false): Promise<ConfirmedDraft> {
      const activeSave = savePromiseRef.current;
      if (activeSave) {
        await activeSave;
        if (savePromiseRef.current === activeSave) {
          savePromiseRef.current = null;
        }
        observeLatestRevision();
        if (composeDraftIsDirty(lifecycleRef.current)) {
          return saveLatest(false);
        }
        return lastConfirmedDraftRef.current;
      }

      const revision = observeLatestRevision();
      if (!force && !composeDraftIsDirty(lifecycleRef.current)) {
        const currentPolicy = evaluateComposeAttachments(
          snapshotRef.current.attachments,
					snapshotRef.current.body,
        );
        if (!currentPolicy.ok) throw new Error(currentPolicy.error);
        return {
          identity: draftIdentityRef.current,
          attachmentRefs: currentPolicy.refs,
        };
      }
      if (!composeMailboxId) throw new Error("No mailbox is available for this draft.");

      const savedSnapshot = snapshotRef.current;
      const savedAttachmentSnapshot = [...savedSnapshot.attachments];
      const savedAttachmentPolicy = evaluateComposeAttachments(
        savedAttachmentSnapshot,
				savedSnapshot.body,
      );
      const token = ++nextSaveTokenRef.current;
      applyLifecycleEvent({ type: "save-started", token, revision });

      const savePromise = (async () => {
        if (!savedAttachmentPolicy.ok) throw new Error(savedAttachmentPolicy.error);
        const identity = draftIdentityRef.current;
        const draftSaveKey = await composeDraftSaveKey({
          composeKey: draftCreateKeyRef.current,
          draftId: identity?.id,
          draftVersion: identity?.version,
          fingerprint: JSON.stringify([
            composeDraftFingerprint(savedSnapshot),
            savedAttachmentPolicy.refs,
          ]),
        });
        const draftRequest = {
          mailboxId: composeMailboxId,
          draft: {
            to: savedSnapshot.to,
            cc: savedSnapshot.cc || undefined,
            bcc: savedSnapshot.bcc || undefined,
            subject: savedSnapshot.subject,
            body: savedSnapshot.body,
            in_reply_to:
              composeOptions.originalEmail?.id ||
              composeOptions.draftEmail?.in_reply_to ||
              undefined,
            thread_id:
              composeOptions.originalEmail?.thread_id ||
              composeOptions.draftEmail?.thread_id ||
              undefined,
            draft_id: identity?.id,
            draft_version: identity?.version,
            draft_create_key: identity ? undefined : draftCreateKeyRef.current,
            draft_save_key: draftSaveKey,
            attachments: savedAttachmentPolicy.refs,
          },
        };
        let saved;
        try {
          saved = await saveDraftMutation.mutateAsync(draftRequest);
        } catch (firstError) {
          const saveStillInProgress =
            firstError instanceof ApiError &&
            firstError.body.code === "draft_save_in_progress";
          const retryableSave =
            !(firstError instanceof ApiError) ||
            firstError.status >= 500 ||
            saveStillInProgress;
          if (!retryableSave) throw firstError;
          if (saveStillInProgress) {
            await new Promise((resolve) => window.setTimeout(resolve, 500));
          }
          saved = await saveDraftMutation.mutateAsync(draftRequest);
        }
        const nextIdentity = {
          id: saved.id,
          version: saved.draft_version ?? 1,
        };
        const confirmedAttachments = evaluateStoredDraftAttachments(
          saved.id,
          saved.attachments,
          saved.body ?? savedSnapshot.body,
        );
        if (!confirmedAttachments.ok) {
          throw new Error(confirmedAttachments.error);
        }
        draftIdentityRef.current = nextIdentity;
        setDraftIdentity(nextIdentity);
        const reconciledAttachments = await reconcileSavedDraft(
          saved.id,
          savedAttachmentSnapshot,
          saved.attachments,
          saved.attachment_save_scope,
        );
        snapshotRef.current = {
          ...snapshotRef.current,
          attachments: reconciledAttachments,
        };
        const confirmed = {
          identity: nextIdentity,
          attachmentRefs: confirmedAttachments.refs,
        };
        lastConfirmedDraftRef.current = confirmed;
        sendIdentityRef.current.reset();
        applyLifecycleEvent({
          type: "save-succeeded",
          token,
          revision,
        });
        setError(null);
        return confirmed;
      })();
      savePromiseRef.current = savePromise;

      let confirmed: ConfirmedDraft;
      try {
        confirmed = await savePromise;
      } catch (saveError) {
        const message =
          saveError instanceof Error
            ? saveError.message
            : "Failed to save draft.";
        applyLifecycleEvent({ type: "save-failed", token, error: message });
        setError(message);
        throw saveError instanceof Error ? saveError : new Error(message);
      } finally {
        if (savePromiseRef.current === savePromise) {
          savePromiseRef.current = null;
        }
      }
      observeLatestRevision();
      if (composeDraftIsDirty(lifecycleRef.current)) {
        return saveLatest(false);
      }
      return confirmed;
    },
    [
      applyLifecycleEvent,
      composeMailboxId,
      composeOptions,
      observeLatestRevision,
      reconcileSavedDraft,
      saveDraftMutation,
    ],
  );

  useEffect(() => {
		const shouldAutosave =
			lifecycle.phase === "pending" ||
			(lifecycle.phase === "failed" && recoveryAutosaveNeededRef.current);
    if (!shouldAutosave || isSending || closePrompt || isUploading) {
      return;
    }
    const timer = window.setTimeout(() => {
			recoveryAutosaveNeededRef.current = false;
      void saveCurrentDraft().catch(() => undefined);
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [
    closePrompt,
    isSending,
    isUploading,
    lifecycle.phase,
    saveCurrentDraft,
  ]);

  const hasUnconfirmedWork =
    composeDraftIsDirty(lifecycle) ||
    lifecycle.phase === "saving" ||
    lifecycle.phase === "failed" ||
    (hasUnpersistedInitialDraft && !draftIdentity);
  useEffect(() => {
		if (!hasUnconfirmedWork && !isSending) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
	}, [hasUnconfirmedWork, isSending]);

  const finishClose = useCallback(() => {
    const complete = closeCompletionRef.current;
    closeCompletionRef.current = null;
    closeCompose(!mailboxChanged);
    complete?.();
  }, [closeCompose, mailboxChanged]);

  const requestClose = useCallback(async (onClosed?: () => void) => {
    if (isSending || isResolvingClose) return;
    closeCompletionRef.current = onClosed ?? null;
    const closePlan = planComposeClose({
      isDirty: composeDraftIsDirty(lifecycleRef.current),
      isSaving: lifecycleRef.current.phase === "saving",
      hasPersistedDraft: Boolean(draftIdentityRef.current),
      hasUnpersistedInitialDraft:
        hasUnpersistedInitialDraft && !draftIdentityRef.current,
      isEmpty: composeDraftIsEmpty(snapshotRef.current),
    });
    if (closePlan === "close-now") {
      finishClose();
      return;
    }
    if (closePlan === "ask") {
      setClosePrompt({ reason: "unsaved" });
      return;
    }

    setIsResolvingClose(true);
    try {
      await saveCurrentDraft(!draftIdentityRef.current);
      finishClose();
    } catch (closeError) {
      setClosePrompt({
        reason:
          closeError instanceof ApiError && closeError.status === 403
            ? "access-revoked"
            : "save-failed",
        message:
          closeError instanceof Error
            ? closeError.message
            : "The draft could not be saved.",
      });
    } finally {
      setIsResolvingClose(false);
    }
  }, [
    finishClose,
    hasUnpersistedInitialDraft,
    isResolvingClose,
    isSending,
    saveCurrentDraft,
  ]);

  const requestDiscard = useCallback(() => {
    if (isSending || isResolvingClose) return;
    if (
      !draftIdentityRef.current &&
      composeDraftIsEmpty(snapshotRef.current) &&
      !composeDraftIsDirty(lifecycleRef.current)
    ) {
      finishClose();
      return;
    }
    setClosePrompt({ reason: "discard" });
  }, [finishClose, isResolvingClose, isSending]);

  const keepEditing = useCallback(() => {
    closeCompletionRef.current = null;
    setClosePrompt(null);
  }, []);

  const saveAndClose = useCallback(async () => {
    if (isResolvingClose) return;
    setIsResolvingClose(true);
    try {
      await saveCurrentDraft(!draftIdentityRef.current);
      setClosePrompt(null);
      finishClose();
	    } catch (closeError) {
	      setClosePrompt({
	        reason:
	          closeError instanceof ApiError && closeError.status === 403
	            ? "access-revoked"
	            : "save-failed",
        message:
          closeError instanceof Error
            ? closeError.message
            : "The draft could not be saved.",
      });
    } finally {
      setIsResolvingClose(false);
    }
  }, [finishClose, isResolvingClose, saveCurrentDraft]);

  const discardAndClose = useCallback(async () => {
    if (isResolvingClose || !composeMailboxId) return;
    setIsResolvingClose(true);
    try {
      const activeSave = savePromiseRef.current;
      if (activeSave) await activeSave.catch(() => undefined);
      const identity = draftIdentityRef.current;
      if (identity) {
        await discardDraftMutation.mutateAsync({
          mailboxId: composeMailboxId,
          id: identity.id,
          version: identity.version,
        });
      }
      setClosePrompt(null);
      finishClose();
      toastManager.add({ title: identity ? "Draft discarded" : "Changes discarded" });
    } catch (discardError) {
      const message =
        discardError instanceof Error
          ? discardError.message
          : "The draft could not be discarded.";
      setError(message);
      setClosePrompt({
        reason:
          discardError instanceof ApiError && discardError.status === 403
            ? "access-revoked"
            : "discard",
        message:
          discardError instanceof ApiError && discardError.status === 403
            ? "Your mailbox access was removed. You can discard only these local changes and close; the server draft will remain unchanged."
            : message,
      });
    } finally {
      setIsResolvingClose(false);
    }
  }, [
    composeMailboxId,
    discardDraftMutation,
    finishClose,
    isResolvingClose,
    toastManager,
  ]);

  const discardLocalAndClose = useCallback(() => {
    setClosePrompt(null);
    finishClose();
    toastManager.add({
      title: "Local changes discarded",
      description: "The server draft was left unchanged.",
    });
  }, [finishClose, toastManager]);

  const handleSaveDraft = useCallback(async () => {
    if (isSending || isResolvingClose) return;
    try {
      await saveCurrentDraft(!draftIdentityRef.current);
      toastManager.add({ title: "Draft saved" });
    } catch (saveError) {
      toastManager.add({
        title:
          saveError instanceof Error ? saveError.message : "Failed to save draft.",
        variant: "error",
      });
    }
  }, [isResolvingClose, isSending, saveCurrentDraft, toastManager]);

  const performSend = async (
    scheduledFor: string | undefined,
    attachmentRefs: AttachmentRef[],
  ) => {
    if (!currentMailbox || !composeMailboxId) return;
    setIsSending(true);
    try {
      observeLatestRevision();
      const needsDraftFlush =
        composeDraftIsDirty(lifecycleRef.current) ||
        lifecycleRef.current.phase === "saving" ||
        lifecycleRef.current.phase === "failed" ||
        (hasUnpersistedInitialDraft && !draftIdentityRef.current);
      let confirmedDraft = needsDraftFlush
        ? await saveCurrentDraft()
        : {
            identity: draftIdentityRef.current,
            attachmentRefs,
          };
      const fromName = currentMailbox.settings?.fromName || currentMailbox.name;
      const from =
        fromName && fromName !== currentMailbox.email
          ? { email: currentMailbox.email, name: fromName }
          : currentMailbox.email;
      const mode = composeOptions.mode;
      const originalId =
        composeOptions.originalEmail?.id || composeOptions.draftEmail?.in_reply_to;
			const enqueueConfirmedDraft = async (
				draft: ConfirmedDraft,
			): Promise<OutboundEnqueueResponse> => {
				const finalSnapshot = snapshotRef.current;
				const sendPayload = {
					source_draft_id: draft.identity?.id,
					source_draft_version: draft.identity?.version,
					to: toEmailListValue(splitEmailList(finalSnapshot.to)),
					cc: toEmailListValue(splitEmailList(finalSnapshot.cc)),
					bcc: toEmailListValue(splitEmailList(finalSnapshot.bcc)),
					from,
					subject: finalSnapshot.subject,
					html: finalSnapshot.body,
					text: htmlToPlainText(finalSnapshot.body),
					attachments: draft.attachmentRefs,
					...(scheduledFor ? { scheduled_for: scheduledFor } : {}),
				};
				const sendPersistenceKey = draft.identity
					? composeDeliveryPersistenceKey({
							mailboxId: composeMailboxId,
							draftId: draft.identity.id,
							draftVersion: draft.identity.version,
							scheduledFor,
							mode,
							originalEmailId: composeOptions.originalEmail?.id,
						})
					: undefined;
				const emailData = {
					...sendPayload,
					idempotency_key: sendIdentityRef.current.keyFor(
						sendPayload,
						sendPersistenceKey,
					),
				};
				if ((mode === "reply" || mode === "reply-all") && originalId) {
					return replyMutation.mutateAsync({
						mailboxId: composeMailboxId,
						emailId: originalId,
						email: emailData,
					});
				}
				if (mode === "forward" && originalId) {
					return forwardMutation.mutateAsync({
						mailboxId: composeMailboxId,
						emailId: originalId,
						email: emailData,
					});
				}
				return sendEmailMutation.mutateAsync({
					mailboxId: composeMailboxId,
					email: emailData,
				});
			};
			let result = await enqueueConfirmedDraft(confirmedDraft);
			let enqueuePlan = planComposeEnqueueResult(result);
			if (enqueuePlan.action === "renew_revision_and_resend") {
				confirmedDraft = await saveCurrentDraft(true);
				result = await enqueueConfirmedDraft(confirmedDraft);
				enqueuePlan = planComposeEnqueueResult(result);
			}
			if (enqueuePlan.action !== "finish") {
				const message = enqueuePlan.action === "block"
					? enqueuePlan.message
					: "A prior delivery still owns this draft revision. Review it before sending again.";
				setError(message);
				toastManager.add({ title: message, variant: "error" });
				return;
			}
      // Handed to the mailbox-level watcher: this composer unmounts on the very
      // next line, so it can never see the delivery reach its outcome.
      trackSend({
        deliveryId: result.deliveryId,
        emailId: result.id,
        mailboxId: composeMailboxId,
        scheduledFor: result.scheduledFor ?? undefined,
        title: enqueuePlan.title,
        canUndo: enqueuePlan.canUndo,
      });
      finishClose();
    } catch (sendError) {
      const message =
        sendError instanceof Error ? sendError.message : "Failed to send email.";
      setError(message);
      toastManager.add({ title: message, variant: "error" });
    } finally {
      setIsSending(false);
    }
  };

  const requestSend = async (
    scheduledFor?: string,
    confirmedMissingAttachmentFingerprint?: string,
  ) => {
    if (isSending) return;
    setError(null);
    if (!currentMailbox || !composeMailboxId) {
      setError("No mailbox selected.");
      return;
    }
    const plan = planComposeSend({
			snapshot: snapshotRef.current,
			scheduledFor,
			confirmedMissingAttachmentFingerprint,
		});
		if (plan.action === "error") {
			setPendingMissingAttachment(null);
			setError(plan.message);
			return;
		}
		if (plan.action === "confirm-missing-attachment") {
			setPendingMissingAttachment({ fingerprint: plan.fingerprint, scheduledFor });
			return;
		}

		setPendingMissingAttachment(null);
		await performSend(scheduledFor, plan.attachmentRefs);
  };

  const handleSend = (e: FormEvent, scheduledFor?: string) => {
    e.preventDefault();
    void requestSend(scheduledFor);
  };

  const confirmMissingAttachment = () => {
    const pending = pendingMissingAttachment;
    if (!pending) return;
    setPendingMissingAttachment(null);
    void requestSend(pending.scheduledFor, pending.fingerprint);
  };

  const cancelMissingAttachment = () => setPendingMissingAttachment(null);

  const draftStatusLabel =
    lifecycle.phase === "saving"
      ? "Saving…"
      : lifecycle.phase === "failed"
        ? "Save failed"
        : lifecycle.phase === "pending"
          ? "Unsaved changes"
          : draftIdentity
            ? "Saved"
            : hasUnpersistedInitialDraft
              ? "Not saved yet"
              : "";

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
    setBody: handleBodyChange,
    handleBodyChange,
    applyAiBody,
    canInsertSignature,
    insertSignature,
    error,
    setError,
    isSavingDraft: lifecycle.phase === "saving",
    isSending,
    formTitle,
    handleSaveDraft,
    handleSend,
    isMissingAttachmentWarningOpen: Boolean(pendingMissingAttachment),
    confirmMissingAttachment,
    cancelMissingAttachment,
    requestClose,
    requestDiscard,
    closePrompt,
    keepEditing,
    saveAndClose,
    discardAndClose,
    discardLocalAndClose,
    isResolvingClose,
    draftStatusLabel,
    hasPersistedDraft: Boolean(draftIdentity),
    hasUnconfirmedWork,
    mailboxChanged,
    originMailboxId: composeMailboxId,
    attachments,
    addFiles,
		addInlineImages,
		inlineImagePreviews,
    removeAttachment,
    retryAttachment,
    isUploading,
    hasAttachmentIssue: !attachmentPolicy.ok,
  };
}
