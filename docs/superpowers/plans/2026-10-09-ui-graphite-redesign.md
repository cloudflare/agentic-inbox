# Graphite UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the agentic-inbox web UI to the approved "Graphite" look (neutral zinc + indigo accent, Inter, light and dark mode) without changing behavior or layout structure.

**Architecture:** A kumo theme override file redefines kumo's semantic CSS variables (unlayered `:root` and `:root[data-mode="dark"]` rules beat kumo's `@layer base` values) and adds five new tokens through `@theme`. A tiny theme module plus an inline head script drive `data-mode` on `<html>`. Screen tasks then polish markup and Tailwind classes per area, using only kumo tokens so both modes work.

**Tech Stack:** React Router v7, React 19, Tailwind CSS v4, `@cloudflare/kumo`, `@phosphor-icons/react`, Cloudflare Workers (vite plugin).

Spec: `docs/superpowers/specs/2026-10-09-ui-graphite-redesign-design.md`.

## Global Constraints

- Visual only: no changes under `workers/`, no API, route, store, or query changes, no new dependencies.
- Keep the four-column structure and existing breakpoints (`md`, `lg`) and widths (sidebar `w-64`, list `380px`, agent column `380px`).
- Colors only through kumo tokens (`bg-kumo-*`, `text-kumo-*`, `border-kumo-*`, plus the new `kumo-sidebar`, `kumo-selected`, `kumo-accent-soft`, `kumo-accent-line`, `text-kumo-accent`). No raw hex, no `bg-blue-*`/`text-gray-*` style palette classes, no `dark:` variants.
- Font weights: `font-normal` (400) and `font-medium` (500). `font-semibold` only for the mailbox title on the home page.
- Radii: controls `rounded-lg` (8px), cards/panels/bubbles `rounded-xl` (12px), avatars and pills `rounded-full`.
- Times, dates, and counts get `tabular-nums`.
- UI copy stays as it is (English, sentence case); do not rename labels except the delete tooltips already present.
- Every task must pass `npm run typecheck` (exit 0).
- No commits inside parallel tasks; the orchestrator commits after review.

## File map

| File | Task | Responsibility |
|---|---|---|
| `app/theme-graphite.css` (new) | 1 | Token overrides, new tokens, font, scrollbars |
| `app/index.css` | 1 | Import the theme file |
| `app/root.tsx` | 1, 2 | Font links, theme init script, `suppressHydrationWarning` |
| `app/lib/theme.ts` (new) | 2 | Theme preference read/write/apply + init script string |
| `app/components/ThemeToggle.tsx` (new) | 2 | Header button cycling light → dark → system |
| `app/routes/mailbox.tsx`, `app/components/Sidebar.tsx` | 3 | Shell and sidebar |
| `app/components/Header.tsx`, `app/routes/email-list.tsx`, `app/components/MailboxSplitView.tsx`, `app/routes/search-results.tsx` | 4 | Header, list, search results |
| `app/components/EmailPanel.tsx`, `app/components/email-panel/*`, `app/components/EmailIframe.tsx`, `app/components/EmailAttachmentList.tsx` | 5 | Reading pane |
| `app/components/AgentPanel.tsx`, `app/components/AgentSidebar.tsx`, `app/components/MCPPanel.tsx` | 6 | Agent column |
| `app/components/ComposeEmail.tsx`, `app/components/ComposePanel.tsx`, `app/components/RichTextEditor.tsx` | 7 | Compose |
| `app/routes/home.tsx`, `app/routes/settings.tsx`, `app/routes/not-found.tsx`, `app/routes/mailbox-index.tsx`, `app/root.tsx` (ErrorBoundary/HydrateFallback markup only) | 8 | Home, settings, empty/error states |

Tasks 3–8 touch disjoint files and can run in parallel after Tasks 1–2. Task 8 owns only the ErrorBoundary/HydrateFallback JSX in `root.tsx`; Tasks 1–2 own its `<head>`/`<html>`.

---

