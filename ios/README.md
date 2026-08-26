# Inboxies — iOS

Native SwiftUI client for the Cloudflare [Agentic Inbox](../../README.md) backend.

Designed for people coming from **web / Ionic / Capacitor**: SwiftUI views ≈ React components, `@Observable` stores ≈ Zustand/context, `async/await` + `URLSession` ≈ `fetch`.

## What’s included

### Phase 1 (MVP)
- **Sign in with Apple** → backend exchanges the Apple identity token for a mobile session JWT (`Authorization: Bearer …`)
- **Dev login** (DEBUG builds only) against `/api/v1/auth/dev` while running the Worker locally
- **Notion-inspired shell**: top folder pills (Inbox / Sent / Drafts / Archive / Trash / AI), floating Search + Ask AI bar
- **Email list + detail**, styled like Notion search rows
- **Search screen** with highlighted snippets
- **Multi-conversation AI chat** via WebSocket `/agents/email-agent/{mailbox}::{conversationId}`

### Phase 2
- **Mail-like compose interactions** (Notion look): drag grabber to **minimize** to a bottom dock (not dismiss); tap dock to expand
- **New / Reply / Reply All / Forward / Edit Draft** with save draft + send
- **HTML body rendering** (`WKWebView`) and **attachment download** (Quick Look)
- Compose chrome uses `AppTheme` (not Apple Mail blue branding)

### Phase 3 (not yet)
- Push notifications
- Outbound attachment upload from Photos/Files
- Rich-text Format toolbar

## Open in Xcode (Mac required)

1. Install Xcode 15+ (iOS 17 SDK).
2. Open `Inboxies.xcodeproj`.
3. Set your **Team** under Signing & Capabilities.
4. Confirm bundle ID `co.inboxies.app` (or change it — then update Worker secret `APPLE_CLIENT_ID` to match).
5. Capability **Sign in with Apple** is declared in `Inboxies.entitlements`.
6. On the sign-in screen, set **API base URL** to your Worker (simulator → `http://127.0.0.1:5173` when `pnpm dev` is running on the Mac).

### Optional: XcodeGen

If you prefer regenerating the project from `project.yml`:

```bash
brew install xcodegen
cd ios/AgenticInbox
xcodegen generate
open Inboxies.xcodeproj
```

## Backend secrets for mobile

In Cloudflare Worker secrets (and `.dev.vars` locally):

| Secret | Purpose |
|--------|---------|
| `APPLE_CLIENT_ID` | iOS bundle ID (Apple token `aud`) |
| `MOBILE_JWT_SECRET` | HS256 secret for mobile session JWTs (you generate this — not from Apple) |

Web continues to use Cloudflare Access (`POLICY_AUD` / `TEAM_DOMAIN`). Production accepts **either** Access JWT **or** mobile Bearer token.

## Mental model (web → native)

| Web / Ionic | iOS |
|-------------|-----|
| React route | SwiftUI `View` |
| Zustand store | `@Observable` class + `.environment` |
| `fetch` / React Query | `APIClient` + `.task { await … }` |
| `useComposeForm` | `ComposeFormModel` + `ComposeSession` |
| Agents SDK `useAgentChat` | `AgentChatClient` (WebSocket `cf_agent_*`) |
| Capacitor Preferences | Keychain (`KeychainStore`) |

## Folder map

```
Inboxies/
  InboxiesApp.swift          # @main
  Config/AppConfig.swift     # API base URL, bundle ID
  Models/                    # Codable types matching backend JSON
  Services/                  # API, auth, app state, compose, agent WS
  Views/                     # Auth, Home, Email, Compose, Search, Chat
  Theme/                     # Notion-like light palette
```
