import { describe, it, expect } from 'vitest';
import { insertHarvestedQuote, upsertAuthorSubject } from '../../src/db/quotes.js';
import type { QuoteEvidence } from '../../src/verify/quote-gate.js';
import { verifyVertical } from '../../src/verify/run.js';
import { seedItem, testDb } from '../helpers/db.js';

const NOW = () => new Date('2026-09-15T00:00:00.000Z');
const BODY = 'A wonderful fact to reflect upon, that every human creature is constituted to be that profound secret and mystery to every other.';
const OTHER = 'Nothing in this second passage has any primary text behind it, so it cannot be verified yet.';

const primary: QuoteEvidence = {
  kind: 'primary-text',
  citation: 'Charles Dickens, A Tale of Two Cities (Project Gutenberg #98)',
  url: 'https://www.gutenberg.org/ebooks/98.txt.utf-8',
  excerpt: BODY,
  location: 'characters 10-140 after the Project Gutenberg header',
  authorMatches: true,
};

function setup() {
  const db = testDb();
  const verticalId = Number(
    db.prepare("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'Literature', 'config/verticals/literature.yaml')").run()
      .lastInsertRowid,
  );
  const subjectId = upsertAuthorSubject(
    db,
    verticalId,
    { name: 'Charles Dickens', gutendex_name: 'Dickens, Charles', wikidata_id: 'Q5686', birth_year: 1812, death_year: 1870 },
    NOW(),
  );
  const quote = (body: string, evidence: QuoteEvidence[]) =>
    insertHarvestedQuote(
      db,
      { verticalId, subjectId, author: 'Charles Dickens', body, workTitle: 'A Tale of Two Cities', evidence, wikiquotePage: 'Charles Dickens', wikiquoteCheckedAt: NOW().toISOString() },
      NOW(),
    ).itemId;
  return { db, verticalId, quote };
}

const status = (db: ReturnType<typeof testDb>, id: number) => db.prepare('SELECT status FROM items WHERE id = ?').pluck().get(id);

describe('verifyVertical', () => {
  it('decides every checked raw quote with the quote gate', () => {
    const { db, verticalId, quote } = setup();
    const verified = quote(BODY, [primary]);
    const insufficient = quote(OTHER, [{ kind: 'reference', citation: 'Wikiquote, Charles Dickens', url: 'https://en.wikiquote.org/wiki/Charles_Dickens' }]);
    expect(verifyVertical(db, verticalId, { now: NOW })).toEqual({
      considered: 2,
      verified: 1,
      rejected: { 'insufficient-evidence': 1 },
      unchecked: 0,
      malformed: 0,
      reopened: 0,
    });
    expect([status(db, verified), status(db, insufficient)]).toEqual(['verified', 'rejected']);
    expect(db.prepare('SELECT tier, url FROM sources WHERE item_id = ?').all(verified)).toEqual([{ tier: 1, url: primary.url }]);
  });

  it('leaves a raw quote without a recorded Wikiquote check raw', () => {
    const { db, verticalId } = setup();
    const { itemId } = seedItem(db, BODY);
    db.prepare("INSERT INTO item_evidence (item_id, kind, citation, url, excerpt, author_matches, recorded_at) VALUES (?, 'primary-text', 'x', ?, ?, 1, ?)").run(
      itemId,
      primary.url,
      BODY,
      NOW().toISOString(),
    );
    expect(verifyVertical(db, verticalId, { now: NOW })).toMatchObject({ considered: 1, verified: 0, unchecked: 1 });
    expect(status(db, itemId)).toBe('raw');
  });

  it('leaves a quote with malformed evidence raw instead of deciding on the rest', () => {
    const { db, verticalId, quote } = setup();
    const itemId = quote(BODY, [primary]);
    db.prepare("INSERT INTO item_evidence (item_id, kind, citation, recorded_at) VALUES (?, 'attribution-conflict', 'Some anthology', ?)").run(
      itemId,
      NOW().toISOString(),
    );
    expect(verifyVertical(db, verticalId, { now: NOW })).toMatchObject({ considered: 1, verified: 0, malformed: 1 });
    expect(status(db, itemId)).toBe('raw');
  });

  it('reopens only insufficient-evidence rejections when asked, and decides them again', () => {
    const { db, verticalId, quote } = setup();
    const insufficient = quote(OTHER, []);
    const listed = quote(BODY, [primary, { kind: 'listed-misattributed', citation: 'Wikiquote, Charles Dickens: Misattributed' }]);
    verifyVertical(db, verticalId, { now: NOW });
    expect([status(db, insufficient), status(db, listed)]).toEqual(['rejected', 'rejected']);
    expect(verifyVertical(db, verticalId, { retryInsufficient: true, now: NOW })).toEqual({
      considered: 1,
      verified: 0,
      rejected: { 'insufficient-evidence': 1 },
      unchecked: 0,
      malformed: 0,
      reopened: 1,
    });
    expect(db.prepare('SELECT reject_reason FROM items WHERE id = ?').pluck().get(listed)).toMatch(/^misattributed: /);
  });
});