### Task 1: Theme foundation

**Files:**
- Create: `app/theme-graphite.css`
- Modify: `app/index.css`
- Modify: `app/root.tsx` (add `links` export)

**Interfaces:**
- Produces: utilities `bg-kumo-sidebar`, `bg-kumo-selected`, `bg-kumo-accent-soft`, `border-kumo-accent-line`, `text-kumo-accent`, `shadow-float`; all existing `kumo-*` utilities now render Graphite colors in both modes.

- [ ] **Step 1: Create `app/theme-graphite.css`**

```css
/* Graphite theme: overrides kumo's semantic tokens. Unlayered rules beat kumo's @layer base. */
@theme {
	--font-sans: Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
	--color-kumo-sidebar: #f6f6f7;
	--color-kumo-selected: #eef0ff;
	--color-kumo-accent-soft: #eef0ff;
	--color-kumo-accent-line: #dcdcfb;
	--text-color-kumo-accent: #3e3eb8;
	--shadow-float: 0 8px 24px rgb(0 0 0 / 0.08), 0 2px 6px rgb(0 0 0 / 0.05);
}

:root {
	--text-color-kumo-default: #18181b;
	--text-color-kumo-inverse: #fafafa;
	--text-color-kumo-strong: #3f3f46;
	--text-color-kumo-subtle: #71717a;
	--text-color-kumo-inactive: #a1a1aa;
	--text-color-kumo-brand: #5b5bd6;
	--text-color-kumo-link: #4b4bc4;
	--text-color-kumo-success: #15803d;
	--text-color-kumo-danger: #dc2626;
	--text-color-kumo-warning: #a16207;
	--color-kumo-surface: #ffffff;
	--color-kumo-recessed: #fafafa;
	--color-kumo-base: #ffffff;
	--color-kumo-tint: #f4f4f5;
	--color-kumo-contrast: #0b0b0d;
	--color-kumo-elevated: #ffffff;
	--color-kumo-overlay: #ffffff;
	--color-kumo-control: #ffffff;
	--color-kumo-interact: #d4d4d8;
	--color-kumo-fill: #f1f1f3;
	--color-kumo-fill-hover: #e9e9ec;
	--color-kumo-brand: #5b5bd6;
	--color-kumo-brand-hover: #4b4bc4;
	--color-kumo-line: #e4e4e7;
	--color-kumo-ring: #c7c7f5;
	--color-kumo-tip-shadow: #e4e4e7;
	--color-kumo-tip-stroke: transparent;
	--color-kumo-info: #5b5bd6;
	--color-kumo-info-tint: #e6e7ff;
	--color-kumo-warning: #eab308;
	--color-kumo-warning-tint: #fef3c7;
	--color-kumo-danger: #dc2626;
	--color-kumo-danger-tint: #fee2e2;
	--color-kumo-success: #16a34a;
	--color-kumo-success-tint: #dcfce7;
}

:root[data-mode="dark"] {
	--text-color-kumo-default: #ededef;
	--text-color-kumo-inverse: #0b0b0d;
	--text-color-kumo-strong: #c4c4cc;
	--text-color-kumo-subtle: #8b8b93;
	--text-color-kumo-inactive: #5c5c66;
	--text-color-kumo-brand: #9090f5;
	--text-color-kumo-link: #a5a5ff;
	--text-color-kumo-success: #4ade80;
	--text-color-kumo-danger: #f87171;
	--text-color-kumo-warning: #facc15;
	--color-kumo-surface: #0b0b0d;
	--color-kumo-recessed: #0b0b0d;
	--color-kumo-base: #141417;
	--color-kumo-tint: #1b1b1f;
	--color-kumo-contrast: #fafafa;
	--color-kumo-elevated: #18181c;
	--color-kumo-overlay: #18181c;
	--color-kumo-control: #141417;
	--color-kumo-interact: #3f3f46;
	--color-kumo-fill: #1e1e22;
	--color-kumo-fill-hover: #26262b;
	--color-kumo-brand: #6e6ef0;
	--color-kumo-brand-hover: #7c7cf0;
	--color-kumo-line: #27272c;
	--color-kumo-ring: #3a3a7a;
	--color-kumo-tip-shadow: transparent;
	--color-kumo-tip-stroke: #27272c;
	--color-kumo-info: #7c7cf0;
	--color-kumo-info-tint: #1e1e3a;
	--color-kumo-warning: #ca8a04;
	--color-kumo-warning-tint: #3a2e0a;
	--color-kumo-danger: #ef4444;
	--color-kumo-danger-tint: #3b1414;
	--color-kumo-success: #22c55e;
	--color-kumo-success-tint: #0f2e1a;
	--color-kumo-sidebar: #0e0e10;
	--color-kumo-selected: #1d1d33;
	--color-kumo-accent-soft: #1e1e3a;
	--color-kumo-accent-line: #2e2e5a;
	--text-color-kumo-accent: #c0c0ff;
	--shadow-float: 0 8px 24px rgb(0 0 0 / 0.4), 0 2px 6px rgb(0 0 0 / 0.3);
}

html {
	font-feature-settings: "cv11", "ss01";
	-webkit-font-smoothing: antialiased;
}

* {
	scrollbar-width: thin;
	scrollbar-color: var(--color-kumo-fill-hover) transparent;
}
```

