-- Law versions. A version is the public corpus (rules/verified and rules/ir) exactly as it stood at one
-- git commit, published as its own Neon branch named law-<date>-<short sha>. The first version is a
-- schema-only branch, so no share or payment row is ever copied into it; each later version is a child
-- of the one before, so Neon stores only the pages that changed. This table indexes those branches. The
-- API reads a version's rules from its branch and diffs two of them. A published branch is never
-- loaded again; a new corpus gets a new branch.
--
-- IF NOT EXISTS: scripts/neon applies this ahead of the API's bookkeeping, so code that predates it keeps
-- starting; the API records it the first time it migrates with the owner's URL.

CREATE TABLE IF NOT EXISTS law_versions (
    name text PRIMARY KEY CHECK (name ~ '^law-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{7,12}$'),
    seq integer NOT NULL UNIQUE CHECK (seq > 0),
    git_sha text NOT NULL UNIQUE CHECK (git_sha ~ '^[0-9a-f]{40}$'),
    committed_at timestamptz NOT NULL,
    subject text NOT NULL,
    parent text REFERENCES law_versions (name),
    branch_id text NOT NULL UNIQUE CHECK (branch_id ~ '^br-[a-z0-9-]+$'),
    endpoint_host text NOT NULL CHECK (endpoint_host ~ '^ep-[a-z0-9-]+\.[a-z0-9.-]+$'),
    -- sha256 of the sorted (st, verified sha256, IR sha256) list: the corpus's identity
    corpus_sha256 text NOT NULL CHECK (corpus_sha256 ~ '^[0-9a-f]{64}$'),
    jurisdictions integer NOT NULL CHECK (jurisdictions >= 0),
    rules integer NOT NULL CHECK (rules >= 0),
    sources integer NOT NULL CHECK (sources >= 0),
    load_ms integer CHECK (load_ms >= 0),
    published_at timestamptz NOT NULL DEFAULT now()
);

-- One row per jurisdiction file in a version, so a claim or packet can name the version its rules came
-- from by the files' hashes alone, and two versions can be compared state by state without reading
-- their branches when the hashes match.
CREATE TABLE IF NOT EXISTS law_version_files (
    version text NOT NULL REFERENCES law_versions (name) ON DELETE CASCADE,
    st text NOT NULL CHECK (st ~ '^[A-Z]{2}$'),
    verified_sha256 text NOT NULL CHECK (verified_sha256 ~ '^[0-9a-f]{64}$'),
    ir_sha256 text CHECK (ir_sha256 ~ '^[0-9a-f]{64}$'),
    rule_count integer NOT NULL CHECK (rule_count >= 0),
    PRIMARY KEY (version, st)
);

CREATE INDEX IF NOT EXISTS law_version_files_lookup_idx ON law_version_files (st, verified_sha256);
