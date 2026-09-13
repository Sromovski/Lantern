import { describe, it, expect } from 'vitest';
import { insertSource } from '../../src/db/sources.js';
import { BANNED_SOURCE_DOMAINS, SourcePolicyError } from '../../src/verify/source-policy.js';
import { seedItem, testDb } from '../helpers/db.js';

const NOW = '2026-01-01T00:00:00.000Z';
const count = (db: ReturnType<typeof testDb>) => db.prepare('SELECT COUNT(*) FROM sources').pluck().get();

describe('source guards', () => {
  it('insertSource refuses banned sources and writes nothing', () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    expect(() =>
      insertSource(db, itemId, { tier: 2, citation: 'x', url: 'https://www.brainyquote.com/q' }),
    ).toThrow(SourcePolicyError);
    expect(count(db)).toBe(0);
  });

  it('the database trigger rejects every banned domain even with raw SQL', () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    const raw = db.prepare("INSERT INTO sources (item_id, tier, url, citation, retrieved_at) VALUES (?, 2, ?, 'x', ?)");
    for (const domain of BANNED_SOURCE_DOMAINS) {
      expect(() => raw.run(itemId, `https://www.${domain}/anything`, NOW), domain).toThrow(/banned source domain/);
    }
  });

  it('items cannot be inserted already verified', () => {
    const db = testDb();
    const { verticalId } = seedItem(db);
    expect(() =>
      db.prepare("INSERT INTO items (vertical_id, kind, body, body_hash, status, created_at) VALUES (?, 'quote', 'b', 'h2', 'verified', ?)").run(verticalId, NOW),
    ).toThrow(/inserted as raw/);
  });

  it('an item with only tier 3 sources cannot be verified', () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    insertSource(db, itemId, { tier: 3, citation: 'Wikiquote', url: 'https://en.wikiquote.org/wiki/Charles_Dickens' });
    expect(() => db.prepare("UPDATE items SET status = 'verified' WHERE id = ?").run(itemId)).toThrow(/tier 1 or tier 2/);
  });

  it('an item with a tier 1 source can be verified, and that source cannot then be deleted', () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    const sourceId = insertSource(db, itemId, { tier: 1, citation: 'A Tale of Two Cities, Book 1, Ch. 1' });
    db.prepare("UPDATE items SET status = 'verified' WHERE id = ?").run(itemId);
    expect(() => db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId)).toThrow(/last tier 1 or tier 2 source/);
  });
});
