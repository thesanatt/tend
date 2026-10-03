-- Payments. A proposal waits here for its six-digit code for at most ten minutes. The code itself is
-- never stored, only a MAC that binds it to the action id, amount, account, and payee. The payee
-- is cleared as soon as the action finishes or expires; after that only a keyed hash remains.

CREATE TABLE meta (
    key text PRIMARY KEY,
    value text NOT NULL
);

CREATE TABLE pending_actions (
    action_id text PRIMARY KEY CHECK (action_id ~ '^act_[0-9a-f]{20}$'),
    status text NOT NULL CHECK (status IN ('proposed', 'executing', 'done', 'unverified', 'failed', 'expired', 'locked')),
    amount_cents bigint NOT NULL CHECK (amount_cents > 0),
    from_account text NOT NULL,
    payee text,
    payee_tag text NOT NULL,
    code_mac text NOT NULL,
    channel text NOT NULL CHECK (channel IN ('app', 'agent')),
    dry_run boolean NOT NULL,
    bill_id text,
    item_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    attempts integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    confirmed_at timestamptz,
    finished_at timestamptz,
    withdrawal_id text,
    readback jsonb,
    error_kind text,
    CHECK (payee IS NOT NULL OR status NOT IN ('proposed', 'executing'))
);

CREATE INDEX pending_actions_expires_idx ON pending_actions (expires_at);

-- The audit log of confirmed payments: append-only and hash-chained. Each row's hash is the
-- sha256 of its canonical JSON body, and the body names the hash of the row before it, so
-- changing or dropping any row breaks every hash after it. The triggers below refuse updates,
-- deletes, and truncation, and refuse an insert that does not extend the chain exactly.

CREATE TABLE audit_log (
    seq bigint PRIMARY KEY CHECK (seq > 0),
    ts timestamptz NOT NULL,
    event text NOT NULL CHECK (event IN ('confirmed', 'executed', 'unverified', 'failed')),
    action_id text NOT NULL,
    body text NOT NULL,
    prev_hash text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
    hash text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$')
);

CREATE FUNCTION audit_log_refuse_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only';
END
$$;

CREATE FUNCTION audit_log_extend_chain() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
    last_seq bigint;
    last_hash text;
    doc jsonb;
BEGIN
    -- Writers take this lock before reading the head, so two inserts can never both extend it.
    PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_SCHEMA || ':audit_log'));
    SELECT a.seq, a.hash INTO last_seq, last_hash FROM audit_log a ORDER BY a.seq DESC LIMIT 1;
    IF NEW.seq IS DISTINCT FROM coalesce(last_seq, 0) + 1 THEN
        RAISE EXCEPTION 'audit_log: row % does not follow row %', NEW.seq, coalesce(last_seq, 0);
    END IF;
    IF NEW.prev_hash IS DISTINCT FROM coalesce(last_hash, repeat('0', 64)) THEN
        RAISE EXCEPTION 'audit_log: prev_hash does not name the previous row';
    END IF;
    IF NEW.hash IS DISTINCT FROM encode(sha256(convert_to(NEW.body, 'UTF8')), 'hex') THEN
        RAISE EXCEPTION 'audit_log: hash is not the sha256 of the body';
    END IF;
    doc := NEW.body::jsonb;
    IF (doc ->> 'seq')::bigint IS DISTINCT FROM NEW.seq
       OR doc ->> 'prev_hash' IS DISTINCT FROM NEW.prev_hash
       OR doc ->> 'event' IS DISTINCT FROM NEW.event
       OR doc ->> 'action_id' IS DISTINCT FROM NEW.action_id
       OR (doc ->> 'ts')::timestamptz IS DISTINCT FROM NEW.ts THEN
        RAISE EXCEPTION 'audit_log: body does not match the row';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_extend_chain();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_refuse_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_refuse_change();
