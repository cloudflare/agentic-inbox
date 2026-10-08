# UI redesign: Graphite (visual refresh)

Date: 2026-10-09 · Status: approved by user (direction A "石墨靛蓝", scope "visual refresh only", dark mode "follow system + manual toggle")

## Goal

Make the web UI look premium and modern ("精致极简", Linear-like) without changing features, routes, data flow, or the four-column layout (sidebar · list · reading pane · agent panel).

## Non-goals

- No new features, no keyboard shortcuts or command palette, no API or worker changes.
- No layout restructuring (column order, widths, and responsive breakpoints stay as they are; small spacing changes are fine).
- No restyling of email HTML content rendered inside `EmailIframe` (third-party markup keeps its own styles).

## 1. Theme foundation

Implemented as a kumo theme override, the same mechanism kumo's own `theme-fedramp.css` uses.

- New file `app/theme-graphite.css`, imported in `app/index.css` after the kumo and Tailwind imports. It redefines kumo's semantic tokens (`--color-kumo-*`, `--text-color-kumo-*`) with `light-dark()` values. Components keep using `bg-kumo-*`, `text-kumo-*`, `border-kumo-*`; no component changes are needed for colors to switch. The few new tokens below are declared in an `@theme` block in the same file so Tailwind v4 generates their utilities.
- Dark mode uses kumo's existing mechanism: `data-mode="dark"` on `<html>` sets `color-scheme: dark`, which flips every `light-dark()` token.

Palette:

| Role | Light | Dark | kumo tokens |
|---|---|---|---|
| Page canvas | `#FAFAFA` | `#0B0B0D` | `recessed` |
| Sidebar | `#F6F6F7` | `#0E0E10` | new token `kumo-sidebar` (utility `bg-kumo-sidebar`) |
| Panel | `#FFFFFF` | `#141417` | `base`, `elevated`, `surface` |
| Hairline | `#E4E4E7` | `#27272C` | `line` |
| Hover fill | `#F4F4F5` | `#1B1B1F` | `tint`, `fill-hover` |
| Fill (chips, badges) | `#F1F1F3` | `#1E1E22` | `fill`, `control` |
| Text | `#18181B` | `#EDEDEF` | `text default` |
| Strong secondary text | `#3F3F46` | `#C4C4CC` | `text strong` |
| Secondary text | `#71717A` | `#8B8B93` | `text subtle` |
| Inactive text | `#A1A1AA` | `#5C5C66` | `text inactive` |
| Accent | `#5B5BD6` | `#7C7CF0` | `brand`, `interact`, `ring`, text `brand`, `link` |
| Accent hover | `#4B4BC4` | `#9090F5` | `brand-hover` |
| Selected bg | `#EEF0FF` | `#1D1D33` | new token `kumo-selected` (utility `bg-kumo-selected`), used where the code marks a selected row or nav item |
| Accent soft (avatars, draft cards) | `#EEF0FF` / border `#DCDCFB` | `#1E1E3A` / border `#2E2E5A` | new tokens `kumo-accent-soft`, `kumo-accent-line`; text on it uses new `text-kumo-accent` (`#3E3EB8` / `#C0C0FF`) |
| Danger / warning / success / info | kumo defaults, desaturated slightly to sit with the neutrals | same | `danger`, `warning`, `success`, `info` (+ `-tint`) |

Typography: Inter (400, 500) from Google Fonts via `links()` in `app/root.tsx`, with `preconnect`. Stack: `Inter, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif`. Times and counts use `tabular-nums`. Only weights 400 and 500 (600 allowed for the mailbox/page title only).

Shape: controls 8px radius, cards and panels 12px. Shadows only on floating layers (menus, dialogs, tooltips, toasts): `0 8px 24px rgb(0 0 0 / 0.08), 0 2px 6px rgb(0 0 0 / 0.05)` light, stronger alpha in dark. Everything else is separated by surface tone and hairlines.

## 2. Dark mode

- Preference values: `light`, `dark`, `system` (default). Stored in `localStorage` key `agentic-inbox-theme`.
- An inline script in `<head>` (before CSS paints) reads the preference and sets `data-mode` on `<html>`, so there is no white flash. `<html>` gets `suppressHydrationWarning`.
- `system` follows `prefers-color-scheme` and updates live when the OS setting changes.
- `ThemeToggle` component (new, `app/components/ThemeToggle.tsx`): an icon button in the header that cycles light → dark → system, with a tooltip naming the current mode. Also shown on the home page header.
- Storage access is wrapped in try/catch; failure falls back to `system`.

## 3. Screens

1. App shell (`mailbox.tsx`): canvas `recessed`; sidebar, content, and agent column separated by hairlines; content column on `base`.
2. Sidebar: identity block (initials avatar in accent-soft, name, address in secondary text); full-width accent Compose button; nav items 32px tall, 8px radius, selected = selected bg + default text + accent icon; counts as small tabular pills; section label 11px secondary text; spacing on a 4px grid.
3. Header: search field 36px, 8px radius, filled background, leading search icon, clear button; ghost icon buttons (agent toggle, settings, theme toggle) 32px.
4. Email list: header (folder name 15px/500, conversation count secondary, refresh ghost button); rows with sender + time on line 1, subject on line 2, snippet on line 3 in secondary text; unread = accent dot + 500 weight sender and subject; selected = selected bg; hover = hover fill; thread count as a small fill pill; hover actions unchanged; pagination footer quieter.
5. Reading pane: toolbar of 32px ghost icon buttons in groups; subject 18px/500; message header with initials avatar (accent-soft), sender 500, meta secondary; collapsed messages as quiet rows; quoted text secondary with a hairline left rule; drafts (including AI drafts) as an accent-soft card with an "AI draft"/"Draft" pill instead of the yellow left border; email iframe sits on a white rounded surface in both modes so HTML mail stays readable in dark mode.
6. Agent panel: tabs as underline tabs with accent indicator; user messages as selected-bg bubbles with default text (no saturated blue); agent messages plain; tool calls as quiet fill chips; input 12px radius with accent send button.
7. Compose: hairline-separated fields, ghost editor toolbar, accent Send, secondary Discard.
8. Home (mailbox picker) and settings: centered 640px column, mailbox rows as cards with initials avatar, primary action accent; settings grouped in cards with section titles.
9. Empty, loading, and error states: consistent icon size (40px, inactive text), title 15px/500, one line of secondary text.

## 4. Verification

- `npm run typecheck` passes.
- Local `npm run dev` (Access is skipped in dev). Seed a mailbox and a few inbound emails locally (via the local email handler endpoint if available, else via UI drafts), then screenshot every screen above in light and dark at 1440×900 and 390×844, and fix visual defects before deploying.
- Deploy, confirm `https://mail.juliusyolo.com` still returns the Access redirect, commit.
