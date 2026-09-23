import type { HarvestAuthor } from '../harvest/gutendex.js';
import { bodyHash } from '../verify/normalize.js';
import type { QuoteEvidence } from '../verify/quote-gate.js';
import type { Db } from './connection.js';
import { insertEvidence } from './evidence.js';

/** The author would bind to a subject row that names a different Wikidata entity, or the entity already has another subject. */
export class SubjectConflictError extends Error {
  override name = 'SubjectConflictError';
}

export function authorSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The author's subjects row, created on first use and bound by Wikidata id both ways: a row with the
 * author's slug must carry the same wikidata_id, and a wikidata_id already used by a subject under
 * another name is refused. Quotes can then never attach to a different author of the same name, and
 * one author can never become two subjects (which would defeat subject spacing, spec section 12).
 */
export function upsertAuthorSubject(db: Db, verticalId: number, author: HarvestAuthor, now: Date = new Date()): number {
  const slug = authorSlug(author.name);
  const byWikidata = db.prepare('SELECT slug FROM subjects WHERE vertical_id = ? AND wikidata_id = ?').get(verticalId, author.wikidata_id) as
    | { slug: string }
    | undefined;
  if (byWikidata !== undefined && byWikidata.slug !== slug) {
    throw new SubjectConflictError(`${author.wikidata_id} is already the subject ${byWikidata.slug}, not ${slug}`);
  }
  const existing = db.prepare('SELECT id, wikidata_id FROM subjects WHERE vertical_id = ? AND slug = ?').get(verticalId, slug) as
    | { id: number; wikidata_id: string | null }
    | undefined;
  if (existing !== undefined) {
    if (existing.wikidata_id !== author.wikidata_id) {
      throw new SubjectConflictError(`subject ${slug} is ${existing.wikidata_id ?? 'unset'}, not ${author.wikidata_id}`);
    }
    return existing.id;
  }
  const meta = JSON.stringify({ gutendex_name: author.gutendex_name, birth_year: author.birth_year, death_year: author.death_year });
  return Number(
    db
      .prepare(
        "INSERT INTO subjects (vertical_id, kind, name, slug, wikidata_id, meta_json, created_at) VALUES (?, 'author', ?, ?, ?, ?, ?)",
      )
      .run(verticalId, author.name, slug, author.wikidata_id, meta, now.toISOString()).lastInsertRowid,
  );
}

export interface HarvestedQuote {
  verticalId: number;
  subjectId: number;
  /** The author's name, as recorded in conflict evidence when another author's item already has this body. */
  author: string;
  /** The verbatim passage, whitespace tidied only (user decision 2026-09-13). */
  body: string;
  workTitle: string;
  evidence: QuoteEvidence[];
  /** The Wikiquote page whose Misattributed and Disputed sections were checked for this quote. */
  wikiquotePage: string;
  /** When that page was fetched (UTC ISO-8601), which may be earlier than now when it came from the cache. */
  wikiquoteCheckedAt: string;
}

export interface InsertedQuote {
  itemId: number;
  inserted: boolean;
  /**
   * 'none': a new item, or the same author's item already had this body.
   * 'recorded': another author's raw item had this body, so attribution-conflict evidence was added to it
   * and verify will reject it (spec section 8).
   * 'decided': another author's item with this body was already verified or rejected; nothing was written,
   * and a human should look at it.
   */
  conflict: 'none' | 'recorded' | 'decided';
}

/**
 * Inserts a raw quote, its evidence and its Wikiquote check in one transaction. A body whose
 * normalized hash already exists in the vertical (spec section 7 dedupe) is not inserted again. When
 * that existing item belongs to the same author nothing is written, so re-running harvest never
 * duplicates rows; when it belongs to another author, the conflict is recorded or reported instead.
 */
