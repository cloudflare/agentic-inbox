# Wiser Team Mail Portal Go-Live Runbook

This runbook is for WISER-242, the Wiser deployment of the shared Mail Portal codebase. It intentionally separates local verification from production mutations. Do not run the production-changing steps until the exact target and action have been approved.

## Production Shape

- App domain: `mail.wiserchat.ai`
- Inbound mail domain: `wiserchat.ai`. The apex Email Routing and MX are already active. No temporary test domain is used.
- Human users: `hesham@wiserchat.ai` (ADMIN/personal) and `ibrahem@wiserchat.ai` (AGENT/personal)
- Shared Mailboxes: `hello@wiserchat.ai` and `contact@wiserchat.ai`
- Unknown recipients: permanent SMTP reject via the Worker email handler
- Cloudflare Worker: `wiser-mail-portal`
- D1 database: `wiser_mail_portal_users` (`87c3de98-d31b-4ec3-8e05-d26b4dc71d92`)
- Attachment R2 bucket: `wiser-mail-portal`
- Isolated attachment development preview bucket: `wiser-mail-portal-preview`
- Authoritative raw-mail R2 bucket: `wiser-mail-raw-archive`
- Isolated raw-mail development preview bucket: `wiser-mail-raw-archive-preview`
- Inbound Queue: `wiser-mail-inbound`
- Dead-letter Queue: `wiser-mail-inbound-dlq`
- Terminal-ledger parking Queue: `wiser-mail-inbound-parking`
- Automatic post-ingress emergency Queue: `wiser-mail-emergency-forward`
- Archive reconciler: every five minutes
- OAuth KV namespace: `wiser-mail-portal-oauth` (`c934d803c2f8430d9088f4a5d9f29d55`)
- AWS region: `eu-west-2`
- SES identity: `wiserchat.ai`

## Ordered Launch Path

The closeout has three ordered stages. Do not interleave them:

1. Complete local verification and read-only production inventory while the
   active apex route remains unchanged.
2. Execute only the separately approved resource provisioning, D1 migrations,
   Worker deployment, Shared Mailbox transition, secrets cleanup, and production
   canaries in the exact order below.
3. Validate the already-live apex, reconcile Zoho history, then run the clean
   two-user 72-hour pilot with Hesham and Ibrahem.

## Approval Gates

Each of these is a separate production mutation and needs explicit approval before execution:

1. Create any missing Wiser R2 bucket or Queue, or update the locked 14-day
   Queue retention.
2. Apply remote D1 migrations to `wiser_mail_portal_users`.
3. Deploy `wiser-mail-portal`.
4. Run the Wiser role-account to Shared Mailbox transition.
5. Create, update, or delete Worker production secrets.
6. Create or update the dedicated Wiser SES IAM credentials.
7. Run the both-brand email authorization canary. Approval must name the two
   temporary Workers, two temporary KV namespaces, two temporary exact-address
   Email Routing rules, eight emails, and automatic cleanup.
8. Create or change the Cloudflare custom domain, DNS, or permanent Email
   Routing records. No such change is currently planned.
9. Import Zoho exports into production Shared Mailboxes.
10. Disable or delete Zoho mailboxes/routing after final reconciliation.
11. Push a deployment branch, create or merge a PR, or change the deployed branch.

## Stage 1: Local Verification And Read-Only Production Inventory

### Local Preflight

Run these before any production mutation:

```bash
npm install
npm run assets:wiser
npm test
npm run test:workerd:inbound-exact-size
npm run typecheck
npm run typecheck:wiser
npm run verify:env:whispyr
npm run verify:env:wiser
npm run deploy:whispyr -- --dry-run --outdir /tmp/mail-portal-dry-run/whispyr
npm run deploy:wiser -- --dry-run --outdir /tmp/mail-portal-dry-run/wiser
```

The exact-size workerd proof is mandatory before either dry-run. A sandbox that
cannot bind its listener is an environmental failure, not a waiver. Run it on an
approved host where workerd can bind and record the passing result.

Each `verify:env` command holds the exact shared primary/guard artifact lock while
rebuilding, copies the complete fresh build into a private immutable staging
directory, and inspects that staged configuration. The deployment driver prints
bounded progress and owns detailed `script-logs/environment-artifact-*` and
verifier logs. Concurrent Whispyr/Wiser artifact operations fail closed. The Wiser
artifact must contain only `wiser-mail-portal`, `wiser_mail_portal_users`, the
isolated `wiser-mail-portal`/`wiser-mail-portal-preview` attachment bucket pair,
the isolated `wiser-mail-raw-archive`/`wiser-mail-raw-archive-preview` pair, the four Wiser
Queues, Wiser OAuth KV, Workers AI, the three Durable Object bindings, and the
single `mail.wiserchat.ai` route. `DOMAINS` must be exactly `wiserchat.ai` with no
`test.wiserchat.ai` reference. Scheduled triggers must be exactly `* * * * *`,
`*/5 * * * *`, and `17 * * * *`. Each dry-run must use the exact generated
configuration and contain no resource belonging to the other brand.

### Exact Wiser Migration Branch

The live Wiser D1 ledger contains only migrations 0001 and 0002. This exact
baseline must not follow the shared runbook's code-first branch because the
final Worker reads tables introduced by migrations 0003 through 0012. Confirm
the remote pending list before requesting a migration write:

```bash
npx wrangler d1 migrations list DB --env wiser --remote
```

The pending list must be exactly:

```text
0003_create_mailbox_access.sql
0004_create_ai_cost_controls.sql
0005_auth_security.sql
0006_credential_recovery.sql
0007_create_saved_views.sql
0008_create_follow_up_reminders.sql
0009_create_global_today_brief_claims.sql
0010_create_agent_connection_revocations.sql
0011_create_saved_view_create_operations.sql
0012_create_credential_recovery_jobs.sql
```

If the ledger differs, stop. Do not manually execute migration files or edit the
Wrangler migration ledger.

For this exact 0001 and 0002 baseline, migration 0006 creates
`users.recovery_email` as `NULL` for every existing row, so migration 0012's
legacy-destination guard remains zero without a destructive scrub. The private
legacy export and scrub branch in the shared credential-recovery runbook applies
only to an environment where migration 0006 is already present and non-null
legacy destinations can exist.

During the separately approved migration and deploy window, freeze login,
account administration, and user creation. Then run the following in order:

```bash
npx wrangler d1 migrations apply DB --env wiser --remote
npx wrangler d1 migrations list DB --env wiser --remote
npx wrangler d1 execute DB --env wiser --remote --command \
  "SELECT control_id, enabled FROM credential_recovery_control ORDER BY control_id"
npm run deploy:wiser
npm run transition:wiser-shared-mailboxes
```

The second migration-list command must report no pending migrations, and the
control query must return exactly `global | 0`. The transition command is
read-only preflight. After separate approval naming the Wiser production D1
transition, apply it:

