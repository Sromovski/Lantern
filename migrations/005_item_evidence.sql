-- Evidence the harvest stage gathers for a quote item, read back by the verify stage
-- (spec section 7: state lives in SQLite between stages). One row per QuoteEvidence value.
CREATE TABLE item_evidence (
  id             INTEGER PRIMARY KEY,
  item_id        INTEGER NOT NULL REFERENCES items(id),
  kind           TEXT NOT NULL CHECK (kind IN ('primary-text', 'scholarly', 'reference', 'listed-misattributed', 'attribution-conflict')),
  citation       TEXT NOT NULL CHECK (length(trim(citation)) > 0),
  url            TEXT,
  excerpt        TEXT,
  author_matches INTEGER CHECK (author_matches IN (0, 1)),
  other_author   TEXT,
  recorded_at    TEXT NOT NULL
);

CREATE INDEX idx_item_evidence_item ON item_evidence(item_id);
