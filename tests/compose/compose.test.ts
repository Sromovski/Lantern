import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { ComposeError, composeAltText, composePost, renditionPath, workLine } from '../../src/compose/compose.js';
import type { ComposeConfig } from '../../src/config/schema.js';
import type { Db } from '../../src/db/connection.js';
import type { PostImage } from '../../src/db/images.js';
import type { PostToCompose } from '../../src/db/posts.js';
import { testDb } from '../helpers/db.js';

const NOW = new Date('2026-09-15T12:00:00Z');
const FONTS = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const CONFIG: ComposeConfig = {
  quote_font: 'Lora.ttf',
  meta_font: 'WorkSans.ttf',
  wordmark: 'THE COMMONPLACE BOOK',
  formats: ['square', 'pin'],
  jpeg_quality: 90,
};
const QUOTE = 'It was the best of times, it was the worst of times.';
const SOURCE = 'source/charles-dickens-portrait.jpg';
const PLACEHOLDER = 'the placeholder enrich wrote';

let db: Db;
let mediaDir: string;
let postId: number;
let seq: number;

/**
 * A post with an image already attached, which is the state the media stage leaves behind.
 *
 * A test may seed more than one post, so the vertical, the subject and the image are reused when
 * they already exist: their slugs and source url are unique, and one portrait serving all of an
 * author's posts is how the media stage actually behaves.
 */
function seed(quote = QUOTE, withImage = true): number {
  const id = (sql: string, ...params: unknown[]) => Number(db.prepare(sql).run(...params).lastInsertRowid);
  const pick = (sql: string, ...params: unknown[]) => db.prepare(sql).pluck().get(...params) as number | undefined;

  const verticalId =
    pick("SELECT id FROM verticals WHERE slug = 'literature'") ??
    id("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'The Commonplace Book', 'config/verticals/literature.yaml')");
  const subjectId =
    pick('SELECT id FROM subjects WHERE vertical_id = ? AND slug = ?', verticalId, 'charles-dickens') ??
    id(
      "INSERT INTO subjects (vertical_id, kind, name, slug, wikidata_id, created_at) VALUES (?, 'author', 'Charles Dickens', 'charles-dickens', 'Q5686', ?)",
      verticalId,
      NOW.toISOString(),
    );
  // Items are inserted raw and promoted once they have sources; a guard trigger refuses anything else.
  const itemId = id(
    `INSERT INTO items (vertical_id, subject_id, kind, body, body_hash, work_title, work_year, status, created_at)
     VALUES (?, ?, 'quote', ?, ?, 'A Tale of Two Cities', 1859, 'raw', ?)`,
    verticalId,
    subjectId,
    quote,
    `hash-${++seq}`,
    NOW.toISOString(),
  );
  const imageId = withImage
    ? (pick('SELECT id FROM images WHERE subject_id = ?', subjectId) ??
      id(
        `INSERT INTO images (subject_id, origin, source_url, file_page_url, license, attribution, local_path, width, height, mime, bytes, sha256, created_at)
         VALUES (?, 'wikimedia', 'https://upload.wikimedia.org/x/Portrait.jpg', 'https://commons.wikimedia.org/wiki/File:Portrait.jpg',
                 'public-domain', 'Popular Graphic Arts', ?, 800, 1000, 'image/jpeg', 1234, 'a', ?)`,
        subjectId,
        SOURCE,
        NOW.toISOString(),
      ))
    : null;
  return id(
    `INSERT INTO posts (item_id, vertical_id, image_id, hook, body, closer, alt_text, status, created_at)
     VALUES (?, ?, ?, 'A hook', 'A body', 'A closer', ?, 'draft', ?)`,
    itemId,
    verticalId,
    imageId,
    PLACEHOLDER,
    NOW.toISOString(),
  );
}

const run = (formats: readonly ('square' | 'pin')[], post = postId) =>
  composePost({ db, postId: post, formats, config: CONFIG, fontsDir: FONTS, mediaDir, now: () => NOW });

const POST: PostToCompose = {
  postId: 1,
  verticalId: 1,
  imageId: 1,
  status: 'draft',
  body: QUOTE,
  workTitle: 'Bleak House',
  workYear: 1853,
  author: 'Charles Dickens',
};
const IMAGE: PostImage = {
  imageId: 1,
  localPath: SOURCE,
  license: 'public-domain',
  attribution: 'Popular Graphic Arts',
  author: 'Charles Dickens',
  subjectSlug: 'charles-dickens',
};