```bash
npm run transition:wiser-shared-mailboxes -- \
  --apply \
  --confirm transition-wiser-role-mailboxes
```

The transition keeps `hello@wiserchat.ai` and `contact@wiserchat.ai` as
permanently inactive credential tombstones, converts their canonical Personal
Mailboxes to Shared Mailboxes, and grants both Shared Mailboxes to
`hesham@wiserchat.ai` and `ibrahem@wiserchat.ai`. It preserves immutable audit
and unrelated data. Do not create a third user. If the command reports
`COMMITTED cleanup pending`, allow the minutely Cron to drain exact Agent
revocations and rerun the read-only preflight until it reports `PASS`.

After this Wiser-specific migration and deploy branch is complete, use the
shared [credential-recovery rollout runbook](credential-recovery-rollout-runbook.md)
for AWS callback proof, independent monitoring, explicit recovery-control enable,
and end-to-end recovery proof. Migration 0012 is never paired with an immediate
enable. A missing or unreadable control remains disabled.

### Scheduled Maintenance

The deployment artifact must contain exactly three schedules:

- `* * * * *` drains durable Agent connection-reconciliation work. Work that
  fails during the invocation or remains immediately due fails that Cron turn,
  while the D1 outbox retains future-backoff items for later retries. Monitor the
  outbox separately because deferred work does not make every interim turn fail.
  When credential recovery control is disabled or unreadable, this same Cron
  still drains agent work but does not access any recovery request, delivery,
  attempt, event, or retention table.
- `*/5 * * * *` reconciles authoritative raw R2 receipts with Queue and Mailbox
  projection state. It repairs safe gaps and durably records anomalies that need
  operator review.
- `17 * * * *` deletes expired AI response-cache rows in bounded batches. A
  remaining backlog fails the invocation instead of being hidden.

After an approved deploy, inspect Cron Trigger invocation logs without exposing
mail content or credentials. Verify all three schedules invoke the Worker and that
`agent_connection_revocations` reaches zero after an approved disposable
revocation drill. Do not modify a real user's credentials solely to create this
probe.

### Read-Only Cloudflare Inventory

Before requesting any production mutation, run the Wrangler 4.74 read-only
inspection commands:

```bash
npx wrangler r2 bucket info wiser-mail-portal --env wiser
npx wrangler r2 bucket info wiser-mail-portal-preview --env wiser
npx wrangler r2 bucket info wiser-mail-raw-archive --env wiser
npx wrangler r2 bucket info wiser-mail-raw-archive-preview --env wiser
npx wrangler r2 bucket lifecycle list wiser-mail-raw-archive --env wiser
npx wrangler r2 bucket lock list wiser-mail-raw-archive --env wiser
npx wrangler queues info wiser-mail-inbound --env wiser
npx wrangler queues info wiser-mail-inbound-dlq --env wiser
npx wrangler queues info wiser-mail-inbound-parking --env wiser
npx wrangler queues info wiser-mail-emergency-forward --env wiser
npx wrangler secret list --env wiser --format json
```

Both attachment buckets must exist before any remote Wiser development session.
If `wiser-mail-portal-preview` is missing, obtain the separate R2 provisioning
approval from gate 1, then create exactly that bucket before running the remote
preview. Never substitute `wiser-mail-portal`, because that is the production
attachment store.

The exact Queue graph is `wiser-mail-inbound` → `wiser-mail-inbound-dlq` →
`wiser-mail-inbound-parking`. The primary and DLQ consumers each use batch size
1, concurrency 1, batch timeout 5 seconds, and 10 retries; their retry delays are
1 and 60 seconds. The parking consumer uses batch size 1, concurrency 1, batch
timeout 5 seconds, 100 retries, and a 3600-second delay, with no further DLQ.
All four Queues are product-locked to 14-day retention. The emergency consumer
uses batch size 1, concurrency 1, 100 platform retries, and a five-minute retry
delay. Its durable R2 active marker carries a 20-minute lease and monotonically
increasing generation. The independent five-minute scan admits at most eight
markers, skips live leases, and re-enqueues only a new generation after expiry.
Older Queue deliveries acknowledge as stale, so overlapping Queue retry and
Cron recovery cannot create more than one live delivery generation.

`wrangler queues info` proves that a Queue exists, but it cannot prove retention
or consumer settings. The current read-only inventory shows the Wiser primary,
DLQ, and parking Queues but not `wiser-mail-emergency-forward`. After separate
approval naming the missing Queue and all four retention updates, run:

```bash
npx wrangler queues create wiser-mail-emergency-forward \
  --env wiser \
  --message-retention-period-secs 1209600
npx wrangler queues update wiser-mail-inbound \
  --env wiser \
  --message-retention-period-secs 1209600
npx wrangler queues update wiser-mail-inbound-dlq \
  --env wiser \
  --message-retention-period-secs 1209600
npx wrangler queues update wiser-mail-inbound-parking \
  --env wiser \
  --message-retention-period-secs 1209600
npx wrangler queues update wiser-mail-emergency-forward \
  --env wiser \
  --message-retention-period-secs 1209600
```

Repeat all four `queues info` commands afterward. The rebuilt artifact verifier
proves the configured consumer settings and edges. The Cloudflare control plane
must show 14-day retention for every Queue before deploy.

The current `wiser-mail-raw-archive` inventory has an enabled indefinite Bucket
Lock on `raw/`. Verify that state before and after closeout and do not change it
as part of this run. Any future lifecycle or Bucket Lock change needs a new
decision and separate approval, must use the exact `raw/` prefix, and must never
cover `receipts/`, `system/`, cursors, markers, anomalies, or audits.

### AWS SES

`wiserchat.ai` must remain verified in SES `eu-west-2`, with DKIM successful, account out of sandbox, and custom MAIL FROM `mail.wiserchat.ai` successful before launch.

Create a dedicated Wiser IAM access key with least privilege for SES send only. The policy should allow `ses:SendEmail` against the Wiser SES identity and should restrict From addresses to `*@wiserchat.ai` where AWS condition keys are available. Do not reuse Whispyr SES keys.

Configure and prove the Wiser source-domain EventBridge rule, API Destination,
bearer Connection, 24-hour/185-attempt retry envelope, SQS DLQ, CloudWatch alarms,
exact callback, and five-minute synthetic callback canary using the shared
[credential-recovery rollout runbook](credential-recovery-rollout-runbook.md).

