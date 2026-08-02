<div align="center">
  <h1>Mail Portal</h1>
  <p><em>Self-hosted team email — send/receive, bulk send, and a manual AI assistant, on Cloudflare Workers + AWS SES. One brand-parameterized codebase, one isolated deploy per brand.</em></p>
</div>

A fork of [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) (Apache 2.0). Users log in with email + password, send and receive from `firstname@<brand-domain>`, do light bulk send (mail merge), and use a manually-invoked AI assistant.

This is a **shared, brand-parameterized platform**: source is shared, but each brand deploys as its own isolated Cloudflare Worker (own D1, Durable Objects, R2, KV, SES identity, secrets, and domain) via a named Wrangler environment. Brands are selected at build time with `CLOUDFLARE_ENV` - e.g. `npm run deploy:whispyr` or `npm run deploy:wiser`. Whispyr (`mail.whispyrcrm.com`) is live; Wiser (`mail.wiserchat.ai`) is isolated in `env.wiser` and follows the Wiser go-live runbook.

Design + decisions live in the second brain: the shared platform in `~/Documents/hesham-os/wiserchat/initiatives/team-mail-portal/`, Whispyr history in `~/Documents/hesham-os/whispyr-sales/initiatives/sales-mail-portal/`.

## What changed from upstream

| Area          | Upstream                                      | This fork                                                                                 |
| ------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Outbound      | Cloudflare Email Sending (`env.EMAIL.send()`) | **AWS SES** (API v2 `SendEmail`, Simple content) via `aws4fetch`                          |
| Auth          | Cloudflare Access                             | **Email + password**, hand-rolled (PBKDF2 + JWT cookie via `jose`), roles `AGENT`/`ADMIN` |
| Authorization | None (any authed user → any mailbox)          | **Per-mailbox**: a rep sees only their mailbox; an admin sees all                         |
| Users         | implicit (Access)                             | **D1 `users` table** + `/admin/users` console                                             |
| AI model      | Kimi K2.5                                     | `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, **manual-only** (auto-draft removed)          |
| MCP (`/mcp`)  | open to any authed user                       | **per-user bearer token**; reads admin=all/agent=own, writes own-only                     |
| Bulk send     | -                                             | **CSV mail merge** with a DO alarm scheduler (`/bulk`)                                    |
| Apex landing  | -                                             | separate static site on Vercel (this Worker serves `mail.` only)                          |

## Architecture

Single Cloudflare Worker (Hono + React Router v7 SSR). Per-mailbox state in Durable Objects (SQLite via Drizzle); attachments in R2; global users in D1. Inbound via Cloudflare Email Routing (catch-all → Worker). Outbound via AWS SES (`eu-west-2`). Threading is SES-proof via an app-controlled `References` token (SES rewrites `Message-ID`).

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars.whispyr   # for Whispyr local dev
cp .dev.vars.example .dev.vars.wiser     # for Wiser local dev
npm run dev:whispyr                      # Cloudflare Access is bypassed in dev; auth gate still runs
npm run dev:wiser                        # uses only .dev.vars.wiser, not the generic file
```

Do not use one generic `.dev.vars` for both brands. Wrangler loads `.dev.vars.<environment>` exclusively when it exists, which keeps local secrets isolated by brand. `npm run typecheck`, `npm run typecheck:wiser`, `npm run verify:env:whispyr`, and `npm run verify:env:wiser` should pass before deploying brand work.

## One-time Zoho import

The admin-only importer restores exported `.eml` history into a mailbox that has
already been provisioned. It preserves dates, threads, folders, and attachments;
Trash and Spam are excluded, and re-running the same export is safe.

Keep the admin password out of command arguments. Capture it with a hidden shell
prompt, export it only for the importer process, then remove it:

```bash
read -s IMPORT_PASSWORD
export IMPORT_PASSWORD
node scripts/import-zoho.mjs \
  --base https://mail.wiserchat.ai \
  --email hesham@wiserchat.ai \
  --mailbox hello@wiserchat.ai \
  --dir ./zoho-export/hello
unset IMPORT_PASSWORD
```

Repeat for `contact@wiserchat.ai`. The driver reconciles the exact source and
result totals, and exits non-zero on any message failure, unprocessed source, or
identity collision. It derives identity locally from the exact RFC822 bytes,
maps folders locally, requires matching permanent server evidence for
no-Message-ID duplicates, and
writes a private exclusive log with a final `PASS` or `FAIL` reconciliation
summary. The full Wiser migration and live-apex closeout order is in
[`docs/wiser-go-live-runbook.md`](docs/wiser-go-live-runbook.md).

## Deploy (production runbook — Whispyr environment)

Each brand is a named Wrangler environment in `wrangler.jsonc` (`env.whispyr`, …), deployed by baking the env at build time. The steps below are the Whispyr environment; a new brand repeats them against its own resources under a new `env.<brand>` block. Prerequisites: a Cloudflare account with `whispyrcrm.com`, and the existing AWS SES production account in `eu-west-2`.