- [ ] **Step 2: Import it in `app/index.css`** — add after line 3 (`@import "tailwindcss";`):

```css
@import "./theme-graphite.css";
```

- [ ] **Step 3: Add font links in `app/root.tsx`** — add above `export function Layout`:

```tsx
export function links() {
	return [
		{ rel: "preconnect", href: "https://fonts.googleapis.com" },
		{ rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
		{ rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" },
	];
}
```

- [ ] **Step 4: Verify** — `npm run typecheck` → exit 0. `npm run build` → succeeds, and `grep -l "kumo-selected" build/client/assets/*.css` prints a file.

---

### Task 2: Dark mode preference and toggle

**Files:**
- Create: `app/lib/theme.ts`
- Create: `app/components/ThemeToggle.tsx`
- Modify: `app/root.tsx` (`<html>` and `<head>`)
- Modify: `app/components/Header.tsx` (add toggle next to settings button only — no other Header changes in this task)

**Interfaces:**
- Produces: `ThemePreference`, `THEME_STORAGE_KEY = "agentic-inbox-theme"`, `readThemePreference()`, `writeThemePreference(p)`, `applyTheme(p)`, `THEME_INIT_SCRIPT` from `~/lib/theme`; default export `ThemeToggle({ className?: string })` from `~/components/ThemeToggle`.

- [ ] **Step 1: Create `app/lib/theme.ts`**