Production secrets required by `env.wiser`:

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
SES_EVENT_WEBHOOK_SECRET
CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1
JWT_SECRET
ADMIN_BOOTSTRAP_EMAIL
ACCOUNT_RECOVERY_DIRECTORY
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
```

Use `ADMIN_BOOTSTRAP_EMAIL=hesham@wiserchat.ai`. Generate `JWT_SECRET` with at least 48 random base64 bytes. Generate separate high-entropy `SES_EVENT_WEBHOOK_SECRET` and `CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1` values. The V1 payload key encrypts durable recovery jobs and creates opaque correlation refs. It must remain separate from `JWT_SECRET` and must not be rotated in place or deleted while any version-1 ciphertext exists. A future rotation needs a new versioned key binding and an explicit decrypt/re-encrypt rollout. Store `{"*":"heshamelmahdi@gmail.com"}` in `ACCOUNT_RECOVERY_DIRECTORY`; the exact `"*"` key covers every portal address without an exact override. Generate one VAPID keypair for Wiser push.

### First Deploy And Secrets

Wrangler validates `secrets.required` on deploy. For the first production deploy, use a temporary secrets file so the Worker is deployed with its required secrets in one operation:

```bash
set -euo pipefail
set +x
REQUIRED_SECRET_NAMES=(
ACCOUNT_RECOVERY_DIRECTORY
ADMIN_BOOTSTRAP_EMAIL
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1
JWT_SECRET
SES_EVENT_WEBHOOK_SECRET
VAPID_PRIVATE_KEY
VAPID_PUBLIC_KEY
)
SECRETS_FILE=""
SECRETS_DIRECTORY=""
cleanup_secrets_file() {
  unset SECRET_NAME SECRET_VALUE
  for SECRET_NAME in "${REQUIRED_SECRET_NAMES[@]}"; do
    unset "$SECRET_NAME"
  done
  unset SECRET_NAME
  if [ -n "${SECRETS_FILE:-}" ] &&
    { [ -e "$SECRETS_FILE" ] || [ -L "$SECRETS_FILE" ]; }; then
    rm -- "$SECRETS_FILE"
  fi
  SECRETS_FILE=""
  if [ -n "${SECRETS_DIRECTORY:-}" ] && [ -d "$SECRETS_DIRECTORY" ]; then
    rmdir -- "$SECRETS_DIRECTORY"
  fi
  SECRETS_DIRECTORY=""
}
abort_secret_deploy() {
  SIGNAL_STATUS="$1"
  trap - EXIT HUP INT TERM
  cleanup_secrets_file
  exit "$SIGNAL_STATUS"
}
create_private_secrets_envelope() (
  set -euo pipefail
  set +x
  cleanup_prompt_secrets() {
    unset SECRET_NAME SECRET_VALUE
    for SECRET_NAME in "${REQUIRED_SECRET_NAMES[@]}"; do
      unset "$SECRET_NAME"
    done
    unset SECRET_NAME
  }
  abort_secret_prompt() {
    SIGNAL_STATUS="$1"
    trap - EXIT HUP INT TERM
    cleanup_prompt_secrets
    exit "$SIGNAL_STATUS"
  }
  trap cleanup_prompt_secrets EXIT
  trap 'abort_secret_prompt 129' HUP
  trap 'abort_secret_prompt 130' INT
  trap 'abort_secret_prompt 143' TERM

  for SECRET_NAME in "${REQUIRED_SECRET_NAMES[@]}"; do
    printf 'Enter %s: ' "$SECRET_NAME" >&2
    if ! IFS= read -r -s SECRET_VALUE </dev/tty; then
      printf '\nSecret prompt failed before envelope creation.\n' >&2
      exit 1
    fi
    printf '\n' >&2
    test -n "$SECRET_VALUE"
    export "$SECRET_NAME=$SECRET_VALUE"
    unset SECRET_VALUE
  done

  CREATED_SECRETS_FILE="$(node scripts/create-secrets-envelope.mjs wiser)"
  cleanup_prompt_secrets
  printf '%s\n' "$CREATED_SECRETS_FILE"
)

# The operator shell starts clean. Prompt values and exports exist only in the
# command-substitution process; the parent receives only the created path.
cleanup_secrets_file
trap cleanup_secrets_file EXIT
trap 'abort_secret_deploy 129' HUP
trap 'abort_secret_deploy 130' INT
trap 'abort_secret_deploy 143' TERM
if ! SECRETS_FILE="$(create_private_secrets_envelope)"; then
  printf 'Secret envelope creation failed.\n' >&2
  exit 1
fi
SECRETS_DIRECTORY="$(dirname -- "$SECRETS_FILE")"

npm run deploy:wiser -- --secrets-file "$SECRETS_FILE"
cleanup_secrets_file
SECRETS_FILE=""
SECRETS_DIRECTORY=""
trap - EXIT HUP INT TERM
```

The temporary file must remain an owned regular non-symlink single-link 0600
JSON envelope with exact schema version 1, exact brand `wiser`, and exactly the
nine non-empty string secrets above. The deployment driver validates and
snapshots it, then gives Wrangler only a derived 0400 secret map in a private
0700 temporary directory that is removed on success or failure. Do not commit
the envelope, paste it into tickets, or store it in the repo. `.secrets*` is
ignored as an extra local guard, but `/tmp` is preferred. Paste
`ACCOUNT_RECOVERY_DIRECTORY` as the exact compact single-line JSON object above
without outer quotes or manual escaping. The creator JSON-encodes that mapping
as an outer envelope string and prints only the unpredictable path.
Run the block as a Bash process, never source it into an interactive shell. The
hidden prompt and every secret export live only in an isolated
command-substitution process. Failed input, `HUP`, `INT`, and `TERM` unset all
nine names and exit nonzero. Before path handoff, the creator waits for any
issued file operation to settle, closes the handle, removes the file and
directory, then re-raises the original `HUP`, `INT`, or `TERM`. Once the parent
receives the path, its own signal handlers remove the envelope and directory
before terminating.

For secret rotation after the Worker exists, use:

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID --env wiser
npx wrangler secret put AWS_SECRET_ACCESS_KEY --env wiser
npx wrangler secret put SES_EVENT_WEBHOOK_SECRET --env wiser
npx wrangler secret put CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1 --env wiser
npx wrangler secret put JWT_SECRET --env wiser
npx wrangler secret put ADMIN_BOOTSTRAP_EMAIL --env wiser
npx wrangler secret put ACCOUNT_RECOVERY_DIRECTORY --env wiser
npx wrangler secret put VAPID_PUBLIC_KEY --env wiser
npx wrangler secret put VAPID_PRIVATE_KEY --env wiser
```

Note: `wrangler secret put` creates and deploys a new Worker version immediately. Use `wrangler versions secret put` only if we deliberately move to staged Workers versions/gradual deployments.

After the approved deploy, inventory names without reading values:

```bash
npx wrangler secret list --env wiser --format json
```

The final set must contain exactly the nine required names above. If an obsolete
name remains, identify it in a separate secret-deletion approval, then delete
only that exact name:

```bash
EXACT_OBSOLETE_SECRET="${EXACT_OBSOLETE_SECRET:?set one separately approved obsolete secret name}"
npx wrangler secret delete "$EXACT_OBSOLETE_SECRET" --env wiser
npx wrangler secret list --env wiser --format json
unset EXACT_OBSOLETE_SECRET
```

Never delete a required name, and never infer obsolescence from age alone.

### HTTP Smoke Test

