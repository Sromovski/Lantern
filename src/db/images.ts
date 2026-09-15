import type { ImageLicense } from '../media/commons.js';
import type { Db } from './connection.js';

export interface NewImage {
  subjectId: number;
  /** Where the file came from (spec section 6); Commons is the only origin this stage uses. */
  origin: 'wikimedia';
  /** The file url, without any tracking query. */
  sourceUrl: string;
  /** The Commons file page, which shows the licence and the credit. */
  filePageUrl: string;
  license: ImageLicense;
  /** The creator as Commons states it, or null when it names none. */
  attribution: string | null;
  /** Where the original is kept, relative to the media directory. */
  localPath: string;
  width: number;
  height: number;
  mime: string;
  bytes: number;
  sha256: string;
}

export interface StoredImage {
  id: number;
  sourceUrl: string;
  localPath: string;
  license: string;
}

/** Inserts the image, or returns the row this subject already has for that source url (a re-run downloads nothing). */
export function insertImage(db: Db, image: NewImage, now: Date = new Date()): number {
  const existing = db.prepare('SELECT id FROM images WHERE subject_id = ? AND source_url = ?').pluck().get(image.subjectId, image.sourceUrl) as
    | number
    | undefined;
  if (existing !== undefined) return existing;
  return Number(
    db
      .prepare(
        `INSERT INTO images (subject_id, origin, source_url, file_page_url, license, attribution, local_path, width, height, mime, bytes, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        image.subjectId,
        image.origin,
        image.sourceUrl,
        image.filePageUrl,
        image.license,
        image.attribution,
        image.localPath,
        image.width,
        image.height,
        image.mime,
        image.bytes,
        image.sha256,
        now.toISOString(),
      ).lastInsertRowid,
  );
}

/** The image already stored for a subject, if any: the same portrait is reused for all of that subject's posts. */
export function subjectImage(db: Db, subjectId: number): StoredImage | undefined {
  return db
    .prepare('SELECT id, source_url AS sourceUrl, local_path AS localPath, license FROM images WHERE subject_id = ? ORDER BY id LIMIT 1')
    .get(subjectId) as StoredImage | undefined;
}

export interface PostNeedingImage {
  postId: number;
  itemId: number;
  subjectId: number;
  subjectSlug: string;
  author: string;
  wikidataId: string;
}

/**
 * Posts of a vertical that have no image yet, oldest first. A post that already has one is never
 * returned, so an approved post keeps the image it was approved with (spec section 10). A subject
 * without a Wikidata id cannot be looked up and is left out.
 */
export function postsNeedingImage(db: Db, verticalId: number, limit: number): PostNeedingImage[] {
  return db
    .prepare(
      `SELECT p.id AS postId, i.id AS itemId, s.id AS subjectId, s.slug AS subjectSlug, s.name AS author, s.wikidata_id AS wikidataId
       FROM posts p
       JOIN items i ON i.id = p.item_id
       JOIN subjects s ON s.id = i.subject_id
       WHERE p.vertical_id = ? AND p.image_id IS NULL AND s.wikidata_id IS NOT NULL
       ORDER BY p.id
       LIMIT ?`,
    )
    .all(verticalId, limit) as PostNeedingImage[];
}

/** Links an image to a post that has none. Returns false when the post already has one: an image is never replaced. */
export function attachImage(db: Db, postId: number, imageId: number): boolean {
  return db.prepare('UPDATE posts SET image_id = ? WHERE id = ? AND image_id IS NULL').run(imageId, postId).changes === 1;
}
