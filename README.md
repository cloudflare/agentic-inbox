<div align="center">
  <h1>Dumb Inbox</h1>
  <p><em>A self-hosted email client on Cloudflare Workers with explicit opt-in AI drafts.</em></p>
</div>

Dumb Inbox lets you send, receive, search, and organize email through a modern web interface powered by your own Cloudflare account. Incoming email arrives through [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), each mailbox is isolated in a SQLite-backed [Durable Object](https://developers.cloudflare.com/durable-objects/), and attachments are stored in [R2](https://developers.cloudflare.com/r2/).

![Dumb Inbox screenshot](./demo_app.png)

## Features

- **Full email client** - Send and receive email with a rich text composer, reply/forward threading, folders, search, and attachments.
- **Plain receive path** - Inbound mail is parsed with PostalMime, stored in the mailbox Durable Object, and never forwarded to a model.
- **Permission hierarchy** - Cloudflare Access users register their email, admins approve them, and mailbox roles control read/respond/manage access.
- **Response templates** - Mailbox managers can save reusable response templates for responders.
- **Explicit AI drafts** - AI can draft an editable reply only after a permitted user clicks the AI draft action for a specific message.
- **Per-mailbox isolation** - Each mailbox runs in its own Durable Object with SQLite storage and R2 attachment blobs.
- **Cloudflare Access auth** - Production requests require Cloudflare Access JWT validation.

## Stack

- **Frontend:** React 19, React Router v7, Tailwind CSS, Zustand, TipTap, `@cloudflare/kumo`
- **Backend:** Hono, Cloudflare Workers, D1, Durable Objects (SQLite), R2, Email Routing, Email Service, Workers AI
- **Auth:** Cloudflare Access JWT validation plus D1-backed app users and mailbox memberships

## Getting Started

```bash
bun install
bun run dev
```

## Configuration

1. Set your domain in `wrangler.jsonc`.
2. Create an R2 bucket named `dumb-inbox`:

```bash
wrangler r2 bucket create dumb-inbox
```

3. Create a D1 database and replace the `APP_DB` `database_id` in `wrangler.jsonc`:

```bash
bunx wrangler d1 create dumb-inbox-app
bunx wrangler d1 migrations apply dumb-inbox-app --local
```

4. Configure `POLICY_AUD` and `TEAM_DOMAIN` as Worker secrets for production Cloudflare Access.
5. Seed at least one manual global admin by copying `DOCS/seed-admin.example.sql` to `DOCS/seed-admin.sql`, replacing the email, and running:

```bash
bunx wrangler d1 execute dumb-inbox-app --local --file DOCS/seed-admin.sql
```

6. Enable Email Routing for your domain and route inbound mail to this Worker.
7. Enable Cloudflare Email Service for outbound mail through the `send_email` binding.
8. Workers AI is bound as `AI`; override `AI_DEFAULT_MODEL` if needed.

## Deploy

```bash
bun run deploy
```

## Prerequisites

- Cloudflare account with a domain
- [Email Routing](https://developers.cloudflare.com/email-routing/) enabled for receiving
- [Email Service](https://developers.cloudflare.com/email-service/) enabled for sending
- D1 database bound as `APP_DB`
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) configured for deployed/shared environments
- Workers AI available for explicit draft generation

Cloudflare Access is the login boundary, but app authorization is stored in D1. Access-approved users must register their email, a seeded global admin must activate them, and mailbox access is granted per mailbox as `manager`, `responder`, or `viewer`.

## Architecture

```text
Inbound mail
  Cloudflare Email Routing
    -> Worker email handler
    -> PostalMime parse
    -> MailboxDO SQLite rows
    -> R2 attachment blobs

Web app
  Browser React UI
    -> Hono API routes
    -> D1 app metadata (users, mailboxes, memberships, templates, AI settings)
    -> MailboxDO
    -> R2 attachments

Explicit AI draft
  Composer action
    -> Hono permission checks
    -> MailboxDO message read
    -> Workers AI
    -> Editable draft body returned to browser

Outbound mail
  Composer / reply / forward
    -> Hono API routes
    -> MailboxDO sent rows
    -> Cloudflare Email Service
```

## License

Apache 2.0 -- see [LICENSE](LICENSE).
