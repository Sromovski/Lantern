-- The banned-domain triggers in 002 are a best-effort substring backstop for
-- hand-typed SQL; they do not decode percent-encoded hosts (e.g.
-- 'brainyquote%2Ecom'). The authoritative check is `assertSourceAllowed`,
-- called by `insertSource`, which parses the URL properly.

CREATE TRIGGER sources_tier_range_on_update
BEFORE UPDATE OF tier ON sources
WHEN NEW.tier NOT IN (1, 2, 3)
BEGIN
  SELECT RAISE(ABORT, 'source tier must be 1, 2, or 3');
END;

CREATE TRIGGER sources_keep_last_tier12_on_downgrade
BEFORE UPDATE OF tier ON sources
WHEN OLD.tier <= 2
  AND NEW.tier > 2
  AND (SELECT status FROM items WHERE id = OLD.item_id) = 'verified'
  AND (SELECT COUNT(*) FROM sources WHERE item_id = OLD.item_id AND tier <= 2) = 1
BEGIN
  SELECT RAISE(ABORT, 'cannot downgrade the last tier 1 or tier 2 source of a verified item');
END;

CREATE TRIGGER sources_item_id_immutable
BEFORE UPDATE OF item_id ON sources
WHEN NEW.item_id <> OLD.item_id
BEGIN
  SELECT RAISE(ABORT, 'sources cannot be moved between items');
END;
