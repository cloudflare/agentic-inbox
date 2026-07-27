// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Banner, Button, Dialog, DropdownMenu, Input } from "@cloudflare/kumo";
import {
  CalendarBlankIcon,
  CaretDownIcon,
  ClockIcon,
  FloppyDiskIcon,
  PaperPlaneTiltIcon,
  SparkleIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useBlocker, useParams } from "react-router";
import { useComposeForm } from "~/hooks/useComposeForm";
import { useUIStore } from "~/hooks/useUIStore";
import LazyLoadBoundary from "~/components/LazyLoadBoundary";
import {
  earliestScheduleTime,
  formatDateTimeLocalValue,
  formatScheduledTime,
  getSendLaterPresets,
  parseAndValidateLocalSchedule,
  scheduleHorizonEnd,
} from "~/lib/send-later";
import {
  planComposeShortcut,
  type ComposeShortcutOrigin,
} from "~/lib/compose-shortcuts";
import {
  composeSurface,
  INLINE_COMPOSE_HOST_ID,
  type ComposeSurface,
} from "~/lib/compose-surface";
import {
  consumeComposeFileTransfer,
  transferContainsFiles,
} from "~/lib/compose-file-transfer";
import RichTextEditor from "./RichTextEditor";
import ComposeAttachments from "./ComposeAttachments";
import RecipientCombobox from "./RecipientCombobox";

/**
 * The frame around the compose form: a centered dialog, or a card that sits at
 * the end of a thread. Only the frame differs between the two surfaces.
 */
function ComposeChrome({
  variant,
  inlineHost,
  open,
  title,
  status,
  onRequestClose,
  closeDisabled,
  surfaceRef,
  onKeyDown,
  children,
}: {
  variant: ComposeSurface;
  inlineHost: HTMLElement | null;
  open: boolean;
  title: string;
  status: string;
  onRequestClose: () => void;
  closeDisabled: boolean;
  surfaceRef: RefObject<HTMLElement | null>;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  const header = (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-kumo-line px-4 py-3 sm:px-6 sm:py-4">
      <div className="min-w-0">
        {variant === "inline" ? (
          <h2 className="truncate text-base font-semibold text-kumo-default">
            {title}
          </h2>
        ) : (
          <Dialog.Title className="text-lg font-semibold text-kumo-default">
            {title}
          </Dialog.Title>
        )}
        <div
          role="status"
          aria-live="polite"
          className={`mt-0.5 text-xs ${
            status === "Save failed"
              ? "font-semibold text-kumo-danger"
              : "text-kumo-subtle"
          }`}
        >
          {status}
        </div>
      </div>
      <Button
        variant="ghost"
        shape="square"
        size="sm"
        icon={<XIcon size={18} />}
        className="min-h-11 min-w-11"
        onClick={onRequestClose}
        disabled={closeDisabled}
        aria-label="Close compose"
      />
    </div>
  );

  if (variant === "inline" && inlineHost) {
    return createPortal(
      <section
        ref={surfaceRef}
        aria-label={title}
        onKeyDown={onKeyDown}
        className="border-t-2 border-kumo-brand/40 bg-kumo-base"
      >
        {header}
        {children}
      </section>,
      inlineHost,
    );
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !closeDisabled) onRequestClose();
      }}
    >
      <Dialog
        size="lg"
        className="flex min-w-0 max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] flex-col overflow-hidden p-0 sm:min-w-[32rem] sm:w-[min(820px,94vw)]"
      >
        {header}
        {children}
      </Dialog>
    </Dialog.Root>
  );
}

/**
 * The composer. One form with two chromes: a centered modal for new mail and
 * draft edits, and an inline card that answers a thread without covering it.
 * Driven by the shared `isComposing` UI state, so the Compose button, the thread
 * toolbar, and the AI-draft flow all open the same form.
 *
 * This is the only mounted composer either way: the inline chrome is rendered
 * into the open thread through a portal, so `useComposeForm` stays the single
 * owner of the draft and the editor is only ever loaded through one module path.
 */
