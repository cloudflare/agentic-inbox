// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

import { describe, expect, it } from "vitest";
import { MailboxSettings } from "../../shared/mailbox-settings";

describe("MailboxSettings", () => {
  it("defaults autoDraft.enabled to true when missing", () => {
    const parsed = MailboxSettings.parse({});
    expect(parsed.autoDraft.enabled).toBe(true);
  });

  it("defaults agentModel to the kimi entry when missing", () => {
    const parsed = MailboxSettings.parse({});
    expect(parsed.agentModel).toBe("@cf/moonshotai/kimi-k2.5");
  });

  it("respects an explicit disabled autoDraft", () => {
    const parsed = MailboxSettings.parse({ autoDraft: { enabled: false } });
    expect(parsed.autoDraft.enabled).toBe(false);
  });

  it("preserves arbitrary extra fields (passthrough)", () => {
    const parsed = MailboxSettings.parse({ agentSystemPrompt: "Hi" });
    expect(parsed.agentSystemPrompt).toBe("Hi");
  });

  // The security sub-shape is opt-in: an undefined `security` block must
  // round-trip to undefined (no surprise object materialised). The runtime
  // consumer in `workers/security/settings.ts` is the single source of
  // default values — we don't want the schema to invent a default that the
  // consumer would then overwrite.
  it("leaves security undefined when missing", () => {
    const parsed = MailboxSettings.parse({});
    expect((parsed as { security?: unknown }).security).toBeUndefined();
  });

  it("accepts a valid attachment_policy", () => {
    const parsed = MailboxSettings.parse({
      security: {
        attachment_policy: {
          executable_action: "block",
          container_action: "score",
          macro_office_action: "ignore",
          custom_blocklist_extensions: ["dmg", "rtf"],
        },
      },
    });
    expect(parsed.security?.attachment_policy?.executable_action).toBe("block");
    expect(parsed.security?.attachment_policy?.custom_blocklist_extensions).toEqual(["dmg", "rtf"]);
  });

  it("rejects an invalid attachment action enum", () => {
    const result = MailboxSettings.safeParse({
      security: {
        attachment_policy: { executable_action: "lol" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Issue should point at the bad enum value, not surface a generic 500.
      const path = result.error.issues[0].path.join(".");
      expect(path).toContain("executable_action");
    }
  });

  it("preserves co-existing security fields (allowlist alongside attachment_policy)", () => {
    // Regression guard for the passthrough hazard: adding a typed `security`
    // sub-shape must NOT strip unrelated security fields like
    // `allowlist_senders` or `thresholds` — they live in passthrough.
    const parsed = MailboxSettings.parse({
      security: {
        allowlist_senders: ["ceo@company.com"],
        thresholds: { tag: 30, quarantine: 60, block: 80 },
        attachment_policy: { executable_action: "score" },
      },
    });
    const sec = parsed.security as Record<string, unknown>;
    expect(sec.allowlist_senders).toEqual(["ceo@company.com"]);
    expect(sec.thresholds).toEqual({ tag: 30, quarantine: 60, block: 80 });
  });

  it("accepts folder_policies with mode + treat_as_verified", () => {
    const parsed = MailboxSettings.parse({
      security: {
        folder_policies: {
          inbox: { treat_as_verified: true },
          archive: { mode: "skip_classifier" },
          quarantine: { mode: "skip_all" },
        },
      },
    });
    expect(parsed.security?.folder_policies?.inbox?.treat_as_verified).toBe(true);
    expect(parsed.security?.folder_policies?.archive?.mode).toBe("skip_classifier");
    expect(parsed.security?.folder_policies?.quarantine?.mode).toBe("skip_all");
  });

  it("allows unknown folder names in folder_policies (forward-compatible)", () => {
    // User-defined custom folders must survive the round-trip — folder ids
    // are runtime data, not a closed enum.
    const result = MailboxSettings.safeParse({
      security: {
        folder_policies: {
          "Newsletters/2026": { mode: "skip_classifier" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid folder mode value", () => {
    const result = MailboxSettings.safeParse({
      security: {
        folder_policies: { inbox: { mode: "burn_it_down" } },
      },
    });
    expect(result.success).toBe(false);
  });
});
