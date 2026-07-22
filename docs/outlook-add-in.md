# Outlook add-in deployment

The add-in is a thin Office.js task pane. The Cloudflare Worker remains the
application/API host; Microsoft Graph is the source of truth for connected
Outlook data and the Durable Object stores the local cache and action state.

## Microsoft Entra app

Create an app registration for the self-hosted deployment and add the exact
redirect URL:

```text
https://YOUR_WORKER_HOST/auth/microsoft/callback
```

Use delegated permissions only for the initial deployment:

- `openid`, `profile`, `email`, `offline_access`
- `User.Read`
- `Mail.ReadWrite`
- `Calendars.ReadWrite`
- `Contacts.ReadWrite`
- `Tasks.ReadWrite`

Set `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`,
`MICROSOFT_REDIRECT_URI`, `APP_ORIGIN`, and `TOKEN_ENCRYPTION_KEY` as Worker
secrets or environment values. Never commit the client secret or encryption
key.

## Cloudflare deployment

```bash
npm run typecheck
npm run build
npm run deploy
```

The current slice uses the mailbox Durable Object for productivity state and
renews Graph subscriptions with Durable Object alarms. The API exposes:

- `POST /api/v1/mailboxes/:mailboxId/sync` for inbox synchronization
- `GET /api/v1/mailboxes/:mailboxId/productivity` for events, contacts, and tasks
- `POST /api/v1/mailboxes/:mailboxId/productivity/events` to create calendar events
- `POST /api/v1/mailboxes/:mailboxId/productivity/tasks` to create To Do tasks
- `POST /api/v1/mailboxes/:mailboxId/subscriptions` to create Graph webhooks

Queue-based large backfills and periodic reconciliation remain suitable next
operations work once the deployment needs to process more than the bounded
interactive sync window. The included `SYNC_QUEUE` consumer now handles
manual sync jobs with retries; create the queue before deploying:

Ensure the `email-agent-queue` queue exists before deploying (it is the queue
configured by `wrangler.jsonc`); create it only if it is absent:

```bash
wrangler queues create email-agent-queue
```

OAuth access tokens are refreshed and rotated automatically from the encrypted
refresh token. If Microsoft revokes consent, the account is marked for
reauthentication by the failing API request.

## Outlook sideloading

Use the manifest in `add-in/manifest.xml` and set its task-pane URL to the
deployed `/addin/taskpane.html`. Sideload it in Outlook on the web, open a
message, and launch the add-in. The pane can open the full Briefing workspace
or connect the current mailbox through the Microsoft OAuth flow.

For production distribution, host the manifest and static assets on the same
HTTPS Worker origin and validate the supported Outlook requirement sets before
publishing to AppSource.
