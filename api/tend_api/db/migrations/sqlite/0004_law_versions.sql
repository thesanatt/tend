-- SQLite twin of db/ensure/law_versions.sql (a numbered migration here: SQLite files are local, so no
-- other build shares them). Law versions live in Neon branches; offline, this registry stays empty
-- unless a test fills it. Quote search uses the quote column of rules_fts.

CREATE TABLE law_versions (
    name TEXT PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE CHECK (seq > 0),
    git_sha TEXT NOT NULL UNIQUE CHECK (length(git_sha) = 40),
    committed_at TEXT NOT NULL,
    subject TEXT NOT NULL,
    parent TEXT REFERENCES law_versions (name),
    branch_id TEXT NOT NULL UNIQUE,
    endpoint_host TEXT NOT NULL,
    corpus_sha256 TEXT NOT NULL CHECK (length(corpus_sha256) = 64),
    jurisdictions INTEGER NOT NULL,
    rules INTEGER NOT NULL,
    sources INTEGER NOT NULL,
    load_ms INTEGER,
    published_at TEXT NOT NULL
);

CREATE TABLE law_version_files (
    version TEXT NOT NULL REFERENCES law_versions (name) ON DELETE CASCADE,
    st TEXT NOT NULL CHECK (length(st) = 2 AND st = upper(st)),
    verified_sha256 TEXT NOT NULL CHECK (length(verified_sha256) = 64),
    ir_sha256 TEXT,
    rule_count INTEGER NOT NULL,
    PRIMARY KEY (version, st)
);

CREATE INDEX law_version_files_lookup_idx ON law_version_files (st, verified_sha256);
