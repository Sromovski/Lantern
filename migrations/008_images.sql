-- Image provenance for lantern media (spec sections 2.3 and 10): enough to re-check a licence
-- later, and to prove the stored file is the one Commons served.
ALTER TABLE images ADD COLUMN file_page_url TEXT;   -- the Commons file page, where the licence and credit are shown
ALTER TABLE images ADD COLUMN mime TEXT;
ALTER TABLE images ADD COLUMN bytes INTEGER;
ALTER TABLE images ADD COLUMN sha256 TEXT;          -- of the downloaded original

-- One row per source file per subject, so a re-run reuses the stored image instead of downloading it again.
CREATE UNIQUE INDEX idx_images_subject_source ON images(subject_id, source_url);
CREATE INDEX idx_images_item ON images(item_id);
