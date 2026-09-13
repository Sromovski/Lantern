CREATE TRIGGER sources_no_banned_domains
BEFORE INSERT ON sources
WHEN NEW.url IS NOT NULL AND (
     lower(NEW.url) LIKE '%brainyquote.com%'
  OR lower(NEW.url) LIKE '%goodreads.com%'
  OR lower(NEW.url) LIKE '%azquotes.com%'
  OR lower(NEW.url) LIKE '%quotefancy.com%'
  OR lower(NEW.url) LIKE '%quotes.net%'
  OR lower(NEW.url) LIKE '%quotemaster.org%'
  OR lower(NEW.url) LIKE '%quotationspage.com%'
  OR lower(NEW.url) LIKE '%wisdomquotes.com%'
  OR lower(NEW.url) LIKE '%everydaypower.com%'
  OR lower(NEW.url) LIKE '%quotegarden.com%'
  OR lower(NEW.url) LIKE '%quotepark.info%'
  OR lower(NEW.url) LIKE '%inspiringquotes.us%'
)
BEGIN
  SELECT RAISE(ABORT, 'banned source domain');
END;

CREATE TRIGGER sources_no_banned_domains_on_update
BEFORE UPDATE OF url ON sources
WHEN NEW.url IS NOT NULL AND (
     lower(NEW.url) LIKE '%brainyquote.com%'
  OR lower(NEW.url) LIKE '%goodreads.com%'
  OR lower(NEW.url) LIKE '%azquotes.com%'
  OR lower(NEW.url) LIKE '%quotefancy.com%'
  OR lower(NEW.url) LIKE '%quotes.net%'
  OR lower(NEW.url) LIKE '%quotemaster.org%'
  OR lower(NEW.url) LIKE '%quotationspage.com%'
  OR lower(NEW.url) LIKE '%wisdomquotes.com%'
  OR lower(NEW.url) LIKE '%everydaypower.com%'
  OR lower(NEW.url) LIKE '%quotegarden.com%'
  OR lower(NEW.url) LIKE '%quotepark.info%'
  OR lower(NEW.url) LIKE '%inspiringquotes.us%'
)
BEGIN
  SELECT RAISE(ABORT, 'banned source domain');
END;

CREATE TRIGGER sources_tier_range
BEFORE INSERT ON sources
WHEN NEW.tier NOT IN (1, 2, 3)
BEGIN
  SELECT RAISE(ABORT, 'source tier must be 1, 2, or 3');
END;

CREATE TRIGGER items_insert_not_verified
BEFORE INSERT ON items
WHEN NEW.status = 'verified'
BEGIN
  SELECT RAISE(ABORT, 'items must be inserted as raw and promoted after sources exist');
END;

CREATE TRIGGER items_verified_requires_tier12
BEFORE UPDATE OF status ON items
WHEN NEW.status = 'verified'
  AND NOT EXISTS (SELECT 1 FROM sources WHERE item_id = NEW.id AND tier <= 2)
BEGIN
  SELECT RAISE(ABORT, 'verified items need at least one tier 1 or tier 2 source');
END;

CREATE TRIGGER sources_keep_last_tier12_of_verified
BEFORE DELETE ON sources
WHEN OLD.tier <= 2
  AND (SELECT status FROM items WHERE id = OLD.item_id) = 'verified'
  AND (SELECT COUNT(*) FROM sources WHERE item_id = OLD.item_id AND tier <= 2) = 1
BEGIN
  SELECT RAISE(ABORT, 'cannot delete the last tier 1 or tier 2 source of a verified item');
END;
