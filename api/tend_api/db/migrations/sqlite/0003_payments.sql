-- SQLite twin of postgres/0003_payments.sql. SQLite has no sha256 in SQL, so the insert trigger
-- checks the chain links (seq and prev_hash) and Python checks each row's hash.

CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE pending_actions (
    action_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('proposed', 'executing', 'done', 'unverified', 'failed', 'expired', 'locked')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    from_account TEXT NOT NULL,
    payee TEXT,
    payee_tag TEXT NOT NULL,
    code_mac TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('app', 'agent')),
    dry_run INTEGER NOT NULL,
    bill_id TEXT,
    item_ids TEXT NOT NULL DEFAULT '[]',
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    confirmed_at TEXT,
    finished_at TEXT,
    withdrawal_id TEXT,
    readback TEXT,
    error_kind TEXT,
    CHECK (payee IS NOT NULL OR status NOT IN ('proposed', 'executing'))
);

CREATE INDEX pending_actions_expires_idx ON pending_actions (expires_at);

CREATE TABLE audit_log (
    seq INTEGER PRIMARY KEY CHECK (seq > 0),
    ts TEXT NOT NULL,
    event TEXT NOT NULL CHECK (event IN ('confirmed', 'executed', 'unverified', 'failed')),
    action_id TEXT NOT NULL,
    body TEXT NOT NULL,
    prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
    hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64)
);

CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
WHEN NEW.seq IS NOT coalesce((SELECT max(seq) FROM audit_log), 0) + 1
  OR NEW.prev_hash IS NOT coalesce((SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1), printf('%064d', 0))
BEGIN
    SELECT RAISE(ABORT, 'audit_log: row does not extend the chain');
END;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;