```ts
export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "agentic-inbox-theme";

function isPreference(value: unknown): value is ThemePreference {
	return value === "light" || value === "dark" || value === "system";
}

export function readThemePreference(): ThemePreference {
	try {
		const value = localStorage.getItem(THEME_STORAGE_KEY);
		if (isPreference(value)) return value;
	} catch {}
	return "system";
}

export function writeThemePreference(preference: ThemePreference) {
	try {
		localStorage.setItem(THEME_STORAGE_KEY, preference);
	} catch {}
}

export function applyTheme(preference: ThemePreference) {
	const dark =
		preference === "dark" ||
		(preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
	document.documentElement.setAttribute("data-mode", dark ? "dark" : "light");
}

// Runs in <head> before first paint so dark-mode users never see a light flash.
export const THEME_INIT_SCRIPT = `(function(){var p="system";try{var v=localStorage.getItem("${THEME_STORAGE_KEY}");if(v==="light"||v==="dark"||v==="system")p=v}catch(e){}var d=p==="dark"||(p==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-mode",d?"dark":"light")})();`;
```

- [ ] **Step 2: Create `app/components/ThemeToggle.tsx`**

```tsx
import { Button, Tooltip } from "@cloudflare/kumo";
import { DesktopIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { applyTheme, readThemePreference, writeThemePreference, type ThemePreference } from "~/lib/theme";

const NEXT: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };
const LABELS: Record<ThemePreference, string> = { light: "Light theme", dark: "Dark theme", system: "System theme" };

export default function ThemeToggle({ className }: { className?: string }) {
	// null until mounted, so SSR and the first client render match.
	const [preference, setPreference] = useState<ThemePreference | null>(null);

	useEffect(() => {
		setPreference(readThemePreference());
	}, []);

	useEffect(() => {
		if (!preference) return;
		applyTheme(preference);
		if (preference !== "system") return;
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => applyTheme("system");
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, [preference]);

	const current = preference ?? "system";
	const cycle = () => {
		const next = NEXT[current];
		writeThemePreference(next);
		setPreference(next);
	};
	const icon =
		current === "light" ? <SunIcon size={18} /> : current === "dark" ? <MoonIcon size={18} /> : <DesktopIcon size={18} />;

	return (
		<Tooltip content={LABELS[current]} side="bottom" asChild>
			<Button variant="ghost" shape="square" size="sm" icon={icon} onClick={cycle} aria-label={LABELS[current]} className={className} />
		</Tooltip>
	);
}
```

- [ ] **Step 3: Wire into `app/root.tsx`** — change `<html lang="en">` to `<html lang="en" suppressHydrationWarning>`, add `import { THEME_INIT_SCRIPT } from "~/lib/theme";`, and insert as the first child of `<head>`:

```tsx
<script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
```

- [ ] **Step 4: Add the toggle to `app/components/Header.tsx`** — import `ThemeToggle from "~/components/ThemeToggle"` and render `<ThemeToggle />` immediately before the settings (`GearSixIcon`) button inside the `ml-auto` button group.

- [ ] **Step 5: Verify** — `npm run typecheck` → exit 0.

---

### Task 3: App shell and sidebar

**Files:** Modify `app/routes/mailbox.tsx`, `app/components/Sidebar.tsx`.

- [ ] **Step 1: Shell (`mailbox.tsx`)** — sidebar wrapper gets `bg-kumo-sidebar border-r border-kumo-line`; content column keeps `bg-kumo-base`; mobile backdrop `bg-black/40`; agent column keeps `border-l border-kumo-line bg-kumo-base`.
- [ ] **Step 2: Identity block (`Sidebar.tsx`)** — top block: back link to mailboxes as 12px `text-kumo-subtle hover:text-kumo-default` with caret; then a row with a 32px `rounded-full bg-kumo-accent-soft text-kumo-accent text-xs font-medium` initials avatar (first letters of the display name, fallback first letter of the address), name `text-sm font-medium truncate`, address `text-xs text-kumo-subtle truncate`. Padding `px-3 pt-4 pb-3`.
- [ ] **Step 3: Compose button** — full width, kumo `Button variant="primary"`, `rounded-lg h-9`, pencil icon, inside `px-3 pb-3`.
- [ ] **Step 4: Nav items (`FolderLink`)** — `h-8 px-2.5 rounded-lg text-sm flex items-center gap-2.5`; idle `text-kumo-strong hover:bg-kumo-tint hover:text-kumo-default`; active `bg-kumo-selected text-kumo-default font-medium` with icon `text-kumo-brand`; icons 18px regular weight (active: `weight="fill"` is NOT used — keep regular). Unread count: `ml-auto text-xs tabular-nums px-1.5 min-w-5 h-5 rounded-full bg-kumo-fill text-kumo-strong flex items-center justify-center` (active: `bg-kumo-base`). Replace any existing `Badge` there with this span.
- [ ] **Step 5: Folders section** — section label "Folders" as `text-xs font-medium text-kumo-subtle` (sentence case, no uppercase/tracking), with the add-folder button as a 24px ghost icon button on the right. Custom folder rows reuse `FolderLink` styling.
- [ ] **Step 6: Verify** — `npm run typecheck` → exit 0.

### Task 4: Header, email list, search results

**Files:** Modify `app/components/Header.tsx` (except the ThemeToggle insertion from Task 2, which must be kept), `app/routes/email-list.tsx`, `app/components/MailboxSplitView.tsx`, `app/routes/search-results.tsx`.

- [ ] **Step 1: Header** — `h-14 px-4 gap-3 bg-kumo-base border-b border-kumo-line`; search input wrapper `max-w-xl`, input `h-9 rounded-lg bg-kumo-tint border-transparent focus:bg-kumo-base focus:border-kumo-ring` with a leading 16px `MagnifyingGlassIcon text-kumo-subtle` positioned inside (`pl-9`); keep existing submit/clear behavior. Right-side icon buttons stay ghost `size="sm"`.
- [ ] **Step 2: List header** — folder name `text-[15px] font-medium`, count `text-xs text-kumo-subtle tabular-nums`, refresh ghost icon button; container `h-12 px-4 border-b border-kumo-line`.
- [ ] **Step 3: Rows** — `px-4 py-3 border-b border-kumo-line cursor-pointer transition-colors`; idle `hover:bg-kumo-tint`; selected `bg-kumo-selected`; line 1: sender (`text-sm truncate`, unread `font-medium text-kumo-default`, read `text-kumo-strong`) + thread count pill `text-[11px] tabular-nums px-1.5 rounded-full bg-kumo-fill text-kumo-subtle` + time `ml-auto text-xs text-kumo-subtle tabular-nums`; line 2: subject `text-sm truncate` (unread `font-medium`); line 3: snippet from `getSnippetText` `text-xs text-kumo-subtle truncate` (add if missing, using the row's `snippet` field). Unread dot: `size-1.5 rounded-full bg-kumo-brand` left of the sender. Star and hover actions unchanged functionally; hover action buttons sit on `bg-kumo-base/90 rounded-lg` so they read over text.
- [ ] **Step 4: Footer/pagination and empty state** — footer `h-12 px-4 border-t border-kumo-line text-xs text-kumo-subtle tabular-nums`. `FolderEmptyState`: icon 40px `text-kumo-inactive`, title `text-[15px] font-medium`, body `text-sm text-kumo-subtle`, centered with `gap-2`.
- [ ] **Step 5: `MailboxSplitView` and search results** — list column `bg-kumo-base border-r border-kumo-line`; search result rows use the same row classes as Step 3 and a folder badge `text-[11px] px-1.5 rounded-full bg-kumo-fill text-kumo-subtle`.
- [ ] **Step 6: Verify** — `npm run typecheck` → exit 0.

### Task 5: Reading pane

**Files:** Modify `app/components/EmailPanel.tsx` (markup/classes only — keep all handlers, including the delete/trash logic), `app/components/email-panel/EmailPanelToolbar.tsx`, `EmailPanelHeader.tsx`, `ThreadMessage.tsx`, `SingleMessageView.tsx`, `EmailPanelDialogs.tsx`, `app/components/EmailIframe.tsx`, `app/components/EmailAttachmentList.tsx`.

- [ ] **Step 1: Toolbar** — `h-12 px-3 border-b border-kumo-line bg-kumo-base`; all icon buttons ghost `size="sm"` 18px icons; separate groups (reply group | star/read/move | source/delete/close) with `w-px h-5 bg-kumo-line mx-1`.
- [ ] **Step 2: Header** — subject `text-lg font-medium leading-snug`, message count `text-xs text-kumo-subtle`; padding `px-6 pt-5 pb-3`.
- [ ] **Step 3: Message blocks** — header row: 36px initials avatar `rounded-full bg-kumo-accent-soft text-kumo-accent text-xs font-medium`, sender `text-sm font-medium`, address/recipients `text-xs text-kumo-subtle`, time `text-xs text-kumo-subtle tabular-nums`. Collapsed messages: single quiet row `hover:bg-kumo-tint rounded-lg`. Between messages `border-t border-kumo-line`.
- [ ] **Step 4: Drafts** — replace the yellow/warning left-border treatment with a card: `rounded-xl border border-kumo-accent-line bg-kumo-accent-soft p-4`, a pill `text-[11px] font-medium px-2 py-0.5 rounded-full bg-kumo-base text-kumo-accent` reading "Draft" (keep existing text if it already says "Draft"), actions: Send = `Button variant="primary" size="sm"`, Edit = secondary, Discard = ghost.
- [ ] **Step 5: Email body** — `EmailIframe` wrapper: `rounded-xl bg-white overflow-hidden` with `border border-kumo-line` so HTML mail stays readable in dark mode; plain-text bodies render in `text-sm leading-relaxed text-kumo-default`. Quoted text (if styled in our markup) `text-kumo-subtle border-l-2 border-kumo-line pl-3`.
- [ ] **Step 6: Attachments** — chips `rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 hover:bg-kumo-tint`, filename `text-sm truncate`, size `text-xs text-kumo-subtle tabular-nums`.
- [ ] **Step 7: Dialogs** — keep kumo `Dialog`; inner content padding `p-5`, title `text-base font-medium`.
- [ ] **Step 8: Verify** — `npm run typecheck` → exit 0.

### Task 6: Agent column

**Files:** Modify `app/components/AgentPanel.tsx`, `app/components/AgentSidebar.tsx`, `app/components/MCPPanel.tsx` (markup/classes only).

- [ ] **Step 1: Tabs** — `h-12 px-3 border-b border-kumo-line flex gap-4`; tab `text-sm h-full flex items-center gap-1.5 border-b-2`; active `border-kumo-brand text-kumo-default font-medium`, idle `border-transparent text-kumo-subtle hover:text-kumo-default`.
- [ ] **Step 2: Messages** — user bubble: `ml-auto max-w-[85%] rounded-xl rounded-br-md bg-kumo-selected text-kumo-default text-sm px-3.5 py-2.5` (remove saturated blue bg and white text); agent message: no bubble, `text-sm leading-relaxed text-kumo-default` with a 24px agent avatar `rounded-full bg-kumo-accent-soft text-kumo-accent`; tool calls: `inline-flex items-center gap-1.5 text-xs rounded-full bg-kumo-fill text-kumo-strong px-2.5 py-1`; auto-triggered messages: `text-xs text-kumo-subtle` prefix pill "Auto".
- [ ] **Step 3: Composer** — container `p-3 border-t border-kumo-line`; textarea/input `rounded-xl bg-kumo-tint border border-transparent focus-within:border-kumo-ring focus-within:bg-kumo-base`; send button `Button variant="primary" shape="square" size="sm" rounded-lg`.
- [ ] **Step 4: MCP panel** — sections as `rounded-xl border border-kumo-line bg-kumo-base p-4`, code/URL blocks `rounded-lg bg-kumo-tint font-mono text-xs px-3 py-2`.
- [ ] **Step 5: Verify** — `npm run typecheck` → exit 0.

### Task 7: Compose

**Files:** Modify `app/components/ComposeEmail.tsx`, `app/components/ComposePanel.tsx`, `app/components/RichTextEditor.tsx` (markup/classes only).

- [ ] **Step 1: Container** — panel/dialog `bg-kumo-base`, header `h-12 px-4 border-b border-kumo-line text-sm font-medium`, close ghost button.
- [ ] **Step 2: Fields** — To/Cc/Bcc/Subject rows `px-4 h-11 border-b border-kumo-line flex items-center gap-3`, label `w-14 text-xs text-kumo-subtle`, inputs borderless `bg-transparent text-sm focus:outline-none`.
- [ ] **Step 3: Editor toolbar** — `px-2 h-10 border-b border-kumo-line flex gap-0.5`, buttons ghost 28px `rounded-md`, active `bg-kumo-selected text-kumo-accent`; editor area `px-4 py-3 text-sm leading-relaxed`.
- [ ] **Step 4: Footer** — `px-4 h-14 border-t border-kumo-line flex items-center gap-2`; Send `variant="primary"`, discard ghost with trash icon at right.
- [ ] **Step 5: Verify** — `npm run typecheck` → exit 0.

### Task 8: Home, settings, empty and error states

**Files:** Modify `app/routes/home.tsx`, `app/routes/settings.tsx`, `app/routes/not-found.tsx`, `app/routes/mailbox-index.tsx`, `app/root.tsx` (only `HydrateFallback` and `ErrorBoundary` JSX). Do not touch `<html>`, `<head>`, `links`, or imports Task 1–2 added.

- [ ] **Step 1: Home** — page `min-h-screen bg-kumo-recessed`; top bar `h-14 px-6 flex items-center border-b border-kumo-line bg-kumo-base` with product name "Agentic Inbox" `text-sm font-medium` and `ThemeToggle` (import from `~/components/ThemeToggle`) at right; content `max-w-2xl mx-auto px-6 py-12`; title `text-2xl font-semibold tracking-tight`, subtitle `text-sm text-kumo-subtle`; mailbox list as `rounded-xl border border-kumo-line bg-kumo-base divide-y divide-kumo-line`, each row `px-4 py-3 flex items-center gap-3 hover:bg-kumo-tint` with 36px initials avatar (`bg-kumo-accent-soft text-kumo-accent`); create-mailbox form inside a `rounded-xl border border-kumo-line bg-kumo-base p-5` card; primary action `variant="primary"`.
- [ ] **Step 2: Settings** — `max-w-2xl mx-auto px-6 py-8 space-y-6`; each group a `rounded-xl border border-kumo-line bg-kumo-base p-5` card with `text-sm font-medium` title and `text-xs text-kumo-subtle` description.
- [ ] **Step 3: Empty/loading/error** — consistent: icon 40px `text-kumo-inactive`, title `text-[15px] font-medium`, body `text-sm text-kumo-subtle`, centered with `gap-2`. Apply to `not-found.tsx`, `mailbox-index.tsx`, and `root.tsx` ErrorBoundary/HydrateFallback. (`FolderEmptyState` in `email-list.tsx` is handled in Task 4 Step 4.)
- [ ] **Step 4: Verify** — `npm run typecheck` → exit 0.

### Task 9: Visual QA (light and dark, desktop and mobile)

**Files:** any of the above, for fixes only.

- [ ] **Step 1: Run locally** — `npm run dev` (Access JWT check is skipped in dev). Open the printed local URL.
- [ ] **Step 2: Seed data** — create mailbox `hello@juliusyolo.com` in the UI. Inject at most 4 inbound emails through the local email handler if supported: `curl -X POST "http://localhost:<port>/cdn-cgi/handler/email?from=alex@example.com&to=hello@juliusyolo.com" --data-binary @/path/to/message.eml` (raw RFC 822 message with From/To/Subject/Date/Message-ID headers; include one multi-message thread via In-Reply-To). Each inbound email triggers one paid Workers AI auto-draft; do not exceed 4. NEVER click Send or call any send/reply API (outbound mail is real). If the handler endpoint is unavailable, seed drafts via the UI compose "save draft" path instead.
- [ ] **Step 3: Screenshot matrix** — home, mailbox list with a selected thread, thread with a draft, compose open, agent panel, settings, empty Trash — each in light and dark (toggle via the header button), at 1440×900; plus list and reading pane at 390×844.
- [ ] **Step 4: Fix** — contrast problems, leftover saturated blue/yellow, misaligned paddings, invisible borders in dark mode, text using raw palette colors. Re-run `npm run typecheck`.

### Task 10: Ship

- [ ] **Step 1:** `npm run deploy`; then `curl -s -o /dev/null -w "%{http_code}" https://mail.juliusyolo.com/` → `302`.
- [ ] **Step 2:** Commit all redesign files with message "Graphite UI redesign: theme tokens, dark mode, screen polish".
