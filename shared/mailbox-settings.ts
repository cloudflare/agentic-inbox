// shared/mailbox-settings.ts
// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

import { z } from "zod";

/**
 * Per-mailbox settings stored at R2 key `mailboxes/<mailboxId>.json`.
 *
 * The schema is intentionally lenient on the write side (passthrough) so
 * future fields can land without coordinated frontend/backend deploys.
 * Strict on the read side: every consumer that reads a typed field uses
 * `MailboxSettings.parse(...)` which fills in defaults.
 *
 * `security` is a typed sub-shape: only `attachment_policy` and
 * `folder_policies` are validated here — the rest of the object is
 * passthrough so unrelated security fields (allowlist_senders, thresholds,
 * business_hours, etc.) round-trip untouched. Defaults intentionally NOT
 * set in the schema; the runtime consumer in `workers/security/settings.ts`
 * (`getSecuritySettings`) is the single source of default values, and
 * duplicating them here would invite drift.
 */

const AttachmentAction = z.enum(["block", "score", "ignore"]);

const AttachmentPolicy = z
  .object({
    executable_action: AttachmentAction.optional(),
    container_action: AttachmentAction.optional(),
    macro_office_action: AttachmentAction.optional(),
    custom_blocklist_extensions: z.array(z.string()).optional(),
  })
  .passthrough();

const FolderPolicy = z
  .object({
    mode: z.enum(["skip_all", "skip_classifier"]).optional(),
    treat_as_verified: z.boolean().optional(),
  })
  .passthrough();

const SecuritySettings = z
  .object({
    attachment_policy: AttachmentPolicy.optional(),
    folder_policies: z.record(z.string(), FolderPolicy).optional(),
  })
  .passthrough();

export const MailboxSettings = z.object({
  agentSystemPrompt: z.string().optional(),
  autoDraft: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),
  agentModel: z.string().default("@cf/moonshotai/kimi-k2.5"),
  security: SecuritySettings.optional(),
}).passthrough();

export type MailboxSettings = z.infer<typeof MailboxSettings>;

/** The hand-curated list shown in the Settings model dropdown. The first
 *  entry MUST match the default in MailboxSettings.agentModel above so an
 *  unconfigured mailbox renders with a list option selected, not "Custom". */
export const TEXT_MODELS = [
  "@cf/moonshotai/kimi-k2.5",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
] as const;