1. **D1 database**

   ```bash
   npx wrangler d1 create sales_portal_users --env whispyr
   ```

   Copy the returned `database_id` into `wrangler.jsonc` (`d1_databases[0].database_id`), then apply the schema:

   ```bash
   npx wrangler d1 migrations apply sales_portal_users --env whispyr --remote
   ```

   Migration 0010 creates the durable Agent connection-reconciliation outbox and
   lifecycle triggers required by live access revocation. Migration 0011 adds
   the idempotency ledger required by saved-view creation. Migration 0012 adds
   encrypted durable recovery intake, delivery, per-attempt provider correlation,
   event evidence, and a default-disabled D1 control. Recovery is intentionally
   unavailable when the control table or row is absent. Use the shared
   [credential-recovery rollout runbook](docs/credential-recovery-rollout-runbook.md)
   for environments where migrations 0006 through 0011 are already deployed.
   Its fixed order is code-first frozen deploy, private export/reconciliation,
   separately approved scrub, migration 0012, disabled schema proof,
   callback/secret proof, explicit enable, then end-to-end proof. Wiser's live
   ledger currently contains only migrations 0001 and 0002, so its exact
   migration-first closeout branch is documented separately in the
   [Wiser go-live runbook](docs/wiser-go-live-runbook.md).

2. **R2 bucket**

   ```bash
   npx wrangler r2 bucket create sales-mail-portal --env whispyr
   npx wrangler r2 bucket create sales-mail-portal-preview --env whispyr
   npx wrangler r2 bucket create sales-mail-raw-archive --env whispyr
   npx wrangler r2 bucket create sales-mail-raw-archive-preview --env whispyr
   npx wrangler queues create sales-mail-inbound --env whispyr --message-retention-period-secs 1209600
   npx wrangler queues create sales-mail-inbound-dlq --env whispyr --message-retention-period-secs 1209600
   npx wrangler queues create sales-mail-inbound-parking --env whispyr --message-retention-period-secs 1209600
   npx wrangler queues create sales-mail-emergency-forward --env whispyr --message-retention-period-secs 1209600
   ```

   `sales-mail-raw-archive` is the private authoritative copy of every accepted
   raw inbound message. The separate `sales-mail-portal-preview` attachment and
   `sales-mail-raw-archive-preview` raw-mail buckets prevent remote development
   from writing to either production bucket. The Queue graph is exactly
   `sales-mail-inbound` → `sales-mail-inbound-dlq` →
   `sales-mail-inbound-parking`, with the configured terminal parking consumer.
   All four Queues must use the locked 14-day retention. The dedicated
   emergency-forward Queue sends exact archived RFC 5322 streams only to the
   fixed verified destination configured by the `EMERGENCY_EMAIL` binding. Its
   R2 marker uses a 20-minute lease and generation fence, so the five-minute
   reconciler can recover expired delivery without creating multiple live
   attempts. Provider acceptance is committed to the marker before the exact
   `forwarded` receipt, allowing a receipt-CAS retry to finish without resending.
   The combined scheduled reconciliation shape is capped at 8,865 service
   subrequests per run. This bounds work but does not promise a delivery time
   during a Cron outage or sustained ingress above a lane's admitted capacity.

   Raw-archive lifecycle and Bucket Lock retention are not yet product-locked.
   Any future rule must target the exact `raw/` prefix only. It must never target
   the whole bucket or mutable `receipts/`, `system/`, cursor, marker, anomaly,
   or audit objects. Before routing live mail, choose the raw retention behavior,
   record it, obtain separate approval, and verify both that a `raw/` object is
   protected and that a receipt plus emergency marker can still be created,
   conditionally updated, and deleted. Do not copy a placeholder duration into
   production.

   For existing Queues, inspect and correct retention before deployment:

   ```bash
   npx wrangler queues info sales-mail-inbound --env whispyr
   npx wrangler queues info sales-mail-inbound-dlq --env whispyr
   npx wrangler queues info sales-mail-inbound-parking --env whispyr
   npx wrangler queues info sales-mail-emergency-forward --env whispyr
   npx wrangler r2 bucket info sales-mail-raw-archive --env whispyr
   npx wrangler r2 bucket lifecycle list sales-mail-raw-archive --env whispyr
   npx wrangler r2 bucket lock list sales-mail-raw-archive --env whispyr
   ```

   These Wrangler 4.74 commands are read-only. `queues info` confirms that each
   Queue exists, but it does not prove the locked 14-day retention or the
   deployed consumer settings. Verify retention in the Cloudflare control plane
   and verify consumer settings and edges in the rebuilt deployment artifact.
   Queue creation or updates, and any R2 lifecycle or Bucket Lock mutation, are
   separately approval-gated. After approval, existing Queue retention is set
   with:

   ```bash
   npx wrangler queues update sales-mail-inbound --env whispyr --message-retention-period-secs 1209600
   npx wrangler queues update sales-mail-inbound-dlq --env whispyr --message-retention-period-secs 1209600
   npx wrangler queues update sales-mail-inbound-parking --env whispyr --message-retention-period-secs 1209600
   npx wrangler queues update sales-mail-emergency-forward --env whispyr --message-retention-period-secs 1209600
   ```

