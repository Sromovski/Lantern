-- Closes the item-mutation and REPLACE gaps left open by 002-003: a
-- verified item's content/attribution or status could be silently
-- rewritten, and INSERT OR REPLACE could reuse an existing items/sources
-- id. TypeScript (`insertSource` / `applyQuoteDecision`) remains the
-- authoritative write path; these triggers are a best-effort backstop.

CREATE TRIGGER items_verified_content_immutable
BEFORE UPDATE OF body, body_hash, subject_id, kind, vertical_id, work_title, work_year ON items
WHEN OLD.status = 'verified'
BEGIN
  SELECT RAISE(ABORT, 'verified items cannot have their content or attribution changed');
END;

CREATE TRIGGER items_verified_not_reopened
BEFORE UPDATE OF status ON items
WHEN OLD.status = 'verified' AND NEW.status = 'raw'
BEGIN
  SELECT RAISE(ABORT, 'verified items cannot be reopened to raw');
END;

CREATE TRIGGER sources_append_only_by_id
BEFORE INSERT ON sources
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM sources WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'sources are append-only; an existing source id cannot be replaced');
END;

CREATE TRIGGER items_append_only_by_id
BEFORE INSERT ON items
WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM items WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'items are append-only; an existing item id cannot be replaced');
END;
