-- Asking for cloud backup, and the Admin tab (the same tables as Sol's, without its reminders
-- and voice tables: Tick's reminders live in the Durable Object).
-- Apply with: npx wrangler d1 migrations apply tick --remote

-- Someone asking for cloud backup. The name and note are what they typed, so the admin can
-- decide; the device proves it made the request with a secret whose SHA-256 is kept here.
CREATE TABLE IF NOT EXISTS requests (
  id            TEXT PRIMARY KEY,
  secret_hash   TEXT NOT NULL,
  name          TEXT NOT NULL,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | revoked
  request_count INTEGER NOT NULL DEFAULT 1,
  make_admin    INTEGER NOT NULL DEFAULT 0,        -- approving gives the backup admin rights
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  decided_at    INTEGER
);

-- Whose backup is whose, for the Admin tab. Admin rights belong to a backup: any device that has
-- opened an admin's backup (with its recovery code) is the admin.
ALTER TABLE vaults ADD COLUMN name TEXT;
ALTER TABLE vaults ADD COLUMN via TEXT;           -- 'request' | 'invite' | 'open'
ALTER TABLE vaults ADD COLUMN request_id TEXT;
ALTER TABLE vaults ADD COLUMN revoked_at INTEGER;
ALTER TABLE vaults ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