export function insertHarvestedQuote(db: Db, quote: HarvestedQuote, now: Date = new Date()): InsertedQuote {
  return db.transaction((): InsertedQuote => {
    const hash = bodyHash(quote.body);
    const result = db
      .prepare(
        "INSERT OR IGNORE INTO items (vertical_id, subject_id, kind, body, body_hash, work_title, status, created_at) VALUES (?, ?, 'quote', ?, ?, ?, 'raw', ?)",
      )
      .run(quote.verticalId, quote.subjectId, quote.body, hash, quote.workTitle, now.toISOString());
    if (result.changes === 0) {
      const existing = db.prepare('SELECT id, subject_id, status FROM items WHERE vertical_id = ? AND body_hash = ?').get(quote.verticalId, hash) as {
        id: number;
        subject_id: number | null;
        status: string;
      };
      if (existing.subject_id === quote.subjectId) return { itemId: existing.id, inserted: false, conflict: 'none' };
      if (existing.status !== 'raw') return { itemId: existing.id, inserted: false, conflict: 'decided' };
      const primary = quote.evidence.find((e): e is Extract<QuoteEvidence, { kind: 'primary-text' }> => e.kind === 'primary-text');
      insertEvidence(
        db,
        existing.id,
        {
          kind: 'attribution-conflict',
          citation: primary?.citation ?? `${quote.author}, ${quote.workTitle}`,
          ...(primary?.url === undefined ? {} : { url: primary.url }),
          otherAuthor: quote.author,
        },
        now,
      );
      return { itemId: existing.id, inserted: false, conflict: 'recorded' };
    }
    const itemId = Number(result.lastInsertRowid);
    for (const evidence of quote.evidence) insertEvidence(db, itemId, evidence, now);
    db.prepare("INSERT INTO quote_checks (item_id, check_name, page, checked_at) VALUES (?, 'wikiquote', ?, ?)").run(
      itemId,
      quote.wikiquotePage,
      quote.wikiquoteCheckedAt,
    );
    return { itemId, inserted: true, conflict: 'none' };
  })();
}

export function hasWikiquoteCheck(db: Db, itemId: number): boolean {
  return db.prepare("SELECT 1 FROM quote_checks WHERE item_id = ? AND check_name = 'wikiquote'").get(itemId) !== undefined;
}

export interface BookPick {
  verticalId: number;
  gutenbergId: number;
  promptSha256: string;
  model: string;
  batches: number;
  failedBatches: number;
  picked: number;
}

export function hasBookPick(db: Db, verticalId: number, gutenbergId: number, promptSha256: string, model: string): boolean {
  return (
    db
      .prepare('SELECT 1 FROM book_picks WHERE vertical_id = ? AND gutenberg_id = ? AND prompt_sha256 = ? AND model = ?')
      .get(verticalId, gutenbergId, promptSha256, model) !== undefined
  );
}

/** Quotes in a vertical by the author with this Wikidata id that are raw or verified; a rejected quote is not in the backlog. */
export function authorQuoteCount(db: Db, verticalId: number, wikidataId: string): number {
  return db
    .prepare(
      `SELECT COUNT(*) FROM items i JOIN subjects s ON s.id = i.subject_id
       WHERE i.vertical_id = ? AND s.wikidata_id = ? AND i.kind = 'quote' AND i.status != 'rejected'`,
    )
    .pluck()
    .get(verticalId, wikidataId) as number;
}

/** Records that the picker judged a book with this prompt and model. A repeat updates the counts. */
export function recordBookPick(db: Db, pick: BookPick, now: Date = new Date()): void {
  db.prepare(
    `INSERT INTO book_picks (vertical_id, gutenberg_id, prompt_sha256, model, batches, failed_batches, picked, picked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vertical_id, gutenberg_id, prompt_sha256, model)
     DO UPDATE SET batches = excluded.batches, failed_batches = excluded.failed_batches, picked = excluded.picked, picked_at = excluded.picked_at`,
  ).run(pick.verticalId, pick.gutenbergId, pick.promptSha256, pick.model, pick.batches, pick.failedBatches, pick.picked, now.toISOString());
}
