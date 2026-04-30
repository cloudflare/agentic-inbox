# PhishSOC UI continuation — design

**Date:** 2026-04-29
**Status:** Approved scope, pending user spec review
**Owner:** schmug

## Context

The fork of `cloudflare/agentic-inbox` is being rebranded to **PhishSOC**. The
brand identity (page title, README, `package.json`, deploy button URL) and a
new design library at `app/components/phishsoc/` (`Logo`, `Shell`, `ScoreRing`,
`VerdictPill`, `Sparkline`, `verdict.ts`) are already in place. The new visual
language is driven by CSS custom-property tokens declared in
`app/index.css` — `paper/ink/accent/safe/danger`, plus utility classes
`pp-card`, `pp-pill-*`, `pp-mono`, `pp-serif`.

Four routes — `dashboard.tsx`, `mailbox.tsx`, `cases.tsx`, `case-detail.tsx` —
already use the new tokens. `app/routes/mailbox.tsx` wraps every child of
`/mailbox/:mailboxId/*` in `<Shell>`, so the structural migration for nested
routes is **already done**: their internal class names just haven't been
swapped yet.

This document specifies the work to bring every remaining surface onto the
PhishSOC visual language and to fix two UX-quality issues that the new Shell
makes obvious.

## Goal

Finish the PhishSOC UI rebrand on user-facing surfaces and ship two open UX
issues — [#19](https://github.com/cloudflare/agentic-inbox/issues/19)
(loading/error states) and
[#11](https://github.com/cloudflare/agentic-inbox/issues/11) (auto-draft
toggle + agent model picker) — in the same continuation.

## Non-goals

- Worker rename (`agentic-inbox` → `phishsoc` in `wrangler.jsonc:3`). Touching
  the Worker name creates a new Worker and orphans existing state. Out of
  scope here; will be its own migration plan.
- R2 bucket rename (`wrangler.jsonc:28-29`). Same reasoning — destructive,
  needs data migration plan.
- README link cleanup (`README.md:18`, `:64` reference upstream
  `cloudflare/agentic-inbox`). Owner-level decision tied to whether the fork
  stays at `schmug/PhishSOC` or moves; out of band.
- Onboarding rebuild. The user has stated this lands later as its own effort,
  on top of the new Shell. Upstream PR #10 will not be merged.
- Removal of the `@cloudflare/kumo` package. We keep it for component
  primitives (`Button`, `Pagination`, `Tooltip`, `Loader`, `useKumoToastManager`).
  Only the `kumo-*` *Tailwind utility classes* (`bg-kumo-recessed`,
  `text-kumo-default`, etc.) are being phased out.
- Backend-only issues: #16 (safeParse), #17 (silent catches), #18 (rate-limit
  logging), #8 (multi-domain), #9 (external API), #1 (mailbox cleanup).

## Scope

### Surfaces requiring style migration

All currently use `kumo-*` Tailwind classes. Token equivalents already exist
in `app/index.css`. This is mechanical replacement.

| Surface | Notes |
|---|---|
| `app/routes/email-list.tsx` | Folder list view; renders inside `<Shell>`. Pagination skeleton needed. |
| `app/routes/settings.tsx` | Mailbox settings; renders inside `<Shell>`. New "Behavior" card lands here. |
| `app/routes/search-results.tsx` | Search view; renders inside `<Shell>`. Skeleton + empty/error states. |
| `app/routes/home.tsx` | Mailbox picker, **outside** `<Shell>` (no `mailboxId` yet). Slim treatment: paper background, `<Logo>` header, `pp-serif` titles. No nav rail. |
| `app/routes/mailbox-index.tsx` | Default landing inside `/mailbox/:id`. Audit + restyle if kumo-classed. |
| `app/routes/dmarc.tsx` | Audit + restyle if kumo-classed. |
| `app/routes/hub.tsx` | Audit + restyle if kumo-classed. |
| `app/routes/not-found.tsx` | Audit + restyle (small surface). |
| `app/components/AgentPanel.tsx` | Right-rail agent chat; lazy-loaded by `AgentSidebar`. |
| `app/components/AgentSidebar.tsx` | Wrapper around `AgentPanel`. |
| `app/components/ComposeEmail.tsx` | Modal composer. |
| `app/components/EmailPanel.tsx` + `app/components/email-panel/*` | Selected-email panel. |
| `app/components/MCPPanel.tsx` | MCP setup card. |
| `app/components/MailboxSplitView.tsx` | Split view layout. |
| `app/components/RichTextEditor.tsx` | TipTap chrome. |
| `app/components/SecuritySettingsPanel.tsx` | Security toggles within Settings. |
| `app/components/VerdictBadge.tsx` | Score badge. (Note: `phishsoc/VerdictPill` is the new equivalent — verify whether `VerdictBadge` should be deleted or re-skinned.) |
| `app/components/ReportPhishButton.tsx` | Report-as-phish action. |
| `app/components/EmailIframe.tsx` | Sandboxed body renderer; check chrome only. |
| `app/components/EmailAttachmentList.tsx` | Attachment list. |
| `app/components/ComposePanel.tsx` | Compose chrome. |

