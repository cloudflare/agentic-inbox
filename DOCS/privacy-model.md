# Privacy Model

Dumb Inbox is a plain mail client. Email content must stay inside the mail pipeline:

1. Cloudflare Email Routing delivers the raw message to the Worker email handler.
2. `workers/index.ts` parses the message with PostalMime.
3. Message metadata/body is stored in `MailboxDO` SQLite.
4. Attachments are stored in R2 under the message ID.
5. The React UI and Hono API read/write through the mailbox Durable Object.

There is no agent route, MCP route, or automatic draft generation. Model-backed mail access is limited to the explicit AI draft route:

1. The user must be an active app user.
2. The user must have a mailbox role with response permissions.
3. The mailbox AI setting must be enabled by a mailbox manager or global admin.
4. The user must click the AI draft action for a specific email/thread.
5. The generated body is returned as editable draft content only; it is never sent automatically.

Inbound mail handling must never call a model. Background receive hooks, agent runtimes, MCP routes, and automatic draft creation remain out of scope.

The guard test `tests/no-ai-mail.test.ts` blocks the removed MCP/agent runtime paths from coming back silently and verifies that `env.AI.run` only appears in the explicit draft helper.
