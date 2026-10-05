-- Encrypted cloud backup. Apply with: npx wrangler d1 migrations apply tick --remote
-- The server stores ciphertext only. Record ids are HMACs of local ids; seq is per vault and
-- only ever grows, so a device can ask for "everything after N".

CREATE TABLE IF NOT EXISTS vaults (
  id         TEXT PRIMARY KEY,         -- derived from the vault key; says nothing about the owner
  auth_hash  TEXT NOT NULL,            -- SHA-256 of the auth secret
  next_seq   INTEGER NOT NULL DEFAULT 1,
  bytes      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  used_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  vault TEXT NOT NULL,
  id    TEXT NOT NULL,
  seq   INTEGER NOT NULL,
  iv    TEXT NOT NULL,
  ct    TEXT NOT NULL,
  PRIMARY KEY (vault, id)
);

CREATE INDEX IF NOT EXISTS records_by_seq ON records (vault, seq);
