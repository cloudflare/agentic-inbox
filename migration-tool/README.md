# Cloudmail → Agentic Inbox Migration Tool

This is an **independent Cloudflare Worker**. It lives under `migration-tool/` so it does not change or run as part of the Agentic Inbox application itself.

It migrates the old `gui-cloud-mail` data model directly from Cloudflare D1 + R2 into the new Agentic Inbox Durable Object + R2 storage.

## What it migrates

- All active Cloudmail mailboxes from the old `account` table
- Sent mail → `Sent`
- Received mail → `Inbox`
- Optional old `is_del=1` records → `Trash`
- HTML body / plain-text body
- From / To / CC / BCC
- Read/unread state
- Starred state from the old `star` table
- Message-ID / In-Reply-To metadata
- Conversation grouping using a stable subject + participant hash
- Attachments from the old R2 bucket to the Agentic Inbox R2 bucket
- Missing attachments are reported without silently deleting the email

The migration is **resumable**. Each request processes a small batch and uses the old `email_id` as a cursor. Re-running the same mailbox skips emails that already exist in Agentic Inbox.

The tool never sends an email.

## Important: no company resources are stored in GitHub

`wrangler.jsonc` intentionally contains **no D1 IDs, D1 names, R2 bucket names, or company-specific resource identifiers**.

When deploying through the Cloudflare dashboard, create the following bindings in the Worker:

### D1 binding

- Variable name: `SOURCE_DB`
- Resource: select the old Cloudmail D1 database for the domain you are migrating

### R2 binding — source

- Variable name: `SOURCE_R2`
- Resource: select the old Cloudmail attachment R2 bucket

### R2 binding — target

- Variable name: `TARGET_R2`
- Resource: select the Agentic Inbox R2 bucket for the target system

### Durable Object binding — target

- Variable name: `TARGET_MAILBOX`
- Durable Object class: `MailboxDO`
- Script/Worker: select the target Agentic Inbox Worker (normally `agentic-inbox`)

This makes the migration tool reusable for different domains and different Cloudmail installations without changing GitHub code.

## Secret

Create one Worker secret:

- `MIGRATION_TOKEN` — a long random password used by the migration page

Do **not** put this value into GitHub or `wrangler.jsonc`.

## Deploy from this repository

When using Cloudflare Workers Builds / Git integration:

- Repository: `guiming99/agentic-inbox`
- Branch: `main`
- Root directory: `migration-tool`
- Build command: `npm install`
- Deploy command: `npx wrangler deploy`

Alternatively, from the `migration-tool` directory:

```bash
npm install
npx wrangler secret put MIGRATION_TOKEN
npx wrangler deploy
```

After deployment, open the Worker URL shown by Cloudflare. The migration page is at `/`.

## Safe operating order

1. Deploy the migration worker.
2. Configure `SOURCE_DB`, `SOURCE_R2`, `TARGET_R2`, and `TARGET_MAILBOX` in Cloudflare.
3. Set the `MIGRATION_TOKEN` secret.
4. Open `/` and enter the token.
5. Click **Refresh mailboxes**.
6. Run **Dry run** first.
7. Verify the mailbox list and processing behavior.
8. Run the real migration.
9. Leave the old Cloudmail system untouched until the migration has been checked in Agentic Inbox.
10. If necessary, run the migration again; existing deterministic IDs are skipped.

## Important

The old Cloudmail R2 attachment keys are different from Agentic Inbox's attachment layout. The tool copies the binary object and writes the new Agentic attachment metadata so the existing Agentic Inbox attachment endpoint can serve the file.

The source and target resources must be in the **same Cloudflare account**, because the target `MailboxDO` binding uses a cross-Worker Durable Object binding.
