-- Full-text search over the verbatim quotes alone (GET /api/law/search): the law's own words, never
-- Tend's summaries. A generated tsvector with a GIN index, so a search is one index scan. Idempotent for
-- the same reason as 0004.

ALTER TABLE rules ADD COLUMN IF NOT EXISTS quote_search tsvector GENERATED ALWAYS AS (to_tsvector('english', quote)) STORED;

CREATE INDEX IF NOT EXISTS rules_quote_search_idx ON rules USING gin (quote_search);
