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
 */
export const MailboxSettings = z.object({
  agentSystemPrompt: z.string().optional(),
  autoDraft: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),
  agentModel: z.string().default("@cf/moonshotai/kimi-k2.5"),
}).passthrough();

export type MailboxSettings = z.infer<typeof MailboxSettings>;

/** The hand-curated list shown in the Settings model dropdown. The first
 *  entry MUST match the default in MailboxSettings.agentModel above so an
 *  unconfigured mailbox renders with a list option selected, not "Custom". */
export const TEXT_MODELS = [
  "@cf/moonshotai/kimi-k2.5",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
] as const;
