import { describe, it, expect } from 'vitest';
import { loadEvidence } from '../../src/db/evidence.js';
import {
  authorSlug,
  hasBookPick,
  hasWikiquoteCheck,
  insertHarvestedQuote,
  recordBookPick,
  SubjectConflictError,
  upsertAuthorSubject,
  type HarvestedQuote,
} from '../../src/db/quotes.js';
import type { HarvestAuthor } from '../../src/harvest/gutendex.js';
import type { QuoteEvidence } from '../../src/verify/quote-gate.js';
import { verifyVertical } from '../../src/verify/run.js';
import { seedItem, testDb } from '../helpers/db.js';

const NOW = new Date('2026-09-15T00:00:00.000Z');
const FETCHED = '2026-09-14T12:00:00.000Z';
const DICKENS: HarvestAuthor = {
  name: 'Charles Dickens',
  gutendex_name: 'Dickens, Charles',
  wikidata_id: 'Q5686',
  birth_year: 1812,
  death_year: 1870,
};
const AUSTEN: HarvestAuthor = { name: 'Jane Austen', gutendex_name: 'Austen, Jane', wikidata_id: 'Q36322', birth_year: 1775, death_year: 1817 };
const BODY = 'A wonderful fact to reflect upon, that every human creature is constituted to be that profound secret and mystery to every other.';

const primary = (citation: string): QuoteEvidence => ({
  kind: 'primary-text',
  citation,
  url: 'https://www.gutenberg.org/cache/epub/98/pg98.txt',
  excerpt: BODY,
  location: 'characters 120450-120580 after the Project Gutenberg header',
  authorMatches: true,
});

function setup() {
  const db = testDb();
  const verticalId = Number(
    db.prepare("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'Literature', 'config/verticals/literature.yaml')").run()
      .lastInsertRowid,
  );
  const subjectId = upsertAuthorSubject(db, verticalId, DICKENS, NOW);
  const quote: HarvestedQuote = {
    verticalId,
    subjectId,
    author: 'Charles Dickens',
    body: BODY,
    workTitle: 'A Tale of Two Cities',
    evidence: [primary('Charles Dickens, A Tale of Two Cities (Project Gutenberg #98)')],
    wikiquotePage: 'Charles Dickens',
    wikiquoteCheckedAt: FETCHED,
  };
  return { db, verticalId, subjectId, quote };
}

