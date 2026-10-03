-- SQLite twin of postgres/0002_shares.sql: ciphertext and IV only, never a key.

CREATE TABLE sealed_shares (
    id TEXT PRIMARY KEY,
    ciphertext BLOB,
    iv BLOB CHECK (iv IS NULL OR length(iv) BETWEEN 12 AND 32),
    size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
    once INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    opened_at TEXT,
    CHECK (expires_at > created_at),
    CHECK ((ciphertext IS NULL) = (iv IS NULL)),
    CHECK (ciphertext IS NULL OR length(ciphertext) = size_bytes),
    CHECK (ciphertext IS NOT NULL OR opened_at IS NOT NULL)
);

CREATE INDEX sealed_shares_expires_idx ON sealed_shares (expires_at);
