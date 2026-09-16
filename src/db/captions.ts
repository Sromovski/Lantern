import type { Db } from './connection.js';

export interface NewCaption {
  postId: number;
  platform: string;
  /** Pinterest and YouTube carry a title; Facebook has only a caption body. */
  title: string | null;
  /** The caption body, already within the channel's text_max. */
  text: string;
  /** Space-separated. Unused by both Phase 2 channels: Pinterest copy is plain keywords (spec section 11). */
  hashtags: string | null;
  /** The archive permalink. Null until the archive site ships in Phase 8 (spec section 13, user decision 2026-09-16). */
  link: string | null;
}

/**
 * Writes one platform's caption, replacing the row that platform already has.
 *
 * The table's UNIQUE(post_id, platform) makes this the natural shape, exactly as UNIQUE(post_id,
 * format) does for renditions: re-running the stage regenerates one platform's caption and leaves
 * every other platform untouched.
 *
 * `char_count` is computed here rather than passed in, so it cannot disagree with the text it
 * counts. It counts the body only: `text_max` governs `captions.text` and `title_max` governs the
 * title, so a combined number would mean neither.
 */
export function upsertCaption(db: Db, caption: NewCaption, now: Date = new Date()): number {
  db.prepare(
    `INSERT INTO captions (post_id, platform, title, text, hashtags, link, char_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(post_id, platform) DO UPDATE SET
       title = excluded.title,
       text = excluded.text,
       hashtags = excluded.hashtags,
       link = excluded.link,
       char_count = excluded.char_count,
       created_at = excluded.created_at`,
  ).run(
    caption.postId,
    caption.platform,
    caption.title,
    caption.text,
    caption.hashtags,
    caption.link,
    [...caption.text].length,
    now.toISOString(),
  );
  return db.prepare('SELECT id FROM captions WHERE post_id = ? AND platform = ?').pluck().get(caption.postId, caption.platform) as number;
}
