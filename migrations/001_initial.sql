-- A content vertical (literature, science-curious, ...)
CREATE TABLE verticals (
  id            INTEGER PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  config_path   TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1
);

-- A configured destination: one platform account for one vertical.
CREATE TABLE channels (
  id             INTEGER PRIMARY KEY,
  vertical_id    INTEGER NOT NULL REFERENCES verticals(id),
  platform       TEXT NOT NULL,      -- 'facebook'|'pinterest'|'youtube'|'instagram'|'tiktok'
  handle         TEXT,               -- public @name, for logs and the review UI
  account_ref    TEXT NOT NULL,      -- env var NAME holding the page/board/channel id
  config_path    TEXT NOT NULL,
  auto_publish   INTEGER NOT NULL DEFAULT 0,  -- 0 = queue to needs_review first
  enabled        INTEGER NOT NULL DEFAULT 1,
  UNIQUE(vertical_id, platform, account_ref)
);

-- A subject: an author, a scientific concept, a phenomenon.
CREATE TABLE subjects (
  id            INTEGER PRIMARY KEY,
  vertical_id   INTEGER NOT NULL REFERENCES verticals(id),
  kind          TEXT NOT NULL,          -- 'author' | 'concept' | 'organism' | ...
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  wikidata_id   TEXT,                   -- Q-number, the join key to everything
  summary       TEXT,                   -- short factual bio/definition
  meta_json     TEXT,                   -- dates, nationality, field, etc.
  created_at    TEXT NOT NULL,
  UNIQUE(vertical_id, slug)
);

-- The unit of truth. Verified once, reused across every platform.
CREATE TABLE items (
  id            INTEGER PRIMARY KEY,
  vertical_id   INTEGER NOT NULL REFERENCES verticals(id),
  subject_id    INTEGER REFERENCES subjects(id),
  kind          TEXT NOT NULL,          -- 'quote' | 'fact' | 'explainer'
  body          TEXT NOT NULL,          -- the quote text, or the core fact
  body_hash     TEXT NOT NULL,          -- normalized hash for dedupe
  work_title    TEXT,                   -- source work, for quotes
  work_year     INTEGER,
  status        TEXT NOT NULL,          -- 'raw'|'verified'|'rejected'
  reject_reason TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(vertical_id, body_hash)
);

-- Evidence. Every verified item has >= 1. This table is what keeps us honest.
CREATE TABLE sources (
  id            INTEGER PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES items(id),
  tier          INTEGER NOT NULL,       -- 1 = primary text, 2 = scholarly, 3 = reference
  url           TEXT,
  citation      TEXT NOT NULL,          -- human-readable
  excerpt       TEXT,                   -- the matched passage, if applicable
  retrieved_at  TEXT NOT NULL
);

-- Source imagery, before composition.
CREATE TABLE images (
  id            INTEGER PRIMARY KEY,
  subject_id    INTEGER REFERENCES subjects(id),
  item_id       INTEGER REFERENCES items(id),
  origin        TEXT NOT NULL,          -- 'wikimedia'|'loc'|'met'|'nypl'|'openverse'|'generated'
  source_url    TEXT,
  license       TEXT NOT NULL,          -- 'public-domain'|'cc0'|'cc-by'|'generated'
  attribution   TEXT,
  local_path    TEXT NOT NULL,
  width         INTEGER, height INTEGER,
  created_at    TEXT NOT NULL
);

-- The editorial write-up. Platform-neutral prose.
CREATE TABLE posts (
  id            INTEGER PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES items(id),
  vertical_id   INTEGER NOT NULL REFERENCES verticals(id),
  image_id      INTEGER REFERENCES images(id),  -- chosen source image
  hook          TEXT NOT NULL,
  body          TEXT NOT NULL,
  closer        TEXT,
  alt_text      TEXT NOT NULL,
  status        TEXT NOT NULL,          -- 'draft'|'needs_review'|'approved'|'rejected'
  reject_reason TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(item_id)
);

-- Format-specific media artifacts derived from a post.
CREATE TABLE renditions (
  id            INTEGER PRIMARY KEY,
  post_id       INTEGER NOT NULL REFERENCES posts(id),
  format        TEXT NOT NULL,          -- 'square'|'portrait'|'pin'|'short'|'landscape'
  media_type    TEXT NOT NULL,          -- 'image'|'video'
  aspect        TEXT NOT NULL,          -- '1:1'|'4:5'|'2:3'|'9:16'|'16:9'
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  duration_ms   INTEGER,                -- video only
  local_path    TEXT NOT NULL,
  public_url    TEXT,                   -- required by Instagram and TikTok
  bytes         INTEGER,
  status        TEXT NOT NULL,          -- 'pending'|'ready'|'failed'
  error         TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(post_id, format)
);

-- Platform-specific text derived from a post.
CREATE TABLE captions (
  id            INTEGER PRIMARY KEY,
  post_id       INTEGER NOT NULL REFERENCES posts(id),
  platform      TEXT NOT NULL,
  title         TEXT,                   -- YouTube title, Pinterest pin title
  text          TEXT NOT NULL,          -- the body of the caption/description
  hashtags      TEXT,                   -- space-separated, platform-appropriate
  link          TEXT,                   -- Pinterest destination, archive permalink
  char_count    INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE(post_id, platform)
);

-- One scheduled or completed delivery: a rendition + caption to a channel.
CREATE TABLE publications (
  id              INTEGER PRIMARY KEY,
  post_id         INTEGER NOT NULL REFERENCES posts(id),
  channel_id      INTEGER NOT NULL REFERENCES channels(id),
  rendition_id    INTEGER NOT NULL REFERENCES renditions(id),
  caption_id      INTEGER NOT NULL REFERENCES captions(id),
  status          TEXT NOT NULL,        -- 'scheduled'|'publishing'|'published'|'failed'|'skipped'
  scheduled_for   TEXT,
  published_at    TEXT,
  remote_id       TEXT,                 -- platform-returned post id
  permalink       TEXT,
  idempotency_key TEXT NOT NULL,        -- hash(post_id, channel_id); guards double-posting
  attempt         INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  UNIQUE(post_id, channel_id),
  UNIQUE(idempotency_key)
);

-- Pipeline observability.
CREATE TABLE run_log (
  id            INTEGER PRIMARY KEY,
  vertical_id   INTEGER,
  channel_id    INTEGER,
  stage         TEXT NOT NULL,
  ok            INTEGER NOT NULL,
  detail_json   TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_items_status_vertical      ON items(status, vertical_id);
CREATE INDEX idx_items_body_hash            ON items(body_hash);
CREATE INDEX idx_posts_status_vertical      ON posts(status, vertical_id);
CREATE INDEX idx_renditions_post_status     ON renditions(post_id, status);
CREATE INDEX idx_publications_status_sched  ON publications(status, scheduled_for);
CREATE INDEX idx_publications_channel_pub   ON publications(channel_id, published_at);
CREATE INDEX idx_run_log_stage_created      ON run_log(stage, created_at);
