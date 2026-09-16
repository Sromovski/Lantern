import type { SourceInput } from '../verify/source-policy.js';
import type { Db } from './connection.js';
import { insertSource } from './sources.js';

/** After this many failed attempts a quote is no longer offered to enrich, unless a run asks to retry failed quotes. */
export const MAX_ENRICH_FAILURES = 3;

export interface ItemToEnrich {
  itemId: number;
  subjectId: number;
  body: string;
  workTitle: string;
  author: string;
  wikidataId: string;
}

export interface ItemsToEnrichOptions {
  /** Also offer quotes that have already failed MAX_ENRICH_FAILURES times. */
  retryFailed?: boolean;
}

/**
 * Verified quotes in a vertical with no post yet, at most `limit`, with their author.
 *
 * Quotes with fewer recorded failures come first, so a quote that always fails cannot hold back new
 * ones, and a quote that has failed MAX_ENRICH_FAILURES times is left out unless `retryFailed`. Within
 * that, subjects take turns: every subject's oldest waiting quote comes before any subject's second, so
 * a small limit still mixes authors. Quotes without a work title or an author Wikidata id cannot be
 * given sources and are not returned; harvest always records both.
 */
export function itemsToEnrich(db: Db, verticalId: number, limit: number, options: ItemsToEnrichOptions = {}): ItemToEnrich[] {
  return db
    .prepare(
      `SELECT itemId, subjectId, body, workTitle, author, wikidataId FROM (
         SELECT i.id AS itemId, s.id AS subjectId, i.body AS body, i.work_title AS workTitle, s.name AS author, s.wikidata_id AS wikidataId,
                (SELECT COUNT(*) FROM enrich_failures f WHERE f.item_id = i.id) AS failures,
                ROW_NUMBER() OVER (PARTITION BY i.subject_id ORDER BY i.id) AS turn
         FROM items i JOIN subjects s ON s.id = i.subject_id
         WHERE i.vertical_id = ? AND i.kind = 'quote' AND i.status = 'verified'
           AND i.work_title IS NOT NULL AND s.wikidata_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.item_id = i.id)
       )
       WHERE ? = 1 OR failures < ?
       ORDER BY failures, turn, subjectId, itemId
       LIMIT ?`,
    )
    .all(verticalId, options.retryFailed === true ? 1 : 0, MAX_ENRICH_FAILURES, limit) as ItemToEnrich[];
}

/** Records one failed attempt to write a post for a quote. */
export function recordEnrichFailure(db: Db, itemId: number, reason: string, now: Date = new Date()): void {
  db.prepare('INSERT INTO enrich_failures (item_id, reason, failed_at) VALUES (?, ?, ?)').run(itemId, reason, now.toISOString());
}

/** Verified quotes without a post that are no longer offered because they failed MAX_ENRICH_FAILURES times. */
export function countGivenUp(db: Db, verticalId: number): number {
  return db
    .prepare(
      `SELECT COUNT(*) FROM items i
       WHERE i.vertical_id = ? AND i.kind = 'quote' AND i.status = 'verified'
         AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.item_id = i.id)
         AND (SELECT COUNT(*) FROM enrich_failures f WHERE f.item_id = i.id) >= ?`,
    )
    .pluck()
    .get(verticalId, MAX_ENRICH_FAILURES) as number;
}

export interface PostForCaption {
  postId: number;
  status: string;
  /** The post's own editorial prose, which is what a caption is built from. */
  hook: string;
  /** Body paragraphs separated by a blank line. */
  body: string;
  closer: string;
  /**
   * The quotation, exactly as the source prints it. Named `quotation` rather than `body` on purpose:
   * PostToCompose calls the quotation `body`, and confusing the two would put the quote where the
   * write-up belongs.
   */
  quotation: string;
  workTitle: string;
  author: string;
  /** Null when the media stage has not run; 'generated' is what obliges a caption to disclose (spec section 9). */
  imageLicense: string | null;
}

/** The one post a caption run is about: its approved prose, the quotation it is about, and its image's licence. */
export function postForCaption(db: Db, postId: number): PostForCaption | undefined {
  return db
    .prepare(
      `SELECT p.id AS postId, p.status, p.hook, p.body, p.closer,
              i.body AS quotation, i.work_title AS workTitle,
              s.name AS author, im.license AS imageLicense
       FROM posts p
       JOIN items i ON i.id = p.item_id
       JOIN subjects s ON s.id = i.subject_id
       LEFT JOIN images im ON im.id = p.image_id
       WHERE p.id = ?`,
    )
    .get(postId) as PostForCaption | undefined;
}

