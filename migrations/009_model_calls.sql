-- Every Claude call the pipeline makes, with the tokens the API reported, so what a quote cost is a
-- query rather than an estimate. A call is recorded as soon as its response arrives, before its
-- answer is judged, because a refused or truncated answer is billed like any other.
-- Prices are not stored: they change, so `lantern costs` applies config/pricing.yaml when it reports.
CREATE TABLE model_calls (
  id                          INTEGER PRIMARY KEY,
  vertical_id                 INTEGER REFERENCES verticals(id),
  stage                       TEXT NOT NULL,     -- 'harvest' | 'enrich' | 'caption'
  role                        TEXT NOT NULL,     -- 'picker' | 'writer' | 'reviser' | 'checker'
  item_id                     INTEGER REFERENCES items(id),   -- enrich calls
  post_id                     INTEGER REFERENCES posts(id),   -- caption calls
  gutenberg_id                INTEGER,                        -- harvest calls: the book whose passages were offered
  requested_model             TEXT NOT NULL,
  model                       TEXT NOT NULL,     -- the model billed; differs when a server-side fallback answered
  input_tokens                INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens               INTEGER NOT NULL CHECK (output_tokens >= 0),
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_creation_input_tokens >= 0),
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_input_tokens >= 0),
  stop_reason                 TEXT,
  created_at                  TEXT NOT NULL
);

CREATE INDEX idx_model_calls_item ON model_calls(item_id);
CREATE INDEX idx_model_calls_post ON model_calls(post_id);
CREATE INDEX idx_model_calls_stage ON model_calls(stage, created_at);
