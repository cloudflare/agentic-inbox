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

## Cloudflare resources

Edit `wrangler.jsonc` before deployment:

1. `REPLACE_WITH_OLD_CLOUDMAIL_D1_NAME` — old Cloudmail D1 database name
2. `REPLACE_WITH_OLD_CLOUDMAIL_D1_ID` — old Cloudmail D1 database ID
3. `REPLACE_WITH_OLD_CLOUDMAIL_R2_BUCKET` — old Cloudmail R2 bucket name

The target resources are already configured:

- target R2: `agentic-inbox`
- target Durable Object namespace: `MailboxDO` from Worker `agentic-inbox`

The target Durable Object is accessed through Cloudflare's cross-Worker RPC binding, so the migration worker does **not** need to expose an import API in Agentic Inbox.

## Secret

Create one Worker secret:

- `MIGRATION_TOKEN` — a long random password used by the migration page

Do not put this value into GitHub or `wrangler.jsonc`.

## Deploy from this repository

When using Cloudflare Workers Builds / Git integration:

- Repository: `guiming99/agentic-inbox`
- Branch: `migration/cloudmail-to-agentic`
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
2. Open `/` and enter the `MIGRATION_TOKEN`.
3. Click **Refresh mailboxes**.
4. Run **Dry run** first.
5. Verify the mailbox list and counts/processing behavior.
6. Run the real migration.
7. Leave the old Cloudmail system untouched until the migration has been checked in Agentic Inbox.
8. If necessary, run the migration again; existing deterministic IDs are skipped.

## Important

The old Cloudmail R2 attachment keys are different from Agentic Inbox's attachment layout. The tool copies the binary object and writes the new Agentic attachment metadata so the existing Agentic Inbox attachment endpoint can serve the file.

The source and target resources must be in the **same Cloudflare account**, because the target `MailboxDO` binding uses the `script_name: "agentic-inbox"` cross-Worker Durable Object binding.
