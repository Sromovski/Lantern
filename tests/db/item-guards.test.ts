import { describe, it, expect } from 'vitest';
import { insertSource } from '../../src/db/sources.js';
import { seedItem, testDb } from '../helpers/db.js';

const NOW = '2026-01-01T00:00:00.000Z';

function verifyWithTier1(db: ReturnType<typeof testDb>, itemId: number): number {
  const sourceId = insertSource(db, itemId, { tier: 1, url: 'https://www.gutenberg.org/ebooks/98', citation: 'A Tale of Two Cities, Book 1, Ch. 1' });
  db.prepare("UPDATE items SET status = 'verified' WHERE id = ?").run(itemId);
  return sourceId;
}

describe('item guards (004_item_guards.sql)', () => {
  it("a verified item's body cannot be changed", () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    verifyWithTier1(db, itemId);
    expect(() =>
      db.prepare('UPDATE items SET body = ? WHERE id = ?').run('Be yourself; everyone else is already taken.', itemId),
    ).toThrow(/cannot have their content or attribution changed/);
  });

  it("a verified item's subject_id cannot be changed", () => {
    const db = testDb();
    const { itemId, verticalId } = seedItem(db);
    verifyWithTier1(db, itemId);
    const subjectId = Number(
      db
        .prepare(
          "INSERT INTO subjects (vertical_id, kind, name, slug, created_at) VALUES (?, 'author', 'Mark Twain', 'mark-twain', ?)",
        )
        .run(verticalId, NOW).lastInsertRowid,
    );
    expect(() => db.prepare('UPDATE items SET subject_id = ? WHERE id = ?').run(subjectId, itemId)).toThrow(
      /cannot have their content or attribution changed/,
    );
  });

  it("a raw item's body can still be changed", () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    expect(() =>
      db.prepare('UPDATE items SET body = ? WHERE id = ?').run('A different quote, still raw', itemId),
    ).not.toThrow();
  });

  it('a verified item cannot be reopened to raw', () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    verifyWithTier1(db, itemId);
    expect(() => db.prepare("UPDATE items SET status = 'raw' WHERE id = ?").run(itemId)).toThrow(
      /cannot be reopened to raw/,
    );
  });

  it('a verified item can still be rejected', () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    verifyWithTier1(db, itemId);
    expect(() =>
      db.prepare("UPDATE items SET status = 'rejected', reject_reason = 'x' WHERE id = ?").run(itemId),
    ).not.toThrow();
  });

  it('sources are append-only: an existing source id cannot be REPLACEd', () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    const sourceId = verifyWithTier1(db, itemId);
    expect(() =>
      db
        .prepare(
          'INSERT OR REPLACE INTO sources (id, item_id, tier, url, citation, retrieved_at) VALUES (?, ?, 3, NULL, ?, ?)',
        )
        .run(sourceId, itemId, 'x', NOW),
    ).toThrow(/append-only/);
    expect(db.prepare('SELECT tier FROM sources WHERE id = ?').pluck().get(sourceId)).toBe(1);
  });

  it('sources are append-only: REPLACE with a different item_id also throws', () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    const sourceId = verifyWithTier1(db, itemId);
    const { itemId: otherItemId } = seedItem(db, 'A different quote entirely, for a second item');
    expect(() =>
      db
        .prepare(
          'INSERT OR REPLACE INTO sources (id, item_id, tier, url, citation, retrieved_at) VALUES (?, ?, 3, NULL, ?, ?)',
        )
        .run(sourceId, otherItemId, 'x', NOW),
    ).toThrow(/append-only/);
  });

  it('items are append-only: reusing an existing item id via REPLACE throws', () => {
    const db = testDb();
    const { itemId, verticalId } = seedItem(db);
    expect(() =>
      db
        .prepare(
          "INSERT OR REPLACE INTO items (id, vertical_id, kind, body, body_hash, status, created_at) VALUES (?, ?, 'quote', 'replaced body', 'replaced-hash', 'raw', ?)",
        )
        .run(itemId, verticalId, NOW),
    ).toThrow(/append-only/);
  });
});
