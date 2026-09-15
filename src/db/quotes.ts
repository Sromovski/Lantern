import type { HarvestAuthor } from '../harvest/gutendex.js';
import { bodyHash } from '../verify/normalize.js';
import type { QuoteEvidence } from '../verify/quote-gate.js';
import type { Db } from './connection.js';
import { insertEvidence } from './evidence.js';

/** An existing subjects row with the author's slug names a different Wikidata entity. */
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
 * The author's subjects row, created on first use. An existing row with the same slug must carry the
 * same wikidata_id, so harvested quotes can never attach to a different author of the same name.
 */
export function upsertAuthorSubject(db: Db, verticalId: number, author: HarvestAuthor, now: Date = new Date()): number {
  const slug = authorSlug(author.name);
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
  /** The verbatim passage, whitespace tidied only (user decision 2026-09-13). */
  body: string;
  workTitle: string;
  evidence: QuoteEvidence[];
  /** The Wikiquote page whose Misattributed and Disputed sections were checked for this quote. */
  wikiquotePage: string;
}

export interface InsertedQuote {
  itemId: number;
  inserted: boolean;
}

/**
 * Inserts a raw quote, its evidence and its Wikiquote check in one transaction. A body whose
 * normalized hash already exists in the vertical (spec section 7 dedupe) is left as it is: the
 * existing item gets no further evidence or checks, so re-running harvest never duplicates rows.
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
      const itemId = db.prepare('SELECT id FROM items WHERE vertical_id = ? AND body_hash = ?').pluck().get(quote.verticalId, hash) as number;
      return { itemId, inserted: false };
    }
    const itemId = Number(result.lastInsertRowid);
    for (const evidence of quote.evidence) insertEvidence(db, itemId, evidence, now);
    db.prepare("INSERT INTO quote_checks (item_id, check_name, page, checked_at) VALUES (?, 'wikiquote', ?, ?)").run(
      itemId,
      quote.wikiquotePage,
      now.toISOString(),
    );
    return { itemId, inserted: true };
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

/** Records that the picker judged a book with this prompt and model. A repeat updates the counts. */
export function recordBookPick(db: Db, pick: BookPick, now: Date = new Date()): void {
  db.prepare(
    `INSERT INTO book_picks (vertical_id, gutenberg_id, prompt_sha256, model, batches, failed_batches, picked, picked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vertical_id, gutenberg_id, prompt_sha256, model)
     DO UPDATE SET batches = excluded.batches, failed_batches = excluded.failed_batches, picked = excluded.picked, picked_at = excluded.picked_at`,
  ).run(pick.verticalId, pick.gutenbergId, pick.promptSha256, pick.model, pick.batches, pick.failedBatches, pick.picked, now.toISOString());
}
