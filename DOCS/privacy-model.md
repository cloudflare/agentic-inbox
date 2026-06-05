# Privacy Model

Dumb Inbox is a plain mail client. Email content must stay inside the mail pipeline:

1. Cloudflare Email Routing delivers the raw message to the Worker email handler.
2. `workers/index.ts` parses the message with PostalMime.
3. Message metadata/body is stored in `MailboxDO` SQLite.
4. Attachments are stored in R2 under the message ID.
5. The React UI and Hono API read/write through the mailbox Durable Object.

There is no agent route, MCP route, Workers AI binding, or automatic draft generation. New features that inspect mail content must be deterministic application code unless the user explicitly opts into a model-backed feature in a future design.

The guard test `tests/no-ai-mail.test.ts` blocks the removed model/MCP/agent runtime paths from coming back silently.
