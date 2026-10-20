# Recovered attachment repair

`repair-recovered-attachments.mjs` audits the October 8–13, 2026 incident window across all configured mailboxes. It finds attachment-free copies whose original Message-ID and body match an intact copy in another mailbox. Dry run is the default; `--apply` invokes the authenticated repair endpoint. Existing bodies, read flags, folders, and attachments are preserved. It does not send mail.

```sh
INBOX_ENV_FILE=/path/to/ignored/.env node scripts/repair-recovered-attachments.mjs
INBOX_ENV_FILE=/path/to/ignored/.env node scripts/repair-recovered-attachments.mjs --apply
```

The environment file supplies `EMAILBOX_API_KEY`, `AGENTIC_INBOX_ACCESS_CLIENT_ID`, and `AGENTIC_INBOX_ACCESS_CLIENT_SECRET`. Never print or commit their values.

## October 15, 2026 repair evidence

- The earlier metadata-only recovery omitted attachments. Message presence alone was insufficient acceptance evidence. Future recovery must verify attachment metadata and stored bytes as well as Message-ID, body, and read status.
- Scanned 19 mailboxes and 119 incident-window records. One incomplete Marketing copy matched an intact Finance copy. Restored its two attachment files (PNG and invoice spreadsheet); the operation verified attachment count and unchanged body/read flag. A repeated repair returned zero, confirming idempotency.
- The viewer previously resolved only parts labeled `inline`; this sender used `attachment` and `application/octet-stream` for PNG data. It now resolves Content-ID independently of disposition and fetches raster image data in the authenticated parent, keeping the email iframe sandbox intact.
- Authenticated production browser verification showed the restored original with a PNG data URL and both attachment entries. The forwarded September bill conversation displayed its invoice table, with three embedded images resolved and no unresolved CID image sources. The verification browser was closed with zero owned Chrome processes remaining.
- Code commit: `60b27a6`. Production Worker version: `28e14ee0-3dfe-4cd3-88ce-77abf4b7a000`, deployment `d9870c8c-b883-4531-8a42-ef1c4ac816ac`, 100%.
- Marketing and Reservation Email Routing rules remain enabled and target `agentic-inbox`. The Worker stores mail before forwarding the original MIME to the respective Gmail destination. Cloudflare reported Marketing destination verified at `2026-10-15T07:32:25.372037Z`. No new external test email was sent during this repair.
- Validation: 14 regression tests, typecheck, build, and diff whitespace checks passed. Dependency audit still reports existing advisories; dependency remediation is outside this incident change.