After deploy:

```bash
curl -I https://mail.wiserchat.ai/login
curl -s https://mail.wiserchat.ai/manifest.webmanifest
```

The manifest must use Wiser icons and Wiser theme values. The login page must render Wiser branding, not Whispyr.

### Human Users And Shared Mailboxes

1. Visit `https://mail.wiserchat.ai/login`.
2. Sign in as `hesham@wiserchat.ai`.
3. Confirm `/admin/users` shows the two human accounts,
   `hesham@wiserchat.ai` and `ibrahem@wiserchat.ai`. The inactive role-account
   tombstones must not appear as manageable users.
4. Confirm both humans can open `hello@wiserchat.ai` and
   `contact@wiserchat.ai` as Shared Mailboxes.
5. Confirm neither role address can authenticate and no non-launch Mailbox
   exists.

Do not add another account to satisfy the pilot. Do not create a third user.

### Outbound Proof

From the production UI, send:

- `hesham@wiserchat.ai` to an external mailbox.
- `hello@wiserchat.ai` to an external mailbox.
- `contact@wiserchat.ai` to an external mailbox.
- A reply from one Wiser mailbox to a received thread.

Confirm SPF, DKIM, and DMARC pass in the external recipient headers. Confirm sent mail appears in the correct mailbox and does not leak across mailboxes.

### Push Proof

Use the repository's Playwright runner at desktop and mobile widths to verify
the notification controls, permission states, subscription persistence, Wiser
assets, and disabled state. Playwright cannot prove delivery of an
operating-system push notification.

Complete the live proof on a real subscribed desktop or mobile device:

1. Enable notifications from `mail.wiserchat.ai` and confirm the subscription
   appears in the product.
2. Put the portal in the background, send one uniquely referenced message to a
   Shared Mailbox, and confirm one notification appears on the intended device.
3. Open it and confirm it returns to the correct Wiser Mailbox without exposing
   content from another Mailbox.
4. Disable notifications in the product, send a second uniquely referenced
   message, and confirm mail still arrives but no later push is delivered.

### Email Authorization Boundary Canary

This canary proves both Cloudflare mechanisms for both brands at 5.1 MiB and at
the established 24,960,359-byte near-limit fixture. It sends exactly eight
uniquely identified messages:

- Wiser `message.forward()` at both sizes.
- Wiser `send_email` at both sizes.
- Whispyr `message.forward()` at both sizes.
- Whispyr `send_email` at both sizes.

The operator token needs only the scoped Cloudflare permissions required to
read Email Routing state and verified addresses and to create and remove
temporary Workers, KV namespaces, and Email Routing rules. The AWS identity
needs SES v2 `SendEmail` for the two verified source domains in `eu-west-2`.
Load the exact account and zone identifiers, then enter credentials without
printing them:

```bash
set +x
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:?set the exact Cloudflare account ID}"
export CLOUDFLARE_WISER_ZONE_ID="${CLOUDFLARE_WISER_ZONE_ID:?set the wiserchat.ai zone ID}"
export CLOUDFLARE_WHISPYR_ZONE_ID="${CLOUDFLARE_WHISPYR_ZONE_ID:?set the whispyrcrm.com zone ID}"
export AWS_REGION=eu-west-2
printf 'Cloudflare API token: ' >&2
IFS= read -r -s CLOUDFLARE_API_TOKEN </dev/tty
printf '\nAWS access key ID: ' >&2
IFS= read -r -s AWS_ACCESS_KEY_ID </dev/tty
printf '\nAWS secret access key: ' >&2
IFS= read -r -s AWS_SECRET_ACCESS_KEY </dev/tty
printf '\n' >&2
export CLOUDFLARE_API_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
npm run canary:email-authorization
```

The no-argument command is read-only preflight. It verifies both zones, the
fixed destination, free routing-rule capacity, and absence of every generated
resource name. It performs no sends and creates nothing.

After same-turn approval naming both brands, two temporary Workers, two
temporary KV namespaces, two temporary exact-address Email Routing rules,
eight emails, and automatic cleanup, run:

```bash
npm run canary:email-authorization -- \
  --apply --confirm run-email-authorization-canary
CANARY_STATUS="$?"
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
unset CLOUDFLARE_WISER_ZONE_ID CLOUDFLARE_WHISPYR_ZONE_ID
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION
test "$CANARY_STATUS" -eq 0
unset CANARY_STATUS
```

Each brand's rule is created disabled, read back, enabled only for the two
forward probes, disabled, and deleted before the `send_email` probes. The script
does not retry an ambiguous SES, forward, or send operation. On failure or
interruption it stops new probes, disables and deletes the exact temporary
rule, removes the temporary Worker and KV namespace, and verifies the original
rule list and catch-all are unchanged.

Provider `messageId` evidence proves acceptance, not final inbox delivery.
For forward probes, the private log records both the exact submitted fixture
size and Cloudflare's observed raw size. SES replaces transport headers, so the
observed size must remain within the script's bounded transport delta rather
than equal the submitted bytes.
Confirm all eight probe IDs arrived at `heshamelmahdi@gmail.com`, inspect their
SPF, DKIM, and DMARC results, and attach the private log plus the eight
privacy-safe probe IDs to the production evidence. Email Routing may label a
successful `send_email` operation as dropped, so use Email Sending evidence and
the external inbox, not that Routing label.

### Credential Recovery Proof And Monitoring

The authoritative both-brand procedure, AWS graph, enable gate, exact proof,
aggregate SLA queries, and roll-forward rollback are in the shared
[credential-recovery rollout runbook](credential-recovery-rollout-runbook.md).
The Wiser proof below is an additional launch checklist, not an alternative
sequence.

Use an approved disposable production account whose external destination is in
`ACCOUNT_RECOVERY_DIRECTORY`. Request recovery from the public page and require
all of the following before recovery enable or pilot start:

1. The public response is the same generic 202 shape for an eligible address and
   for an unknown address.
2. The eligible request produces one external recovery message with the expected
   Wiser sender and a single-use HTTPS link on `mail.wiserchat.ai`.
3. The link sets a new password, invalidates prior sessions and MCP credentials,
   and cannot be consumed a second time.
4. The delivery outbox reaches `accepted`; the matching attempt reaches
   `accepted`; an SES delivery, bounce, or complaint callback is recorded once
   per event ID. Do not interpret the absence of a callback as proof that the
   provider rejected the send.
5. A retry or timeout drill is complete only when the same durable request or
   delivery remains pending, becomes terminal with an operator error code, or
   later exact SES evidence promotes the preserved attempt to accepted. Never
   delete or manually rewrite request, delivery, attempt, or event rows.

Use only these aggregate read-only queries for routine inspection. They select
no account, destination, token, ciphertext, provider message ID, delivery ID, or
attempt ID:

