-- Senders a key may use in addition to those of its mailboxes, and the default it sends from.
ALTER TABLE inbox_api_keys ADD COLUMN sender_identity_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE inbox_api_keys ADD COLUMN default_sender_identity_id text REFERENCES sender_identities(id);
