import { describe, it, expect } from 'vitest';
import {
  applyQuoteDecision,
  ItemNotFoundError,
  ItemNotRawError,
  NotAQuoteError,
  NotReopenableError,
  parseRejectReason,
  reopenInsufficientEvidence,
} from '../../src/verify/apply.js';
import { decideQuote, type QuoteEvidence } from '../../src/verify/quote-gate.js';
import { assertSourceAllowed, SourcePolicyError } from '../../src/verify/source-policy.js';
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

  it('counts a misattributed listing even with a protocol-relative url', () => {
    const listed: QuoteEvidence = {
      kind: 'listed-misattributed',
      citation: 'Wikiquote: Misattributed',
      url: '//en.wikiquote.org/wiki/Charles_Dickens#Misattributed',
    };
    expect(decideQuote(QUOTE, [primary(), listed])).toMatchObject({ status: 'rejected', reason: 'misattributed' });
  });

  it('counts an attribution conflict even with a relative url', () => {
    const conflict: QuoteEvidence = {
      kind: 'attribution-conflict',
      citation: 'Some anthology',
      url: '/wiki/Mark_Twain',
      otherAuthor: 'Mark Twain',
    };
    expect(decideQuote(QUOTE, [scholarly, conflict])).toMatchObject({ status: 'rejected', reason: 'attribution-conflict' });
  });

  it('rejects a primary-text excerpt that does not match the quote', () => {
    const wrongExcerpt = { ...primary(), excerpt: 'Call me Ishmael.' };
    expect(decideQuote(QUOTE, [wrongExcerpt])).toMatchObject({ status: 'rejected', reason: 'insufficient-evidence' });
  });

  it('rejects a primary-text excerpt that is empty', () => {
    const emptyExcerpt = { ...primary(), excerpt: '' };
    expect(decideQuote(QUOTE, [emptyExcerpt])).toMatchObject({ status: 'rejected', reason: 'insufficient-evidence' });
  });

  it('still verifies when the primary-text excerpt differs only by typographic folding', () => {
    const typographic = {
      ...primary(),
      excerpt: '\u201cIt was the best of times\u2014it was the WORST of times',
    };
    const d = decideQuote(QUOTE, [typographic]);
    expect(d.status).toBe('verified');
    if (d.status !== 'verified') return;
    expect(d.sources.map((s) => s.tier)).toEqual([1]);
  });

  it('ignores scholarly evidence whose url is a reference site', () => {
    const onReference: QuoteEvidence = { ...scholarly, url: 'https://en.wikiquote.org/wiki/Charles_Dickens' };
    expect(decideQuote(QUOTE, [onReference])).toMatchObject({ status: 'rejected', reason: 'insufficient-evidence' });
  });

  it('ignores primary-text evidence with a blank citation', () => {
    expect(decideQuote(QUOTE, [{ ...primary(), citation: '   ' }])).toMatchObject({
      status: 'rejected',
      reason: 'insufficient-evidence',
    });
  });

  it('ignores primary-text evidence on an archived reference page even when the excerpt matches', () => {
    const archived = { ...primary(), url: 'https://web.archive.org/web/2020/https://en.wikiquote.org/wiki/Charles_Dickens' };
    expect(decideQuote(QUOTE, [archived])).toMatchObject({ status: 'rejected', reason: 'insufficient-evidence' });
  });

  it('keeps a valid primary source when a companion scholarly source is invalid', () => {
    const d = decideQuote(QUOTE, [primary(), { ...scholarly, url: 'https://en.wikipedia.org/wiki/A_Tale_of_Two_Cities' }]);
    expect(d.status).toBe('verified');
    if (d.status !== 'verified') return;
    expect(d.sources.map((s) => s.tier)).toEqual([1]);
  });

  it('only ever returns verified decisions whose sources pass the insert policy', () => {
    const pool: QuoteEvidence[] = [
      primary(),
      primary(false),
      scholarly,
      wikiquote,
      { ...scholarly, url: 'https://en.wikipedia.org/wiki/X' },
      { ...primary(), citation: '' },
      { ...primary(), url: 'https://web.archive.org/web/2019/https://www.brainyquote.com/x' },
      { ...scholarly, citation: '' },
    ];
    let verified = 0;
    for (let mask = 0; mask < 1 << pool.length; mask++) {
      const evidence = pool.filter((_, i) => (mask >> i) & 1);
      const d = decideQuote(QUOTE, evidence);
      if (d.status !== 'verified') continue;
      verified++;
      for (const source of d.sources) expect(() => assertSourceAllowed(source)).not.toThrow();
    }
    expect(verified).toBeGreaterThan(0);
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

  it('throws ItemNotRawError for an item that was already decided', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [wikiquote]));
    expect(() => applyQuoteDecision(db, itemId, decideQuote(QUOTE, [primary()]))).toThrow(ItemNotRawError);
  });

  it('throws ItemNotFoundError for a missing item', () => {
    const db = testDb();
    expect(() => applyQuoteDecision(db, 9999, decideQuote(QUOTE, [primary()]))).toThrow(ItemNotFoundError);
  });

  it('refuses to apply a quote decision to a non-quote item', () => {
    const db = testDb();
    const { verticalId } = seedItem(db, QUOTE);
    const factId = Number(
      db
        .prepare(
          "INSERT INTO items (vertical_id, kind, body, body_hash, status, created_at) VALUES (?, 'fact', 'Water boils at 100 C at sea level', 'fact-hash-1', 'raw', '2026-01-01T00:00:00.000Z')",
        )
        .run(verticalId).lastInsertRowid,
    );
    expect(() => applyQuoteDecision(db, factId, decideQuote(QUOTE, [primary()]))).toThrow(NotAQuoteError);
    expect(db.prepare('SELECT COUNT(*) FROM sources').pluck().get()).toBe(0);
  });
});

describe('parseRejectReason', () => {
  it.each([
    ['insufficient-evidence: reference sources only', { reason: 'insufficient-evidence', detail: 'reference sources only' }],
    ['misattributed: Wikiquote: Misattributed', { reason: 'misattributed', detail: 'Wikiquote: Misattributed' }],
    ['unparseable', { reason: 'unparseable', detail: '' }],
  ])('parses %j', (text, expected) => {
    expect(parseRejectReason(text)).toEqual(expected);
  });
});

describe('reopenInsufficientEvidence', () => {
  const statusOf = (db: ReturnType<typeof testDb>, id: number) =>
    db.prepare('SELECT status, reject_reason FROM items WHERE id = ?').get(id);

  it('reopens an insufficient-evidence rejection so the quote can be verified later', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [wikiquote]));
    reopenInsufficientEvidence(db, itemId);
    expect(statusOf(db, itemId)).toEqual({ status: 'raw', reject_reason: null });
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [primary()]));
    expect(statusOf(db, itemId)).toMatchObject({ status: 'verified' });
  });

  it('refuses to reopen a final rejection', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    const listed: QuoteEvidence = { kind: 'listed-misattributed', citation: 'Wikiquote: Misattributed' };
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [listed]));
    expect(() => reopenInsufficientEvidence(db, itemId)).toThrow(NotReopenableError);
    expect(statusOf(db, itemId)).toMatchObject({ status: 'rejected' });
  });

  it('refuses to reopen a raw item', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    expect(() => reopenInsufficientEvidence(db, itemId)).toThrow(NotReopenableError);
  });

  it('refuses to reopen a verified item', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [primary()]));
    expect(() => reopenInsufficientEvidence(db, itemId)).toThrow(NotReopenableError);
    expect(statusOf(db, itemId)).toMatchObject({ status: 'verified' });
  });
});