3. **Secrets**

   ```bash
   npx wrangler secret put AWS_ACCESS_KEY_ID --env whispyr       # SES IAM user (ses:SendEmail)
   npx wrangler secret put AWS_SECRET_ACCESS_KEY --env whispyr
   npx wrangler secret put SES_EVENT_WEBHOOK_SECRET --env whispyr
   npx wrangler secret put CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1 --env whispyr
   npx wrangler secret put JWT_SECRET --env whispyr              # openssl rand -base64 48
   npx wrangler secret put ADMIN_BOOTSTRAP_EMAIL --env whispyr   # e.g. hesham@whispyrcrm.com
   npx wrangler secret put ACCOUNT_RECOVERY_DIRECTORY --env whispyr
   npx wrangler secret put VAPID_PUBLIC_KEY --env whispyr
   npx wrangler secret put VAPID_PRIVATE_KEY --env whispyr
   ```

   `ACCOUNT_RECOVERY_DIRECTORY` is a platform-operator managed JSON object. The
   exact key `"*"` supplies the default external recovery email when no normalized
   portal-email key matches; an exact entry overrides the default. For example:
   `{"*":"owner@personal.example"}`. Application administrators cannot enter or
   change these addresses. New users remain pending
   until they consume the emailed setup link; claimed users request recovery from
   the sign-in page and receive a generic response that does not reveal account
   existence.
   `CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1` is a separate high-entropy encryption
   key for durable recovery jobs. It is not the JWT signing secret. Keep this
   V1 value available without rotation or deletion while any request or
   delivery ciphertext created with key version 1 exists. A future rotation
   requires a new versioned binding and an explicit decrypt/re-encrypt plan.
   `AWS_REGION` and `DOMAINS` are plain vars already set in `wrangler.jsonc`.
   Before deployment, verify `heshamelmahdi@gmail.com` as an Email Routing
   destination and onboard `emergency-forward@whispyrcrm.com` as an allowed
   Email Service sender. The binding and Worker var both pin the destination;
   `EMERGENCY_FORWARD_DESTINATION` is the single pinned authority used by both
   raw-first ingress `forward()` and post-ingress Email Service delivery.

4. **Deploy** — provisions the Worker and the `mail.whispyrcrm.com` custom domain (the `routes` entry in `env.whispyr`). The script holds an atomic local lock across build, resolved-artifact verification, and deploy. It rejects config/environment overrides and invokes Wrangler only with `--config build/server/wrangler.json`:

   ```bash
   npm run deploy:whispyr
   ```

5. **Inbound — Cloudflare Email Routing** (dashboard → `whispyrcrm.com` → Email Routing): enable it (accept the MX records), then add a **catch-all** rule that delivers to this Worker.

6. **Outbound — AWS SES** (`eu-west-2`): add `whispyrcrm.com` as a verified domain identity. SES issues 3 DKIM CNAMEs — add them to Cloudflare DNS. Configure the brand-filtered SES configuration-set, EventBridge API Destination, bearer Connection, retry/DLQ, alarms, exact callback proof, and synthetic canary from the shared [credential-recovery rollout runbook](docs/credential-recovery-rollout-runbook.md). Then add:
   - `TXT whispyrcrm.com` → `v=spf1 include:amazonses.com include:_spf.mx.cloudflare.net -all`
   - `TXT _dmarc.whispyrcrm.com` → `v=DMARC1; p=quarantine; rua=mailto:hesham@whispyrcrm.com`

7. **First admin** — visit `https://mail.whispyrcrm.com/login` and sign in with `ADMIN_BOOTSTRAP_EMAIL` + a password (≥12 chars). With zero users, this bootstraps the first `ADMIN` account and provisions its mailbox. Then create reps at `/admin/users`.

8. **MCP (optional)** - connect through the OAuth flow at `https://mail.whispyrcrm.com/mcp`. A connection can access only the Personal and Shared Mailboxes available to that live user. Mail tools are limited to read, search, and reviewable Draft creation; sending and destructive actions stay in the portal.

## Deploy (production runbook - Wiser environment)

Wiser has its own named Wrangler environment, resources, secrets, SES identity, and DNS/routing sequence. Use [`docs/wiser-go-live-runbook.md`](docs/wiser-go-live-runbook.md) for the full launch checklist and the shared [`docs/credential-recovery-rollout-runbook.md`](docs/credential-recovery-rollout-runbook.md) for the mandatory both-brand recovery sequence.

## License

Apache 2.0 — see [LICENSE](LICENSE). Based on [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox).
