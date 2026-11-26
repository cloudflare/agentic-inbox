# RealAdvisor inbox

A Postgres-backed fork of [Cloudflare Agentic Inbox](https://github.com/cloudflare/agentic-inbox), based on commit `48039bb6785af34e592c2966f87cde2b255c4c80`.
The upstream React inbox UI and shared helpers retain their Apache-2.0 copyright notices and [license](./LICENSE). The backend, migrations, fixtures, and local runners are new.

This is an intentionally standalone pnpm workspace with its own lockfile: the upstream React 19 application does not inherit the monorepo's React 18 overrides. This repository is the RealAdvisor fork of Cloudflare Agentic Inbox. Clone it beside the RealAdvisor monorepo and run all commands from this repository. It has its own commits, pull requests, dependencies, and deployment pipeline.

## Scope

- Postgres stores mailboxes, messages, folder state, drafts, thread identifiers and attachment metadata.
- Privacy and Info are separate logical mailboxes in one database. Live mailboxes use `ingest.realadvisor.com`; local seed mailboxes remain synthetic.
- The UI supports browsing, search operators, reading, starring, folders, composing, drafts, replies and manual conversation tags.
- Local **Simulate send** stores a simulated message. Hosted live mode sends through Cloudflare Email Sending using approved public From addresses. The app contains no SMTP or Google credentials.
- Attachment bytes live outside Postgres: `.local/attachments` locally and a private R2 bucket on Cloudflare. Live raw MIME is retained privately in R2.
- Probo, historical imports, and the upstream MCP server are not connected. The hosted inbox uses Cloudflare Workers, Hyperdrive, Neon Postgres, and private R2 attachments.

## Sender identities

Settings → Senders creates, edits and removes sender identities and selects the workspace default. The composer From dropdown can
select another sender independently of the current mailbox, including All.
Migration 042 registers existing mailbox identities (excluding the All collector),
backfills saved drafts, and selects `info@realadvisor.com` as the initial default
when that mailbox exists. Privacy uses `privacy@realadvisor.com`. Fresh local seed
and live mailbox setup also initialize Info without replacing an existing default.
Migration 043 adds sender names and archival. Run `pnpm db:migrate` before deploying code that uses these settings.

The UI, API and agent drafts use the same precedence: explicit identity, saved
draft identity, matching reply recipients, then the default. When no default has
yet been configured, a mailbox's own identity is used. Multiple matching identities
require an explicit choice; unavailable identities never silently fall back.
Replies remain in the original mailbox and conversation. Sender changes update the
signature in the composer and are included in draft conflict detection.

`GET /api/v1/sender-identities` lists sender IDs and the default.
`POST /api/v1/sender-identities` creates a sender with `name`, `email`, and `mailbox_id`;
`PUT /api/v1/sender-identities/:id` edits those fields and `DELETE` removes it.
Removal preserves messages and requires replacing the default first.

Settings → API keys selects the sender identities of each key and its default. A key
can always use the senders of its mailboxes; other senders are granted individually,
at creation or later with Senders on an active key (`PATCH /api/v1/api-keys/:id` with
`sender_identity_ids` and `default_sender_identity_id`). A key's default replaces the
workspace default for that key. Migration 047 adds both settings.

Replies with unmatched recipients use the workspace default, initially Info, even inside another mailbox.
`PATCH /api/v1/inbox-settings` accepts `default_sender_identity_id`.
Draft, send, reply and forward requests accept `sender_identity_id`; send requests
can also supply `draft_id` to retain its sender. Responses report the selected
identity. See the bundled API reference for request schemas.

Senders and the default can be changed by administrators or keys with `senders:manage`.
API keys can select only identities in their allowed mailboxes, in addition to
having access to the conversation mailbox. Live sending still validates the
registered ingest mailbox and its public address; arbitrary From addresses are
not accepted. A send retry retains the identity of the original accepted request,
even if the default changes. Local sending remains simulated.

## Draft intent

Migration 044 adds `draft_mode` (`new`, `reply`, `reply-all`, `forward`) and
`draft_source_id`, an internal source email ID distinct from RFC `in_reply_to`.
The inbox and agent save this intent; editing, reopening and direct sending retain
it and the selected sender. Replies use the source's RFC Message-ID and references;
forwards stay in the source conversation internally without reply headers. New
forwards keep a sanitized copy of the original HTML document outside the editable
note, with an isolated preview. Saving and reopening a draft preserves that boundary
and its formatting; direct draft sending uses the same complete HTML. Existing
plain-text forward drafts remain unchanged. Saved intent is immutable; compose a new draft to change its mode or source. A deleted source prevents sending
an explicit reply/forward rather than silently changing its intent.

Existing drafts have unknown mode: historical replies and forwards cannot be
reliably distinguished. Migration preserves any matching same-mailbox UUID source
as context without guessing from the subject or changing old headers. These drafts
reopen/send as new messages without reply headers; compose a fresh reply if threading
is needed. Older clients may still submit the deprecated `in_reply_to` source alias,
but alias-only new drafts keep unknown legacy intent. Old tabs' ambiguous or
mismatched send requests return 422 before delivery, with guidance to keep unsaved
text, reload and reopen. Reopened legacy drafts show a notice that sending starts a
new conversation; the refreshed client explicitly confirms `draft_mode: "new"` in
the send request. Explicit reply/forward intent requires a fresh composition.
Pre-upgrade stale saves reject without changing stored contents or clearing the
tab's text; retain unsaved text before reloading the draft. Nullable
columns keep older application writes compatible during rollout. Existing version
tokens become stale once after upgrade; reload a draft before editing it.

## Composer AI assistance

The composer offers Quick Draft, an Advanced prompt/model dialog, and Improve / Shorten / Formal actions through
Vercel AI SDK `generateText`. It reuses the agent's model catalog, mailbox model
and writing instructions, and server-side provider credentials. The model picker
can override the model for the current composer without changing mailbox settings.
Composer model choices use Vercel AI Gateway when configured via `AI_GATEWAY_API_KEY`, including in the Worker. The agent retains its existing provider setup.
Generation returns an editable suggestion without saving or sending an email.
Existing text, including edits made during generation, is retained until the user
chooses Use suggestion. Draft saving and sending remain manual.

## Re-evaluate saved classification answers

Changing decision thresholds preserves existing classifications; prompt, option and other semantic changes still invalidate them. After saving rules, reopen the tag/group editor and use **Preview saved rules**, then **Apply to pending reviews**. This evaluates saved provider answers across all mailboxes in bounded pages, without new Jev calls. Counts represent classifier/group decisions rather than tag rows. Human decisions, manual overrides, accepted results, changed conversations, technical failures, missing answers and insufficient-evidence choices stay unchanged. Each page is atomic; stopping or closing the editor leaves completed pages applied. The API is `POST /api/v1/classification/reapply-rules`, restricted to admins and documented in OpenAPI.

## Typesafe credit pauses

A Typesafe HTTP 402 pauses Jev across all mailboxes, live classification,
historical runs and interactive classifier tests. Pending work stays saved;
parked deliveries do not consume processing retries. The dispatcher stops
publishing classification work until an administrator resumes it.

Settings → Runs shows **Paused — Typesafe credits exhausted**. After adding
credits, **Resume processing** sends one small synthetic Jev request. Only a
valid successful response clears the pause; payment errors, network failures
and invalid responses leave it paused. Concurrent clicks share a probe lease;
an interrupted check can be retried after 60 seconds. Requests already in
flight may finish. A later payment error takes precedence over a successful
probe. Rate limits and transient server errors retain automatic backoff.

Monitoring reads `GET /api/v1/classification/health` with any API key. It
returns only `paused`, `paused_at`, `resume_error` and `last_classified_at`
(when the newest successful Jev request finished): no mail content or
addresses.

Migration 035 adds the shared pause state and excluded credit-attempt counter.
The migration does not pause work or retry past terminal failures automatically.

## Draft cleanup after sending

Accepted delivery and draft deletion are separate operations. If deletion fails,
**Message submitted** remains successful; reopen the leftover draft and use
**Retry draft cleanup**. This retries deletion only. A missing draft (404), including
a deletion whose response was lost, counts as completed cleanup. Accepted drafts
cannot be sent or saved again from either composer or the draft panel.

Cleanup receipts contain only mailbox/draft identifiers and accepted/cleaned state
in this browser profile's local storage. They survive refresh, reopening and other
same-origin tabs, including stale panels after deletion. They are not server locks:
other devices/users, cleared storage, storage failures after acceptance, and
simultaneous sends in separate tabs before acceptance are outside this guard.
There is no automatic expiry, because an old open panel must not resend a draft.

Unconfirmed responses preserve draft text and never trigger deletion or automatic
resending. Safe explicit recovery uses the send-intent journal and the existing
`sendScope` for each composition or draft. That journal owns the original idempotency key and
exact request payload; cleanup receipts do not replace it or block its explicit
uncertain-send retry. This change adds no server API or database migration.

## One-click email translation

Delivered messages offer **Translate** and **Show original**, including individual
messages in a conversation. The target defaults to the first supported browser language
(English fallback); the language selector remembers your choice on that browser. Translation
runs only on request through the mailbox's configured AI model and server-side provider.
Only text-node segments are sent to the model. Larger or heavily fragmented messages
use up to three parallel batches with bounded neighboring context; short messages use
one request. Boundary whitespace is restored locally. Batches share a 25-second deadline
and are cancelled together on failure; only complete translations are displayed. Validated translations replace those source
spans in the original HTML and use the same sanitized, sandboxed email renderer. Styles,
tables, images and link destinations are preserved; translated text can naturally change
line wrapping and height. Original stored content, attachments and reply content remain unchanged. Results are cached in browser memory per message/body/language for up to
30 minutes after leaving the message, not persisted as emails or in browser storage. Only the language
preference is stored. Refreshing the page clears translation results.

The authenticated inbox endpoint is `POST /api/v1/mailboxes/:mailboxId/emails/:emailId/translation`
with `{ "targetLanguage": "fr" }`; integration API keys cannot invoke it. It rejects drafts,
empty text, oversized content (200,000 HTML / 16,000 extracted characters / 500 text segments), and incomplete
model output instead of silently returning a partial translation. Failed requests leave
the original readable and offer an explicit retry. Loading has a cancel action. No external images or attachments are
sent to the model, and mailbox writing instructions do not influence translation.

Inline reply, expanded/modal compose, and direct draft sending share the same
recipient/sender initialization and send operation (`useComposerSend`). The
operation delegates uncertain retries to the existing send-intent journal and
accepted/cleaned draft receipts to the existing delivery ledger. It never creates
a replacement send key or retries delivery during draft cleanup. Saved draft mode,
source reference, and edit version remain explicit; missing reply/forward sources
and unavailable senders must be resolved before sending. AI suggestions and
translation do not replace the original reply/forward source content.

## Recipient suggestions

To, Cc and Bcc search a mailbox-scoped contact index after two characters.
Migration 025 backfills addresses from received senders and confirmed outgoing
recipients. A database trigger maintains the index on delivery, including local
simulated sends; drafts and unconfirmed sends do not count. New inbound MIME
supplies display names (older stored messages contain addresses only).
Suggestions use indexed name/address prefixes. Current-mailbox contacts rank first,
followed by contacts from the registered All mailbox, with duplicates removed.
Within each source, exact addresses, sent frequency and recency determine order.
Already-selected recipients and automated senders are excluded. Access is currently
application-wide; shared sources must follow the same permissions if mailbox-level
access controls are introduced. No additional backfill is needed for shared lookup.

### Google Workspace people directory

Interactive To/Cc/Bcc autocomplete can also search Google Workspace people using
[People API directory search](https://developers.google.com/people/api/rest/v1/people/searchDirectoryPeople).
Groups and shared external contacts are not queried. The integration requests only
names and email addresses and suggests each person's primary address. Exact email
matches rank first, followed by up to three existing contacts, directory matches,
and remaining contacts, with at most five unique results. Selected addresses and
the current mailbox are excluded. Integration API keys and agent contact tools
continue to use mailbox contacts only.

Enable the People API in the service account's Google Cloud project. A Workspace
administrator must authorize that service account's numeric OAuth client ID for
[domain-wide delegation](https://developers.google.com/identity/protocols/oauth2/service-account#delegatingauthority)
with only `https://www.googleapis.com/auth/directory.readonly`. Use a dedicated
Workspace user with access to the directory as the delegated subject. Every inbox
user sees the people visible to this account, so choose its directory visibility
accordingly. Personal contacts and Google Groups are not requested.

Set these Worker secrets (and optionally local `.env` values):

- `GOOGLE_DIRECTORY_SERVICE_ACCOUNT`: service account email.
- `GOOGLE_DIRECTORY_PRIVATE_KEY`: PEM private key; literal `\n` escapes are accepted.
- `GOOGLE_DIRECTORY_USER`: delegated Workspace user's email.

Use `pnpm exec wrangler secret put NAME` to enter each value securely. Never commit
credentials. All three settings are needed to enable directory lookup. No database
migration is required. Requests have a 1.5-second network budget; a failed lookup
falls back to contacts with a 30-second backoff. Tokens are cached until shortly
before expiry and up to 128 query results are cached in Worker memory for one
minute. Names, queries, credentials, and tokens are never logged or stored in the
contact index. Verify a colleague who has no mailbox history appears in To/Cc/Bcc
before considering the integration activated.

## Conversation status

Conversations have an Open or Done status, independent of tags and classification.
Inbox defaults to Open; Open, Done, and All filters work alongside tag filters
and Needs review. The conversation panel offers Mark done and Reopen, with the
latest 50 status transitions behind the information icon next to the status.

Migration 018 adds workflow state; migration 019 moves previous Waiting
conversations to Open, preserving their history. Waiting and scheduled reopening
are disabled. New received messages reopen Done conversations; duplicate ingestion,
drafts, and outgoing messages do not. Status writes require the current revision
and record the authenticated actor in live mode. Stale actions are rejected.
Classification and email-agent execution remain independent of completion.

Run `pnpm db:migrate` before deploying this version. No live data is changed by
building or testing. For a separate built local preview, use
`PORT=4392 PUBLIC_ORIGIN=http://127.0.0.1:4392 pnpm start`.

## Run locally

Requires Node 22, pnpm 10, and either Docker or native PostgreSQL 17 (`pg_config` on PATH, or `PG_BIN` set to its binary directory).

```sh
cd agentic-inbox
pnpm install --frozen-lockfile
pnpm setup:local

# Choose one database runner:
docker compose up -d --wait
# Or, without Docker:
pnpm db:local

pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open <http://127.0.0.1:4310>. The API listens on port 4311, and Postgres on port 55439. Both app servers and the database bind only to loopback.

`setup:local` generates credentials in gitignored `.env` and preserves an existing file. The native runner creates its own cluster under `.local/postgres`, separate from any CRM database. The Docker runner uses its own named volume. Do not run both database runners simultaneously.

Migrations are transactional and versioned. Seeding is repeatable: it inserts missing fixture messages without resetting existing messages, read flags or replies. The seed includes deletion/access requests, an ordinary enquiry, an existing reply thread, a spam example and a downloadable text attachment.

Stop the app with Ctrl-C. Stop the native database with `pnpm db:stop`, or the Docker database with `docker compose stop`. Neither removes stored data.

## Connect directly to Postgres

Use the `DATABASE_URL` from `.env` in your SQL client or another local service:

| Field    | Value                                   |
| -------- | --------------------------------------- |
| Host     | `127.0.0.1`                             |
| Port     | `55439`                                 |
| Database | `agentic_inbox_prototype`               |
| User     | `inbox`                                 |
| Password | Generated `POSTGRES_PASSWORD` in `.env` |
| TLS      | Off for this loopback-only prototype    |

```sql
SELECT mailbox_id, subject, sender, date, folder_id, delivery_status
FROM emails
ORDER BY date DESC;

SELECT id, thread_id, in_reply_to, body
FROM emails
WHERE mailbox_id = 'privacy@realadvisor.com'
ORDER BY date;
```

The UI reads this same database; there is no SQLite or Durable Object mailbox store. The backend uses parameterized Postgres.js queries. All message queries are mailbox-scoped; composite foreign keys prevent cross-mailbox folder and attachment associations. This is structural isolation, not user-level authorization: the local prototype user can access both inboxes.

## UI components

Use `app/components/AppSelect.tsx` for dropdowns. It wraps Kumo Select and keeps
menus in the owning drawer's focus and stacking context. Do not introduce native
`<select>` menus in components; ESLint enforces this. Use Kumo inputs and buttons,
check existing components before adding controls, and visually verify both the
closed control and open menu at narrow and desktop widths.

## Verification

```sh
pnpm check
pnpm test
pnpm build
pnpm exec playwright install chromium
# Create this dedicated disposable database on your local Postgres first.
DATABASE_URL="postgres://inbox:<test-password>@127.0.0.1:55439/inbox_browser_test" pnpm test:browser
pnpm test:email-rendering
```

Node integration tests create and drop uniquely named schemas. The full application
browser suite starts the built SPA/API on loopback port 4432 (`BROWSER_PORT` overrides
it), refuses to reuse an existing server, and never loads `.env`. It requires the
exact database name `inbox_browser_test` on `127.0.0.1`, without URL options. **Each
application suite run resets that database's public schema**, applies migrations,
and loads the synthetic seed. Use a disposable database, not your prototype data.
Classifier UI is explicitly enabled, provider keys are cleared, and delivery is
simulated. Provider behavior in individual tests uses synthetic adapters or route
fixtures; no paid AI or live email is needed.

CI installs Playwright Chromium and runs Node, lint/types, deployment dry-run, the
full application suite, and email rendering. New `tests/browser/*.spec.ts` files
are discovered automatically; only `email-rendering.spec.ts` runs in its separate
fixture server. Screenshots, failure traces, and HTML reports are isolated under
`test-results/{application,email-rendering}` and
`playwright-report/{application,email-rendering}`, uploaded for seven days even
when browser assertions fail. To inspect a local report, run
`pnpm exec playwright show-report playwright-report/application`.

To serve the built SPA through the API server, stop `pnpm dev` and run `pnpm start`; open <http://127.0.0.1:4311>.

## Cloudflare deployment

The hosted inbox runs on Cloudflare Workers with Neon Postgres through Hyperdrive and private R2 storage. All HTTP routes, including static assets, validate Cloudflare Access JWTs in live mode. Configure permitted people in the editable **Inbox team** Access policy; all permitted people share registered mailboxes.

Merging a pull request into `main` releases the app through **Inbox CI and release**. Pull requests run lint/type checks, isolated Postgres tests, and a production build/deployment dry-run without production credentials. On `main`, the same checks must pass before the `production` job applies versioned database migrations and deploys the Worker, validated frontend artifact, queue bindings/consumers, and cron configuration. No seed or mailbox-setup commands run. Existing Worker secrets are retained.

The GitHub `production` environment is restricted to `main` and requires deployment secrets: `DATABASE_URL` (the direct production Neon connection) and `CLOUDFLARE_API_TOKEN` (a dedicated deployment token scoped to the RealAdvisor account and inbox zone, with permissions for the resources in `wrangler.jsonc`; see [Cloudflare's GitHub Actions setup](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)). Main requires a PR and the `check` status. There is no manual dispatch or tag deployment trigger. Releases are serialized without interrupting an active migration/deployment; superseded commits are skipped. The frontend is built once per run and passed to deployment as an artifact tied to the commit.

Migration 036 adds trigram indexes for literal substring search and an index for mailbox/date pagination. It builds indexes concurrently with a 16 MB maintenance-memory budget and parallel index workers disabled so inbound writes can continue; allow several minutes on a populated database. The migration runner uses the direct database connection, retries interrupted invalid index builds, and records completion only after both indexes are valid. List and search clients can request `view=summary` to omit message bodies and raw headers; message detail endpoints still return the full content. Both list routes always return `{ emails, totalCount }`, including empty pages. Summary rows retain RFC threading fields, tags, scores and conversation aggregates; only message/thread detail loads attachments and `draft_version`. The shared contracts in `shared/mail.ts` distinguish summaries, details, saved drafts and confirmed send results. The browser's old bare-array fallback has been removed because this standalone API has always returned the envelope; external API responses are unchanged. Request schemas retain legacy draft aliases, defaults and version checks. A `sent` result confirms delivery acceptance; ambiguous attempts remain HTTP errors and keep the existing send-intent recovery flow.

Migration 037 adds concurrent mailbox/time indexes for the runs list. Run history filters and bounds each source before merging and loading question summaries; email lists reuse one set of matches for page results and their total count.

A migration failure prevents deployment. If publishing fails after migrations, the old Worker continues running against the upgraded schema: keep migrations backward compatible and rerun the failed job after fixing the cause. Reruns use versioned migrations and skip commits no longer at the head of `main`. The final probe requires an authenticated JSON readiness response; login redirects, HTML and the old shallow health response fail verification. Configure `HEALTH_ACCESS_CLIENT_ID` and `HEALTH_ACCESS_CLIENT_SECRET` in the production environment before this release. Use an inbox-only Cloudflare Access Service Auth token permitted by the whole-host application and list its client ID in `ACCESS_SERVICE_CLIENT_IDS`; this grants readiness access as a User, not recovery administration. Missing probe credentials fail before migration/deployment. GitHub records the deployed commit under the production environment.

For emergency manual recovery only, install locked dependencies, run `pnpm exec tsx --env-file=.env.cloud scripts/migrate.ts`, then `pnpm run deploy` from the intended release commit. Credentials belong in ignored `.env.cloud` (permissions 0600), never in git. Local `.env` stays pointed at the local database. `pnpm deploy:check` builds and bundles without publishing.

The existing Neon project is `email-inbox` (`jolly-rain-30890362`) in the RealAdvisor organization, Frankfurt (`aws-eu-central-1`). Hyperdrive query caching is disabled. The Worker and private R2 bucket retain the infrastructure name `realadvisor-email-inbox-prototype` to preserve the existing resources and data. The public hostname is `inbox.realadvisor.com`; workers.dev and preview URLs are disabled.

Hosted URL: <https://inbox.realadvisor.com>.

## Operational readiness and inbound recovery

`GET /api/health` remains behind Cloudflare Access and inbox membership. It returns
only `{"status":"ready"}` (200) or `{"status":"unavailable"}` (503). It checks the
complete required migration set, Postgres query access, live sending/storage/Access
bindings, enabled classifier configuration and an R2 read. No email is sent and no
paid provider is called. This tests R2 read reachability; it does not prove write
permissions or external email/AI/Cloud Tasks provider availability. Anonymous callers
receive 401 and unapproved service identities receive 403. API keys cannot use this
endpoint. Local Node readiness checks the schema; it has no live Worker bindings.

Migration 045 adds a private ingestion journal without changing existing messages or
jobs. New deliveries store original MIME before parsing, then record mailbox, content
hash, envelope sender, size and state. Parsing or transactional delivery failures are
recorded as `failed` with a safe stage code; crashes can leave `pending`. No provider
errors or message bodies are returned by the recovery API. MIME is bounded to 10 MiB
including actual streamed bytes. Unknown mailboxes and oversized messages are rejected
without recovery records. Attachment objects use deterministic mailbox/hash/index keys
so retrying failed delivery does not accumulate a new set of orphan objects.

An administrator can use the authenticated API documentation at `/api/docs`:

1. `GET /api/v1/operations` lists the oldest 100 unresolved records, sends stuck in
   `sending`/`unknown` for 15 minutes, and unpublished classifier jobs older than 30
   minutes. These are bounded diagnostic lists, not full counts. Refresh after fixing
   the oldest entries. Pending ingestion may still be active; investigate records older
   than a few minutes. For stale jobs, check queue credentials/pause state and the cron.
   For uncertain sends, reconcile provider acceptance; never automatically resend.
2. Fix the reported parse/delivery cause first. Use the record ID with
   `POST /api/v1/operations/{id}/replay` and `Content-Type: application/json`. The server
   loads the recorded mailbox and original MIME, validates size and SHA-256, and applies
   the existing mailbox lock, Message-ID uniqueness and database transaction. Concurrent
   replay/redelivery cannot duplicate emails, trigger-created jobs or webhook events.
   Completed records are a no-op. Ordinary downstream dispatch resumes after success;
   replay never directly sends mail. Corrupt/missing objects return 409; another failure
   returns 503 and retains the record. Replay records the last actor and attempt time.
3. Refresh operations and inspect the received message. Inbox API keys, ordinary users
   and service identities cannot list or replay recovery records; use an admin session.

Unresolved records and their raw MIME/attachment objects have **no automatic expiry**;
retain them until investigated. The cron removes only completed journal metadata after
30 days. Raw MIME uses the existing private R2 retention policy (currently no automatic
delete); never apply a bucket lifecycle rule or orphan cleanup to `raw/` or
`inbound-attachments/` without excluding unresolved recovery references. There is no
HTTP raw-MIME download route. Storage access remains restricted to the Worker and
infrastructure operators. An initial R2 failure or database outage before journal
creation cannot be made recoverable by that unavailable dependency: ingestion throws,
and the delivery source must retry. Raw objects may remain without journal rows after
a database outage; automatic discovery/import of those older objects is not included.
This release does not replay historical failures automatically or alter provider retry
policies. Keep storage quotas and unresolved-record monitoring in the operator routine.

## Upstream updates

The `upstream` remote is `https://github.com/cloudflare/agentic-inbox.git`; `origin` is `https://github.com/realadvisor/agentic-inbox.git`. Our port starts from the upstream commit named above. Fetch upstream and review changes on a dedicated update branch before merging them into the Postgres port. Backend and AI/MCP changes can require manual adaptation; syncing upstream is not an automatic database upgrade.

## Real-mail configuration

The Worker supports `MAIL_MODE=live`. Live HTTP routes require a signed Cloudflare Access application JWT, verified against `ACCESS_ISSUER` and `ACCESS_AUDIENCE`; the prototype password is not accepted in this mode. Manage people in Cloudflare One → Access controls → Applications → RealAdvisor Inbox → Policies. The application does not embed a user allowlist.

Receiving and sending identities are separate:

| Receive address                | Outbound From / Reply-To |
| ------------------------------ | ------------------------ |
| privacy@ingest.realadvisor.com | privacy@realadvisor.com  |
| info@ingest.realadvisor.com    | info@realadvisor.com     |

For a fresh deployment:

1. Create a self-hosted Access application covering the entire app hostname and configure the approved users. Set `ACCESS_ISSUER=https://realadvisor.cloudflareaccess.com` and the application's audience in Wrangler. Verify all public app hostnames are protected; disable unused workers.dev/preview URLs if deploying on a custom hostname.
2. Run the migrations with `.env.cloud`, then `pnpm exec tsx --env-file=.env.cloud scripts/setup-mailboxes.ts`. This adds separate live mailboxes without deleting synthetic data. Live mode hides the synthetic mailboxes.
3. Onboard **only `ingest.realadvisor.com`** for Email Routing and route unmatched mail to this Worker through the zone catch-all; the Worker accepts only registered ingest addresses. Preserve the apex domain's Google Workspace MX records. Unknown mailbox addresses are rejected by the handler.
4. Onboard `realadvisor.com` for Cloudflare Email Sending and verify the required authentication DNS records. Preserve existing SPF/DMARC and other providers' DKIM records. Add a `send_email` binding named `EMAIL`, using the verified sending domain. The server derives the sender exclusively from registered ingest mailboxes. Sending domain approval is separate from receiving MX configuration.
5. Set `MAIL_MODE=live` and `INBOUND_ENABLED=true` only after Access, database migrations, and email bindings are configured. Deploy through main and verify login, a controlled inbound message, its attachment, and a reply with the expected From/Reply-To and authentication headers. Do not seed synthetic messages into live mailboxes.
6. To receive copies of group mail later, add each ingest address as a member of its corresponding Google Group with each-email delivery. Replies to the public address continue through the Group.

Inbound MIME is limited to 10 MiB and stored privately in R2 before parsing. Postgres stores mailbox-scoped messages, threading, attachment metadata, and the raw object key. Duplicate Message-IDs are ignored within a mailbox. Failed processing leaves raw MIME for recovery; automated replay and object-retention cleanup are not implemented yet.

Outbound requests require an idempotency key and persist the authenticated actor and send state. Provider acceptance is recorded as `sent`, not proof of final recipient delivery. An ambiguous provider error is recorded as `unknown` and is not automatically retried. Check provider logs before resending. Delivery/bounce webhook reconciliation and outbound attachment uploads remain follow-up work. A live test must be completed before treating this rollout as operational.

Browser sends keep a per-mailbox intent journal in `sessionStorage`, including the
exact serialized request (including selected `sender_identity_id` and `draft_id`)
and its idempotency key. Direct draft sends also pin the loaded draft sender.
Changing the selected sender, workspace default or saved draft cannot alter a
pending request. Compose, reply, forward and
Send draft retries reuse it after a timeout or lost response, including after a
reload in the same tab. Identical concurrent submissions share one request.
Changed content or a different send endpoint is blocked while an intent is
unresolved. The confirmation dialog can check/retry the saved **original** request;
it never submits the changed message in that action. After confirmation, review
Sent and start a new composition for different content. A server `sending` or
`unknown` outcome stays blocked for manual delivery investigation; there is no
automatic resend with a new key or expiry. A first-attempt validation/access
rejection permits correction, but a rejection after uncertainty cannot unlock it.

Confirmed compositions/drafts remain protected for the tab session, independently
of draft cleanup. A new composition after confirmed delivery gets a new intent.
The journal contains message content and lasts until the tab session ends; storage
failure prevents sending. Confirmed-scope receipts are saved before the pending
intent is released, so a storage failure preserves the original retry key.
It does not coordinate separate tabs/devices or survive
clearing browser data. Verify delivery in Sent before recreating an uncertain
message outside that session. Local simulated sends do not implement the live
server's idempotency ledger; lost-response integration tests use a fake mail sender
with the real live handler and isolated Postgres.

Sent messages retain their outbound audit/idempotency record and can be moved to Trash but not permanently deleted through the API. Object retention cleanup, mailbox-level permissions, classification and Probo integration are not implemented.

## API reference

[Scalar API documentation](https://inbox.realadvisor.com/api/docs) and the [OpenAPI document](https://inbox.realadvisor.com/api/openapi.json) are protected by the same Cloudflare Access login as the inbox. The versioned contract is [`openapi.json`](./openapi.json); update it alongside API changes. Scalar assets are bundled from the locked npm package and served locally, without a CDN or request proxy.

Run `pnpm dev` and open <http://127.0.0.1:4311/api/docs> for synthetic local requests. Hosted interactive requests use your browser session and affect real mail. Send/reply retries must retain the same UUID `Idempotency-Key` and identical request body; do not blindly retry an ambiguous send.

**n8n status:** service identities and mailbox/action permissions are not implemented. A Cloudflare service token alone is insufficient with the current human-identity validator. Do not export browser cookies into workflows. Future automation should use dedicated expiring service credentials stored in n8n's credential manager, with permissions enforced by the API.

## Creating live mailboxes

Administrators see **New Mailbox** on the homepage. `MAILBOX_ADMINS` is a comma-separated list of verified Access email identities (initially Jonas). `MAILBOX_CREATION_ENABLED=true` and `INBOUND_ENABLED=true` enable creation. The API checks the same permissions; hiding the button is not the security boundary. Creation records `created_by` and `created_at`, and commits the mailbox and its folders in one transaction. Duplicate addresses return 409. Live deletion remains disabled.

Mailboxes use `name@ingest.realadvisor.com` and send as `name@realadvisor.com`. The zone catch-all sends otherwise unmatched mail to the inbox Worker; only registered ingest recipients are accepted, before writing MIME to R2. Existing explicit Privacy/Info routes still work. The apex Google MX stays unchanged. The Send Email binding permits the verified domain; the backend authorizes the specific sender by its Postgres mailbox registration. No Cloudflare administrative API credential is stored in the application.

Creating an ingest mailbox does not create a Google Group or Workspace address. Configure the corresponding public address and forwarding separately if replies to `name@realadvisor.com` should return to this inbox. All Access-authorized users can read and send from registered mailboxes; creation is administrator-only.

## Conversation tags

Create, rename, recolor and delete shared tags in **Settings → Tags**. Inbox rows show colored chips; **Tag filter** narrows the current folder. The **Tags** section below Folders in the sidebar opens tagged conversations across all folders in the current mailbox, including Archive. Tag filters are included in the URL for bookmarking and reloads. Open a conversation to use **+ Tag** or remove a chip. Select rows (or the current page) for bulk add/remove. Selections reset when changing mailbox, folder, filter or page. Deleting a shared tag requires confirmation and removes its assignments everywhere; removing a conversation chip keeps the tag catalog entry.

Tags use stable UUIDs and case-insensitively unique names. Assignments are keyed by `(mailbox_id, thread_id, tag_id)`, independently of folders and individual messages. Replies, incoming messages and archiving retain a conversation's tags. Database triggers register conversations for every ingestion/send path, including existing messages backfilled by migration 005. Conversation identity persists even if its last message is deleted; assignment endpoints require an existing message in that mailbox.

The authenticated Access email is recorded as the manual actor (local mode uses `local-synthetic-user`). Each assignment stores source, creation/update times and a nullable `removed_at`. Removing a chip writes a manual removal record, including when the chip is already absent. These rows are the latest explicit decisions, not a full event history: future classifiers must respect **all** manual rows, including removals. New messages never clear manual choices. No classifier, model calls or background classification are implemented by tags.

Scalar documents tag CRUD, individual thread assignment/removal, atomic bulk changes (up to 100 thread IDs), and `tag_id` filtering on email/search endpoints. Filtering happens before conversation grouping, counting and pagination. All authenticated inbox users share the tag catalog; assignment routes enforce the existing registered-mailbox rules. Migration 005 is independent of migration 004 reserved by classifier PR #4. The versioned runner checks each migration individually, 004 belongs to the superseded hardcoded reply-classifier proposal and must not be merged over the configurable classifier implementation.

## Local classifier preview

Run `pnpm build` then `pnpm preview:classifiers` with the normal local `.env`. Open http://127.0.0.1:4313/mailbox/privacy@example.test/settings?tab=classifiers. The server refuses remote database hosts and creates an isolated `classifier_preview` schema in local Postgres. Settings, tag choices, runs and corrections persist there; the normal database schema is not modified.

This is a UI/workflow preview, not the production Jev classifier. It seeds three presets and 18 synthetic conversations across Privacy, Info and Bot. Run on existing uses fixed fixture answers for unedited presets, one conversation per second. New or edited questions go to Needs review. Runs support mailbox scope, unprocessed/all selection, preserving/resetting classifier corrections, progress and cancellation. Existing manual tag decisions always win. No provider requests or real email sending occur. Automatic processing of newly received messages, production conversation-version checks and live Jev evaluation are not implemented by this fixture driver.

The preview APIs mount only in the local Node entrypoint with `CLASSIFIER_PREVIEW=1`; the Cloudflare Worker does not mount them. No production migration or deployment is needed.

## Live Jev classifiers

Settings → Tags configures Jev instructions within each tag or group editor. Migration 006 seeds Needs reply, Privacy: Deletion and Privacy: Data access, all **inactive**. Only `MAILBOX_ADMINS` can create/edit/enable classifiers or run/cancel batches. All authenticated inbox users can review uncertain results. Activating a classifier applies to new mail and confirmed sent replies; it never starts a historical scan. **Reprocess conversations** and Settings → Runs → **Reprocess emails** create a durable server-side backfill. The default is **Missing or outdated results**; there is no default size cap. Optional mailbox scope, received-date range (latest received message, in the browser’s timezone), and a limit up to 250,000 narrow the selection. Archived received conversations are included; spam, trash, and sent-only/draft-only conversations are excluded. Groups are selected as a unit. The preview counts matching conversations, including those the worker may skip as current or protected. Manual tags and reviewed human/agent answers are preserved unless classifier corrections are explicitly reset in force mode.

Migration 033 separates backfill preparation/admission from the HTTP request. `POST /api/v1/classification/backfills` atomically records all selected tag runs and returns 202; the existing server dispatcher prepares the selection and admits pages of 100 with at most 500 outstanding jobs per classifier. Completion/cancellation and replaced jobs reconcile progress in Postgres. Dispatch, ingestion and the scheduled recovery path keep work moving after closing the browser. Progress cards persist across reloads and group the tag runs into a single batch, with processed, already-current, reused, skipped, failed and remaining counts. Counts are tag evaluations, so one conversation evaluated by five tags contributes five units. Cancel uses the existing classifier cancel endpoint. Starting another missing/outdated run retries errors and skips successful current work.

A result’s evaluation key includes the classifier revision, teaching examples (including removals), optional reviewed examples and an explicit engine/model contract marker; conversation generation tracks changed messages. No-op saves and cosmetic group color edits preserve evaluation versions and jobs. Existing results from before migration 033 have no evaluation key and need one successful evaluation to establish it; nothing is automatically reprocessed by migration. A future model/prompt-contract change must bump the engine marker, or an operator can explicitly choose **Force reprocess** for a refreshed `jev-latest` evaluation.

Backfills also share successful results for identical complete classifier inputs, using a SHA-256 cache key and an expiring owner lease to avoid concurrent duplicate calls. The evaluation clock is pinned to the batch start so time-sensitive questions are consistent within the batch. The key includes that clock, mailbox perspective, sender/recipients, chronological conversation content, dates, attachment counts, effective questions/examples, model, target option and decision rules. Different recipients, mailbox perspectives or later replies cannot reuse a result. Mail records are never merged or deleted. Reuse is conservative and scoped to equal effective input during a backfill; it is not a global subject/body deduplication rule. Cache entries expire with the 30-day history maintenance; failed calls are never cached. The legacy single-classifier `/runs` API remains compatible with its 5,000 active-conversation limit.

### Google Cloud Tasks

The classifier supports Cloud Tasks delivery to the existing serverless Worker. Run
`bash scripts/setup-cloud-tasks.sh` with an authorized Google Cloud account to
provision dedicated `inbox-classifications` (10 concurrent) and
`inbox-classifier-backfills` (5 concurrent), and `inbox-agent-drafts` (2 concurrent) queues in `realadvisor-prod/europe-west1`.
The script grants the dedicated service account enqueue permission only on these
queues. It does not change the other RealAdvisor queues or deploy the application.

Before enabling, configure these Worker variables:

- `CLOUD_TASKS_PROJECT=realadvisor-prod`
- `CLOUD_TASKS_LOCATION=europe-west1`
- `CLOUD_TASKS_SERVICE_ACCOUNT=inbox-classifications@realadvisor-prod.iam.gserviceaccount.com`

Store that dedicated service account's PKCS8 private key as the Worker secret
`CLOUD_TASKS_PRIVATE_KEY` using `wrangler secret put`; never commit a key or use
an existing broadly privileged account. Google OAuth tokens are short-lived and
cached in memory. Delivery uses Google-signed OIDC tokens with the exact endpoint
audience and expected service-account email; queue headers alone are not trusted.

Cloudflare Access must bypass **only** `/internal/classification-task` on the inbox
hostname, using a path-specific Access application. The Worker itself verifies
Google OIDC on that route. Keep the rest of the hostname protected by Access.
Verify unauthenticated POSTs return 401 and a real task succeeds before switching
production dispatch. Do not configure a hostname-wide bypass.

Deploy after provisioning the queues and configuring the variables, secret, and
Access. All background work uses Google Cloud Tasks; there are no Cloudflare
queue bindings or consumers. The existing `/internal/classification-task` endpoint
also accepts draft deliveries with `kind: "agent-draft"`, using the same Google
OIDC validation and exact audience. Drafts do not depend on classification being enabled.
Existing token/lease checks protect against duplicate processing. Unpublished work
is recovered on dispatch or by the 15-minute recovery cron.

Cloud Tasks carries only job tokens. Provider backoff and cooldown remain enforced
in Postgres; the handler returns 503 for a retry and 204 after completion. Four
actual processing attempts exhaust a job into a visible error via the existing
failure path; waiting for leases/cooldown or a paused feature does not consume this
budget. Broker retries are unlimited so a database outage cannot silently discard
work. Failed creation leaves the outbox uncommitted and recoverable. Automatic AI
drafting uses its separate Google queue. Existing draft jobs retain their stable IDs;
completed or potentially partial agent runs are never replayed. Before retiring
legacy queues, republish pending draft jobs through Cloud Tasks by clearing only
their `published_at` markers. Leave results, drafts, and agent turns intact.

### Classification delivery

Google Cloud Tasks delivers classifier work. New mail and confirmed sent replies use `inbox-classifications`; explicit historical runs use `inbox-classifier-backfills`. The live queue permits 10 concurrent consumers and backfills permit five, with batch size one. Published classifier tokens for the same conversation generation and delay are grouped into `{version: 2, tokens: ["uuid", ...]}` messages, never email bodies or addresses. Version 1 single-token messages remain supported while existing deliveries drain. Ready sibling leases are claimed atomically to keep a conversation’s questions together under concurrent delivery. Neon remains the source of truth for configuration, results, corrections and run progress.

Migration 007 adds a transactional `classifier_outbox`: changes to pending job versions record dispatch intent in the same database transaction. Ingestion and successful API mutations publish promptly after commit; consumers continue draining large unpublished batches. The published marker is committed only after broker acceptance, so an ambiguous publish may duplicate a message but cannot silently lose work. Stable version tokens and short per-job leases make retries/duplicate deliveries safe. Completion and tag changes are atomic. New mail, configuration edits, cancellation and human review invalidate stale messages.

The task handler enforces four actual processing attempts, respecting provider
backoff and a shared 429 cooldown. Exhausted jobs are recorded in Neon for review
or reprocessing. Outbox intent survives broker expiry and can republish pending
classifications after 25 hours. Manual choices and cancellation behavior are unchanged.

Jev receives chronological received/confirmed-sent conversation text and metadata via `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`, question type `noul`. Responses ≥0.85 apply the tag; ≤0.15 remove the automatic tag; intermediate results need human review. Full attachments/raw MIME are not submitted. Classification budgets apply after HTML-to-text conversion, including every message. A conservative UTF-8 ceiling leaves headroom under Jev’s 32k per-question and 64k per-request token limits; it is not an exact token count. Optional examples are dropped before rejecting a request. Token-limit responses split distinct questions and, if necessary, remove examples once; conversation content is never truncated. Conversations exceeding the 1,000-message/10-million-raw-character resource guard or the prepared request budget require review. Provider failures never become a confident No. New messages, configuration revisions, human corrections and cancellation invalidate in-flight result tokens. Manual tag additions/removals always win. Editing or disabling clears only classifier-owned tags. This labels conversations; it never sends replies or performs deletion.

Provision Google queues with `bash scripts/setup-cloud-tasks.sh`. Set the server-only
Worker secret `TYPESAFE_API_KEY`, retain `CLASSIFIERS_ENABLED=true` and the recovery
cron, then deploy. Set `CLASSIFIERS_ENABLED=false` to pause classification without
discarding work. Scalar documents `/api/v1/classification/*`.

Classifier editors offer **Use recent human examples** (off by default). When enabled, Jev receives up to three yes and three no examples from the same mailbox and question, labeled within the last 30 days. New manual tag additions/removals and classifier reviews capture frozen conversation snapshots; automatic predictions and unlabeled conversations are never examples. Existing labels are not backfilled because their historical message state is unknown. Examples omit drafts and unsent messages, exclude the current conversation, and are size-limited. Editing the question or tag clears its examples. Turning the setting on affects future processing; use Run on existing to reevaluate completed conversations. This supplies request context, not model training.

Ready classifier questions for the same conversation are grouped into one Jev request without a classifier-count cap. Each question retains its own examples, probability, manual overrides and retry token. Different conversation snapshots and requests exceeding the batching payload budget are sent separately. A delivery time budget keeps split requests within job leases; deferred jobs retry through their existing broker deliveries. Historical processing uses up to five concurrent consumers; new-mail processing uses up to ten; later broker deliveries for already completed sibling jobs are acknowledged without another provider call.

## Classifier request logs

Inbox administrators can open **Settings → Runs** or use the **Classification** button on a conversation to open its latest run directly in a side drawer. Earlier runs are available from the run history selector without leaving the email. Each entry is one actual Jev request, including batched questions and retries. The drawer contains per-question probabilities and application outcomes, the request JSON, and the raw response (including malformed/non-JSON errors). Reading logs does not run classifiers. Logs start at migration `010_classifier_provider_runs.sql`; older raw payloads cannot be reconstructed.

The provider-call tables are separate from backfill `classifier_runs`. Requests snapshot questions, revisions, conversation content and any reviewed examples. Authorization headers are never stored. Both list and detail APIs require classifier-management permissions and return `Cache-Control: no-store`. Payloads remain private email data.

The scheduled Worker removes logs after 30 days; `CLASSIFIER_LOG_RETENTION_DAYS` accepts an integer from 1 to 365. Conversation deletion cascades to its logs. Calls still running after five minutes are marked interrupted, and unfinished application outcomes are marked failed. Apply the database migration before deploying the Worker and UI.

## Email agent

Open **Agent** in a mailbox to chat, search mail, organize incoming messages, or save a draft reply to the selected email. **Settings → Models** lists models, refreshes the gateway catalog, and saves a default per mailbox. The chat dropdown can override that default for the current browser session without changing automatic drafts. Each turn records the model actually used.

Workers AI choices use the `AI` binding through `workers-ai-provider`: Kimi K2.6 (initial default), GLM 4.7 Flash, and Qwen3 30B. Anthropic, OpenAI, and other compatible providers use **Vercel AI Gateway**, matching Mako and the CRM, via AI SDK 6. **Refresh model list** imports tool-capable language models supporting the installed SDK from `https://ai-gateway.vercel.sh/v1/models` into Postgres. Removed models remain visible as unavailable; failed refreshes preserve the previous list. Defaults never silently fall back. Gateway models are selectable only when `AI_GATEWAY_API_KEY` is configured server-side. The public catalog can be refreshed without a key; inference requires a funded gateway account with access to the chosen model. Keys are never exposed to the browser.

**Settings → Models** also provides additional writing instructions and an opt-in **Automatically draft replies to new emails** toggle. It starts disabled and only enqueues future received inbox messages. Existing drafts and superseded conversations are skipped. Automatic tools can only read the triggering conversation and draft a reply to its original sender/Reply-To; interactive tools can also search, compose a new draft, mark read/unread, archive, move to spam/trash, and discard drafts. Neither mode has a send tool. Review draft links open the existing composer for editing and manual sending.

The chat follows the CRM/Mako Vercel AI SDK architecture: `@ai-sdk/react` `useChat`, `DefaultChatTransport`, and server `streamText` → `toUIMessageStreamResponse`. It renders Markdown and expandable tool activity with draft review links. Native UI messages (including tool results) persist in Postgres and are converted back to model messages for bounded follow-up context. A client disconnect aborts generation; the server drains the remaining stream to persist partial progress and release the mailbox lease within Cloudflare’s cleanup window. Changes already saved remain available. Legacy turns remain readable. Postgres stores chat history, the selected model for each turn, actor, and tool results. The panel displays the 30 most recent turns. The model sees up to 30 prior turns within a conservative model-aware context budget and bounded email text; attachments are listed but not submitted. Email content is treated as untrusted. Only one agent turn can write per mailbox at a time. Runs time out after two minutes with a three-minute mutation lease; disconnected or interrupted runs are not automatically replayed. Check history and saved drafts before retrying. Automatic jobs are deduplicated by incoming email and never replay a model run that might already have created a draft. Turning automatic drafting off prevents further writes by active automatic runs.

Interactive chat can read tag and ordered-scale definitions (`list_tag_groups`) and resolve recipients from the current mailbox’s contact history (`search_recipients`). Email and thread reads include tags, current scores, score confidence/review state and conversation workflow revisions/activity. `list_emails` and `search_emails` share the HTTP API store and support tags, Open/Done status, date bounds, read/starred state, review filtering, thread grouping, score ordering and pagination. Search dates use ISO timestamps and the end bound is exclusive; `has_more` identifies another page. Definitions are shared across mailboxes, while messages and contacts remain mailbox-scoped. Automatic drafting still exposes only `get_email`, `get_thread` and `draft_reply`, restricted to the triggering conversation.

Deployment requires migrations **009–017**, the Workers AI `AI` binding, and the Google Cloud Tasks `inbox-agent-drafts` queue provisioned by `scripts/setup-cloud-tasks.sh`. Enable Anthropic/OpenAI with `pnpm exec wrangler secret put AI_GATEWAY_API_KEY`, then refresh the model list in settings. Existing CRM/Mako gateway credentials can be supplied through the deployment secret store; do not commit keys. The ingestion event dispatches its durable Postgres outbox; the existing 15-minute cron recovers unpublished or exhausted deliveries. Chat does not depend on the automatic queue. The local Node server supports gateway chat when `AI_GATEWAY_API_KEY` is in `.env`; automatic drafting requires Google Cloud Tasks delivery to the Worker. Integration tests exercise catalogs, model overrides, streaming, draft tools and queue processing using deterministic models and isolated local Postgres schemas, with no external email delivery.

The assistant normalizes historical tool calls across providers, including failed and interrupted turns. Old context is omitted as complete turns when its budget is exceeded; there is no automatic summary generation. **Stop** revokes a specific run’s write lease, retaining earlier saved changes; generation observes cancellation within its polling interval. Refreshing reconnects the UI to persisted progress through polling, not SSE replay. Completed turns record token usage and, when catalog pricing exists, an approximate model cost excluding caching adjustments, discounts and additional fees. Failed or stopped turns do not display a potentially incomplete cost estimate.

For a local preview of the complete classifier UI (including Runs and Needs review),
set `CLASSIFIERS_ENABLED=1` in `.env` and restart `pnpm dev`. This exposes the
existing database-backed classifier routes; the local server does not run the
hosted Jev queue worker.

## Agent organization tools

Interactive chat can add/remove an existing conversation tag, change Open/Done
using the current revision, star a message, and mark a whole conversation read or
unread. These tools reuse API mutation services, retain mailbox scoping and the
run lease, and record successful changes in the agent turn. Tag and status
history identifies the agent acting on behalf of the authenticated operator.
Single-choice and ordered-scale edits preserve the existing manual override rules.

`draft_email` accepts multiple To recipients and optional Cc/Bcc. `get_draft`
returns a bounded plain-text preview and `draft_version`; `update_draft` changes
only supplied fields using that version. Omitting body preserves existing rich
HTML; supplying body replaces it with escaped plain text. A stale version fails
without overwriting newer edits. The composer also sends the version when saving.
API clients can pass `draft_version` to `POST .../drafts` for the same protection;
omission remains supported for older clients. `POST .../threads/:threadId/read`
accepts `{ "read": false }` to mark unread; no body retains mark-read behavior.

Single requested changes execute directly. The agent is instructed to present
specific changes and obtain confirmation before acting on multiple conversations;
no bulk-write tool is exposed. Automatic drafting keeps only its existing
read-email, read-thread and draft-reply tools. Sending remains manual.

## Tag groups

Settings → Tags extends the shared tag catalogue with groups. Each group has a
name, single or multiple selection, editable options and one instruction for Jev.
Urgency, Importance and Topic start with automatic classification disabled. Enable
it in the group editor to classify new mail through the existing Jev queue and
batching pipeline. Saving a group updates its managed per-option classifiers,
cancels obsolete jobs/runs and clears automatic results; manual choices remain.
Existing conversations are not silently reclassified. Use “Apply to existing conversations” in the tag or group editor for explicit
historical runs. The Tags page is the only configuration surface: standalone
tags retain their existing Jev prompts, mailbox scope, and reviewed-example
settings. Manual groups do not require a prompt. The former Classifiers tab
opens Tags for compatibility; Runs remains the execution history.

Single-select conversation badges open a picker that replaces the current choice
atomically. Manual edits take precedence for the group on later mail. Contradictory
positive Jev answers in an exclusive group clear the automatic selection and enter
the existing review queue. Removed options are retired, preserving classifier run
history. Existing standalone tags and classifiers keep their current behavior.
Group configuration requires inbox administrator access in live mode. Apply
migration 014 before deploying this change.

In a tag or group editor, **Try on emails** searches the current mailbox and selects up to five conversations. **Preview requests** shows the exact batched payloads with conversation content. **Test with Jev** sends those conversations using unsaved instructions and shows probabilities without saving configuration, assigning tags, or creating historical runs. Received and confirmed-sent messages are included; attachments are excluded. Local testing requires `TYPESAFE_API_KEY` in `.env`; hosted testing uses the existing Worker secret. Uncertain answers and conflicting positive answers in a single-selection group require review.

Single-selection groups compile to one native Jev Choice with per-tag descriptions and an `insufficient_evidence` fallback. Multiple-selection groups and standalone tags remain Noul questions. Production and tests share request construction, conversation text normalization, batching, and answer validation. Choice initially requires confidence ≥0.60, winning probability ≥0.75, and a ≥0.20 margin; otherwise every option goes to review. These are provisional thresholds, separate from Noul's 0.85/0.15 policy, and require validation on reviewed mail. Manual overrides and stale-job fencing still apply. Provider logs retain the raw Choice distribution and associate the shared question with each affected classifier job.

Migration 015 adds optional tag descriptions and allows multiple classifier audit items per provider question. Migration 016 refines only untouched, disabled default Urgency/Importance groups; customized or enabled groups retain their instructions. Review their definitions in Settings before enabling. Message state includes readable text, UTC evaluation time, direction and attachment counts. Only exact previously seen `>`-quoted lines are deduplicated; unique quoted evidence remains. Deadline arithmetic is not delegated to Jev, and no deadline extraction is added here.

Run `pnpm eval:jev --live` to compare native Choice with independent Noul questions on eight synthetic multilingual triage fixtures using the local key. This sends only synthetic text and does not access mailboxes. It holds revised instructions constant to compare request types, reports correct/review/incorrect outcomes, and is a smoke evaluation rather than a real-mail accuracy benchmark. Use separate, held-out reviewed emails to tune thresholds and measure production accuracy.

The assistant supports separate saved conversations. Use **New conversation** (+) for fresh context and **Conversation history** to search titles and resume earlier chats. History and messages are paginated; the selected conversation is remembered in this browser per mailbox. Each conversation retains its model choice through its latest turn. Existing pre-conversation history is preserved under **Previous conversations**; automatic draft runs get separate conversations. Conversations are shared with users who can access the mailbox, like existing inbox history. One run can write per mailbox at a time.
Curated examples live in the tag/group drawer under **Examples** (migration 020). Administrators can also adjust the conversation’s tags and click **Save as example** directly in the inbox. This confirms the visible tags as labels for assigned groups and configured standalone tags; unassigned groups are skipped. Multi-select groups save all selected options together, with other options treated as negative. Re-saving updates the conversation snapshot and labels without duplicates, preserves an existing test-only role, and defaults new examples to teaching. Example use can be changed in Settings → Tags → Examples. New examples are added only from the inbox. Setup displays saved examples with an **Open inbox** link; administrators can review or edit existing labels, remove examples, and choose **Teach Jev** or **Test only**. Labels belong to a group as a whole, or a standalone yes/no classifier, and are scoped to a mailbox. Saving freezes the conversation; changing a label preserves that snapshot and does not assign inbox tags. Store at most 50 examples per configuration/mailbox.

Teaching uses at most six compatible examples, balanced across labels, within the request context budget. The current conversation and duplicate evidence are excluded. Test-only examples are never teaching context. Curated datasets replace the legacy recent-human-example source for that mailbox. Semantic edits preserve examples but mark their labels for review; reconfirm labels before using them as teaching context. Cosmetic color edits do not invalidate labels. **Run test set** evaluates frozen held-out cases using the draft instructions, shows expected/predicted labels and review/error counts, and exposes the actual requests. Results stay in the drawer and never modify inbox tags. These examples provide in-context guidance, not model training.

When classification is enabled, the chat agent can inspect a conversation's current classifications, correct independent/multiple-choice boolean results on request, and queue a single-conversation rerun for administrators. The inspection API is `GET /api/v1/classification/threads/{mailbox}/{thread}/classifications`; it returns recorded scores, confidence, ordered levels and provenance, never provider logs or an invented model rationale. Choice and ordered-scale corrections require explicit tag selection, not boolean coercion. Agent corrections are stored with `source: agent` and the requesting actor (migration 027), excluded from human-reviewed teaching examples, and protected during reruns. Human corrections and manual tags remain protected. Classification tools are unavailable during automatic drafting.

The conversation panel’s **Reclassify** action queues all saved Jev classifiers in mailbox scope for that thread, including those with automatic assignment disabled and refreshes tags after completion. Manual tags and reviewed human answers are preserved. Explicit reruns support archived/sent conversations as well as inbox mail, excluding spam/trash and draft-only threads. Ready questions for the same conversation are batched into shared Jev requests, splitting only when payload limits require it. Automatic new-mail processing continues to honor the enabled switches. Hosted requests use the durable Queue outbox; local explicit reruns use the same batching worker with the configured Jev key.

Tag and group editors expose **Automatic decision rules** (migration 021). Thresholds control post-response decisions and are never sent to Jev. Defaults retain existing behavior: yes/no 85%/15%; Choice confidence 60%, winning probability 75%, and a 20 percentage-point margin. Tests use draft thresholds; production and audit interpretation use the saved rules. Threshold edits follow existing configuration revision invalidation and preserve curated labels. **Full instructions** shows shared email-handling rules plus the current prompt; actual conversation previews include selected teaching examples.

Migration 022 records classification attempt states transactionally, including queued work and failures before a Jev request. Runs shows these alongside provider requests without duplicating attempts that have a request log. Existing current states are marked as recovered history, with no invented request payloads. Attempt details remain accessible after dispatch and link to the physical requests. Completed attempt history follows the same 30-day retention as provider logs.

Migration 031 hands a lifecycle record over to its provider request item atomically
when Jev is called, so sent attempts no longer have a second full outcome record.
Queued and pre-provider failures remain in `classification_attempts`; their links
continue to resolve after dispatch. Token replacement and job deletion close
superseded lifecycle records, and the recovery cron reconciles older orphan states.
Runs filters use mailbox/date indexes and exclude legacy overlap directly in the
attempt query. Automatic refresh runs every 15 seconds on the first page only;
older loaded pages refresh on demand. This does not change emails, classifications,
manual tags, or provider request retention.

Manual reclassification starts the existing leased worker immediately in a request-scoped background task; the transactional outbox and hosted queues remain the recovery path. Enqueue writes are batched, and sibling classifiers reuse one prepared conversation per generation within a processing call. The conversation UI refreshes tags as completed-result counts change.

## Outgoing webhooks

Administrators can configure **Settings → Webhooks** per mailbox: HTTPS endpoint,
event subscriptions, enable/disable, test ping, and the latest 50 deliveries with
payloads, response excerpts, timing, and manual retry. Supported events are
`email.received`, `email.sent`, `conversation.tags_changed`,
`conversation.classified`, `conversation.status_changed`, and `conversation.matched`. Bodies and attachments
are excluded. `conversation.classified` contains the results when all pending
questions for that conversation generation have settled, including review/error
outcomes; received events precede classification. No historical events are backfilled.

Tag filters in Settings support **any/all included tags** and **excluded tags** (exclusions win). Filters use stable tag IDs, including ordered-scale level tags. Renaming a tag does not change the filter; archived tags are no longer considered active.

- **Conversation starts matching tags** (`conversation.matched`, **Tag conditions matched** in Settings): sends once on a nonmatching → matching transition, including classifier-applied tags. Evaluation happens after all tag changes in the transaction, so temporary level swaps or exclusions applied in the same transaction do not trigger an event. Leaving and re-entering sends a new event ID.
- **Selected events (Settings)**: filters each selected event against its tag set when the event is recorded. An email-received event does not wait for later classification; use `conversation.classified` to check tags after Jev finishes, or the starts-matching event for entry into a matching tag set.

Migration 030 adds filter fields and per-conversation matching state without creating tags or subscriptions. Creating/changing a filter or re-enabling an endpoint establishes a baseline: existing matches are not backfilled. Disabled subscriptions do not queue events. Historical imports update the matching baseline without sending. Queued deliveries retain their original `data.tag_ids` snapshot after tags or filters change; manual retries retain their event ID. Test pings deliberately bypass filters.

Example subscription (administrator browser/API session):

```json
{
	"url": "https://your-n8n.example/webhook/inbox",
	"events": ["conversation.matched"],
	"include_tag_ids": ["<listing-inquiry-tag-uuid>"],
	"exclude_tag_ids": ["<spam-tag-uuid>"],
	"tag_match": "any",
	"enabled": true
}
```

n8n receivers should verify the existing signature and deduplicate by event ID. Delivery remains at least once. Mailbox API service credentials are separate and are not introduced by tag filters.

Migration 028 captures subscribed events and delivery intent transactionally.
Google Cloud Tasks `inbox-webhooks` (5 concurrent) carries only delivery IDs to the
existing authenticated task handler. Run `scripts/setup-cloud-tasks.sh` before
production rollout and set `WEBHOOK_SECRET_KEY` to a random 32-byte hex value
using the deployment secret store. This encrypts endpoint signing secrets at rest;
retain it across deployments. Signing secrets are returned at creation and can be revealed or rotated from Settings. Administrators and API keys with `webhooks:manage` can manage secrets only for endpoints they are authorized to manage; API keys remain restricted to their own endpoints. Reveal and rotate use non-cacheable POST responses. Rotation changes the secret used by new attempts; in-flight attempts may still use the old secret. Update the receiving integration before resuming delivery. Local endpoint
configuration also requires this variable; the local Node server does not dispatch
outgoing webhooks automatically, preventing copied production subscriptions from
sending to real integrations.

Delivery uses `X-Webhook-ID`, Unix-seconds `X-Webhook-Timestamp`, and
`X-Webhook-Signature: v1=<hex HMAC-SHA256>`. Verify the signature over
`timestamp + '.' + rawRequestBody` using the displayed secret, compare in constant
time, and reject stale timestamps (for example, older than five minutes). Store the
event ID to deduplicate: delivery is at least once and ordering is not guaranteed.
Google OIDC authenticates task delivery to the inbox; the HMAC authenticates the
outgoing request to your endpoint. Return 2xx after accepting the event durably.

Requests time out after 10 seconds. Network failures, 408, 429, and 5xx retry with
exponential backoff, up to five attempts; other failures are terminal and visible
in delivery history. Manual retry preserves the event ID and payload. Redirects
are rejected; destinations must be HTTPS public hostnames with public DNS answers.
Completed event logs are retained for 30 days; pending deliveries remain recoverable
through the existing 15-minute cron. Disabling an endpoint skips waiting deliveries.

## Importing the Privacy and Info Groups history

Use the offline import tools for an explicitly selected `topics.mbox`, not the
whole Groups export. Pending moderation, membership files and unrelated groups
are excluded. Keep the source and generated plans in private, ignored storage.
These tools are intentionally restricted to Privacy/Info and the existing Neon
inbox project; they are not an HTTP import endpoint.

Apply migration 029 before importing. It adds a transaction-local
`inbox.historical_import` flag to the classifier, agent and conversation-status
and webhook triggers. Only an import transaction sets it: normal mail still creates jobs and
reopens conversations. Imports retain foreign keys, duplicate constraints,
conversation registration and contact indexing. Later migrations replacing these
trigger functions must retain the guard; the importer refuses to apply without it.

```sh
python3 scripts/index-groups-import.py --name privacy \
  --mbox /private/path/privacy.mbox --output .local/import-privacy
pnpm exec tsx --env-file=.env.cloud scripts/plan-groups-import.ts \
  --index .local/import-privacy/privacy-index.json
pnpm exec tsx --env-file=.env.cloud scripts/import-groups.ts \
  --plan .local/import-privacy/privacy-plan.json
```

Review the summary (counts, dates, duplicates, attachments and errors). The first
script verifies MBOX boundaries and group headers, and the second verifies every
message's group identity, MIME and original date. No write to Neon or R2 occurs
until `--apply`. The original exported MIME bytes, including any MBOX quoting,
are preserved unchanged. Historical messages up to 50 MiB are supported offline;
the live inbound limit remains 10 MiB. Invalid records stop application.

For apply, create ignored `.local/r2.json` with the existing account and bucket:

```json
{
	"name": "inbox-history-import",
	"account_id": "71c7813809b4adb2fc4766ba1fd5cf2d",
	"compatibility_date": "2026-09-22",
	"r2_buckets": [
		{
			"binding": "ATTACHMENTS",
			"bucket_name": "realadvisor-email-inbox-prototype",
			"remote": true
		}
	]
}
```

Authenticate Wrangler normally, then run the same import command with
`--limit 100 --apply` for a pilot, verify it, and rerun with `--apply` for the rest.
Use `--name info` and its selected MBOX to prepare Info separately. Replies are
linked by Message-ID/reference components, including historical parents of live
messages. Conflicts between existing conversation IDs stop the import for review;
existing tags, read/folder state and conversation status are never overwritten.

Received history is archived and marked read; messages whose From is the public
mailbox address go to Sent without being sent again. Uploads use eight bounded
workers with retries, outside the database transaction. Each batch commits at
most 100 emails and their attachments atomically. Deterministic IDs/object keys,
per-message SHA-256 validation and a flushed private NDJSON manifest make retries
safe. After an uncertain commit, rerun the same plan: the database's Message-ID
constraint determines what remains. Do not regenerate the plan or its baseline
snapshot midway through an import. Orphaned R2 objects from a failed batch can be
reused on retry; the importer does not automatically delete objects.

Before declaring completion, reconcile every source Message-ID with the target,
verify imported dates/read/folder state and attachment counts, sample raw object
hashes and attachment contents, and confirm no import-generated classifier or
agent jobs or webhook events. Run classification separately only when explicitly requested.

## Inbox members and roles

Settings → Access lists people with access to **all** mailboxes. Admins may add
exact `@realadvisor.com` email addresses, choose Admin or User, change roles and
remove access. Users can read/send mail, manage conversations and review results;
admins additionally manage membership, mailbox settings, tag/classifier settings,
models and webhooks. Changes are audited in `inbox_member_audit`. The API protects
the last administrator under a transaction lock. No invitation email is sent.

Migration 032 adds membership tables. Migration 034 imports the existing inbox
policy users and the requested Anastasia membership without overwriting existing
roles. Production enables `ACCESS_MEMBERSHIP_ENABLED=true` after that migration
succeeds. Future membership changes belong in Settings → Access. On an empty installation, a verified identity listed
in `MAILBOX_ADMINS` can bootstrap those admins. After initialization, that variable
cannot restore a removed or demoted member. The Worker reads the current database
role on each API request; removal blocks subsequent API requests even with an
existing Access session.

Cloudflare Access remains the authentication layer. Configure its inbox-only
login policy to admit corporate identities **only after** the database membership
gate is deployed and enabled. Corporate-domain authentication alone must not grant
mailbox access: an explicit database membership is also required. Until that
rollout, adding a name in a development preview does not grant production access.
The local preview uses a synthetic administrator and its separate database.

For machine integrations, keep the inbox-specific Cloudflare service-token policy
and explicitly list its approved client IDs in `ACCESS_SERVICE_CLIENT_IDS` before
enabling membership. Only cryptographically verified service identities on that
list receive User access; they cannot manage members or configuration. Service
credentials stay separate from the human member list and are revoked in Cloudflare.

## API keys for agents and n8n

Administrators create keys in **Settings → API keys**. Select explicit mailboxes
and permissions: **Read mail** (`mail:read`), **Manage drafts** (`drafts:manage`),
**Send email** (`mail:send`), **Manage conversations** (`conversations:manage`),
**Manage webhooks** (`webhooks:manage`), **Read classifications** (`classifications:read`),
**Review classifications** (`classifications:review`), **Run classifications**
(`classifications:run`), **Manage folders** (`folders:manage`), and **Use inbox agent**
(`agent:use`). Only Read mail is selected by default. Select all grants these ten
explicit permissions, not administrator access or future permissions. The secret is shown once; only its SHA-256 hash and a display prefix are
stored. Expiry is optional. The list shows last use, authenticated request count
(including permission denials), and revocation state. To rotate, create a new key,
update the client, then revoke the old one. Keys cannot create other keys, change users or alter classifier definitions/settings.
Existing keys retain their original permissions; create a replacement to change access.
Draft management creates/updates via POST /mailboxes/{mailboxId}/drafts and deletes
via DELETE /mailboxes/{mailboxId}/emails/{id}, restricted to actual drafts.
Sending permits new messages, replies and forwards; live sends require an
Idempotency-Key UUID and record the key identity in the delivery record.
Conversation management permits flags, moving mail (including archive/trash),
read status, workflow status and tag assignment/removal. It does not permit
permanent mail deletion or changing shared tag/folder definitions.

```sh
curl --header "Authorization: Bearer $INBOX_API_KEY" \
  https://inbox.realadvisor.com/api/v1/mailboxes
```

Read permission covers email lists/search, individual emails and attachments,
threads/status, and folders in the allowed mailboxes. Mailbox discovery is filtered;
the shared tag/group catalogue is readable for selecting webhook filters. Keys with
webhook management can create subscriptions and manage/test/retry only endpoints
created by that same key. Administrators retain access to all endpoints. Revocation
blocks the next API request; already accepted requests may finish. Revoking a key
**does not disable existing outgoing webhooks**. Administrators can disable/delete
those separately; replacing a key does not transfer webhook ownership.

Classification scopes permit mailbox-scoped results/inspection, corrections, and
single-conversation reruns respectively. API corrections are attributed to the key
as agent reviews and preserve human corrections; choice/score corrections use tag
selection rather than boolean review. Bulk backfills and classifier configuration
remain administrator-only. Folder management applies to custom folders only.

Agent use also requires Read mail. The UI selects it automatically. Each agent tool
is separately restricted by the key's draft, conversation and classification scopes;
new tools are denied until explicitly mapped. Agent settings remain administrator
configuration. The composer generates text; saving drafts requires Manage drafts.
The existing chat agent has no send tool; Send email is available through the mail API.

### Cloudflare Access rollout

Deploy migrations 039–041 and the Worker **before** changing Access. This migration
creates no keys, members, tags or mailboxes. Keep the existing human-login Access
application protecting `inbox.realadvisor.com`, including `/api/docs` and
`/api/openapi.json`. Add a more-specific self-hosted Access application for
`inbox.realadvisor.com/api/v1/*` with an Everyone **Bypass** policy. Do not change
the whole-host policy or the independently authenticated Cloud Tasks route.

The Worker authenticates each request itself: an inbox Bearer key, or a verified
Access JWT assertion/browser `CF_Authorization` cookie. Cookie fallback verifies
the existing human application's issuer, audience, signature and expiry, then
checks inbox membership; never trust an email header. Browser requests remain
same-origin. Bearer keys never authorize pages or task endpoints. Requests with
invalid Bearer credentials fail even if a valid browser session accompanies them.
Existing service-token/JWT clients remain supported by the backend, but the new
API path policy may require migrating clients that rely on Access to mint their
assertion from service-token headers; use an inbox key instead.

After the path-specific policy is enabled, verify: anonymous `/api/v1/config`
returns **401** (not a login page), a valid key returns **200**, a revoked key
returns **401**, another mailbox returns **403**, and normal Google login still
loads mail and Settings. Keep the old host policy in place if any check fails.
The application tests cover Worker Bearer/cookie authentication and permissions;
the external Access policy must be verified against the deployed instance.
