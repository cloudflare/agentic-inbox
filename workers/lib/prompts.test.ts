// System-prompt selector tests. No framework (matches workers/routes/brand.test.ts):
//   node --experimental-strip-types workers/lib/prompts.test.ts
// Exits non-zero on the first failed assertion.

import assert from "node:assert/strict";
import {
	resolveAgentSystemPrompt,
	SUPERSEDED_SYSTEM_PROMPTS,
	systemPromptFor,
	WHISPYR_SYSTEM_PROMPT,
	WISER_SYSTEM_PROMPT,
} from "./prompts.ts";

// The exact prompt seeded into Wiser mailboxes before the assistant was told what
// WiserChat is. Duplicated here deliberately: live R2 settings still hold this
// string byte for byte, so this test fails if the superseded entry is ever edited
// — which would silently strand every mailbox seeded with it.
const SEEDED_WISER_PROMPT_BEFORE_WISERCHAT = `You are the AI assistant inside the Wiser team's email portal. You help one team member work their inbox: answer questions about their email, summarize conversations, find messages, flag who is waiting on a reply, and draft replies in their voice.

## About Wiser
This is the Wiser team's own professional email on wiserchat.ai. You are a general-purpose assistant for everyday correspondence — not a sales tool. Treat every contact as a normal professional correspondent, never a sales prospect.

## Grounding (important)
- You have tools to read THIS mailbox: list_emails, get_email, get_thread, and search_emails. Use them to answer from the team member's actual email.
- A snapshot of the most recent inbox messages is included below the instructions. Use it to answer quickly; for anything not in it (older mail, a full thread, a specific message body, the Sent folder), call a tool.
- Never invent senders, subjects, dates, or email contents. If you can't find something after looking, say so plainly.
- Be concise and specific: name the sender, subject, and date when you reference an email.

## Drafting replies
When asked to write or draft a reply, call draft_reply (or draft_email for a brand-new message). After saving, say one line about what you drafted — do NOT paste the whole body into the chat. The team member reviews and sends from the UI; you never send.
- Warm, clear, and professional.
- Plain text only — natural paragraphs, no markdown, no bullet lists, no headers in the email body.
- Default to English; reply in Arabic only if the correspondent wrote in Arabic.
- Sign off as the team member.`;

// ── whispyr → the canonical sales prompt, unchanged ──
assert.equal(systemPromptFor("whispyr"), WHISPYR_SYSTEM_PROMPT, "whispyr → whispyr prompt");
assert.match(WHISPYR_SYSTEM_PROMPT, /Whispyr/, "whispyr prompt names Whispyr");
assert.match(WHISPYR_SYSTEM_PROMPT, /prospect/i, "whispyr prompt keeps its sales framing");

// ── wiser → the team prompt, which knows the company it works for ──
assert.equal(systemPromptFor("wiser"), WISER_SYSTEM_PROMPT, "wiser → wiser prompt");
assert.match(WISER_SYSTEM_PROMPT, /Wiser team/, "wiser prompt is the Wiser team assistant");
assert.match(WISER_SYSTEM_PROMPT, /WiserChat/, "wiser prompt names WiserChat");
assert.match(WISER_SYSTEM_PROMPT, /wiserchat\.ai/, "wiser prompt names the WiserChat domain");
assert.match(
	WISER_SYSTEM_PROMPT,
	/not the WiserChat buyer chatbot/,
	"wiser prompt stays the team's email assistant, not the buyer-facing product",
);
assert.match(
	WISER_SYSTEM_PROMPT,
	/never give real-estate advice yourself/,
	"wiser prompt refuses to advise on real estate itself",
);

// ── brand separation: the Wiser prompt must NEVER mention Whispyr or carry the
//    Whispyr sales playbook (brand-no-whispyr-association / product separation) ──
assert.ok(!/whispyr/i.test(WISER_SYSTEM_PROMPT), "wiser prompt never says Whispyr");
assert.ok(
	!/lead scoring|whatsapp|20-minute demo|cold outreach/i.test(WISER_SYSTEM_PROMPT),
	"wiser prompt drops the Whispyr sales specifics",
);

// ── the two prompts are genuinely different (env-selection is meaningful) ──
assert.notEqual(WISER_SYSTEM_PROMPT, WHISPYR_SYSTEM_PROMPT, "wiser ≠ whispyr prompt");

// ── the recorded history of seeded defaults ──
assert.deepEqual(
	SUPERSEDED_SYSTEM_PROMPTS.wiser,
	[SEEDED_WISER_PROMPT_BEFORE_WISERCHAT],
	"the superseded wiser default is recorded exactly as mailboxes still store it",
);
assert.deepEqual(
	SUPERSEDED_SYSTEM_PROMPTS.whispyr,
	[],
	"the whispyr default has never been rewritten",
);

// ── resolving a stored per-mailbox prompt ──
// The brand default is COPIED into every mailbox at creation, so a rewritten
// default only reaches existing mailboxes if the seeded copy resolves forward.
assert.equal(
	resolveAgentSystemPrompt(SEEDED_WISER_PROMPT_BEFORE_WISERCHAT, "wiser"),
	WISER_SYSTEM_PROMPT,
	"a mailbox still holding the superseded wiser default gets the current one",
);
assert.equal(
	resolveAgentSystemPrompt(WISER_SYSTEM_PROMPT, "wiser"),
	WISER_SYSTEM_PROMPT,
	"a mailbox holding the current wiser default keeps it",
);
assert.equal(
	resolveAgentSystemPrompt("my custom prompt", "wiser"),
	"my custom prompt",
	"a prompt the user wrote is never rewritten",
);
assert.equal(
	resolveAgentSystemPrompt(
		`${SEEDED_WISER_PROMPT_BEFORE_WISERCHAT}\n\nAlways cc Omar.`,
		"wiser",
	),
	`${SEEDED_WISER_PROMPT_BEFORE_WISERCHAT}\n\nAlways cc Omar.`,
	"a superseded default the user edited is a customisation, not a seeded copy",
);

// Whispyr has no superseded defaults: nothing about its mailboxes changes.
assert.equal(
	resolveAgentSystemPrompt(WHISPYR_SYSTEM_PROMPT, "whispyr"),
	WHISPYR_SYSTEM_PROMPT,
	"a whispyr mailbox holding the whispyr default keeps it",
);
assert.equal(
	resolveAgentSystemPrompt("my custom prompt", "whispyr"),
	"my custom prompt",
	"a whispyr user's own prompt is never rewritten",
);
assert.equal(
	resolveAgentSystemPrompt(SEEDED_WISER_PROMPT_BEFORE_WISERCHAT, "whispyr"),
	SEEDED_WISER_PROMPT_BEFORE_WISERCHAT,
	"one brand's history never rewrites another brand's stored prompt",
);

// No stored prompt at all → the brand default, as before.
for (const stored of [undefined, null, "", "   ", 42]) {
	assert.equal(
		resolveAgentSystemPrompt(stored, "wiser"),
		WISER_SYSTEM_PROMPT,
		`no usable stored prompt (${JSON.stringify(stored)}) → the brand default`,
	);
}

console.log("prompts.test.ts: all assertions passed");
