import { describe, it, expect } from 'vitest';
import { attachImage, insertImage, postsNeedingImage, subjectImage, type NewImage } from '../../src/db/images.js';
import { testDb } from '../helpers/db.js';

const NOW = new Date('2026-09-15T00:00:00.000Z');
const FILE_URL = 'https://upload.wikimedia.org/wikipedia/commons/c/cf/Charles_Dickens_LCCN2003653043.jpg';

function setup() {
  const db = testDb();
  const id = (sql: string, ...params: unknown[]) => Number(db.prepare(sql).run(...params).lastInsertRowid);
  const verticalId = id("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'Literature', 'x')");
  const subject = (name: string, slug: string, wikidataId: string | null) =>
    id("INSERT INTO subjects (vertical_id, kind, name, slug, wikidata_id, created_at) VALUES (?, 'author', ?, ?, ?, ?)", verticalId, name, slug, wikidataId, NOW.toISOString());
  const post = (subjectId: number, body: string, status = 'draft') => {
    const itemId = id(
      "INSERT INTO items (vertical_id, subject_id, kind, body, body_hash, status, created_at) VALUES (?, ?, 'quote', ?, ?, 'raw', ?)",
      verticalId,
      subjectId,
      body,
      `hash-${body.length}-${subjectId}`,
      NOW.toISOString(),
    );
    return id(
      "INSERT INTO posts (item_id, vertical_id, hook, body, alt_text, status, created_at) VALUES (?, ?, 'hook', 'body', 'alt', ?, ?)",
      itemId,
      verticalId,
      status,
      NOW.toISOString(),
    );
  };
  return { db, verticalId, subject, post };
}

const image = (subjectId: number, overrides: Partial<NewImage> = {}): NewImage => ({
  subjectId,
  origin: 'wikimedia',
  sourceUrl: FILE_URL,
  filePageUrl: 'https://commons.wikimedia.org/wiki/File:Charles_Dickens_LCCN2003653043.jpg',
  license: 'public-domain',
  attribution: 'Popular Graphic Arts',
  localPath: 'source/charles-dickens-charles-dickens-lccn2003653043.jpg',
  width: 5340,
  height: 6860,
  mime: 'image/jpeg',
  bytes: 3_875_170,
  sha256: 'a'.repeat(64),
  ...overrides,
});

describe('insertImage and subjectImage', () => {
  it('stores the file and its provenance, and reuses the row on a second run', () => {
    const { db, subject } = setup();
    const dickens = subject('Charles Dickens', 'charles-dickens', 'Q5686');
    const imageId = insertImage(db, image(dickens), NOW);

    expect(db.prepare('SELECT origin, source_url, file_page_url, license, attribution, local_path, width, height, mime, bytes, sha256, created_at FROM images WHERE id = ?').get(imageId)).toEqual({
      origin: 'wikimedia',
      source_url: FILE_URL,
      file_page_url: 'https://commons.wikimedia.org/wiki/File:Charles_Dickens_LCCN2003653043.jpg',
      license: 'public-domain',
      attribution: 'Popular Graphic Arts',
      local_path: 'source/charles-dickens-charles-dickens-lccn2003653043.jpg',
      width: 5340,
      height: 6860,
      mime: 'image/jpeg',
      bytes: 3_875_170,
      sha256: 'a'.repeat(64),
      created_at: '2026-09-15T00:00:00.000Z',
    });
    expect(insertImage(db, image(dickens), NOW)).toBe(imageId);
    expect(db.prepare('SELECT COUNT(*) FROM images').pluck().get()).toBe(1);
    expect(subjectImage(db, dickens)).toEqual({ id: imageId, sourceUrl: FILE_URL, localPath: image(dickens).localPath, license: 'public-domain' });
    expect(subjectImage(db, dickens + 1)).toBeUndefined();
  });
});

describe('postsNeedingImage and attachImage', () => {
  it('lists posts without an image, oldest first, and never replaces one', () => {
    const { db, verticalId, subject, post } = setup();
    const dickens = subject('Charles Dickens', 'charles-dickens', 'Q5686');
    const austen = subject('Jane Austen', 'jane-austen', 'Q36322');
    const unlinked = subject('Anonymous', 'anonymous', null);
    const first = post(dickens, 'It was the best of times, it was the worst of times.');
    const second = post(austen, 'It is a truth universally acknowledged, that a single man in possession of a good fortune.', 'needs_review');
    const third = post(dickens, 'There is a wisdom of the head, and a wisdom of the heart.');
    post(unlinked, 'This subject has no Wikidata id, so it cannot be looked up.');

    expect(postsNeedingImage(db, verticalId, 10).map((p) => [p.postId, p.subjectSlug, p.wikidataId])).toEqual([
      [first, 'charles-dickens', 'Q5686'],
      [second, 'jane-austen', 'Q36322'],
      [third, 'charles-dickens', 'Q5686'],
    ]);
    expect(postsNeedingImage(db, verticalId, 2)).toHaveLength(2);

    const imageId = insertImage(db, image(dickens), NOW);
    expect(attachImage(db, first, imageId)).toBe(true);
    expect(postsNeedingImage(db, verticalId, 10).map((p) => p.postId)).toEqual([second, third]);

    const other = insertImage(db, image(dickens, { sourceUrl: `${FILE_URL}?v=2` }), NOW);
    expect(attachImage(db, first, other)).toBe(false);
    expect(db.prepare('SELECT image_id FROM posts WHERE id = ?').pluck().get(first)).toBe(imageId);
  });
});