```bash
npx wrangler d1 execute DB --env wiser --remote --command "SELECT state, COUNT(*) AS count FROM credential_recovery_request_jobs GROUP BY state ORDER BY state"
npx wrangler d1 execute DB --env wiser --remote --command "SELECT state, COUNT(*) AS count FROM credential_recovery_delivery_outbox GROUP BY state ORDER BY state"
npx wrangler d1 execute DB --env wiser --remote --command "SELECT state, COUNT(*) AS count FROM credential_recovery_delivery_attempts GROUP BY state ORDER BY state"
npx wrangler d1 execute DB --env wiser --remote --command "SELECT event_type, COUNT(*) AS count FROM credential_recovery_delivery_events WHERE recorded_at >= unixepoch('now', '-24 hours') * 1000 GROUP BY event_type ORDER BY event_type"
npx wrangler d1 execute DB --env wiser --remote --command "SELECT last_error_code, COUNT(*) AS count FROM credential_recovery_request_jobs WHERE state IN ('pending', 'expired', 'parked') GROUP BY last_error_code ORDER BY last_error_code"
npx wrangler d1 execute DB --env wiser --remote --command "SELECT last_error_code, COUNT(*) AS count FROM credential_recovery_delivery_outbox WHERE state IN ('pending', 'cancelled', 'expired', 'parked') GROUP BY last_error_code ORDER BY last_error_code"
npx wrangler d1 execute DB --env wiser --remote --command "SELECT COUNT(*) AS stale_dispatches FROM credential_recovery_delivery_outbox WHERE state = 'dispatching' AND lease_expires_at < unixepoch('now') * 1000"
npx wrangler d1 execute DB --env wiser --remote --command "SELECT COUNT(*) AS ambiguous_attempts_over_sla FROM credential_recovery_delivery_attempts WHERE state = 'ambiguous' AND updated_at <= (unixepoch('now') - 300) * 1000"
npx wrangler d1 execute DB --env wiser --remote --command "SELECT (SELECT COUNT(*) FROM credential_recovery_request_jobs WHERE state IN ('pending', 'leased') AND created_at <= (unixepoch('now') - 300) * 1000) AS pending_requests_over_5_minutes, (SELECT COUNT(*) FROM credential_recovery_delivery_outbox WHERE state IN ('pending', 'leased', 'dispatching') AND created_at <= (unixepoch('now') - 300) * 1000) AS pending_deliveries_over_5_minutes"
npx wrangler d1 execute DB --env wiser --remote --command "SELECT (SELECT COUNT(*) FROM credential_recovery_request_jobs WHERE state IN ('pending', 'leased') AND last_error_code IS NOT NULL AND last_error_code NOT IN ('SES_TRANSPORT_AMBIGUOUS', 'SES_INVALID_SUCCESS_RESPONSE')) AS active_request_non_ambiguous_errors, (SELECT COUNT(*) FROM credential_recovery_delivery_outbox WHERE state IN ('pending', 'leased', 'dispatching') AND last_error_code IS NOT NULL AND last_error_code NOT IN ('SES_TRANSPORT_AMBIGUOUS', 'SES_INVALID_SUCCESS_RESPONSE')) AS active_delivery_non_ambiguous_errors, (SELECT COUNT(*) FROM (SELECT attempts.outbox_id FROM credential_recovery_delivery_attempts attempts JOIN credential_recovery_delivery_outbox outbox ON outbox.id = attempts.outbox_id WHERE attempts.state = 'http_rejected' AND outbox.state IN ('pending', 'leased', 'dispatching') GROUP BY attempts.outbox_id HAVING COUNT(*) >= 2)) AS active_deliveries_with_repeated_http_rejections"
npx wrangler d1 execute DB --env wiser --remote --command "SELECT COUNT(*) AS over_age_requests FROM credential_recovery_request_jobs WHERE state IN ('pending', 'leased') AND created_at <= (unixepoch('now') - 86400) * 1000"
npx wrangler d1 execute DB --env wiser --remote --command "SELECT (SELECT COUNT(*) FROM credential_recovery_request_jobs WHERE state = 'parked' AND payload_ciphertext IS NOT NULL AND completed_at <= (unixepoch('now') - 604800) * 1000) AS stale_request_ciphertexts, (SELECT COUNT(*) FROM credential_recovery_delivery_outbox WHERE state = 'parked' AND payload_ciphertext IS NOT NULL AND completed_at <= (unixepoch('now') - 604800) * 1000) AS stale_delivery_ciphertexts"
```

Page on any parked job, any dispatching lease past its stored expiry, every
attempt that remains ambiguous after five minutes even if a sibling attempt was
later accepted, either independent request or delivery age aggregate after five
minutes, any active delivery with two `http_rejected` attempts, a pending
request older than 24 hours, retained parked ciphertext older than seven days,
or a minutely maintenance failure. Page an active non-ambiguous error aggregate
on its third consecutive positive one-minute poll and clear only after two
consecutive zero polls. Safe test pages and clears must cover `SES_HTTP_503`,
`SES_NOT_DISPATCHED`, `PAYLOAD_KEY_UNAVAILABLE`, and
`RECOVERY_DIRECTORY_INVALID_CONFIG` before recovery is enabled. `UNMAPPED`
means an eligible portal address lacks a directory entry. `INVALID_CONFIG`
means the directory secret itself is malformed or violates its closed limits.
They require different operator action and must not be collapsed into one outage
code.

### Zoho Import

Export each Zoho mailbox as `.eml`. Keep exports outside the repo. Import only after the corresponding production mailbox exists:

```bash
read -s IMPORT_PASSWORD
export IMPORT_PASSWORD
node scripts/import-zoho.mjs \
  --base https://mail.wiserchat.ai \
  --email hesham@wiserchat.ai \
  --mailbox hello@wiserchat.ai \
  --dir /path/to/zoho-export/hello
unset IMPORT_PASSWORD
```

Repeat for `contact@wiserchat.ai`. The approved history scope is only `hello@wiserchat.ai` and `contact@wiserchat.ai`; importing `hesham@wiserchat.ai` requires a new explicit product decision. Re-running the same export is safe; the importer is expected to skip duplicates. Reconcile counts by folder, spot-check attachments, and confirm Trash/Spam are excluded.

The endpoint hashes the exact uploaded RFC822 bytes before parsing. Messages
with an RFC `Message-ID` keep the existing mailbox-scoped Message-ID identity.
Messages without one use the mailbox-scoped exact raw SHA-256, so any header,
body, MIME, or attachment-byte difference is a distinct source message while a
byte-identical rerun remains idempotent. The old parsed-field fallback is not
consulted for no-Message-ID history because it cannot prove a duplicate; if an
export was already imported by an older build, a one-time duplicate is safer
than silently dropping a distinct message.

