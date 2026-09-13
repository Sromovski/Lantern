import { describe, it, expect } from 'vitest';
import { applyQuoteDecision } from '../../src/verify/apply.js';
import { decideQuote, type QuoteEvidence } from '../../src/verify/quote-gate.js';
import { SourcePolicyError } from '../../src/verify/source-policy.js';
import { seedItem, testDb } from '../helpers/db.js';

const QUOTE = 'It was the best of times, it was the worst of times';

const primary = (authorMatches = true): QuoteEvidence => ({
  kind: 'primary-text',
  citation: 'Charles Dickens, A Tale of Two Cities (1859), Book 1, Chapter 1',
  url: 'https://www.gutenberg.org/ebooks/98',
  excerpt: 'It was the best of times, it was the worst of times',
  authorMatches,
});
const scholarly: QuoteEvidence = { kind: 'scholarly', citation: 'Oxford World\'s Classics edition, p. 5' };
const wikiquote: QuoteEvidence = {
  kind: 'reference',
  citation: 'Wikiquote: Charles Dickens',
  url: 'https://en.wikiquote.org/wiki/Charles_Dickens',
};

describe('decideQuote', () => {
  it('verifies a primary-text match by the attributed author as tier 1', () => {
    const d = decideQuote(QUOTE, [primary(), wikiquote]);
    expect(d.status).toBe('verified');
    if (d.status !== 'verified') return;
    expect(d.sources.map((s) => s.tier)).toEqual([1, 3]);
    expect(d.sources[0]).toMatchObject({ excerpt: QUOTE, url: 'https://www.gutenberg.org/ebooks/98' });
  });

  it('rejects quotes too short to verify meaningfully', () => {
    expect(decideQuote('Bah! Humbug!', [primary()])).toMatchObject({ status: 'rejected', reason: 'too-short' });
  });

  it('hard-rejects anything listed as misattributed, even with a primary match', () => {
    const listed: QuoteEvidence = { kind: 'listed-misattributed', citation: 'Wikiquote: Misattributed' };
    expect(decideQuote(QUOTE, [primary(), listed])).toMatchObject({ status: 'rejected', reason: 'misattributed' });
  });

  it('rejects conflicting attributions', () => {
    const conflict: QuoteEvidence = { kind: 'attribution-conflict', citation: 'Some anthology', otherAuthor: 'Thomas Carlyle' };
    const d = decideQuote(QUOTE, [scholarly, conflict]);
    expect(d).toMatchObject({ status: 'rejected', reason: 'attribution-conflict' });
    if (d.status === 'rejected') expect(d.detail).toContain('Thomas Carlyle');
  });

  it('rejects a quote found only in a different author\'s work', () => {
    expect(decideQuote(QUOTE, [primary(false)])).toMatchObject({ status: 'rejected', reason: 'author-mismatch' });
  });

  it('verifies on scholarly evidence as tier 2', () => {
    const d = decideQuote(QUOTE, [scholarly]);
    expect(d.status === 'verified' && d.sources.map((s) => s.tier)).toEqual([2]);
  });

  it('never verifies on reference sources alone', () => {
    expect(decideQuote(QUOTE, [wikiquote])).toMatchObject({ status: 'rejected', reason: 'insufficient-evidence' });
    expect(decideQuote(QUOTE, [])).toMatchObject({ status: 'rejected', reason: 'insufficient-evidence' });
  });

  it('ignores evidence from banned or unparseable urls', () => {
    const aggregator: QuoteEvidence = { ...scholarly, url: 'https://www.brainyquote.com/quotes/x' };
    const junk: QuoteEvidence = { ...scholarly, url: 'not a url' };
    expect(decideQuote(QUOTE, [aggregator, junk])).toMatchObject({ status: 'rejected', reason: 'insufficient-evidence' });
  });
});

describe('applyQuoteDecision', () => {
  const statusOf = (db: ReturnType<typeof testDb>, id: number) =>
    db.prepare('SELECT status, reject_reason FROM items WHERE id = ?').get(id);

  it('writes sources and promotes a verified item', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [primary()]));
    expect(statusOf(db, itemId)).toEqual({ status: 'verified', reject_reason: null });
    expect(db.prepare('SELECT tier FROM sources WHERE item_id = ?').pluck().all(itemId)).toEqual([1]);
  });

  it('records the reason for a rejection and writes no sources', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [wikiquote]));
    expect(statusOf(db, itemId)).toMatchObject({ status: 'rejected', reject_reason: expect.stringMatching(/^insufficient-evidence: /) });
    expect(db.prepare('SELECT COUNT(*) FROM sources').pluck().get()).toBe(0);
  });

  it('refuses to re-decide an item that is not raw', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [wikiquote]));
    expect(() => applyQuoteDecision(db, itemId, decideQuote(QUOTE, [primary()]))).toThrow(/only raw items/);
  });

  it('rolls back entirely if any source violates policy', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    const forged = {
      status: 'verified' as const,
      sources: [
        { tier: 1 as const, citation: 'A Tale of Two Cities' },
        { tier: 2 as const, citation: 'x', url: 'https://www.goodreads.com/quotes/1' },
      ],
    };
    expect(() => applyQuoteDecision(db, itemId, forged)).toThrow(SourcePolicyError);
    expect(statusOf(db, itemId)).toMatchObject({ status: 'raw' });
    expect(db.prepare('SELECT COUNT(*) FROM sources').pluck().get()).toBe(0);
  });
});
