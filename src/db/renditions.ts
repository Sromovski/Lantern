import type { Db } from './connection.js';

export interface NewRendition {
  postId: number;
  format: string;
  /** Images here; video renditions belong to the render stage in phase 8. */
  mediaType: 'image';
  aspect: string;
  width: number;
  height: number;
  /** Where the composed file is kept, relative to the media directory. */
  localPath: string;
  bytes: number;
  status: 'ready' | 'failed';
  error: string | null;
}

/**
 * Writes one format's rendition, replacing the row that format already has.
 *
 * The table's UNIQUE(post_id, format) makes this the natural shape: re-running compose regenerates
 * a format and replaces that row only, leaving every other format untouched (spec section 7). The
 * row is keyed on the pair, so a post can never accumulate two rows for the same format.
 */
export function upsertRendition(db: Db, rendition: NewRendition, now: Date = new Date()): number {
  db.prepare(
    `INSERT INTO renditions (post_id, format, media_type, aspect, width, height, local_path, bytes, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(post_id, format) DO UPDATE SET
       media_type = excluded.media_type,
       aspect = excluded.aspect,
       width = excluded.width,
       height = excluded.height,
       local_path = excluded.local_path,
       bytes = excluded.bytes,
       status = excluded.status,
       error = excluded.error,
       created_at = excluded.created_at`,
  ).run(
    rendition.postId,
    rendition.format,
    rendition.mediaType,
    rendition.aspect,
    rendition.width,
    rendition.height,
    rendition.localPath,
    rendition.bytes,
    rendition.status,
    rendition.error,
    now.toISOString(),
  );
  return db.prepare('SELECT id FROM renditions WHERE post_id = ? AND format = ?').pluck().get(rendition.postId, rendition.format) as number;
}