When a no-Message-ID import claim wins, the same Mailbox transaction permanently
reserves its exact raw SHA-256 under the derived portal ID before promotion
starts. Busy, existing, or integrity-blocked losers cannot create a reservation.
This authority survives a lost claim response, claim expiry, abandoned
promotion, and Message deletion. The exact source can resume or reconstruct a
deleted Message, but a missing or different digest for an existing ID is an
identity conflict and can never be reported as a duplicate. The driver
independently parses each source file with the installed PostalMime version,
maps the source folder locally, and rejects any endpoint identity, internal
folder, or derived ID that contradicts its local result.

Every driver run must finish with explicit `source_total`, `result_total`,
`unprocessed`, `imported`, `duplicate`, `excluded`, `error`, and
`identity_collisions` counts. Treat the run as failed unless
`source_total=result_total`, `unprocessed=0`, `error=0`, and
`identity_collisions=0`. The driver also fails closed if the deployed endpoint
does not return bounded identity evidence, violates the documented HTTP status
contract, or reports a durable identity conflict. The private detailed log is
created with exclusive `0600` permissions. Every normal completion, handled
signal, or handled operational failure prints one bounded `PASS` or `FAIL`
summary; an uncatchable runtime or operating-system termination cannot promise
cleanup or a final write. Handled `SIGINT` and `SIGTERM` stop new source work,
abort the active request, write `FAIL`, and close the held log handle. Unexpected
endpoint JSON is bounded and written only to the private log, never the
terminal. On the second exact-export run, require
`imported=0`; every included source file must be a duplicate and every excluded
folder item must remain excluded. Do not continue to Zoho decommissioning on an
unreconciled count or identity failure.

### Mandatory Production Monitor Proof Gate

Recovery enable and Stage 3 are forbidden until the Wiser-specific immutable
monitor proof record from shared rollout Step 7 is attached and separately
approved, every named monitor rule has an independently received page, the
complete 14-row CloudWatch alarm action proof is attached, and the last
successful one-minute external poll is no more than two minutes old. Recheck
the proof references and current poll before requesting recovery enable or
starting the pilot.

## Stage 2: Separately Approved Production Closeout

The apex route is already live. Do not change MX, the permanent catch-all, DNS,
or SPF during this stage. Execute each separately approved action in this order:

1. Create the missing Wiser emergency Queue and set all four Wiser Queue
   retention periods to 14 days.
2. Run the exact Wiser migration branch, verify no pending migration and
   `global | 0`, then deploy the verified Wiser artifact.
3. Run the Shared Mailbox transition, wait for Agent revocations to drain, and
   require the read-only rerun to report `PASS`.
4. Verify the exact nine-secret inventory and remove only separately approved
   obsolete names.
5. Complete HTTP, outbound, real-device push, and both-brand eight-message
   authorization canaries.
6. Complete the AWS callback graph, monitoring evidence, and explicit recovery
   enable sequence from the shared runbook.
7. Import and reconcile the exact `hello@` and `contact@` Zoho exports.

Stop after any failed gate. A completed step is not permission to start the
next production mutation without its own approval.

## Stage 3: Production Validation, Monitoring, And Pilot

Validate the already-live apex using only production addresses under the
approved external test-message scope:

1. Confirm the active apex catch-all delivers to `wiser-mail-portal`.
2. Send to `hesham@wiserchat.ai`, `hello@wiserchat.ai`, and
   `contact@wiserchat.ai`; confirm exact mailbox isolation and authoritative raw
   receipts.
3. Send to an unknown apex recipient and confirm permanent SMTP rejection.
4. Send a Bcc-only message and confirm routing uses the SMTP envelope recipient,
   not the visible `To` header.
5. Confirm the Queue graph drains normally and the parking Queue stays empty.
6. Monitor Worker logs, Cloudflare Email Routing activity, SES send metrics, and
   external inbox headers.

Start the 72-hour pilot only after every validation and import gate passes.
`hesham@wiserchat.ai` and `ibrahem@wiserchat.ai` must both operate
`hello@wiserchat.ai` and `contact@wiserchat.ai` through ordinary receive, read,
reply, new-send, attachment, desktop or mobile, and push workflows. Do not add a
third pilot user. Lost mail, duplicate sending, unauthorized access, or hidden
delivery failure stops the pilot and restarts the full clock after the defect
and affected gates are closed.

Do not create or operate `test.wiserchat.ai` mailboxes or Email Routing records.

### Inbound Monitoring And Recovery

Raw R2 is the receipt source of truth. Receipt sidecars live at
`receipts/<ingressId>.json`; the receipt privately identifies the exact archived
message. Exact R2 keys and provider details stay internal and never appear in
structured logs. Queue and Mailbox storage are projections.

After exact raw MIME persistence succeeds, the Email Worker may return normally
only after one of four outcomes: a durable admitted receipt and successful Queue
send, an idempotent projection of the same `ingressId` into the verified active
Mailbox, a resolved Cloudflare `forward()` of the original inbound Message to
the pinned `EMERGENCY_FORWARD_DESTINATION` whose result contains a usable,
nonblank string
`messageId`, or
`setReject()` so SMTP reports failure and the sender can resend. This applies to
archived-receipt, Mailbox-marker, active-state, admitted-receipt, and Queue-send
failures. A successful Queue send remains a successful handoff if the
best-effort `enqueued` receipt advancement loses its conditional race. Invalid,
disallowed, unprovisioned, and inactive recipients must reject even when the
rejected receipt sidecar cannot commit; they must never be projected or
emergency-forwarded.

