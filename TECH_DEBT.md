# Tech Debt

- Mailbox deletion disables the D1 mailbox row and removes R2 mailbox settings, but does not purge the mailbox Durable Object SQLite data or attachment blobs.
- `wrangler.jsonc` contains a placeholder D1 `database_id`; replace it with the real `wrangler d1 create dumb-inbox-app` ID before remote deploy.
