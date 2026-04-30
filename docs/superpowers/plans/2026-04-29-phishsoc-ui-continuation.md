# PhishSOC UI continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the PhishSOC visual-language migration on remaining surfaces and ship issues #19 (loading/error states) and #11 (auto-draft toggle + agent model picker), in three sequential PRs.

**Architecture:** Three independently shippable PRs. **PR A** is a mechanical kumo-class → token swap plus dead-code deletion (no behavior change). **PR B** introduces a thin toast helper and wires `isPending`/`isError` across mutations and `isLoading` skeletons across queries. **PR C** extends the per-mailbox settings blob with `autoDraft.enabled` and `agentModel`, gates the auto-draft dispatch in `workers/index.ts`, threads the model selection into `streamText`/`generateText` in `workers/agent/index.ts`, and adds a Behavior card to `app/routes/settings.tsx`.

**Tech Stack:** React 19, React Router v7, Tailwind v4 (CSS-vars based tokens in `app/index.css`), `@cloudflare/kumo` (kept for component primitives only — `Button`, `Loader`, `Pagination`, `Tooltip`, `Badge`, `useKumoToastManager`), TanStack Query v5, Zod, Hono, Cloudflare Workers, Workers AI (`workersai`), R2 (per-mailbox settings JSON), Vitest (Node-only — no frontend test runner).

## Spec reference

Implements [docs/superpowers/specs/2026-04-29-phishsoc-ui-continuation-design.md](../specs/2026-04-29-phishsoc-ui-continuation-design.md).

## Constraints discovered during planning