### Dead-code audit (PR A)

Imports verified absent:

- `app/components/Header.tsx` — no importers; superseded by `Shell`'s topbar.
- `app/components/Sidebar.tsx` — no importers; superseded by `Shell`'s nav.

Both deleted in PR A. Any other zero-importer file discovered during the sweep
gets the same treatment. Files retained: `AgentSidebar` and `AgentPanel`
(lazy-loaded chain), `EmailPanel` (uses `email-panel/EmailPanelHeader`).
`VerdictBadge` is borderline — keep until grep confirms zero importers.

### UX issue #19 — loading & error states

Mutations and queries currently render results without surfacing pending or
error states, so failed sends/moves/searches look indistinguishable from
no-ops and double-clicks aren't prevented.

**Sites:**

- `app/components/AgentPanel.tsx` — chat send mutation.
- `app/components/ComposeEmail.tsx` — send/draft mutation.
- `app/components/email-panel/*` and `app/routes/email-list.tsx` — move,
  quarantine, delete, mark-read mutations.
- `app/routes/search-results.tsx` — search query.
- `app/routes/email-list.tsx` — folder pagination query.

**Pattern:**

```tsx
// Disable trigger while pending
<Button disabled={mutation.isPending} onClick={…}>
  {mutation.isPending ? <Loader size="sm" /> : "Send"}
</Button>

// Toast on error
useEffect(() => {
  if (mutation.isError) feedback.error("Couldn't send. Try again.");
}, [mutation.isError]);
```

A thin shared helper avoids re-importing `useKumoToastManager` everywhere:

```ts
// app/lib/feedback.ts
export function useFeedback() {
  const toasts = useKumoToastManager();
  return {
    error: (msg: string) => toasts.add({ tone: "danger", title: msg }),
    success: (msg: string) => toasts.add({ tone: "safe", title: msg }),
  };
}
```

For queries, the empty-state component already exists in
`search-results.tsx`; we reuse it for `isLoading` (skeleton) and `isError`
(retry button + toast).

### UX issue #11 — auto-draft toggle + agent model picker

**Backend (`workers/`):**

Per-mailbox settings already live at R2 path `mailboxes/<id>.json` and are
read in `getSystemPrompt()` and written by `PUT /api/v1/mailboxes/:mailboxId`.
Extend the schema:

```jsonc
{
  // existing fields…
  "autoDraft":  { "enabled": true },
  "agentModel": "@cf/moonshotai/kimi-k2.5"
}
```

- `workers/index.ts` — gate the `agentStub.fetch("/onNewEmail", …)` call on
  `settings.autoDraft.enabled`. Default `true` if missing (backward compat).
- `workers/agent/index.ts` — read `settings.agentModel` alongside
  `agentSystemPrompt` in `onChatMessage` (`streamText`) and `handleNewEmail`
  (`generateText`); pass to `workersai(model)`. Fall back to the current
  hardcoded default if missing.