export interface CitedSource {
  /** The label the post's drafts cite it by (S1, S2, ...). */
  label: string;
  citation: string;
  excerpt: string | null;
}

/**
 * The sources a post's drafts cited, under the labels they used.
 *
 * Nothing has read `post_sources` back before now: enrichment writes it and never looks again. A
 * caption that is not a pure truncation is judged against exactly these, so the caption gate sees
 * the same evidence the post was written from and no more (spec section 7).
 */
export function postCitedSources(db: Db, postId: number): CitedSource[] {
  return db
    .prepare(
      `SELECT ps.label, so.citation, so.excerpt
       FROM post_sources ps
       JOIN sources so ON so.id = ps.source_id
       WHERE ps.post_id = ?
       ORDER BY CAST(SUBSTR(ps.label, 2) AS INTEGER), ps.label`,
    )
    .all(postId) as CitedSource[];
}

export interface PostToCompose {
  postId: number;
  verticalId: number;
  /** Null until the media stage has given the post an image; compose has nothing to compose without one. */
  imageId: number | null;
  status: string;
  /** The quotation, exactly as the source prints it (spec section 8). */
  body: string;
  workTitle: string;
  workYear: number | null;
  author: string;
}

/** The one post a compose run is about, with the quotation and the work it comes from. */
export function postToCompose(db: Db, postId: number): PostToCompose | undefined {
  return db
    .prepare(
      `SELECT p.id AS postId, p.vertical_id AS verticalId, p.image_id AS imageId, p.status,
              i.body AS body, i.work_title AS workTitle, i.work_year AS workYear, s.name AS author
       FROM posts p
       JOIN items i ON i.id = p.item_id
       JOIN subjects s ON s.id = i.subject_id
       WHERE p.id = ?`,
    )
    .get(postId) as PostToCompose | undefined;
}

/**
 * Rewrites a post's alt text once its card exists. Enrich writes a placeholder from the quote alone;
 * the composed card is what a reader actually sees, so this stage owns the description (plan 2.6).
 */
export function updateAltText(db: Db, postId: number, altText: string): boolean {
  return db.prepare('UPDATE posts SET alt_text = ? WHERE id = ?').run(altText, postId).changes === 1;
}

export interface PostRound {
  round: 1 | 2;
  draft: unknown;
  check: unknown;
  /** Every problem the gates found in this round; empty when it passed. */
  problems: string[];
  writerModel: string;
  checkerModel: string;
  /** sha256 of the round's writer system prompt, a blank line, and the checker's system prompt. */
  promptSha256: string;
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
 * (spec section 2.1), the rounds must be numbered from 1 in order, and a 'draft' post's last round must
 * have no problems (spec section 2.6). Each cited paragraph becomes a source of the quote (spec section
 * 2.2: every claim traces to a stored source), reusing an identical source row the quote already has,
 * and is linked to the post under its label.
 */
export function insertPost(db: Db, post: NewPost, now: Date = new Date()): number {
  return db.transaction((): number => {
    const status = db.prepare('SELECT status FROM items WHERE id = ?').pluck().get(post.itemId) as string | undefined;
    if (status !== 'verified') throw new PostRuleError(`item ${post.itemId} is ${status ?? 'missing'}, not verified`);
    const last = post.rounds[post.rounds.length - 1];
    if (last === undefined) throw new PostRuleError('a post needs at least one round');
    if (post.rounds.some((r, i) => r.round !== i + 1)) throw new PostRuleError('rounds must be numbered from 1, in order');
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
      'INSERT INTO post_rounds (post_id, round, draft_json, check_json, problems_json, writer_model, checker_model, prompt_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of post.rounds) {
      round.run(
        postId,
        r.round,
        JSON.stringify(r.draft),
        JSON.stringify(r.check),
        JSON.stringify(r.problems),
        r.writerModel,
        r.checkerModel,
        r.promptSha256,
        now.toISOString(),
      );
    }
    return postId;
  })();
}
