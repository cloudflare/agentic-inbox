# Scoped Agent Access

Create a named access key under a mailbox's **Settings > Agent Access**. Select
the exact mailboxes, permissions, and send mode. The selection belongs to that
key, not to the mailbox currently open in the dashboard. Keys are shown once;
only their SHA-256 hashes are stored. Uncheck **Agent access enabled** and save
to revoke a key. Create a replacement key to rotate credentials.

## Connections

- Remote MCP: `https://<your-worker-host>/agent/mcp`
- REST: `POST https://<your-worker-host>/agent/api/<tool-name>`
- Header: `Authorization: Bearer <agent-key>`
- REST request/response format: JSON, with `Content-Type: application/json`.
- MCP transport: stateless Streamable HTTP, supporting clients with custom headers.
- Keys cannot access `/api/v1/*`, the dashboard agent, or the legacy `/mcp` endpoint.
- No deletion, mailbox administration, or folder mutation tools are exposed.

For clients accepting MCP configuration with HTTP headers:

```json
{
  "mcpServers": {
    "agentic-inbox-agent": {
      "url": "https://<your-worker-host>/agent/mcp",
      "headers": { "Authorization": "Bearer <agent-key>" }
    }
  }
}
```

Keep the actual key in the client's secret store or environment configuration.
Client-specific configuration formats may differ. This is key authentication,
not an OAuth login flow.

## Permissions and modes

| Tool | Required permissions |
| --- | --- |
| `list_mailboxes`, `get_mailbox` | Any active key; assigned mailboxes only |
| `list_emails`, `get_email`, `get_thread`, `search_emails` | read |
| `create_draft` | draft |
| `generate_reply_draft` | read + draft |
| `send_email` | send |
| `send_reply`, `send_draft` | read + send |

`draft_only` means a send request creates a draft and returns
`status: "draft_saved_not_sent", sent: false`. `direct` allows actual delivery.
The send permission is required in both cases. Disabling the send permission
rejects send requests instead of silently converting them.

All content submissions require `footer: { "enabled": true | false }`.
Optional `footer.text` overrides the saved footer for this message only.
`get_mailbox` returns the saved footer so the agent can inspect it first.
An enabled but empty footer is rejected; it is not silently omitted.

New keys default to drafts only, test mode off, and no extra AI verification of
agent-supplied text. When test mode is enabled, configure an explicit test
recipient. Optional recipient allowlists apply in addition to test mode. Limits are per key,
mailbox, and UTC day. Attempted submissions count toward limits.

## Generate a reply with inbox AI

Call `generate_reply_draft` instead of supplying your own message body:

```json
{
  "mailboxId": "hello@example.com",
  "requestId": "reply-generation-unique-001",
  "originalEmailId": "<internal-email-id>",
  "instructions": "Write a concise, friendly answer.",
  "footer": { "enabled": true }
}
```

This works independently of the automatic-drafts setting. The inbox uses the
mailbox's writing prompt and thread context, checks the incoming context with
the existing injection scanner, generates text with Kimi K2.5, and verifies
the draft with the existing draft verifier. The generating model has **no tools**
and can neither send nor manage emails. The response includes `draftId`, `html`,
`text`, and `sent: false`. Review using the response or `get_email`.

To submit that draft:

```json
{
  "mailboxId": "hello@example.com",
  "requestId": "draft-submission-unique-001",
  "draftId": "<draft-id>",
  "footer": { "enabled": true }
}
```

Use this body with `send_draft`. Existing drafts are never deleted. In
draft-only mode a new review copy is saved. Drafts with CC/BCC or attachments
must currently be sent from the dashboard; they are rejected, not truncated.

For `send_email`, supply `mailboxId`, `requestId`, `to`, `subject`, `bodyHtml`,
and `footer`. `send_reply` also requires `originalEmailId`. `create_draft`
accepts supplied content only and cannot read or quote existing emails.

## Retries and results

Every write/generation requires a stable `requestId` (8-128 ASCII letters,
digits, underscores or hyphens). Retry with the **same ID and same arguments**.
An ID reused with different arguments is rejected. Replays return the existing
outcome without sending or generating again. Draft content on replay is loaded
from the current stored draft. Idempotency records are retained, with no expiry.

- `sent`: provider accepted the message and the sent copy was saved. This is
  not confirmation of final recipient delivery.
- `sent_unrecorded`: provider accepted it but saving the sent copy failed.
  **Do not resend.**
- `outcome_unknown` or a pending-operation conflict: delivery may be uncertain.
  Inspect the mailbox/provider before taking further action. **Do not use a new
  requestId to retry automatically.**
- `failed` / `rejected`: inspect the returned error.

The same existing draft cannot be submitted directly twice with different IDs.
If an attempt is uncertain, its submission reservation remains in place for
safety. Activity is available under the agent's settings, including pending
operations. Existing live emails are not rewritten or migrated.

## Cloudflare Access deployment

The dashboard and legacy endpoints remain protected by human Cloudflare Access
login. The dedicated `/agent/*` namespace uses the scoped key validator in the
Worker and rejects requests without a valid key even when a browser is logged in.

When Cloudflare Access covers the entire hostname, add a **more specific** Access
application for the same hostname's `/agent/*` path, with a Bypass policy. This
only bypasses the interactive edge login; the Worker still requires the scoped
key on every request. Do not bypass the hostname root, `/api/*`, or `/mcp`.
Deploy and verify the key validator before enabling this path exception.

No new R2 bucket, Durable Object class, or SQL migration is required. Credentials
use `agent-access/credentials/` in the existing bucket. Operation receipts,
counters and activity use new `agent-*` KV keys in the existing mailbox Durable
Objects, without modifying their SQL schema or existing email rows.

## Verification

Run the focused checks with:

```bash
npm run test:agent-access
npm run typecheck
npm run build
```