- `workers/lib/ai.ts` — out of scope. Injection scanner and draft verifier
  models stay pinned (per the issue's explicit out-of-scope list).

**Frontend (`app/routes/settings.tsx`):**

Add a "Behavior" card with:

1. **Auto-draft toggle.** Bound to `settings.autoDraft.enabled`. Default on.
   Subtitle: "Generate a draft reply automatically when new mail arrives.
   Draft is never sent without explicit confirmation."
2. **Agent model.** A `<select>` populated from a hand-curated allowlist
   (final list verified at implementation time against the current Workers
   AI text-generation catalog; the array below is illustrative, not
   prescriptive):

   ```ts
   const TEXT_MODELS = [
     "@cf/moonshotai/kimi-k2.5", // current default; keep first
     "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
     // additional entries chosen at impl time from the live Workers AI list
   ];
   ```

   Plus a "Custom…" option that reveals a free-text input. Validation:
   non-empty, must start with `@cf/`. Saved value flows through to
   `settings.agentModel`. The current default (whatever the codebase pins
   at impl time) must be the first entry so existing mailboxes' settings
   continue to match a list option after the upgrade.

The list is hand-curated for now; a follow-up issue tracks fetching it from
the Workers AI REST API at `/accounts/{account_id}/ai/models/search?task_name=Text Generation`.
That requires a new `CLOUDFLARE_API_TOKEN` secret and a KV cache, which is
intentionally deferred.

## Approach: three sequential PRs

Splitting on the natural seams — pure styling, then UX states, then a feature.

### PR A — Token sweep + dead-code audit

- Single PR, one commit per route/component for granular review and easy
  revert.
- Mechanical class-name replacement: `bg-kumo-recessed` → `bg-paper`,
  `text-kumo-default` → `text-ink`, `border-kumo-line` → `border-line`, etc.
  A short mapping table goes in the PR description.
- `app/routes/home.tsx` gets a slim header treatment with `<Logo>` and
  `pp-serif` titles, but no nav rail (no `mailboxId` selected yet).
- Delete `app/components/Header.tsx`, `app/components/Sidebar.tsx`, and any
  zero-importer file discovered during the sweep.
- **Validation:** `npm run typecheck`, `npm test`, manual visual check in
  `npm run dev` for each route. No behavior change asserted.
- **Risk:** Low. Pure class-name swaps; existing tests guard interaction.

### PR B — Loading & error states (#19)

- Add `app/lib/feedback.ts` (shared toast helper).
- Wire `isPending` to disable trigger buttons in `AgentPanel`,
  `ComposeEmail`, email-list mutation buttons, search-results.
- Wire `isError` to `feedback.error(...)` toasts.
- Add skeleton on `isLoading` for search-results and email-list pagination
  (reuse the kumo `Skeleton`/`Loader` primitives — no new deps).
- **Validation:** Existing tests, plus one new test per major site asserting
  the disabled state during `isPending` (using TanStack Query's mock
  `isPending` flag).
- **Risk:** Low. Adds UI affordances; doesn't change request shapes.

### PR C — Settings: auto-draft toggle + agent model (#11)

- Backend: extend the per-mailbox settings schema (Zod), gate auto-draft
  fetch in `workers/index.ts`, read `agentModel` in `workers/agent/index.ts`.
- Frontend: add "Behavior" card to `app/routes/settings.tsx` with toggle and
  model dropdown.
- Defaults preserve current behavior — existing mailboxes continue auto-
  drafting on the current model with no migration required.
- **Validation:** New worker tests for the gating logic and model passthrough.
  New frontend test for the Behavior card form. End-to-end: turn off auto-
  draft, send mail, assert no draft is generated.
- **Risk:** Medium. Touches the agent's runtime configuration. Mitigated by
  defaulting both fields to current behavior and feature-flagging the toggle
  off the existing settings persistence path (no schema migration required —
  Zod's `.default()` covers absent fields).

### Ordering rationale

A → B → C because:

- B touches files that A restyles. Doing A first means B's diffs are pure
  behavior changes, not entangled with class swaps.
- C uses the toast helper from B for "saved" feedback on the new form.
- Each PR is independently revertable and shippable.

## Architecture notes

**Where the helper lives.** `app/lib/feedback.ts` is a new directory; check
that `app/lib/` doesn't already exist as a barrel for unrelated utilities. If
it does, drop in alongside; if not, create it.

**Token-class boundary.** The kumo *components* (Button, Pagination, etc.)
internally render their own kumo-classed DOM. We don't touch that. We only
replace kumo classes that *we* author in our route/component files.

**`VerdictBadge` vs `phishsoc/VerdictPill`.** Likely overlap. PR A's audit
step decides: if `VerdictBadge` has no remaining importers after the sweep,
delete it; otherwise restyle and file a follow-up to consolidate.

## Acceptance criteria

- Every route under `/mailbox/:id/*` and the home picker render with the
  PhishSOC token system. No `kumo-*` Tailwind classes remain in `app/routes/`
  or `app/components/` (verified by `grep -r kumo- app/`).
- `Header.tsx` and `Sidebar.tsx` deleted; no other importers broken
  (`npm run typecheck` clean).
- Every mutation in `AgentPanel`, `ComposeEmail`, email-list, and search-
  results disables its trigger during `isPending` and toasts on `isError`.
- Search-results and email-list show a skeleton during `isLoading`.
- Settings shows a working Behavior card; toggling auto-draft off prevents
  auto-draft generation on the next inbound mail (verified end-to-end).
- Agent model dropdown round-trips through the settings R2 blob; the agent
  uses the configured model on next message.
- All existing tests still pass; one new test per major surface added.

## Open questions

None at present. Q1–Q3 resolved during brainstorming:

- Q1: Dead-code audit included in PR A. ✓
- Q2: Hand-curated allowlist + custom free-text fallback; dynamic Workers AI
  fetch deferred to a follow-up issue. ✓
- Q3: One PR per phase, with one commit per route/component inside PR A. ✓

## Follow-up issues to file after this lands

- Worker/bucket rename migration plan (`agentic-inbox` → `phishsoc`).
- README link cleanup tied to fork rename decision.
- Dynamic Workers AI text-model list (replaces the hand-curated array).
- Per-mailbox override of injection scanner and draft verifier models
  (#11's stated out-of-scope).
- Onboarding rebuild on the new Shell.