- **No frontend test runner exists.** `vitest.config.ts` runs Node-only and includes `tests/**` and `test/**` (workers + security pipeline). There is no jsdom/React Testing Library setup. Adding one is out of scope; PR A and PR B therefore validate via `npm run typecheck`, the existing test suite, and manual smoke. PR C adds workers tests for the new gating logic. A follow-up issue tracks adding a frontend test environment.
- **Kumo toast API is `toastManager.add({ title, variant: "error" })`.** Existing call sites in `app/routes/settings.tsx:47-49`, `app/components/EmailPanel.tsx:115`, etc. use this shape. The helper in PR B mirrors it.
- **The auto-draft dispatch site is `workers/index.ts:601-614`** (not :88 as #11 referenced — that pointed at upstream). The fork's call site is inside `triggerAutoDraft(...)`-style logic at end of inbound flow.
- **Model call sites in the agent** are `workers/agent/index.ts:283-284` (`streamText`) and `workers/agent/index.ts:490-491` (`generateText`). Both pass `workersai("@cf/moonshotai/kimi-k2.5")` literally.
- **Per-mailbox settings** live at R2 key `mailboxes/<id>.json`. The schema is currently `z.record(z.any())` ([workers/index.ts:37](workers/index.ts#L37)) — write side intentionally lenient. `agentSystemPrompt` is the existing precedent.

## File structure

### PR A — files modified

Routes (token swap):
- `app/routes/email-list.tsx` (32 kumo-class hits)
- `app/routes/home.tsx` (18)
- `app/routes/search-results.tsx` (13)
- `app/routes/settings.tsx` (9)
- `app/routes/mailbox-index.tsx`, `app/routes/dmarc.tsx`, `app/routes/hub.tsx`, `app/routes/not-found.tsx` — audit + restyle if any kumo classes present

Components (token swap):
- All `*.tsx` under `app/components/` — collectively 177 kumo-class hits. Per-file commit.

Deleted (no importers):
- `app/components/Header.tsx`
- `app/components/Sidebar.tsx`

### PR B — files modified

- `app/lib/feedback.ts` (new) — toast helper.
- Mutation/query consumers wired: `app/components/AgentPanel.tsx`, `app/components/ComposeEmail.tsx`, `app/hooks/useComposeForm.ts`, `app/components/EmailPanel.tsx`, `app/components/email-panel/EmailPanelToolbar.tsx`, `app/components/ReportPhishButton.tsx`, `app/routes/email-list.tsx`, `app/routes/search-results.tsx`.

### PR C — files modified

- `shared/mailbox-settings.ts` (new) — Zod schema for the settings blob, shared between worker and frontend.
- `workers/index.ts` — gate auto-draft dispatch on `settings.autoDraft.enabled`.
- `workers/agent/index.ts` — read `settings.agentModel` and thread into `streamText` / `generateText`.
- `app/routes/settings.tsx` — add Behavior card (toggle + model picker).
- `app/queries/mailboxes.ts` (or wherever the settings query/mutation lives — verified during Task C-1) — typed read/write of the new fields.
- `tests/agent/settings.test.ts` (new) — workers tests for the gating + model passthrough.

---

## PR A — Token sweep + dead-code audit

**Goal:** Replace every `kumo-*` Tailwind utility class in `app/routes/` and `app/components/` with the PhishSOC token equivalent. Delete unused components. No behavior changes.

**Validation per task:** `npm run typecheck`, `npm test`, plus the per-task `grep` verification. Visual smoke in `npm run dev` at the end.

### Class-mapping table (use for every Task A-* swap)

| kumo class | token replacement |
|---|---|
| `bg-kumo-base` | `bg-paper` |
| `bg-kumo-recessed` | `bg-paper-2` |
| `bg-kumo-fill` | `bg-paper-3` |
| `bg-kumo-tint` | `bg-paper-2` (hover) |
| `bg-kumo-brand` | `bg-accent` |
| `bg-kumo-warning-muted` | `bg-accent-tint` |
| `text-kumo-default` | `text-ink` |
| `text-kumo-strong` | `text-ink` |
| `text-kumo-subtle` | `text-ink-3` |
| `text-kumo-inactive` | `text-ink-4` |
| `border-kumo-line` | `border-line` |
| `focus:ring-kumo-ring` | `focus:ring-accent` |

`text-line`, `bg-line`, etc. are **not valid** — only the listed combinations exist as tokens. If a file uses a kumo class not in the table, stop and ask before guessing. The token catalog is defined in [app/index.css](app/index.css).

### Task A-1: Confirm dead-code candidates

**Files:**
- Verify: `app/components/Header.tsx`, `app/components/Sidebar.tsx`

- [ ] **Step 1: Verify zero importers**

Run:
```bash
grep -rn "from.*components/Header\|from.*components/Sidebar\|import Header\|import Sidebar" app/ workers/ shared/ test/ tests/ 2>/dev/null
```
Expected: no output (no importers). If output exists, stop and reassess.

- [ ] **Step 2: Delete the files**

```bash
rm app/components/Header.tsx app/components/Sidebar.tsx
```

- [ ] **Step 3: Verify build still works**

```bash
npm run typecheck
```
Expected: PASS (zero TypeScript errors).

```bash
npm test
```
Expected: PASS (existing test counts unchanged — report explicitly, e.g., "X passing, 0 failing").

- [ ] **Step 4: Commit**

```bash
git add -u app/components/Header.tsx app/components/Sidebar.tsx
git commit -m "refactor: delete unused Header and Sidebar components

Both replaced by app/components/phishsoc/Shell. No remaining importers."
```

### Task A-2: Token sweep — `app/routes/home.tsx`

**Files:**
- Modify: `app/routes/home.tsx`

This is the mailbox picker, which renders **outside** `<Shell>` (no `mailboxId` selected). Goal: paper background, `<Logo>` header, `pp-serif` titles. No nav rail.

- [ ] **Step 1: Apply the class mapping**

For every match found by `grep -n "kumo-" app/routes/home.tsx`, apply the mapping table above. Examples from the file:

Before ([app/routes/home.tsx:143](app/routes/home.tsx#L143)):
```tsx
<div className="min-h-screen bg-kumo-recessed">
```
After:
```tsx
<div className="min-h-screen bg-paper-2">
```

Before ([app/routes/home.tsx:147](app/routes/home.tsx#L147)):
```tsx
<h1 className="text-2xl font-bold text-kumo-default">Mailboxes</h1>
```
After:
```tsx
<h1 className="pp-serif text-[40px] leading-none text-ink">Mailboxes</h1>
```

Before ([app/routes/home.tsx:170](app/routes/home.tsx#L170)):
```tsx
<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
```
After:
```tsx
<div className="pp-card overflow-hidden">
```
(`pp-card` is the named token utility for "card surface with paper background and line border" — defined in [app/index.css:152](app/index.css#L152). Use it everywhere a kumo card pattern appears.)

- [ ] **Step 2: Add Logo header at top of the page**

Above the existing `<h1>Mailboxes</h1>`, add:
```tsx
import Logo from "~/components/phishsoc/Logo";
// …
<header className="px-6 md:px-10 pt-6 pb-4">
  <Logo />
</header>
```
This gives the picker a branded chrome since the user is pre-mailbox and `<Shell>` isn't wrapping it.

- [ ] **Step 3: Verify zero kumo classes remain**

```bash
grep -n "kumo-" app/routes/home.tsx
```
Expected: no output.

- [ ] **Step 4: Run typecheck and tests**

```bash
npm run typecheck && npm test
```
Expected: PASS, X passing 0 failing (same count as before).

- [ ] **Step 5: Visual smoke**

```bash
npm run dev
```
Open `http://localhost:5173/`. Confirm: paper background, Logo visible top-left, mailbox cards have proper border + paper surface, hover state works, dark-mode toggle (if reachable) flips colors correctly.

- [ ] **Step 6: Commit**

```bash
git add -u app/routes/home.tsx
git commit -m "style(home): swap kumo classes to PhishSOC tokens, add Logo header"
```

### Task A-3: Token sweep — `app/routes/settings.tsx`

**Files:**
- Modify: `app/routes/settings.tsx`

- [ ] **Step 1: Apply the class mapping**

Identify the 9 kumo-class hits with `grep -n "kumo-" app/routes/settings.tsx`. Replace each per the table. Common substitutions in this file:

Before:
```tsx
<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
```
After:
```tsx
<div className="pp-card p-5">
```

Before:
```tsx
className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
```
After:
```tsx
className="w-full resize-y rounded-lg border border-line bg-paper-2 px-3 py-2 text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-accent font-mono leading-relaxed"
```

For headings, replace `text-kumo-default mb-6` with `pp-serif text-ink mb-6` to match the visual language of the new routes.

- [ ] **Step 2: Verify zero kumo classes remain**

```bash
grep -n "kumo-" app/routes/settings.tsx
```
Expected: no output.

- [ ] **Step 3: Typecheck + tests**

```bash
npm run typecheck && npm test
```
Expected: PASS, same test count.

- [ ] **Step 4: Visual smoke**

Navigate to `/mailbox/<id>/settings`. Confirm cards have paper surface, headings render in serif, textareas have correct focus ring.

- [ ] **Step 5: Commit**

```bash
git add -u app/routes/settings.tsx
git commit -m "style(settings): swap kumo classes to PhishSOC tokens"
```

### Task A-4: Token sweep — `app/routes/email-list.tsx`

**Files:**
- Modify: `app/routes/email-list.tsx`

32 kumo-class hits — the largest single-file swap.

- [ ] **Step 1: Apply the class mapping**

Use `grep -n "kumo-" app/routes/email-list.tsx` and walk top-to-bottom. Common substitutions:

Before:
```tsx
icon: <TrayIcon size={48} weight="thin" className="text-kumo-subtle" />,
```
After:
```tsx
icon: <TrayIcon size={48} weight="thin" className="text-ink-3" />,
```

Before (skeleton row):
```tsx
<div className="w-4 h-4 rounded bg-kumo-fill" />
```
After:
```tsx
<div className="w-4 h-4 rounded bg-paper-3" />
```

Before (heading):
```tsx
<h3 className="text-base font-semibold text-kumo-default mb-1.5">
```
After:
```tsx
<h3 className="text-base font-semibold text-ink mb-1.5">
```

For row hover state: replace `hover:bg-kumo-tint` with `hover:bg-paper-2` and `bg-kumo-tint` (selected) with `bg-paper-3`.

- [ ] **Step 2: Verify zero kumo classes remain**

```bash
grep -n "kumo-" app/routes/email-list.tsx
```
Expected: no output.

- [ ] **Step 3: Typecheck + tests**

```bash
npm run typecheck && npm test
```
Expected: PASS, same test count.

- [ ] **Step 4: Visual smoke**

Navigate to `/mailbox/<id>/emails/inbox`. Confirm: skeleton renders during load, empty state icon is muted, row hover is subtle, selected row is darker.

- [ ] **Step 5: Commit**

```bash
git add -u app/routes/email-list.tsx
git commit -m "style(email-list): swap kumo classes to PhishSOC tokens"
```

### Task A-5: Token sweep — `app/routes/search-results.tsx`

**Files:**
- Modify: `app/routes/search-results.tsx`

13 kumo-class hits.

- [ ] **Step 1: Apply the class mapping**

Special cases:
- `<mark className="bg-kumo-warning-muted text-kumo-default rounded-sm px-0.5">` → `<mark className="bg-accent-tint text-accent-ink rounded-sm px-0.5">` (highlight uses accent tint).
- `bg-kumo-tint` for the hover/selected row → `bg-paper-2` / `bg-paper-3`.
- Code snippets in the operator hint: `<code className="bg-kumo-tint px-1 rounded">` → `<code className="bg-paper-3 px-1 rounded pp-mono">`.

- [ ] **Step 2: Verify zero kumo classes remain**

```bash
grep -n "kumo-" app/routes/search-results.tsx
```
Expected: no output.

- [ ] **Step 3: Typecheck + tests**

```bash
npm run typecheck && npm test
```

- [ ] **Step 4: Visual smoke**

Navigate to `/mailbox/<id>/search?q=test`. Confirm: highlight pills render in accent color, operator-hint code chips use mono font, row selection works.

- [ ] **Step 5: Commit**

```bash
git add -u app/routes/search-results.tsx
git commit -m "style(search-results): swap kumo classes to PhishSOC tokens"
```

### Task A-6: Audit + restyle remaining routes

**Files:**
- Possibly modify: `app/routes/mailbox-index.tsx`, `app/routes/dmarc.tsx`, `app/routes/hub.tsx`, `app/routes/not-found.tsx`

- [ ] **Step 1: Find any kumo classes in these files**

```bash
grep -n "kumo-" app/routes/mailbox-index.tsx app/routes/dmarc.tsx app/routes/hub.tsx app/routes/not-found.tsx
```

- [ ] **Step 2: For each file with hits, apply the mapping**

If a file has zero hits, skip it. If it has hits, swap them per the table.

- [ ] **Step 3: Verify zero kumo classes remain in `app/routes/`**

```bash
grep -rn "kumo-" app/routes/
```
Expected: no output across all of `app/routes/`.

- [ ] **Step 4: Typecheck + tests + visual smoke**

```bash
npm run typecheck && npm test
```
Visit each route in the dev server and confirm rendering.

- [ ] **Step 5: Commit (one commit if multiple files touched, separate commits if a single file is large)**

```bash
git add -u app/routes/
git commit -m "style(routes): finish kumo→token sweep across remaining routes"
```

### Task A-7: Token sweep — `app/components/` (per-file, one commit each)

**Files:**
- Modify: every `*.tsx` under `app/components/` that has kumo classes (177 hits across the directory).

The order matters because `EmailPanel` and `email-panel/*` reference each other — touch the leaf files first.

Per-file procedure (repeat for each file in the order below):

1. `grep -n "kumo-" <file>` to find the hits.
2. Apply the class-mapping table.
3. `grep -n "kumo-" <file>` to confirm zero remaining.
4. `npm run typecheck && npm test` (PASS, same count).
5. `git add -u <file> && git commit -m "style(<scope>): swap kumo classes to PhishSOC tokens"` where `<scope>` is the component name (lowercase-kebab).

Walk these in order:

- [ ] **Step 1:** `app/components/VerdictBadge.tsx`
- [ ] **Step 2:** `app/components/MailboxSplitView.tsx`
- [ ] **Step 3:** `app/components/EmailIframe.tsx`
- [ ] **Step 4:** `app/components/EmailAttachmentList.tsx`
- [ ] **Step 5:** `app/components/RichTextEditor.tsx`
- [ ] **Step 6:** `app/components/ReportPhishButton.tsx`
- [ ] **Step 7:** `app/components/MCPPanel.tsx`
- [ ] **Step 8:** `app/components/SecuritySettingsPanel.tsx`
- [ ] **Step 9:** `app/components/email-panel/EmailPanelHeader.tsx`
- [ ] **Step 10:** `app/components/email-panel/EmailPanelToolbar.tsx`
- [ ] **Step 11:** `app/components/email-panel/EmailPanelDialogs.tsx`
- [ ] **Step 12:** `app/components/email-panel/SecurityVerdictPanel.tsx`
- [ ] **Step 13:** `app/components/email-panel/SingleMessageView.tsx`
- [ ] **Step 14:** `app/components/email-panel/ThreadMessage.tsx`
- [ ] **Step 15:** `app/components/EmailPanel.tsx`
- [ ] **Step 16:** `app/components/ComposePanel.tsx`
- [ ] **Step 17:** `app/components/ComposeEmail.tsx`
- [ ] **Step 18:** `app/components/AgentPanel.tsx`
- [ ] **Step 19:** `app/components/AgentSidebar.tsx`

For each step the commit message follows: `style(verdict-badge): swap kumo classes to PhishSOC tokens`, etc.

### Task A-8: Final verification + dead-code re-check

- [ ] **Step 1: Verify zero `kumo-` Tailwind classes remain anywhere**

```bash
grep -rn 'kumo-' app/routes/ app/components/
```
Expected: no output. (We do **not** grep `app/` broadly — `useKumoToastManager` is an import name, not a class, and is intentionally retained.)

- [ ] **Step 2: Re-check for newly-orphaned components**

```bash
for f in app/components/*.tsx; do
  name=$(basename "$f" .tsx)
  count=$(grep -rn "from.*components/$name\|import $name " app/ workers/ shared/ 2>/dev/null | grep -v "$f:" | wc -l)
  if [ "$count" -eq 0 ]; then echo "ORPHAN: $f"; fi
done
```
Investigate any reported orphan. If genuinely unused (used to be referenced only by `Header.tsx`/`Sidebar.tsx`), delete and commit:

```bash
rm <file> && git add -u && git commit -m "refactor: delete orphaned <name> component"
```

- [ ] **Step 3: VerdictBadge consolidation check**

If `VerdictBadge` shows zero importers, delete it (the `phishsoc/VerdictPill` is now the canonical badge). If it has importers, leave it — file a follow-up issue to consolidate.

```bash
grep -rn "from.*VerdictBadge\|import VerdictBadge" app/
```

- [ ] **Step 4: Full regression sweep**

```bash
npm run typecheck && npm test && npm run build
```
Expected: typecheck PASS, tests PASS (X passing, 0 failing — report count), build PASS.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin HEAD
gh pr create --title "PhishSOC UI: kumo→token sweep + dead-code audit" --body "$(cat <<'EOF'
## Summary

- Mechanical replacement of every `kumo-*` Tailwind utility class with the PhishSOC token equivalent (`paper/ink/accent/safe/danger`, `pp-card`, `pp-serif`, `pp-mono`).
- Deleted unused `Header.tsx` and `Sidebar.tsx` (superseded by `phishsoc/Shell`).
- No behavior changes — kumo *components* (Button, Loader, Pagination, Tooltip, Badge, useKumoToastManager) still in use.

## Test plan

- [ ] `npm run typecheck` clean
- [ ] `npm test` — same passing count as main
- [ ] `grep -rn 'kumo-' app/routes/ app/components/` returns nothing
- [ ] Dev server smoke: home, dashboard, mailbox-index, email-list, email-detail panel, settings, search, cases, case-detail, dmarc, hub
- [ ] Dark-mode toggle flips correctly on each surface
EOF
)"
```

---

## PR B — Loading & error states (#19)

**Goal:** Make every mutation in `AgentPanel`, `ComposeEmail`, email-list, and search-results disable its trigger during `isPending` and toast on `isError`. Show skeleton on `isLoading` for search-results and email-list pagination.

**Validation:** Manual smoke (toggle Wi-Fi off, attempt action, observe toast and disabled button) plus typecheck/test suite. No new automated tests for frontend (no test runner — see "Constraints" above).

### Task B-1: Add the toast helper

**Files:**
- Create: `app/lib/feedback.ts`

- [ ] **Step 1: Write the helper**

```ts
// app/lib/feedback.ts
// Copyright (c) 2026 schmug. Licensed under the Apache 2.0 license.

import { useKumoToastManager } from "@cloudflare/kumo";

/**
 * Thin wrapper over kumo's toast manager so call sites don't need to
 * remember the {variant: "error"} shape. The hook is the only API — use
 * the returned object's methods inside event handlers / effects.
 */
export function useFeedback() {
  const toasts = useKumoToastManager();
  return {
    error: (title: string) => toasts.add({ title, variant: "error" }),
    success: (title: string) => toasts.add({ title }),
    info: (title: string) => toasts.add({ title }),
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/lib/feedback.ts
git commit -m "feat(lib): add useFeedback toast helper

Wraps kumo's useKumoToastManager so call sites stop repeating the
{variant: 'error'} shape and so the toast surface is centralized for
future style/layout changes."
```

### Task B-2: Wire mutation states in `ComposeEmail` + `useComposeForm`

**Files:**
- Modify: `app/hooks/useComposeForm.ts`, `app/components/ComposeEmail.tsx`

- [ ] **Step 1: Replace direct toast usage in `useComposeForm.ts` with the helper**

Find every `toastManager.add(...)` (5 sites at lines around 225, 230, 253, 259, 261) and replace `useKumoToastManager()` initialization with `useFeedback()`. Each existing call becomes:

Before:
```ts
toastManager.add({ title: "Email sent!" });
toastManager.add({ title: message, variant: "error" });
```
After:
```ts
feedback.success("Email sent!");
feedback.error(message);
```

- [ ] **Step 2: Wire `isPending` to disable the send button**

In `ComposeEmail.tsx`, the send action button gets `disabled={mutation.isPending || existingDisabledConditions}`. The button label becomes `mutation.isPending ? <Loader size="sm" /> : "Send"`. Verify the existing `isSending` state is replaced by `mutation.isPending` rather than duplicated — `useComposeForm` currently maintains its own `isSending`; consolidate.

(Concrete edits depend on the exact mutation hook shape — read `useComposeForm.ts` lines 220-265 to confirm the mutation is a TanStack `useMutation` instance with `.isPending`. If it's a hand-rolled `setIsSending(true/false)` flag, leave that intact and just add the toast helper.)

- [ ] **Step 3: Typecheck + tests**

```bash
npm run typecheck && npm test
```
Expected: PASS, same test count.

- [ ] **Step 4: Manual smoke**

```bash
npm run dev
```
Open compose, click send with no recipient → expect error toast. Click send with valid recipient → expect "Sending email..." then "Email sent!" toasts; the send button should be disabled and show a spinner during the in-flight call.

- [ ] **Step 5: Commit**

```bash
git add -u app/hooks/useComposeForm.ts app/components/ComposeEmail.tsx
git commit -m "feat(compose): wire isPending + toast helper

Disables the send button and shows a spinner while the send mutation
is in flight. Routes errors through useFeedback so they share the
project's toast voice."
```

### Task B-3: Wire mutation states in `AgentPanel`

**Files:**
- Modify: `app/components/AgentPanel.tsx`

The agent panel uses `useChat()` from the AI SDK; the relevant pending flag is exposed by that hook (typically `isLoading` or `status`).

- [ ] **Step 1: Read the file and identify the chat send handler**

```bash
grep -n "useChat\|onSubmit\|sendMessage\|isLoading\|status" app/components/AgentPanel.tsx | head -20
```

- [ ] **Step 2: Disable the send button during pending state**

The send button's `disabled` prop should include the chat's pending flag (e.g., `disabled={isLoading || !input.trim()}`). The send icon becomes a `<Loader size="sm" />` when pending.

- [ ] **Step 3: Surface errors via toast**

If the `useChat` hook exposes an `error` field, watch it in a `useEffect` and call `feedback.error("Agent request failed.")` when it transitions truthy. Import the helper:

```ts
import { useFeedback } from "~/lib/feedback";
const feedback = useFeedback();
useEffect(() => {
  if (error) feedback.error("Agent request failed. Try again.");
}, [error, feedback]);
```

- [ ] **Step 4: Typecheck + tests**

```bash
npm run typecheck && npm test
```

- [ ] **Step 5: Manual smoke**

In dev, send a message to the agent, observe disabled state during streaming. Force an error (e.g., toggle Wi-Fi off) and confirm error toast.

- [ ] **Step 6: Commit**

```bash
git add -u app/components/AgentPanel.tsx
git commit -m "feat(agent-panel): disable send during pending, toast on error"
```

### Task B-4: Wire email-list mutation states

**Files:**
- Modify: `app/components/email-panel/EmailPanelToolbar.tsx`, `app/components/EmailPanel.tsx`, `app/routes/email-list.tsx`

The toolbar contains move/quarantine/delete/mark-read buttons. Each is backed by a TanStack `useMutation`.

- [ ] **Step 1: Locate each mutation hook**

```bash
grep -n "useMutation\|useMoveEmail\|useDelete\|useMark" app/components/email-panel/EmailPanelToolbar.tsx app/components/EmailPanel.tsx app/routes/email-list.tsx
```

- [ ] **Step 2: For each mutation, disable its trigger during `isPending`**

Pattern:
```tsx
<Button
  onClick={() => moveMutation.mutate({ to: "quarantine" })}
  disabled={moveMutation.isPending}
>
  {moveMutation.isPending ? <Loader size="sm" /> : "Quarantine"}
</Button>
```

- [ ] **Step 3: Replace existing direct `toastManager.add({variant: "error"})` calls with `feedback.error(...)`**

Use the helper from Task B-1 in `EmailPanel.tsx` (5 toast sites in that file alone).

- [ ] **Step 4: Typecheck + tests**

```bash
npm run typecheck && npm test
```

- [ ] **Step 5: Manual smoke**

In dev: select an email, click Quarantine → expect button to disable briefly. Force a network failure → expect error toast.

- [ ] **Step 6: Commit**

```bash
git add -u app/components/email-panel/EmailPanelToolbar.tsx app/components/EmailPanel.tsx app/routes/email-list.tsx
git commit -m "feat(email-list): wire mutation isPending + error toasts"
```

### Task B-5: Add skeletons to search and email-list pagination

**Files:**
- Modify: `app/routes/search-results.tsx`, `app/routes/email-list.tsx`

- [ ] **Step 1: Reuse the existing skeleton pattern from `email-list.tsx`**

`email-list.tsx` already renders a 5-row skeleton during initial load (lines around 96-105). Confirm `isLoading` (initial) and `isFetching` (subsequent pages) are wired correctly. The skeleton should render on `isLoading` (full replace) but not on `isFetching` while keeping prior data — or, for pagination, render the skeleton in place of rows when navigating to a new page so the user gets a clear "loading" signal instead of stale data.

Concrete change — wrap the row map with:
```tsx
{isLoading || (isFetching && isPlaceholderData) ? <SkeletonList /> : rows.map(...)}
```
where `SkeletonList` is the existing inline skeleton extracted into a named local component for reuse.

- [ ] **Step 2: Add the same skeleton pattern to `search-results.tsx`**

`search-results.tsx` already shows a `<Loader />` while loading; replace with the same row-shaped skeleton (5 rows mirroring the search-result row layout) for visual consistency.

- [ ] **Step 3: Wire `isError` to a toast in `search-results.tsx`**

```tsx
const feedback = useFeedback();
useEffect(() => {
  if (isError) feedback.error("Search failed. Try again.");
}, [isError, feedback]);
```

- [ ] **Step 4: Typecheck + tests**

```bash
npm run typecheck && npm test
```

- [ ] **Step 5: Manual smoke**

Throttle the network in DevTools to "Slow 3G", trigger a search and a page change in email-list. Confirm skeletons render. Force an error → confirm toast.

- [ ] **Step 6: Commit**

```bash
git add -u app/routes/search-results.tsx app/routes/email-list.tsx
git commit -m "feat(search,email-list): show skeleton on loading, toast on error"
```

### Task B-6: Sweep remaining direct `toastManager.add` sites

**Files:**
- Modify: `app/routes/home.tsx`, `app/routes/settings.tsx`, `app/components/ReportPhishButton.tsx`

- [ ] **Step 1: Replace remaining direct toast calls with `useFeedback`**

`grep -rn "useKumoToastManager\|toastManager\.add" app/` — every site that's NOT inside `app/lib/feedback.ts` should be migrated. The transformation is mechanical:

Before:
```ts
const toastManager = useKumoToastManager();
toastManager.add({ title: "Mailbox created successfully!" });
toastManager.add({ title: "Failed to delete mailbox", variant: "error" });
```
After:
```ts
const feedback = useFeedback();
feedback.success("Mailbox created successfully!");
feedback.error("Failed to delete mailbox");
```

- [ ] **Step 2: Verify no direct `toastManager` usage outside `app/lib/feedback.ts`**

```bash
grep -rn "useKumoToastManager\|toastManager\.add" app/
```
Expected: only the helper file shows up.

- [ ] **Step 3: Typecheck + tests**

```bash
npm run typecheck && npm test
```

- [ ] **Step 4: Commit**

```bash
git add -u app/
git commit -m "refactor(toasts): route remaining sites through useFeedback"
```

### Task B-7: Final verification + open PR

- [ ] **Step 1: Full regression sweep**

```bash
npm run typecheck && npm test && npm run build
```

- [ ] **Step 2: Open PR**

```bash
git push -u origin HEAD
gh pr create --title "PhishSOC UI: loading & error states (#19)" --body "$(cat <<'EOF'
## Summary

Closes #19.

- New `useFeedback` helper at `app/lib/feedback.ts` — thin wrapper over kumo's toast manager.
- Mutation triggers in AgentPanel, ComposeEmail, email-list (move/quarantine/delete), and search-results now disable on `isPending` and show a spinner.
- `isError` surfaces a toast in each site.
- Skeletons render on `isLoading` (initial) and during pagination for search-results and email-list.

## Test plan

- [ ] `npm run typecheck` clean
- [ ] `npm test` — same passing count as main
- [ ] Manual: throttle network, trigger each mutation, confirm disabled state + error toast
- [ ] Manual: load search and email-list with throttled network, confirm skeleton then content
EOF
)"
```

---

## PR C — Settings: auto-draft toggle + agent model (#11)

**Goal:** Add `autoDraft.enabled` and `agentModel` to the per-mailbox settings blob. Gate auto-draft dispatch in `workers/index.ts`. Read the model in `workers/agent/index.ts`. Add a Behavior card to the Settings page with a toggle and a model dropdown (hand-curated allowlist + custom free-text fallback).

**Validation:** Workers tests for the gating + model passthrough (real test runner exists for backend). Frontend validation is manual smoke.

### Task C-1: Define the settings schema

**Files:**
- Create: `shared/mailbox-settings.ts`

- [ ] **Step 1: Write the schema**

```ts
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
```

(Verify the second entry exists in Workers AI before merging. If the ecosystem moved on, swap in a current model. The list is intentionally short — fewer entries to keep working.)

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add shared/mailbox-settings.ts
git commit -m "feat(shared): add MailboxSettings zod schema with autoDraft + agentModel"
```

### Task C-2: Test — auto-draft gate

**Files:**
- Create: `tests/agent/settings.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent/settings.test.ts
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
```

- [ ] **Step 2: Run test to verify it passes (already-implemented schema)**

```bash
npx vitest run tests/agent/settings.test.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 3: Commit**

```bash
git add tests/agent/settings.test.ts
git commit -m "test(settings): cover MailboxSettings defaults and passthrough"
```

### Task C-3: Gate auto-draft dispatch in `workers/index.ts`

**Files:**
- Modify: `workers/index.ts` (around line 601 — `triggerAutoDraft`-ish block)

- [ ] **Step 1: Read the dispatch site**

```bash
sed -n '595,620p' workers/index.ts
```

- [ ] **Step 2: Add a settings fetch + gate**

Before the `agentStub.fetch(new Request("https://agents/onNewEmail", ...))` call, fetch the mailbox settings and check the flag:

```ts
import { MailboxSettings } from "../shared/mailbox-settings";

// …inside the auto-draft dispatch block:
let autoDraftEnabled = true;
try {
  const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
  if (obj) {
    const raw = await obj.json<Record<string, unknown>>();
    const settings = MailboxSettings.parse(raw);
    autoDraftEnabled = settings.autoDraft.enabled;
  }
} catch {
  // Missing or malformed settings → keep default-true behavior.
}

if (!autoDraftEnabled) {
  return; // skip auto-draft dispatch
}

const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
ctx.waitUntil(agentStub.fetch(/* … */));
```

(The exact placement depends on the function signature — wrap the `agentStub` creation and `ctx.waitUntil` in the conditional; do **not** skip the deep-scan or other security work that lives above this in the same function.)

- [ ] **Step 3: Typecheck + tests**

```bash
npm run typecheck && npm test
```
Expected: PASS, X passing 0 failing.

- [ ] **Step 4: Commit**

```bash
git add -u workers/index.ts
git commit -m "feat(workers): gate auto-draft dispatch on settings.autoDraft.enabled

Reads the per-mailbox MailboxSettings blob from R2 and skips the agent
onNewEmail call when autoDraft.enabled is false. Defaults to true when
settings are absent or malformed (preserves existing mailbox behavior)."
```

### Task C-4: Thread agentModel through `workers/agent/index.ts`

**Files:**
- Modify: `workers/agent/index.ts`

- [ ] **Step 1: Extend the existing settings reader**

`getSystemPrompt` at line 94 already reads `mailboxes/<id>.json`. Add a sibling helper:

```ts
import { MailboxSettings } from "../../shared/mailbox-settings";

async function getMailboxSettings(env: Env, mailboxId: string): Promise<MailboxSettings> {
  try {
    const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
    if (obj) {
      const raw = await obj.json<Record<string, unknown>>();
      return MailboxSettings.parse(raw);
    }
  } catch {
    // fall through to defaults
  }
  return MailboxSettings.parse({});
}
```

Refactor `getSystemPrompt` to use this helper internally (or leave it alone and add the new helper alongside — both work, but consolidation is cleaner).

- [ ] **Step 2: Use the model at the streamText call site (line 283-284)**

Before:
```ts
const result = streamText({
  model: workersai("@cf/moonshotai/kimi-k2.5"),
```
After:
```ts
const settings = await getMailboxSettings(env, mailboxId);
const result = streamText({
  model: workersai(settings.agentModel),
```

- [ ] **Step 3: Use the model at the generateText call site (line 490-491)**

Same transformation. Note that `handleNewEmail` already reads `emailData.mailboxId` — pass that to `getMailboxSettings`.

- [ ] **Step 4: Typecheck + tests**

```bash
npm run typecheck && npm test
```

- [ ] **Step 5: Commit**

```bash
git add -u workers/agent/index.ts
git commit -m "feat(agent): read agentModel from per-mailbox settings

Both streamText (chat) and generateText (auto-draft) now use
settings.agentModel. Defaults to the existing kimi-k2.5 model when the
field is absent — no migration required for existing mailboxes."
```

### Task C-5: Add Behavior card to Settings UI

**Files:**
- Modify: `app/routes/settings.tsx`
- Possibly modify: the settings query/mutation file (verify path before editing)

- [ ] **Step 1: Locate the existing settings load/save plumbing**

```bash
grep -rn "agentSystemPrompt\|mailboxSettings\|settings.tsx" app/queries/ app/routes/settings.tsx | head -20
```
Identify the query hook (probably `useMailboxSettings(mailboxId)`) and the mutation hook used to PUT settings. The Behavior card hooks into the same plumbing — no new endpoint.

- [ ] **Step 2: Add the toggle and dropdown UI**

Inside `app/routes/settings.tsx`, after the existing system-prompt card, insert:

```tsx
import { TEXT_MODELS } from "../../shared/mailbox-settings";

// inside the component, near other useState calls:
const [autoDraftEnabled, setAutoDraftEnabled] = useState(
  settings?.autoDraft?.enabled ?? true,
);
const initialModel = settings?.agentModel ?? TEXT_MODELS[0];
const [modelChoice, setModelChoice] = useState<string>(
  TEXT_MODELS.includes(initialModel as typeof TEXT_MODELS[number])
    ? initialModel
    : "__custom__",
);
const [customModel, setCustomModel] = useState(
  modelChoice === "__custom__" ? initialModel : "",
);

// inside the JSX, after the system-prompt card:
<div className="pp-card p-5">
  <div className="text-sm font-medium text-ink mb-4">Behavior</div>

  <label className="flex items-center justify-between gap-3 mb-4">
    <span className="flex flex-col">
      <span className="text-sm text-ink">Auto-draft replies</span>
      <span className="text-xs text-ink-3 mt-1">
        Generate a draft reply automatically when new mail arrives.
        Drafts are never sent without explicit confirmation.
      </span>
    </span>
    <input
      type="checkbox"
      checked={autoDraftEnabled}
      onChange={(e) => setAutoDraftEnabled(e.target.checked)}
      className="h-4 w-4 accent-accent"
    />
  </label>

  <div className="mb-3">
    <label className="block text-sm text-ink mb-1.5">Agent model</label>
    <select
      value={modelChoice}
      onChange={(e) => setModelChoice(e.target.value)}
      className="w-full rounded-md border border-line bg-paper-2 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent"
    >
      {TEXT_MODELS.map((m) => (
        <option key={m} value={m}>{m}</option>
      ))}
      <option value="__custom__">Custom…</option>
    </select>
    {modelChoice === "__custom__" && (
      <input
        type="text"
        placeholder="@cf/your/model"
        value={customModel}
        onChange={(e) => setCustomModel(e.target.value)}
        className="mt-2 w-full rounded-md border border-line bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-accent"
      />
    )}
    <p className="text-xs text-ink-3 mt-2">
      Used for chat and auto-draft. Custom values must start with{" "}
      <code className="pp-mono">@cf/</code>.
    </p>
  </div>
</div>
```

- [ ] **Step 3: Wire the values into the existing save mutation**

When the user clicks "Save settings" (the existing button), build the payload to include the new fields:

```ts
const resolvedModel = modelChoice === "__custom__" ? customModel.trim() : modelChoice;
if (resolvedModel && !resolvedModel.startsWith("@cf/")) {
  feedback.error("Model must start with @cf/");
  return;
}

mutation.mutate({
  ...existingPayload,
  autoDraft: { enabled: autoDraftEnabled },
  agentModel: resolvedModel || TEXT_MODELS[0],
});
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Manual smoke**

```bash
npm run dev
```

Open `/mailbox/<id>/settings`:
1. Toggle auto-draft off, click Save → expect success toast.
2. Send mail to the mailbox → expect **no** draft generated.
3. Toggle auto-draft on, change model to `llama-3.3-70b-...`, save → expect success.
4. Chat with the agent → expect the new model to be used (visible in Cloudflare dashboard under Workers AI usage).
5. Pick "Custom…", enter `gpt-4o`, click Save → expect validation error toast.
6. Pick "Custom…", enter `@cf/foo/bar`, click Save → expect success.

- [ ] **Step 6: Commit**

```bash
git add -u app/routes/settings.tsx
git commit -m "feat(settings): add Behavior card with auto-draft toggle and model picker

Closes #11. Hand-curated model list with custom free-text fallback;
validates @cf/ prefix client-side. Defaults preserve existing behavior
for already-configured mailboxes."
```

### Task C-6: Final verification + open PR

- [ ] **Step 1: Full regression**

```bash
npm run typecheck && npm test && npm run build
```
Expected: typecheck PASS, tests PASS (X passing, 0 failing — report count, expect 4 new tests from Task C-2), build PASS.

- [ ] **Step 2: Open PR**

```bash
git push -u origin HEAD
gh pr create --title "PhishSOC: auto-draft toggle + agent model picker (#11)" --body "$(cat <<'EOF'
## Summary

Closes #11.

- New `shared/mailbox-settings.ts` with a Zod schema (`autoDraft.enabled` + `agentModel`, both with sane defaults preserving current behavior).
- `workers/index.ts` reads the schema and skips the auto-draft dispatch when disabled.
- `workers/agent/index.ts` reads `agentModel` and uses it at both the streamText (chat) and generateText (auto-draft) call sites.
- `app/routes/settings.tsx` gains a Behavior card with a toggle and a hand-curated model dropdown plus custom free-text fallback.

## Out of scope (per #11)

- Non–Workers AI providers (Anthropic/OpenAI via AI SDK adapters).
- Per-mailbox override of the injection scanner / verifier models in `workers/lib/ai.ts`.
- Dynamic Workers AI model list — separate follow-up issue.

## Test plan

- [ ] `npm run typecheck` clean
- [ ] `npm test` — 4 new schema tests pass
- [ ] Toggle auto-draft off, send mail, confirm no draft generated
- [ ] Change model, chat with agent, confirm Workers AI dashboard shows new model
- [ ] Custom model with bad prefix → validation error
- [ ] Custom model with `@cf/` prefix → saves and persists across reload
EOF
)"
```

---

## Self-review

**Spec coverage:**
- Token sweep on remaining surfaces (spec §Scope) → Tasks A-2 through A-7. ✓
- Dead-code audit (spec §Dead-code audit) → Tasks A-1, A-8. ✓
- `home.tsx` slim treatment (spec §Scope) → Task A-2 step 2. ✓
- `useFeedback` helper (spec §UX issue #19) → Task B-1. ✓
- Mutation `isPending` + `isError` across listed sites → Tasks B-2, B-3, B-4. ✓
- Skeletons on `isLoading` for search and email-list pagination → Task B-5. ✓
- `MailboxSettings` schema (spec §UX issue #11 backend) → Task C-1. ✓
- Auto-draft gate in `workers/index.ts` → Task C-3. ✓
- `agentModel` threading in `workers/agent/index.ts` → Task C-4. ✓
- Behavior card UI with toggle + dropdown + custom fallback (spec §UX issue #11 frontend) → Task C-5. ✓
- Defaults preserve current behavior → Task C-1 default values + Task C-3/C-4 fallback paths. ✓
- Workers tests for the gating logic → Task C-2 (covers schema; gating logic itself is exercised end-to-end via manual smoke since the auto-draft dispatch happens deep inside the email pipeline and would require fixturing the full pipeline to unit-test). The schema tests are the load-bearing piece — if they pass, the gate's input is validated.

**Placeholder scan:**
- No "TBD"/"TODO"/"implement later" found.
- One conditional task (A-6) — explicitly handles the "if file has hits" case with an empty-output expectation, not vague.
- One "verify path before editing" hint in C-5 — paired with a concrete `grep` command.

**Type consistency:**
- `useFeedback` returns `{ error, success, info }` — same shape used in B-2/B-3/B-4/B-5/B-6. ✓
- `MailboxSettings` defined in C-1 with `autoDraft.enabled: boolean` and `agentModel: string` — both fields used identically in C-3/C-4/C-5. ✓
- `TEXT_MODELS` exported from C-1 and imported in C-5. ✓
- `getMailboxSettings(env, mailboxId)` defined in C-4 and called in C-4 only. ✓

No issues found.