After Queue processing begins, any forward-eligible terminal projection failure
first writes `system/emergency-forward/active/<encoded-raw-key>.json` and a
`forward_pending` receipt, then enqueues the immutable archive pointer. The
consumer checks exact stored/deleted truth and the
exact R2 key, version, ETag, size, custom metadata, and SHA-256 before passing
the R2 body stream to Cloudflare Email Service. It records `forwarded` only for
a nonblank provider `messageId`, which is the documented
[Workers binding success result](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).
Provider acceptance is first fenced into the active marker with a privacy-safe
reference derived from the provider `messageId`, then an exact `forwarded`
receipt with `providerAccepted: true` and the same reference is committed. If that receipt
CAS fails, the retry finishes the receipt from the accepted marker without
resending. The protocol is still deliberately at-least-once, not exactly-once:
the Email Service API exposes no idempotency key, and a provider may accept a
send while the Worker loses the response or cannot commit the accepted marker.
That ambiguity may produce a duplicate on retry, but it is never silently
treated as delivered. Cloudflare documents a
[25 MiB total-message limit](https://developers.cloudflare.com/email-service/platform/limits/)
for fixed verified destination addresses, matching the 25 MiB inbound routing
limit. The general Email Service limit is 5 MiB. A Worker `send_email` operation
can appear as dropped in the Email Routing summary even when delivery succeeded,
so prove post-ingress emergency sends from Email Sending metrics/logs and the
returned `messageId`, never from the Routing summary status.
Exact stored messages, deletion tombstones, ingress-time admission/policy
rejections, and raw-integrity mismatch are never forwarded. Mailbox inactivity,
unownership, or `MAILBOX_UNAVAILABLE` discovered after raw acceptance is not an
SMTP policy receipt and therefore converges to automatic forwarding.

`setReject()` is authoritative only while the original Email Worker invocation
still owns the synchronous SMTP disposition. That path may write a rejected
receipt, or suppress that diagnostic write if storage is failing, while still
rejecting the message. Once raw acceptance has completed and the original SMTP
disposition can no longer be proven, later Queue, Cron, Mailbox inactivity, or
ownership discovery cannot invent a retroactive rejection. Automatic emergency
forwarding owns every eligible post-acceptance delivery gap.

The combined five-minute scheduled shape is structurally capped at 8,865
service subrequests below the 9,000 application budget and 10,000 Workers limit.
Each run admits 20 repair attempts, 7 cleanup intents, 8 active archives, 64
recent minute-partitioned raw archives, 1 exhaustive raw backstop archive, and
8 emergency-forward markers. Recent discovery reads exact quarantine receipts:
MIME, `EMAXLEN`, and post-acceptance `MAILBOX_UNAVAILABLE` failures are reindexed
for automatic forwarding, while raw-integrity quarantine remains suppressed. These
capacities guarantee bounded work, not a wall-clock delivery deadline. There is
no delivery-time bound while Cron is unavailable or while sustained ingress in
any lane exceeds that lane's admitted throughput; Queue delivery and its retry
policy continue independently during a Cron outage.

During production proof and closeout, monitor these conditions:

The independent application and inbound monitoring gate in the shared
[credential-recovery rollout runbook](credential-recovery-rollout-runbook.md)
is mandatory. Manual queries, Worker logs, Queue dashboards, and this Worker's
own Cron are diagnostics, not an alert service. Until the separately approved
external one-minute monitor and independent test-page proof exist, recovery must
remain disabled and Wiser mail go-live is blocked.

- Any `RAW_ARCHIVE_FAILED`, `RAW_ARCHIVE_SIZE_MISMATCH`, `RAW_ARCHIVE_CHECKSUM_UNAVAILABLE`, `RAW_ARCHIVE_CHECKSUM_MISMATCH`, or `RAW_ARCHIVE_CHECKSUM_PREPARATION_FAILED`: page immediately. Confirm the same `ingressId` then records either `direct_mailbox_fallback` status `succeeded`, or `emergency_forward` status `succeeded`. If neither exists, confirm `smtp_rejection` status `rejected` and investigate all three failed paths.
- Any `dead_letter_pending`, `dead_lettered`, `forward_pending`, forward-eligible `quarantined`, `RECEIPT_STATE_UNKNOWN`, `STORED_PROJECTION_MISSING`, `ADMISSION_DECISION_MISSING`, `TERMINAL_FALLBACK_LEDGER_FAILED`, `RECONCILIATION_RUN_FAILED`, or `ARCHIVE_RECONCILIATION_FAILED` must page immediately through alerting that is independent of the affected Queue and scheduled Worker. A new `forward_pending` receipt has one five-minute reconciliation interval to reach `forwarded`; page if it remains pending for more than ten minutes so one missed Cron tick does not create noise while two missed opportunities become an incident. Page immediately, without the grace period, when any primary, DLQ, parking, or emergency Queue consumer fails, a scheduled reconciliation run fails, Cron does not execute, or either recovery authority cannot be created. `dead_letter_pending` means Cloudflare has not yet confirmed the DLQ consumer. `forward_pending` means the dual R2 recovery authority exists but Email Service acceptance has not yet been durably recorded. The Mailbox terminal ledger is diagnostic only and never owns forwarding progress. `RECEIPT_STATE_UNKNOWN` means a receipt object exists but its pointer, timestamp, state-specific fields, or R2 identity cannot be trusted.
- Any `QUEUE_ENQUEUE_FAILED`: confirm the same `ingressId` immediately records `direct_mailbox_fallback` status `succeeded`, `emergency_forward` status `succeeded`, or `smtp_rejection` status `rejected`. A later reconciliation pass may still repair the admitted receipt, but it is not the SMTP acceptance guarantee.
- Any `R2_DERIVED_UPLOAD_INTEGRITY_FAILED`: page the mail operator. The exact raw MIME remains authoritative, but the Mailbox projection needs retry or audited replay.
- Any `R2_DELETION_OUTBOX_FAILED`: investigate until a later `R2 deletion batch completed` proves cleanup. Mail is already deleted from the user view, but superseded attachment/body objects remain pending in the Mailbox Durable Object outbox.
- Non-zero backlog in the primary, DLQ, parking, or emergency-forward Queue must be explained before declaring inbound healthy. Any message in a parking Queue is an immediate incident. The Wiser emergency Queue is `wiser-mail-emergency-forward`; the Whispyr equivalent is `sales-mail-emergency-forward`.
- Normal-path success is proved by `raw_archive` status `succeeded`, a durable admitted receipt, `queue_enqueue` status `succeeded` or `archive_reconcile` status `reenqueued`, and finally `mailbox_projection` status `succeeded` or `duplicate`. Any post-archive ingress failure is recovered only by a successful direct Mailbox fallback, successful emergency forwarding, or explicit SMTP rejection for the same `ingressId`.

The normal projection reconciler walks the raw archive with a conditionally
updated continuation cursor so old pages cannot starve and overlapping runs
cannot move the cursor backward. It re-enqueues trustworthy `archived`,
`admitted`, and stale `enqueued` or `retrying` receipts. It does not send
delivery-gap states back through normal projection: `forward_pending`, stale
`dead_letter_pending`, `dead_lettered`, forward-eligible quarantine,
`MAILBOX_UNAVAILABLE`, and a genuinely missing `stored` projection establish or
repair emergency-forward authority automatically. The Queue handoff must resolve
before the item can advance. The independent Mailbox terminal ledger and R2
anomaly/failure ledgers are diagnostics only, are bounded, and cannot delay or
own delivery progress.

Reconciliation trusts a present receipt only when its exact body has a usable R2
ETag, canonical timestamp, complete archived pointer matching the raw object,
and the closed field set for its state. A malformed, partial, mismatched, absent,
or post-CAS-loss receipt cannot authorize normal projection. Once the raw pointer
and SHA-256 are trustworthy, reconciliation first establishes emergency-forward
authority, then records `RECEIPT_STATE_UNKNOWN` or
`ADMISSION_DECISION_MISSING` as best-effort diagnostic evidence. The same rule
applies when an `archived` to `admitted` transition cannot be proven by its
immediate exact reread. An exact concurrent terminal winner remains
authoritative; every incompatible winner converges to emergency forwarding.

Primary and DLQ consumers never acknowledge from receipt custom metadata alone.
They read and validate the exact receipt body, archived pointer, canonical
timestamp, closed state fields, object identity, and matching metadata. A
`forwarded` fast path additionally requires `providerAccepted: true`; rejected
or quarantined fast paths require an exact suppression reason. `stored` and
`deleted` also require the authoritative Mailbox Message or deletion tombstone.
Missing Mailbox truth retries without clearing the active recovery marker.

For a raw object without a receipt, reconciliation first performs bounded checks
for an exact deletion tombstone or stored Message and reconstructs that terminal
receipt when proven. False, unavailable, malformed, or timed-out optional truth
cannot create a manual limbo state. It establishes emergency-forward authority
before best-effort `ADMISSION_DECISION_MISSING` evidence and the recovery pointer.
Raw metadata alone never authorizes normal admission or Queue projection. Do not
manufacture or edit recovery pointers manually.

Messages whose selected body exceeds 512 KiB keep a bounded preview in the Mailbox Durable Object and store the complete UTF-8 body in attempt-scoped R2 objects. Attachment objects are also attempt-scoped. Unknown-length decoded streams use R2 multipart upload with one bounded 5 MiB part buffer because workerd requires a declared length for a one-shot R2 stream. Every derived R2 write verifies the returned byte length before the SQL projection can commit.

Deleting an email atomically tombstones the ingress identity and inserts all attachment/body object keys into the Mailbox Durable Object `r2_deletion_outbox`. Its alarm deletes objects idempotently and retries failures with exponential backoff. Never bypass the Mailbox delete operation with direct R2 deletion.

For a manual recovery, first inspect the receipt without modifying it:

```bash
INGRESS_ID="${INGRESS_ID:?set the exact incident ingress identity}"
TARGET_MAILBOX="${TARGET_MAILBOX:?set the exact verified Wiser mailbox}"
npx wrangler r2 object get "wiser-mail-raw-archive/receipts/${INGRESS_ID}.json" --env wiser --remote --pipe
```

After confirming the intended mailbox in the receipt, recover with the dedicated one-message command. It sends only the ingress identity and target mailbox to the server. The authenticated admin endpoint loads the receipt and exact raw object directly from R2, validates the pointer schema, mailbox, size, ETag, and object version, then preserves the original `ingressId`. Do not use the Zoho importer because its historical-import identity would create a second Message when a live projection partially succeeded.

```bash
read -s IMPORT_PASSWORD
export IMPORT_PASSWORD
node scripts/recover-inbound.mjs \
  --base https://mail.wiserchat.ai \
  --email hesham@wiserchat.ai \
  --mailbox "$TARGET_MAILBOX" \
  --ingress-id "$INGRESS_ID"
unset IMPORT_PASSWORD
```

The command accepts only the approved HTTPS Wiser and Whispyr mail portal origins, applies a 15-second login timeout and a 60-second timeout to each of three recovery attempts, prints bounded progress to the terminal, and writes complete request and response detail to `script-logs/recover-inbound-<timestamp>.log`. It does not download raw message content to the operator machine or write secrets to the log. Before the Mailbox is touched, the server writes a unique append-only `system/recovery-audits/<ingressId>/<auditId>-requested.json` object. It reports success only after writing the matching `-completed.json` object with the result and authenticated operator. A receipt-level recovery summary is best effort because a concurrent Queue transition may supersede it; the append-only audit objects remain authoritative.

Verify the Message and attachments in the target Mailbox, then record the
`auditId`, `ingressId`, terminal receipt state, recovery result, operator, and log
path in the incident record. Keep exact R2 identities inside the private receipt
and server-side recovery flow. Never delete or overwrite the R2 raw object or
recovery audit objects as part of replay.

Before the verified artifact is deployed, create or verify all four Queues, set
message retention to 14 days, and verify every binding and consumer. Verify
`heshamelmahdi@gmail.com` as the fixed destination, onboard
`emergency-forward@wiserchat.ai` and
`emergency-forward@whispyrcrm.com` as sender addresses, and confirm the resolved
artifact pins the same destination for both mechanisms. Queue creation,
retention changes, Email Service onboarding, secret changes, deployment, and
the live eight-message canary each require their exact same-turn approval.

## Rollback

If an apex rollback is separately approved before Zoho decommission:

1. Restore recorded Zoho MX records for `wiserchat.ai`.
2. Disable or bypass the Cloudflare Email Routing rule for apex.
3. Leave `mail.wiserchat.ai` running for UI access and data inspection unless a Worker incident specifically requires rollback.
4. Re-run live receive tests against Zoho and confirm no new mail is landing in the Worker.

Do not delete Wiser D1/R2/KV resources during rollback. Preserve imported mail and logs for reconciliation.
Do not delete the raw-mail bucket, Queue, DLQ, receipt sidecars, or raw objects during rollback.
Migration 0012 is forward-only. First disable the exact Wiser
`credential_recovery_control` row, then roll forward a fix. Do not restore
private destinations to `users.recovery_email` and do not roll back to a Worker
that reads or writes that column. Keep the exact approved
`ACCOUNT_RECOVERY_DIRECTORY`, `CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1`, and all
recovery evidence tables intact. If a private legacy export exists for another
environment branch, keep it through that branch's rollback window. If the
matching Worker cannot remain live, disable public recovery and roll forward a
fix. Never delete or rotate the V1 payload key as a rollback action because
pending and parked ciphertext would become undecryptable.

## Post-Go-Live Cleanup

After an agreed observation window:

1. Run a final Zoho delta export and import.
2. Reconcile message counts and spot-check important threads.
3. Confirm `DOMAINS` remains exactly `wiserchat.ai` and that no temporary test-domain routing exists.
4. Decommission Zoho routing/mailboxes only after explicit approval.
5. Write the final launch note in `~/Documents/hesham-os/wiserchat/logs/notes/`.
6. After the live credential-recovery proof and rollback observation window are
   both complete, delete the exact private `LEGACY_RECOVERY_EXPORT` file and
   verify that path no longer exists. Never paste, commit, upload, or back up
   this temporary export.

   ```bash
   rm -- "$LEGACY_RECOVERY_EXPORT"
   test ! -e "$LEGACY_RECOVERY_EXPORT"
   ```

## Stop Conditions

Stop and rollback or ask for direction if any of these happen:

- Wiser build or dry-run references a Whispyr resource.
- Unknown recipients are accepted instead of rejected.
- Any route other than the approved apex catch-all or the canary script's exact
  temporary recipient receives live Wiser mail.
- SES headers fail DKIM or SPF for Wiser.
- The UI shows Whispyr branding on `mail.wiserchat.ai`.
- Imported mail count reconciliation fails without an explained duplicate/skip reason.
- Any raw archive write fails or the raw object size does not match the Email Worker envelope size.
- The inbound Queue, DLQ, parking Queue, or emergency-forward Queue is missing, paused unexpectedly, has the wrong retention, or has an unexplained backlog.
- A receipt reports `dead_lettered`, `quarantined`, or `STORED_PROJECTION_MISSING` without an active incident and verified recovery decision.
- The enabled indefinite `raw/` Bucket Lock is missing or changes during
  closeout.
- Any secret appears in terminal output, files under git, Jira, or documentation.
