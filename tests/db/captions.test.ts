import { beforeEach, describe, expect, it } from 'vitest';
import { upsertCaption } from '../../src/db/captions.js';
import type { Db } from '../../src/db/connection.js';
import { postCitedSources } from '../../src/db/posts.js';
import { testDb } from '../helpers/db.js';

const NOW = new Date('2026-09-16T12:00:00Z');

let db: Db;
let postId: number;

beforeEach(() => {
  db = testDb();
  const id = (sql: string, ...params: unknown[]) => Number(db.prepare(sql).run(...params).lastInsertRowid);
  const verticalId = id("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'The Commonplace Book', 'c.yaml')");
  const itemId = id(
    "INSERT INTO items (vertical_id, kind, body, body_hash, status, created_at) VALUES (?, 'quote', 'A quotation.', 'h1', 'raw', ?)",
    verticalId,
    NOW.toISOString(),
  );
  postId = id(
    "INSERT INTO posts (item_id, vertical_id, hook, body, closer, alt_text, status, created_at) VALUES (?, ?, 'h', 'b', 'c', 'a', 'draft', ?)",
    itemId,
    verticalId,
    NOW.toISOString(),
  );
  // Twelve cited sources, so the labels run past S9, which is where a text sort goes wrong.
  for (let n = 1; n <= 12; n++) {
    const sourceId = id(
      'INSERT INTO sources (item_id, tier, url, citation, excerpt, retrieved_at) VALUES (?, 3, NULL, ?, ?, ?)',
      itemId,
      `citation ${n}`,
      `excerpt ${n}`,
      NOW.toISOString(),
    );
    id('INSERT INTO post_sources (post_id, source_id, label) VALUES (?, ?, ?)', postId, sourceId, `S${n}`);
  }
});

describe('postCitedSources', () => {
  it('orders labels by their number, not as text', () => {
    // A text sort puts S10 before S2. Every label still matches, so nothing is mis-judged, but the
    // checker is shown its paragraphs in this order and the review UI will list them in it.
    expect(postCitedSources(db, postId).map((source) => source.label)).toEqual([
      'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12',
    ]);
  });

  it('returns each cited source once, with its citation and excerpt', () => {
    const cited = postCitedSources(db, postId);
    expect(cited).toHaveLength(12);
    expect(cited[0]).toEqual({ label: 'S1', tier: 3, url: null, citation: 'citation 1', excerpt: 'excerpt 1' });
  });
});

describe('upsertCaption', () => {
  it('replaces one platform and leaves the others', () => {
    const facebook = upsertCaption(db, { postId, platform: 'facebook', title: null, text: 'first', hashtags: null, link: null }, NOW);
    const pinterest = upsertCaption(db, { postId, platform: 'pinterest', title: 't', text: 'pin', hashtags: null, link: null }, NOW);
    const again = upsertCaption(db, { postId, platform: 'facebook', title: null, text: 'second', hashtags: null, link: null }, NOW);

    // The same row, not a duplicate: UNIQUE(post_id, platform) is what makes a re-run safe.
    expect(again).toBe(facebook);
    expect(db.prepare('SELECT COUNT(*) FROM captions').pluck().get()).toBe(2);
    expect(db.prepare('SELECT text FROM captions WHERE id = ?').pluck().get(facebook)).toBe('second');
    expect(db.prepare('SELECT text FROM captions WHERE id = ?').pluck().get(pinterest)).toBe('pin');
  });

  it('counts the body in code points, and not the title', () => {
    const id = upsertCaption(db, { postId, platform: 'facebook', title: 'a much longer title', text: 'body', hashtags: null, link: null }, NOW);
    expect(db.prepare('SELECT char_count FROM captions WHERE id = ?').pluck().get(id)).toBe(4);
  });
});
