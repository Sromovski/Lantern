import type { SourceInput } from '../verify/source-policy.js';
import type { Db } from './connection.js';
import { insertSource } from './sources.js';

export interface ItemToEnrich {
  itemId: number;
  subjectId: number;
  body: string;
  workTitle: string;
  author: string;
  wikidataId: string;
}

/**
 * Verified quotes in a vertical with no post yet, at most `limit`, with their author. Subjects take
 * turns: every subject's oldest waiting quote comes before any subject's second, so a small limit still
 * mixes authors. Quotes without a work title or an author Wikidata id cannot be given sources and are
 * not returned; harvest always records both.
 */
export function itemsToEnrich(db: Db, verticalId: number, limit: number): ItemToEnrich[] {
  return db
    .prepare(
      `SELECT itemId, subjectId, body, workTitle, author, wikidataId FROM (
         SELECT i.id AS itemId, s.id AS subjectId, i.body AS body, i.work_title AS workTitle, s.name AS author, s.wikidata_id AS wikidataId,
                ROW_NUMBER() OVER (PARTITION BY i.subject_id ORDER BY i.id) AS turn
         FROM items i JOIN subjects s ON s.id = i.subject_id
         WHERE i.vertical_id = ? AND i.kind = 'quote' AND i.status = 'verified'
           AND i.work_title IS NOT NULL AND s.wikidata_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.item_id = i.id)
       )
       ORDER BY turn, subjectId, itemId
       LIMIT ?`,
    )
    .all(verticalId, limit) as ItemToEnrich[];
}

export interface PostRound {
  round: 1 | 2;
  draft: unknown;
  check: unknown;
  /** Every problem the gates found in this round; empty when it passed. */
  problems: string[];
  writerModel: string;
  checkerModel: string;
}

export interface PostSource {
  /** The label the drafts cite it by (S1, S2, ...). */
  label: string;
  source: SourceInput;
  retrievedAt: Date;
}

export interface NewPost {
  itemId: number;
  verticalId: number;
  hook: string;
  /** Body paragraphs separated by a blank line. */
  body: string;
  closer: string;
  altText: string;
  status: 'draft' | 'needs_review';
  rounds: PostRound[];
  sources: PostSource[];
}

/** A post that would break the enrichment rules: nothing was written. */
export class PostRuleError extends Error {
  override name = 'PostRuleError';
}

/**
 * Inserts a post with its rounds and cited sources in one transaction. The quote must be verified
 * (spec section 2.1), and a 'draft' post's last round must have no problems (spec section 2.6). Each
 * cited paragraph becomes a source of the quote (spec section 2.2: every claim traces to a stored
 * source), reusing an identical source row the quote already has, and is linked to the post under its
 * label.
 */
export function insertPost(db: Db, post: NewPost, now: Date = new Date()): number {
  return db.transaction((): number => {
    const status = db.prepare('SELECT status FROM items WHERE id = ?').pluck().get(post.itemId) as string | undefined;
    if (status !== 'verified') throw new PostRuleError(`item ${post.itemId} is ${status ?? 'missing'}, not verified`);
    const last = post.rounds[post.rounds.length - 1];
    if (last === undefined) throw new PostRuleError('a post needs at least one round');
    if (post.status === 'draft' && last.problems.length > 0) throw new PostRuleError('a draft post cannot have problems in its last round');

    const postId = Number(
      db
        .prepare('INSERT INTO posts (item_id, vertical_id, hook, body, closer, alt_text, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(post.itemId, post.verticalId, post.hook, post.body, post.closer, post.altText, post.status, now.toISOString()).lastInsertRowid,
    );
    const existing = db
      .prepare('SELECT id FROM sources WHERE item_id = ? AND tier = ? AND url IS ? AND citation = ? AND excerpt IS ? ORDER BY id LIMIT 1')
      .pluck();
    const link = db.prepare('INSERT INTO post_sources (post_id, source_id, label) VALUES (?, ?, ?)');
    for (const { label, source, retrievedAt } of post.sources) {
      const found = existing.get(post.itemId, source.tier, source.url ?? null, source.citation, source.excerpt ?? null) as number | undefined;
      link.run(postId, found ?? insertSource(db, post.itemId, source, retrievedAt), label);
    }
    const round = db.prepare(
      'INSERT INTO post_rounds (post_id, round, draft_json, check_json, problems_json, writer_model, checker_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of post.rounds) {
      round.run(postId, r.round, JSON.stringify(r.draft), JSON.stringify(r.check), JSON.stringify(r.problems), r.writerModel, r.checkerModel, now.toISOString());
    }
    return postId;
  })();
}