export default function ComposeEmail() {
  const { mailboxId, folder } = useParams<{
    mailboxId: string;
    folder: string;
  }>();

  const {
    isComposing,
    composeOptions,
    selectedEmailId,
    queuedCompose,
    applyQueuedCompose,
    cancelQueuedCompose,
  } = useUIStore();
  // The inline chrome needs a thread to live in. If that host is not on screen
  // (panel still loading, no thread open) the modal is the truthful fallback.
  const [inlineHost, setInlineHost] = useState<HTMLElement | null>(null);
  const wantsInline = composeSurface(composeOptions, selectedEmailId) === "inline";
  useEffect(() => {
    setInlineHost(
      wantsInline ? document.getElementById(INLINE_COMPOSE_HOST_ID) : null,
    );
  }, [wantsInline, composeOptions]);
  const isInline = wantsInline && inlineHost !== null;
  const variant: ComposeSurface = isInline ? "inline" : "modal";
  const [showAiPrompt, setShowAiPrompt] = useState(false);
  const [aiActivityLabel, setAiActivityLabel] = useState("");
  const [aiPanelRetryKey, setAiPanelRetryKey] = useState(0);
  const ComposeAiAssistant = useMemo(
    () => lazy(() => import("./ComposeAiAssistant")),
    [aiPanelRetryKey],
  );
  const [scheduledFor, setScheduledFor] = useState<string | null>(null);
  const [showCustomSchedule, setShowCustomSchedule] = useState(false);
  const [customScheduleValue, setCustomScheduleValue] = useState("");
  const [customScheduleError, setCustomScheduleError] = useState<string | null>(
    null,
  );
  const [customScheduleReference, setCustomScheduleReference] = useState(
    () => new Date(),
  );
  const isNewCompose =
    composeOptions.mode === "new" && !composeOptions.draftEmail;
  // An AI-drafted reply arrives as an unsaved draft; the assistant stays
  // available for it, and closes only once a stored draft is being edited.
  const isReplyCompose =
    !composeOptions.draftEmail?.id &&
    Boolean(composeOptions.originalEmail?.id) &&
    (composeOptions.mode === "reply" || composeOptions.mode === "reply-all");
  const isAiComposeEligible = isNewCompose || isReplyCompose;
  // Replying starts in the message, above the quote. Everything else starts at
  // the recipient the writer still has to choose or confirm.
  const focusesBody =
    composeOptions.mode === "reply" || composeOptions.mode === "reply-all";
  const sendLaterPresets = getSendLaterPresets();
  const scheduledLabel = scheduledFor
    ? formatScheduledTime(new Date(scheduledFor))
    : null;

  const {
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
    handleBodyChange,
    applyAiBody,
    canInsertSignature,
    insertSignature,
    error,
    isSavingDraft,
    isSending,
    formTitle,
    handleSaveDraft,
    handleSend,
    isMissingAttachmentWarningOpen,
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
    hasPersistedDraft,
    hasUnconfirmedWork,
    mailboxChanged,
    originMailboxId,
    attachments,
    addFiles,
    addInlineImages,
    inlineImagePreviews,
    removeAttachment,
    retryAttachment,
    isUploading,
    hasAttachmentIssue,
  } = useComposeForm(mailboxId, folder);
  const recipientValues = { to, cc, bcc };
  const navigationBlocker = useBlocker(isComposing && hasUnconfirmedWork);
  const handledBlockedNavigationRef = useRef(false);
  const handledQueuedComposeRef = useRef(false);
  const composeFormRef = useRef<HTMLFormElement>(null);
  const inlineSurfaceRef = useRef<HTMLElement>(null);
  const fileDragDepthRef = useRef(0);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const sendButtonLabel = isSending
    ? scheduledFor
      ? "Scheduling…"
      : "Sending…"
    : isUploading
      ? "Uploading…"
      : hasAttachmentIssue
        ? "Fix attachments"
        : scheduledFor
          ? "Schedule"
          : "Send";

  useEffect(() => {
    if (!isComposing) return;
    setScheduledFor(null);
    setShowCustomSchedule(false);
    setCustomScheduleError(null);
  }, [composeOptions, isComposing]);

  useEffect(() => {
    if (navigationBlocker.state === "unblocked") {
      handledBlockedNavigationRef.current = false;
      return;
    }
    if (
      navigationBlocker.state === "blocked" &&
      !handledBlockedNavigationRef.current
    ) {
      handledBlockedNavigationRef.current = true;
      void requestClose(() => navigationBlocker.proceed());
    }
  }, [navigationBlocker, requestClose]);

  // The inline composer opens below the last message, so bring it into view.
  useEffect(() => {
    if (!isInline) return;
    inlineSurfaceRef.current?.scrollIntoView({ block: "start" });
  }, [isInline]);

  // A compose request made while this composer holds unsaved work waits here
  // until the same close flow that guards navigation resolves it.
  useEffect(() => {
    if (!queuedCompose) {
      handledQueuedComposeRef.current = false;
      return;
    }
    if (handledQueuedComposeRef.current) return;
    handledQueuedComposeRef.current = true;
    void requestClose(applyQueuedCompose);
  }, [applyQueuedCompose, queuedCompose, requestClose]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      let origin: ComposeShortcutOrigin = "outside";
      if (target && composeFormRef.current?.contains(target)) {
        if (target.closest('[data-compose-shortcut-surface="ai-panel"]')) {
          origin = "ai-panel";
        } else if (
          target.closest(
            '[data-compose-shortcut-surface="nested-overlay"], [role="menu"], [role="listbox"]',
          )
        ) {
          origin = "nested-overlay";
        } else {
          origin = "primary";
        }
      }
      const action = planComposeShortcut({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        isImeComposing: event.isComposing,
        composeActive: isComposing,
        defaultPrevented: event.defaultPrevented,
        origin,
        hasBlockingState: Boolean(
          closePrompt ||
          showCustomSchedule ||
          isMissingAttachmentWarningOpen ||
          isResolvingClose,
        ),
      });
      if (action === "ignore" || action === "ai-generate") return;
      event.preventDefault();
      if (action === "submit") {
        composeFormRef.current?.requestSubmit();
      } else if (action === "save") {
        void handleSaveDraft();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [
    closePrompt,
    handleSaveDraft,
    isComposing,
    isMissingAttachmentWarningOpen,
    isResolvingClose,
    showCustomSchedule,
  ]);

  const handleKeepEditing = () => {
    keepEditing();
    cancelQueuedCompose();
    if (navigationBlocker.state === "blocked") navigationBlocker.reset();
  };

  // The modal gets Escape from its dialog; the inline card owns its own. Nested
  // overlays (combobox, menus) mark the event handled before it reaches here.
  const handleInlineKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (isSending || isResolvingClose) return;
    event.preventDefault();
    void requestClose();
  };

  const choosePreset = (date: Date) => {
    setScheduledFor(date.toISOString());
    setCustomScheduleError(null);
  };

  const openCustomSchedule = () => {
    const now = new Date();
    setCustomScheduleReference(now);
    setCustomScheduleValue(
      formatDateTimeLocalValue(
        scheduledFor ? new Date(scheduledFor) : earliestScheduleTime(now),
      ),
    );
    setCustomScheduleError(null);
    setShowCustomSchedule(true);
  };

  const applyCustomSchedule = () => {
    const result = parseAndValidateLocalSchedule(
      customScheduleValue,
      new Date(),
    );
    if (!result.ok) {
      setCustomScheduleError(result.error);
      return;
    }
    setScheduledFor(result.iso);
    setCustomScheduleError(null);
    setShowCustomSchedule(false);
  };

  const fileTransfersDisabled = isSending || isResolvingClose;

  const acceptTransferredFiles = (files: File[]) => {
    fileDragDepthRef.current = 0;
    setIsDraggingFiles(false);
    if (fileTransfersDisabled) return;
    addFiles(files);
  };

  const handleOuterPaste = (event: ReactClipboardEvent<HTMLFormElement>) => {
    consumeComposeFileTransfer(
      event,
      fileTransfersDisabled ? () => {} : acceptTransferredFiles,
    );
  };

  const handleOuterDragEnter = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!transferContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (fileTransfersDisabled) return;
    fileDragDepthRef.current += 1;
    setIsDraggingFiles(true);
  };

  const handleOuterDragOver = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!transferContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = fileTransfersDisabled ? "none" : "copy";
  };

  const handleOuterDragLeave = () => {
    if (fileDragDepthRef.current === 0) return;
    fileDragDepthRef.current -= 1;
    if (fileDragDepthRef.current === 0) setIsDraggingFiles(false);
  };

  const handleOuterDrop = (event: ReactDragEvent<HTMLFormElement>) => {
    fileDragDepthRef.current = 0;
    setIsDraggingFiles(false);
    consumeComposeFileTransfer(
      event,
      fileTransfersDisabled ? () => {} : acceptTransferredFiles,
    );
  };

  return (
    <>
      <ComposeChrome
        variant={variant}
        inlineHost={inlineHost}
        open={isComposing}
        title={formTitle}
        status={draftStatusLabel}
        onRequestClose={() => void requestClose()}
        closeDisabled={isSending || isResolvingClose}
        surfaceRef={inlineSurfaceRef}
        onKeyDown={handleInlineKeyDown}
      >
          <form
            ref={composeFormRef}
            data-compose-shortcut-surface="primary"
            onSubmit={(e) => handleSend(e, scheduledFor ?? undefined)}
            onPaste={handleOuterPaste}
            onDragEnter={handleOuterDragEnter}
            onDragOver={handleOuterDragOver}
            onDragLeave={handleOuterDragLeave}
            onDrop={handleOuterDrop}
            className={`relative flex flex-col ${
              isInline ? "" : "flex-1 min-h-0"
            }`}
          >
            {isDraggingFiles && (
              <div
                role="status"
                aria-live="polite"
                className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-kumo-brand/50 bg-white/90 px-6 text-center text-sm font-semibold text-kumo-brand shadow-sm"
              >
                Drop files to attach
              </div>
            )}
            <div role="status" aria-live="polite" className="sr-only">
              {isSending
                ? "Sending message"
                : isSavingDraft
                  ? "Saving draft"
                  : isUploading
                    ? "Uploading attachments"
                    : hasAttachmentIssue
                      ? "Attachments need attention"
                      : aiActivityLabel}
            </div>
            {/* Inline grows with its content; the thread underneath does the scrolling. */}
            <div
              className={`px-4 py-4 space-y-4 sm:px-6 sm:py-5 ${
                isInline ? "" : "flex-1 min-h-0 overflow-y-auto"
              }`}
            >
              {error && (
                <div role="alert" aria-live="assertive">
                  <Banner variant="error" text={error} />
                </div>
              )}

              {mailboxChanged && (
                <Banner
                  variant="alert"
                  text="You changed mailboxes. This draft is still saving to the mailbox where you started it."
                />
              )}

              {/* Recipients */}
              <div className="flex min-w-0 items-end gap-2 sm:gap-3">
                <div className="flex-1">
                  <RecipientCombobox
                    id="compose-to"
                    label="To"
                    field="to"
                    mailboxId={originMailboxId ?? ""}
                    recipients={recipientValues}
                    placeholder="recipient@example.com, another@example.com"
                    value={to}
                    autoFocus={!focusesBody}
                    onChange={setTo}
                    required
                  />
                </div>
                {!showCcBcc && (
                  <button
                    type="button"
                    onClick={() => setShowCcBcc(true)}
                    className="min-h-11 shrink-0 rounded px-2 text-sm text-kumo-link hover:underline font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
                  >
                    Cc / Bcc
                  </button>
                )}
              </div>

              {showCcBcc && (
                <RecipientCombobox
                  id="compose-cc"
                  label="Cc"
                  field="cc"
                  mailboxId={originMailboxId ?? ""}
                  recipients={recipientValues}
                  value={cc}
                  onChange={setCc}
                  placeholder="Separate multiple addresses with commas"
                />
              )}
              {showCcBcc && (
                <RecipientCombobox
                  id="compose-bcc"
                  label="Bcc"
                  field="bcc"
                  mailboxId={originMailboxId ?? ""}
                  recipients={recipientValues}
                  value={bcc}
                  onChange={setBcc}
                  placeholder="Separate multiple addresses with commas"
                />
              )}

              <Input
                label="Subject"
                type="text"
                placeholder="What’s this about?"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
              />

              {/* AI writing stays scoped to new mail and eligible stored replies. */}
              {isAiComposeEligible && (
                <div>
                  {!showAiPrompt ? (
                    <button
                      type="button"
                      onClick={() => setShowAiPrompt(true)}
                      className="flex min-h-11 items-center gap-1.5 rounded px-1 text-sm text-kumo-link hover:text-kumo-link-hover font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
                    >
                      <SparkleIcon size={15} weight="fill" />
                      Write with AI
                    </button>
                  ) : (
                    <LazyLoadBoundary
                      resetKey={`${showAiPrompt}:${aiPanelRetryKey}`}
                      fallback={
                        <div
                          data-compose-shortcut-surface="ai-panel"
                          role="alert"
                          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-kumo-line bg-kumo-recessed p-3 text-sm text-kumo-default"
                        >
                          <span>
                            Writing assistant could not open. Your draft is
                            unchanged.
                          </span>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              className="min-h-11"
                              onClick={() =>
                                setAiPanelRetryKey((key) => key + 1)
                              }
                            >
                              Retry
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="min-h-11"
                              onClick={() => setShowAiPrompt(false)}
                            >
                              Close
                            </Button>
                          </div>
                        </div>
                      }
                    >
                      <Suspense
                        fallback={
                          <div
                            data-compose-shortcut-surface="ai-panel"
                            role="status"
                            aria-live="polite"
                            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-kumo-line bg-kumo-recessed p-3 text-sm text-kumo-subtle"
                          >
                            <span>Opening writing assistant…</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="min-h-11"
                              onClick={() => setShowAiPrompt(false)}
                            >
                              Close
                            </Button>
                          </div>
                        }
                      >
                        <ComposeAiAssistant
                          key={`${originMailboxId ?? ""}:${composeOptions.originalEmail?.id ?? "new"}:${composeOptions.mode}`}
                          originMailboxId={originMailboxId}
                          composeMode={composeOptions.mode}
                          sourceEmailId={composeOptions.originalEmail?.id}
                          subject={subject}
                          body={body}
                          setSubject={setSubject}
                          applyAiBody={applyAiBody}
                          onActivityLabelChange={setAiActivityLabel}
                          onClose={() => setShowAiPrompt(false)}
                        />
                      </Suspense>
                    </LazyLoadBoundary>
                  )}
                </div>
              )}

              {/* Body */}
              {canInsertSignature && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="min-h-11"
                    aria-label="Insert signature"
                    onClick={insertSignature}
                  >
                    Insert signature
                  </Button>
                </div>
              )}
              <div
                className={
                  isInline
                    ? "flex min-h-[220px] flex-col"
                    : "h-[38dvh] min-h-[220px] sm:h-[42vh] sm:min-h-[280px]"
                }
              >
                <RichTextEditor
                  value={body}
                  autoFocus={focusesBody}
                  onChange={handleBodyChange}
                  onFiles={acceptTransferredFiles}
                  onInlineImages={addInlineImages}
                  inlineImagePreviews={inlineImagePreviews}
                  fileTransfersDisabled={fileTransfersDisabled}
                />
              </div>

              {/* Attachments */}
              <ComposeAttachments
                attachments={attachments}
                bodyHtml={body}
                onAddFiles={addFiles}
                onRemove={removeAttachment}
                onRetry={retryAttachment}
                disabled={fileTransfersDisabled}
              />
            </div>

            {scheduledLabel && (
              <div
                role="status"
                aria-live="polite"
                className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-kumo-line bg-kumo-brand/5 px-4 py-2.5 text-sm sm:px-6"
              >
                <ClockIcon
                  size={17}
                  className="shrink-0 text-kumo-brand"
                  aria-hidden="true"
                />
                <span className="text-kumo-subtle">Scheduled for</span>
                <strong className="text-kumo-default">{scheduledLabel}</strong>
                <button
                  type="button"
                  className="min-h-11 rounded px-2 font-semibold text-kumo-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand sm:ms-auto"
                  onClick={() => setScheduledFor(null)}
                >
                  Send now instead
                </button>
              </div>
            )}

            {/* Footer actions */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-line bg-kumo-recessed px-4 py-3 sm:px-6 sm:py-4 shrink-0">
              <Button
                type="button"
                variant="ghost"
                className="min-h-11"
                onClick={requestDiscard}
                disabled={isSending || isResolvingClose}
              >
                Discard
              </Button>
              <div className="grid min-w-0 basis-full grid-cols-1 gap-2 min-[360px]:flex min-[360px]:basis-auto min-[360px]:flex-1 min-[360px]:items-center min-[360px]:justify-end sm:flex-none">
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-11 min-w-0 w-full min-[360px]:flex-1 sm:w-auto sm:flex-none"
                  loading={isSavingDraft}
                  disabled={
                    isSending ||
                    isResolvingClose ||
                    isUploading ||
                    hasAttachmentIssue
                  }
                  icon={<FloppyDiskIcon size={16} />}
                  onClick={handleSaveDraft}
                  aria-keyshortcuts="Meta+S Control+S"
                  title="Save draft (⌘/Ctrl+S)"
                >
                  {isSavingDraft ? "Saving…" : "Save draft"}
                </Button>
                <div className="flex min-w-0 w-full min-[360px]:flex-1 sm:w-auto sm:flex-none">
                  <Button
                    type="submit"
                    variant="primary"
                    className="min-h-11 min-w-0 flex-1 rounded-r-none sm:min-w-24"
                    loading={isSending}
                    disabled={
                      isSavingDraft ||
                      isSending ||
                      isResolvingClose ||
                      isUploading ||
                      hasAttachmentIssue
                    }
                    icon={<PaperPlaneTiltIcon size={16} />}
                    aria-keyshortcuts="Meta+Enter Control+Enter"
                    title="Send (⌘/Ctrl+Enter)"
                  >
                    {sendButtonLabel}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenu.Trigger
                      render={
                        <Button
                          type="button"
                          variant="primary"
                          shape="square"
                          className="min-h-11 min-w-11 rounded-l-none border-l border-kumo-line/30"
                          icon={<CaretDownIcon size={16} />}
                          aria-label="Send options"
                          disabled={
                            isSavingDraft ||
                            isSending ||
                            isResolvingClose ||
                            isUploading ||
                            hasAttachmentIssue
                          }
                        />
                      }
                    />
                    <DropdownMenu.Content>
                      <DropdownMenu.Group>
                        <DropdownMenu.Label>Send later</DropdownMenu.Label>
                        {sendLaterPresets.map((preset) => (
                          <DropdownMenu.Item
                            key={preset.id}
                            icon={ClockIcon}
                            className="min-h-11"
                            onSelect={() => choosePreset(preset.date)}
                          >
                            <span className="flex min-w-0 flex-col">
                              <span className="font-medium">{preset.title}</span>
                              <span className="text-xs text-kumo-subtle">
                                {formatScheduledTime(preset.date)}
                              </span>
                            </span>
                          </DropdownMenu.Item>
                        ))}
                      </DropdownMenu.Group>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item
                        className="min-h-11"
                        icon={CalendarBlankIcon}
                        onSelect={openCustomSchedule}
                      >
                        Custom date and time…
                      </DropdownMenu.Item>
                      {scheduledFor && (
                        <DropdownMenu.Item
                          className="min-h-11"
                          icon={PaperPlaneTiltIcon}
                          onSelect={() => setScheduledFor(null)}
                        >
                          Send now
                        </DropdownMenu.Item>
                      )}
                    </DropdownMenu.Content>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          </form>
      </ComposeChrome>

      <Dialog.Root
        open={isMissingAttachmentWarningOpen}
        onOpenChange={(open) => {
          if (!open && !isSending) cancelMissingAttachment();
        }}
      >
        <Dialog size="sm" className="w-[calc(100vw-1rem)] p-0 sm:w-[440px]">
          <div className="border-b border-kumo-line px-4 py-4 sm:px-5">
            <Dialog.Title className="text-base font-semibold text-kumo-default">
              Send without an attachment?
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
              Your message says an attachment is included, but no ready file is
              attached.
            </Dialog.Description>
          </div>
          <div className="flex flex-wrap justify-end gap-2 px-4 py-4 sm:px-5">
            <Button
              type="button"
              variant="secondary"
              className="min-h-11"
              disabled={isSending}
              onClick={cancelMissingAttachment}
            >
              Back
            </Button>
            <Button
              type="button"
              variant="primary"
              className="min-h-11"
              loading={isSending}
              disabled={isSending}
              onClick={confirmMissingAttachment}
            >
              Send anyway
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root
        open={Boolean(closePrompt)}
        onOpenChange={(open) => {
          if (!open && !isResolvingClose) handleKeepEditing();
        }}
      >
        <Dialog size="sm" className="w-[calc(100vw-1rem)] p-0 sm:w-[440px]">
          <div className="border-b border-kumo-line px-4 py-4 sm:px-5">
            <Dialog.Title className="text-base font-semibold text-kumo-default">
              {closePrompt?.reason === "save-failed"
                ? "Draft is not safely saved"
                : closePrompt?.reason === "access-revoked"
                  ? "Mailbox access was removed"
                  : closePrompt?.reason === "discard"
                    ? hasPersistedDraft
                      ? "Discard this draft?"
                      : "Discard these changes?"
                    : "Save before closing?"}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
              {closePrompt?.message ||
                (closePrompt?.reason === "discard"
                  ? hasPersistedDraft
                    ? "Discard permanently removes the saved draft and its attachments. This cannot be undone."
                    : "These unsaved changes will be removed. This cannot be undone."
                  : "Save the latest changes, keep editing, or deliberately discard the draft.")}
            </Dialog.Description>
          </div>
          <div className="flex flex-wrap justify-end gap-2 px-4 py-4 sm:px-5">
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={isResolvingClose}
              onClick={handleKeepEditing}
            >
              Keep editing
            </Button>
            {closePrompt?.reason !== "access-revoked" && (
              <Button
                type="button"
                variant="secondary"
                className="min-h-11"
                loading={isResolvingClose && isSavingDraft}
                disabled={isResolvingClose}
                onClick={() => void saveAndClose()}
              >
                Save and close
              </Button>
            )}
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              loading={isResolvingClose && !isSavingDraft}
              disabled={isResolvingClose}
              onClick={() =>
                closePrompt?.reason === "access-revoked"
                  ? discardLocalAndClose()
                  : void discardAndClose()
              }
            >
              {closePrompt?.reason === "access-revoked"
                ? "Discard local changes and close"
                : hasPersistedDraft
                  ? "Discard draft"
                  : "Discard changes"}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root
        open={showCustomSchedule}
        onOpenChange={setShowCustomSchedule}
      >
        <Dialog size="sm" className="w-[calc(100vw-1rem)] p-0 sm:w-[420px]">
          <div className="border-b border-kumo-line px-4 py-4 sm:px-5">
            <Dialog.Title className="text-base font-semibold text-kumo-default">
              Choose a local send time
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-kumo-subtle">
              The timezone shown by your device will be used.
            </Dialog.Description>
          </div>
          <div className="space-y-3 px-4 py-4 sm:px-5">
            <label
              htmlFor="custom-send-time"
              className="block text-sm font-semibold text-kumo-default"
            >
              Local date and time
            </label>
            <input
              id="custom-send-time"
              type="datetime-local"
              value={customScheduleValue}
              min={formatDateTimeLocalValue(
                earliestScheduleTime(customScheduleReference),
              )}
              max={formatDateTimeLocalValue(
                scheduleHorizonEnd(customScheduleReference),
              )}
              onChange={(event) => {
                setCustomScheduleValue(event.target.value);
                setCustomScheduleError(null);
              }}
              aria-describedby="custom-send-time-help"
              aria-invalid={Boolean(customScheduleError)}
              className="min-h-11 w-full rounded-md border border-kumo-line bg-kumo-control px-3 text-base text-kumo-default outline-none focus:ring-2 focus:ring-kumo-brand"
            />
            <p id="custom-send-time-help" className="text-xs text-kumo-subtle">
              Choose any valid future time within the next year.
            </p>
            {customScheduleError && (
              <p role="alert" className="text-sm font-medium text-kumo-danger">
                {customScheduleError}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-5">
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={() => setShowCustomSchedule(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              className="min-h-11"
              onClick={applyCustomSchedule}
            >
              Use this time
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
}