beforeEach(async () => {
  db = testDb();
  seq = 0;
  mediaDir = mkdtempSync(join(tmpdir(), 'lantern-compose-'));
  mkdirSync(join(mediaDir, 'source'), { recursive: true });
  // A real, decodable portrait: sharp has to read and crop it, so opaque bytes will not do.
  await sharp({ create: { width: 800, height: 1000, channels: 3, background: '#6b6b6b' } })
    .jpeg()
    .toFile(join(mediaDir, SOURCE));
  postId = seed();
});

describe('composePost', () => {
  it('writes one card per format at the exact size the rendition matrix requires', async () => {
    const report = await run(['square', 'pin']);
    expect(report).toMatchObject({ postId, considered: 2, written: 2, failed: 0 });

    const rows = db
      .prepare('SELECT format, width, height, aspect, media_type AS mediaType, status, local_path AS localPath FROM renditions ORDER BY format')
      .all();
    expect(rows).toEqual([
      { format: 'pin', width: 1000, height: 1500, aspect: '2:3', mediaType: 'image', status: 'ready', localPath: renditionPath(postId, 'pin') },
      { format: 'square', width: 1200, height: 1200, aspect: '1:1', mediaType: 'image', status: 'ready', localPath: renditionPath(postId, 'square') },
    ]);

    for (const format of ['square', 'pin'] as const) {
      const file = join(mediaDir, renditionPath(postId, format));
      expect(existsSync(file)).toBe(true);
      const meta = await sharp(file).metadata();
      expect({ width: meta.width, height: meta.height, format: meta.format }).toEqual(
        format === 'square' ? { width: 1200, height: 1200, format: 'jpeg' } : { width: 1000, height: 1500, format: 'jpeg' },
      );
    }
  });

  it('replaces only the format it regenerates when it runs again', async () => {
    await run(['square', 'pin']);
    const before = db.prepare('SELECT id, format FROM renditions ORDER BY format').all() as { id: number; format: string }[];

    await run(['square']);
    const after = db.prepare('SELECT id, format FROM renditions ORDER BY format').all() as { id: number; format: string }[];

    expect(after.map((r) => r.format)).toEqual(['pin', 'square']);
    // The same rows, not duplicates: UNIQUE(post_id, format) is what makes a re-run safe.
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(db.prepare('SELECT COUNT(*) FROM renditions').pluck().get()).toBe(2);
  });

  it('rewrites the alt text to describe the card once one exists', async () => {
    expect(db.prepare('SELECT alt_text FROM posts WHERE id = ?').pluck().get(postId)).toBe(PLACEHOLDER);

    await run(['square']);

    const altText = db.prepare('SELECT alt_text FROM posts WHERE id = ?').pluck().get(postId) as string;
    expect(altText).toContain('Charles Dickens');
    expect(altText).toContain('A Tale of Two Cities, 1859');
    expect(altText).toContain(QUOTE);
  });

  it('fails the format rather than shrinking a quote that cannot be set legibly', async () => {
    const long = 'It was the best of times, it was the worst of times, it was the age of wisdom. '.repeat(8);
    const only = seed(long);
    const report = await run(['square'], only);

    expect(report).toMatchObject({ written: 0, failed: 1 });
    const outcome = report.items[0]?.outcome;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.status === 'failed' && outcome.reason).toContain('cannot be set legibly');

    // No row and no file: a rendition's local_path must name a file that exists.
    expect(db.prepare('SELECT COUNT(*) FROM renditions WHERE post_id = ?').pluck().get(only)).toBe(0);
    expect(existsSync(join(mediaDir, renditionPath(only, 'square')))).toBe(false);
    // The alt text still describes no card, because there is none.
    expect(db.prepare('SELECT alt_text FROM posts WHERE id = ?').pluck().get(only)).toBe(PLACEHOLDER);
  });

  it('refuses a post that has no image yet', async () => {
    const imageless = seed(`${QUOTE} And this one has no portrait.`, false);
    await expect(run(['square'], imageless)).rejects.toThrow(ComposeError);
    await expect(run(['square'], imageless)).rejects.toThrow('run lantern media first');
  });

  it('refuses a post that does not exist', async () => {
    await expect(run(['square'], 9999)).rejects.toThrow('post 9999 does not exist');
  });
});

describe('alt text and the work line', () => {
  it('names the year only when the item records one', () => {
    expect(workLine(POST)).toBe('Bleak House, 1853');
    expect(workLine({ ...POST, workYear: null })).toBe('Bleak House');
  });

  it('describes the portrait as well as the quotation', () => {
    expect(composeAltText(POST, IMAGE)).toBe(`Quote card: a portrait of Charles Dickens behind the quotation from Bleak House, 1853: "${QUOTE}"`);
  });
});
