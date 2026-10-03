-- End-to-end encrypted shares. The browser encrypts the packet with a fresh AES-256-GCM key and
-- sends only the ciphertext and IV. The key travels in the link's fragment, which browsers never
-- send to a server, so nothing in this table can be decrypted here. An open-once share loses its
-- ciphertext the moment it is opened; the row stays as a tombstone until it expires.

CREATE TABLE sealed_shares (
    id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{22,64}$'),
    ciphertext bytea,
    iv bytea CHECK (iv IS NULL OR octet_length(iv) BETWEEN 12 AND 32),
    size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
    once boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    opened_at timestamptz,
    CHECK (expires_at > created_at),
    CHECK ((ciphertext IS NULL) = (iv IS NULL)),
    CHECK (ciphertext IS NULL OR octet_length(ciphertext) = size_bytes),
    CHECK (ciphertext IS NOT NULL OR opened_at IS NOT NULL)
);

CREATE INDEX sealed_shares_expires_idx ON sealed_shares (expires_at);