describe('harvest rows', () => {
  it('creates an author subject once, bound to its Wikidata id', () => {
    const { db, verticalId, subjectId } = setup();
    expect(upsertAuthorSubject(db, verticalId, DICKENS, NOW)).toBe(subjectId);
    expect(db.prepare('SELECT kind, name, slug, wikidata_id, meta_json FROM subjects WHERE id = ?').get(subjectId)).toEqual({
      kind: 'author',
      name: 'Charles Dickens',
      slug: 'charles-dickens',
      wikidata_id: 'Q5686',
      meta_json: '{"gutendex_name":"Dickens, Charles","birth_year":1812,"death_year":1870}',
    });
    expect(authorSlug('\u00C9mile Zola')).toBe('emile-zola');
  });

  it('refuses an existing subject of the same name with a different Wikidata id', () => {
    const { db, verticalId } = setup();
    expect(() => upsertAuthorSubject(db, verticalId, { ...DICKENS, wikidata_id: 'Q99999' }, NOW)).toThrow(SubjectConflictError);
  });

  it('refuses a second name for a Wikidata id that already has a subject', () => {
    const { db, verticalId } = setup();
    expect(() => upsertAuthorSubject(db, verticalId, { ...DICKENS, name: 'Boz' }, NOW)).toThrow(SubjectConflictError);
  });

  it('inserts a raw quote with its evidence and its Wikiquote check in one step', () => {
    const { db, quote } = setup();
    const { itemId, inserted, conflict } = insertHarvestedQuote(db, quote, NOW);
    expect([inserted, conflict]).toEqual([true, 'none']);
    expect(db.prepare('SELECT kind, body, work_title, status, subject_id FROM items WHERE id = ?').get(itemId)).toEqual({
      kind: 'quote',
      body: BODY,
      work_title: 'A Tale of Two Cities',
      status: 'raw',
      subject_id: quote.subjectId,
    });
    expect(loadEvidence(db, itemId)).toEqual(quote.evidence);
    expect(hasWikiquoteCheck(db, itemId)).toBe(true);
    expect(db.prepare('SELECT checked_at FROM quote_checks WHERE item_id = ?').pluck().get(itemId)).toBe(FETCHED);
  });

  it('leaves the same author\'s existing item alone when the same passage is harvested again', () => {
    const { db, quote } = setup();
    const first = insertHarvestedQuote(db, quote, NOW);
    const again = insertHarvestedQuote(db, { ...quote, body: BODY.toUpperCase(), workTitle: 'Another edition' }, NOW);
    expect(again).toEqual({ itemId: first.itemId, inserted: false, conflict: 'none' });
    expect(db.prepare('SELECT COUNT(*) FROM item_evidence WHERE item_id = ?').pluck().get(first.itemId)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM quote_checks WHERE item_id = ?').pluck().get(first.itemId)).toBe(1);
  });

  it('records an attribution conflict when another author\'s book has the same passage, so verify rejects it', () => {
    const { db, verticalId, quote } = setup();
    const first = insertHarvestedQuote(db, quote, NOW);
    const austen = upsertAuthorSubject(db, verticalId, AUSTEN, NOW);
    const clash = insertHarvestedQuote(
      db,
      { ...quote, subjectId: austen, author: 'Jane Austen', workTitle: 'Emma', evidence: [primary('Jane Austen, Emma (Project Gutenberg #158)')], wikiquotePage: 'Jane Austen' },
      NOW,
    );
    expect(clash).toEqual({ itemId: first.itemId, inserted: false, conflict: 'recorded' });
    expect(loadEvidence(db, first.itemId).map((e) => e.kind)).toEqual(['primary-text', 'attribution-conflict']);
    expect(verifyVertical(db, verticalId, { now: () => NOW })).toMatchObject({ verified: 0, rejected: { 'attribution-conflict': 1 } });
  });

  it('reports, without writing, a clash with another author\'s item that was already decided', () => {
    const { db, verticalId, quote } = setup();
    const first = insertHarvestedQuote(db, quote, NOW);
    expect(verifyVertical(db, verticalId, { now: () => NOW })).toMatchObject({ verified: 1 });
    const austen = upsertAuthorSubject(db, verticalId, AUSTEN, NOW);
    const clash = insertHarvestedQuote(db, { ...quote, subjectId: austen, author: 'Jane Austen', workTitle: 'Emma' }, NOW);
    expect(clash).toEqual({ itemId: first.itemId, inserted: false, conflict: 'decided' });
    expect(db.prepare('SELECT COUNT(*) FROM item_evidence WHERE item_id = ?').pluck().get(first.itemId)).toBe(1);
  });

  it('reports no Wikiquote check for an item inserted another way, and refuses unknown check names', () => {
    const { db } = setup();
    const { itemId } = seedItem(db, 'Some other passage that was inserted without a check, for this test only.');
    expect(hasWikiquoteCheck(db, itemId)).toBe(false);
    expect(() =>
      db.prepare("INSERT INTO quote_checks (item_id, check_name, page, checked_at) VALUES (?, 'goodreads', 'x', ?)").run(itemId, NOW.toISOString()),
    ).toThrow(/CHECK constraint/);
  });

  it('remembers that a book was picked with a given prompt and model', () => {
    const { db, verticalId } = setup();
    const pick = { verticalId, gutenbergId: 98, promptSha256: 'a'.repeat(64), model: 'claude-sonnet-5', batches: 6, failedBatches: 1, picked: 12 };
    expect(hasBookPick(db, verticalId, 98, pick.promptSha256, pick.model)).toBe(false);
    recordBookPick(db, pick, NOW);
    recordBookPick(db, { ...pick, picked: 14 }, NOW);
    expect(hasBookPick(db, verticalId, 98, pick.promptSha256, pick.model)).toBe(true);
    expect(hasBookPick(db, verticalId, 98, pick.promptSha256, 'claude-opus-5')).toBe(false);
    expect(hasBookPick(db, verticalId, 98, 'b'.repeat(64), pick.model)).toBe(false);
    expect(db.prepare('SELECT picked FROM book_picks').pluck().all()).toEqual([14]);
  });
});
