<div align="center">
  <h1>Dumb Inbox</h1>
  <p><em>A self-hosted email client on Cloudflare Workers. No model reads mail.</em></p>
</div>

Dumb Inbox lets you send, receive, search, and organize email through a modern web interface powered by your own Cloudflare account. Incoming email arrives through [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), each mailbox is isolated in a SQLite-backed [Durable Object](https://developers.cloudflare.com/durable-objects/), and attachments are stored in [R2](https://developers.cloudflare.com/r2/).

![Dumb Inbox screenshot](./demo_app.png)

## Features

- **Full email client** - Send and receive email with a rich text composer, reply/forward threading, folders, search, and attachments.
- **Plain receive path** - Inbound mail is parsed with PostalMime, stored in the mailbox Durable Object, and never forwarded to a model.
- **Per-mailbox isolation** - Each mailbox runs in its own Durable Object with SQLite storage and R2 attachment blobs.
- **Cloudflare Access auth** - Production requests require Cloudflare Access JWT validation.

## Stack

- **Frontend:** React 19, React Router v7, Tailwind CSS, Zustand, TipTap, `@cloudflare/kumo`
- **Backend:** Hono, Cloudflare Workers, Durable Objects (SQLite), R2, Email Routing, Email Service
- **Auth:** Cloudflare Access JWT validation outside local development

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

3. Configure `POLICY_AUD` and `TEAM_DOMAIN` as Worker secrets for production Cloudflare Access.
4. Enable Email Routing for your domain and route inbound mail to this Worker.
5. Enable Cloudflare Email Service for outbound mail through the `send_email` binding.

## Deploy

```bash
bun run deploy
```

## Prerequisites

- Cloudflare account with a domain
- [Email Routing](https://developers.cloudflare.com/email-routing/) enabled for receiving
- [Email Service](https://developers.cloudflare.com/email-service/) enabled for sending
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) configured for deployed/shared environments

Any user who passes the shared Cloudflare Access policy can access all mailboxes in this app by design. There is no per-mailbox authorization; the Cloudflare Access policy is the single trust boundary.

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
    -> MailboxDO
    -> R2 attachments

Outbound mail
  Composer / reply / forward
    -> Hono API routes
    -> MailboxDO sent rows
    -> Cloudflare Email Service
```

## License

Apache 2.0 -- see [LICENSE](LICENSE).
