-- The public law corpus: verified rules with their verbatim quotes, pinpoints, and text-fragment
-- links; the sources they quote (metadata and sha256 only); and the hashes of compiled law images.
-- Nothing here is about a person.

CREATE TABLE categories (
    name text PRIMARY KEY,
    meaning text NOT NULL,
    decides boolean NOT NULL  -- true when the law engine uses the category to decide a line or a check
);

CREATE TABLE jurisdictions (
    st text PRIMARY KEY CHECK (st ~ '^[A-Z]{2}$'),
    name text NOT NULL,
    program jsonb NOT NULL DEFAULT '{}'::jsonb,
    coverage jsonb,
    confidence text,
    verified_sha256 text NOT NULL CHECK (verified_sha256 ~ '^[0-9a-f]{64}$'),
    ir_sha256 text CHECK (ir_sha256 ~ '^[0-9a-f]{64}$'),
    ir_version integer,
    rule_count integer NOT NULL CHECK (rule_count >= 0),
    source_count integer NOT NULL CHECK (source_count >= 0),
    skipped_count integer NOT NULL DEFAULT 0,
    loaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sources (
    st text NOT NULL REFERENCES jurisdictions (st) ON DELETE CASCADE,
    id text NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    kind text NOT NULL,
    retrieved_at timestamptz,
    raw_path text,
    text_path text,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (st, id)
);

CREATE TABLE rules (
    st text NOT NULL REFERENCES jurisdictions (st) ON DELETE CASCADE,
    id text NOT NULL UNIQUE,
    ord integer NOT NULL,
    category text NOT NULL REFERENCES categories (name),
    expense text,
    params jsonb NOT NULL DEFAULT '{}'::jsonb,
    summary text NOT NULL,
    quote text NOT NULL,
    pinpoint text NOT NULL,
    source_id text NOT NULL,
    fragment_url text,
    ir jsonb,                -- the rule as both engines read it (rules/ir), null when skipped
    ir_kind text,            -- covered, expense_cap, excluded, info, ..., or 'skipped'
    skipped_reason text,
    heading text NOT NULL,   -- category, expense, and tags as plain words, weighted highest in search
    search tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', heading), 'A') ||
        setweight(to_tsvector('english', summary), 'B') ||
        setweight(to_tsvector('english', quote), 'C') ||
        setweight(to_tsvector('english', pinpoint), 'D')
    ) STORED,
    PRIMARY KEY (st, id),
    FOREIGN KEY (st, source_id) REFERENCES sources (st, id)
);

CREATE INDEX rules_search_idx ON rules USING gin (search);
CREATE INDEX rules_category_idx ON rules (st, category);

-- One row per compiled image an engine build produced. Kept across engine versions, so a device
-- can check that the WebAssembly engine ran the same image the server published.
CREATE TABLE law_images (
    st text NOT NULL REFERENCES jurisdictions (st) ON DELETE CASCADE,
    image_sha256 text NOT NULL CHECK (image_sha256 ~ '^[0-9a-f]{64}$'),
    engine_version text NOT NULL,
    verified_sha256 text NOT NULL CHECK (verified_sha256 ~ '^[0-9a-f]{64}$'),
    ir_sha256 text,
    bytes integer NOT NULL CHECK (bytes > 0),
    compiled_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (st, image_sha256)
);
