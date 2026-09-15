-- Harvest state that the verify stage and later harvest runs depend on
-- (spec section 7: state lives in SQLite between stages).

-- The Wikiquote Misattributed/Disputed check made for a quote item before it was inserted.
-- verify refuses a raw quote that has no such row (spec section 8).
CREATE TABLE quote_checks (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  check_name  TEXT NOT NULL CHECK (check_name IN ('wikiquote')),
  page        TEXT NOT NULL CHECK (length(trim(page)) > 0),
  checked_at  TEXT NOT NULL,
  UNIQUE(item_id, check_name)
);

-- A book whose candidates the picker has already judged with this prompt and model,
-- so a later harvest run spends nothing on it.
CREATE TABLE book_picks (
  id              INTEGER PRIMARY KEY,
  vertical_id     INTEGER NOT NULL REFERENCES verticals(id),
  gutenberg_id    INTEGER NOT NULL,
  prompt_sha256   TEXT NOT NULL,
  model           TEXT NOT NULL,
  batches         INTEGER NOT NULL,
  failed_batches  INTEGER NOT NULL,
  picked          INTEGER NOT NULL,
  picked_at       TEXT NOT NULL,
  UNIQUE(vertical_id, gutenberg_id, prompt_sha256, model)
);
