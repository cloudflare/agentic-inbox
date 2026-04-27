-- Copyright (c) 2026 Cloudflare, Inc.
-- Licensed under the Apache 2.0 license found in the LICENSE file or at:
--     https://opensource.org/licenses/Apache-2.0

-- Shared identity for any external party we exchange intel with. Inbound and
-- outbound peer configs both reference this so that a single party with
-- bidirectional flows is recognisable as one entity.
CREATE TABLE peers (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    contact TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per upstream MISP instance we PULL from. The synthetic_org_uuid
-- references a local `orgs` row created at the same time as this peer; that
-- org is the contributor used in corroboration math and is never a caller
-- (no api_keys row is created for it).
CREATE TABLE inbound_peers (
    uuid TEXT PRIMARY KEY,
    peer_uuid TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_secret_name TEXT NOT NULL,
    synthetic_org_uuid TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    -- ISO-8601 watermark. NULL = full backfill on first run.
    last_pulled_ts TEXT,
    last_error TEXT,
    -- Dual purpose: failure backoff AND soft cron lock. Cron skips peers
    -- whose next_retry_at is in the future.
    next_retry_at TEXT,
    -- Required at admin-create time. NULL would orphan events to the
    -- synthetic org which has no human callers.
    default_sharing_group_uuid TEXT NOT NULL,
    -- Newline-separated tag patterns. Empty/NULL means no filtering.
    tag_include TEXT,
    tag_exclude TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (peer_uuid) REFERENCES peers(uuid) ON DELETE CASCADE,
    FOREIGN KEY (synthetic_org_uuid) REFERENCES orgs(uuid)
);
CREATE INDEX idx_inbound_peers_next_retry ON inbound_peers(next_retry_at);

-- Provenance on events. NULL = locally authored via POST /events.
ALTER TABLE events ADD COLUMN source_peer_uuid TEXT;
CREATE INDEX idx_events_source_peer ON events(source_peer_uuid);
