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
});
