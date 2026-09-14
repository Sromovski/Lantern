import { describe, it, expect } from 'vitest';
import { EvidenceError, insertEvidence, loadEvidence } from '../../src/db/evidence.js';
import { decideQuote, type QuoteEvidence } from '../../src/verify/quote-gate.js';
import { seedItem, testDb } from '../helpers/db.js';

const QUOTE = 'It was the best of times, it was the worst of times';

const ALL: QuoteEvidence[] = [
  {
    kind: 'primary-text',
    citation: 'Charles Dickens, A Tale of Two Cities (1859)',
    url: 'https://www.gutenberg.org/cache/epub/98/pg98.txt',
    excerpt: QUOTE,
    authorMatches: true,
  },
  { kind: 'scholarly', citation: 'Oxford World\'s Classics edition, p. 5', authorMatches: true },
  { kind: 'reference', citation: 'Wikiquote: Charles Dickens', url: 'https://en.wikiquote.org/wiki/Charles_Dickens' },
  { kind: 'listed-misattributed', citation: 'Wikiquote: Misattributed' },
  { kind: 'attribution-conflict', citation: 'Some anthology', otherAuthor: 'Thomas Carlyle' },
];

describe('item evidence', () => {
  it('round-trips every evidence kind exactly, in insertion order', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    for (const evidence of ALL) insertEvidence(db, itemId, evidence);
    expect(loadEvidence(db, itemId)).toEqual(ALL);
  });

  it('feeds the quote gate unchanged', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    insertEvidence(db, itemId, ALL[0]!);
    expect(decideQuote(QUOTE, loadEvidence(db, itemId))).toMatchObject({ status: 'verified' });
  });

  it('loads an empty list for an item with no evidence', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    expect(loadEvidence(db, itemId)).toEqual([]);
  });

  it('refuses evidence for an item that does not exist', () => {
    const db = testDb();
    expect(() => insertEvidence(db, 9999, ALL[1]!)).toThrow(/FOREIGN KEY/);
  });

  it('refuses to load a row that is malformed for its kind', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    db.prepare(
      "INSERT INTO item_evidence (item_id, kind, citation, recorded_at) VALUES (?, 'primary-text', 'written by raw SQL', '2026-09-13T00:00:00.000Z')",
    ).run(itemId);
    expect(() => loadEvidence(db, itemId)).toThrow(EvidenceError);
  });
});
