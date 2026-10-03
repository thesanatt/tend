-- SQLite twin of postgres/0001_corpus.sql, for offline runs and tests. FTS5 with the porter
-- stemmer stands in for Postgres full-text search.

CREATE TABLE categories (
    name TEXT PRIMARY KEY,
    meaning TEXT NOT NULL,
    decides INTEGER NOT NULL
);

CREATE TABLE jurisdictions (
    st TEXT PRIMARY KEY CHECK (length(st) = 2 AND st = upper(st)),
    name TEXT NOT NULL,
    program TEXT NOT NULL DEFAULT '{}',
    coverage TEXT,
    confidence TEXT,
    verified_sha256 TEXT NOT NULL CHECK (length(verified_sha256) = 64),
    ir_sha256 TEXT CHECK (ir_sha256 IS NULL OR length(ir_sha256) = 64),
    ir_version INTEGER,
    rule_count INTEGER NOT NULL,
    source_count INTEGER NOT NULL,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    loaded_at TEXT NOT NULL
);

CREATE TABLE sources (
    st TEXT NOT NULL REFERENCES jurisdictions (st) ON DELETE CASCADE,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    kind TEXT NOT NULL,
    retrieved_at TEXT,
    raw_path TEXT,
    text_path TEXT,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    PRIMARY KEY (st, id)
);

CREATE TABLE rules (
    st TEXT NOT NULL REFERENCES jurisdictions (st) ON DELETE CASCADE,
    id TEXT NOT NULL UNIQUE,
    ord INTEGER NOT NULL,
    category TEXT NOT NULL REFERENCES categories (name),
    expense TEXT,
    params TEXT NOT NULL DEFAULT '{}',
    summary TEXT NOT NULL,
    quote TEXT NOT NULL,
    pinpoint TEXT NOT NULL,
    source_id TEXT NOT NULL,
    fragment_url TEXT,
    ir TEXT,
    ir_kind TEXT,
    skipped_reason TEXT,
    heading TEXT NOT NULL,
    PRIMARY KEY (st, id),
    FOREIGN KEY (st, source_id) REFERENCES sources (st, id)
);

CREATE INDEX rules_category_idx ON rules (st, category);

CREATE VIRTUAL TABLE rules_fts USING fts5 (
    rule_id UNINDEXED,
    st UNINDEXED,
    heading,
    summary,
    quote,
    pinpoint,
    tokenize = 'porter unicode61'
);

CREATE TABLE law_images (
    st TEXT NOT NULL REFERENCES jurisdictions (st) ON DELETE CASCADE,
    image_sha256 TEXT NOT NULL CHECK (length(image_sha256) = 64),
    engine_version TEXT NOT NULL,
    verified_sha256 TEXT NOT NULL,
    ir_sha256 TEXT,
    bytes INTEGER NOT NULL CHECK (bytes > 0),
    compiled_at TEXT NOT NULL,
    PRIMARY KEY (st, image_sha256)
);
