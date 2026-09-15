-- Enrichment state behind each post (spec section 7, lantern enrich).

-- One writing round of a post: the draft the writer returned, the fact check of it, and every
-- problem the gates found. Round 2 exists only when round 1 had problems: the writer gets one
-- revision (user decision 2026-09-15), and both rounds stay visible in review.
CREATE TABLE post_rounds (
  id             INTEGER PRIMARY KEY,
  post_id        INTEGER NOT NULL REFERENCES posts(id),
  round          INTEGER NOT NULL CHECK (round IN (1, 2)),
  draft_json     TEXT NOT NULL,
  check_json     TEXT NOT NULL,
  problems_json  TEXT NOT NULL,     -- JSON array of strings; empty when the round passed every gate
  writer_model   TEXT NOT NULL,
  checker_model  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE(post_id, round)
);

-- The stored sources a post's drafts cite, under the label the drafts use (S1, S2, ...).
CREATE TABLE post_sources (
  id         INTEGER PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES posts(id),
  source_id  INTEGER NOT NULL REFERENCES sources(id),
  label      TEXT NOT NULL CHECK (length(trim(label)) > 0),
  UNIQUE(post_id, label),
  UNIQUE(post_id, source_id)
);
