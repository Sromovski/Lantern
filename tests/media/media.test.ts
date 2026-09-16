import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createHttpGet } from '../../src/harvest/sources.js';
import { DownloadStatusError } from '../../src/lib/download.js';
import { HttpError } from '../../src/lib/http.js';
import { claimsUrl, DEFAULT_MEDIA_ENDPOINTS, DEPICTS_LIMIT, depictsSearchUrl, imageInfoUrl } from '../../src/media/commons.js';
import { imagePath, mediaVertical, type DownloadFn } from '../../src/media/media.js';
import { testDb } from '../helpers/db.js';

const UA = 'Lantern/test (test@example.invalid)';
const E = DEFAULT_MEDIA_ENDPOINTS;
const NOW = () => new Date('2026-09-15T00:00:00.000Z');
const BYTES = 3_875_170;
/** The bytes every fake download writes, and the sha1 Commons would report for them. */
const PORTRAIT = Buffer.from('a small stand-in for a portrait');
const PORTRAIT_SHA1 = createHash('sha1').update(PORTRAIT).digest('hex');
const hash8 = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 8);
const PORTRAIT_URL = 'https://upload.wikimedia.org/wikipedia/commons/a/aa/Portrait.jpg';
const PORTRAIT_PATH = 'source/charles-dickens-portrait-' + hash8(PORTRAIT_URL) + '.jpg';
const servers: Server[] = [];
let cacheDir: string;
let mediaDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'lantern-media-cache-'));
  mediaDir = mkdtempSync(join(tmpdir(), 'lantern-media-files-'));
});

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const pathOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

async function wiki(routes: Record<string, unknown>) {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const body = routes[req.url ?? ''];
    res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body ?? {}));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const response = await fetch(`${origin}${url.pathname}${url.search}`, init);
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
  return { get: createHttpGet({ cacheDir, http: { userAgent: UA, fetchImpl, maxAttempts: 1 }, secretValues: [] }), hits };
}

const claim = (file: string) => ({ mainsnak: { snaktype: 'value', datavalue: { value: file, type: 'string' } }, type: 'statement', rank: 'normal' });
const entity = (qid: string, files: string[]) => ({ entities: { [qid]: { type: 'item', id: qid, claims: { P18: files.map(claim) } } }, success: 1 });
const meta = (value: string) => ({ value, source: 'commons-desc-page' });
const file = (title: string, width: number, height: number, license = 'pd') => ({
  title,
  imageinfo: [
    {
      size: BYTES,
      width,
      height,
      url: `https://upload.wikimedia.org/wikipedia/commons/a/aa/${title.slice(5).replace(/ /g, '_')}?utm_source=commons.wikimedia.org`,
      descriptionurl: `https://commons.wikimedia.org/wiki/${title.replace(/ /g, '_')}`,
      sha1: PORTRAIT_SHA1,
      mime: 'image/jpeg',
      extmetadata: { License: { value: license, source: 'commons-templates' }, Artist: meta('Popular Graphic Arts'), Restrictions: meta('') },
    },
  ],
});
const pages = (...list: ReturnType<typeof file>[]) => ({ batchcomplete: true, query: { pages: list } });

const DICKENS_ROUTES: Record<string, unknown> = {
  [pathOf(claimsUrl(E, 'Q5686'))]: entity('Q5686', ['Portrait.jpg']),
  [pathOf(imageInfoUrl(E, ['File:Portrait.jpg']))]: pages(file('File:Portrait.jpg', 2000, 3000)),
};

/** A download that writes nothing but reports what a real one would, and records every call. */
function downloader(bytes = BYTES) {
  const calls: { url: string; destPath: string }[] = [];
  const fn: DownloadFn = async (url, destPath) => {
    calls.push({ url, destPath });
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, PORTRAIT);
    return { bytes, sha256: 'b'.repeat(64), finalUrl: url };
  };
  return { fn, calls };
}

function setup() {
  const db = testDb();
  const id = (sql: string, ...params: unknown[]) => Number(db.prepare(sql).run(...params).lastInsertRowid);
  const verticalId = id("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'Literature', 'x')");
  const subject = (name: string, slug: string, wikidataId: string) =>
    id(
      "INSERT INTO subjects (vertical_id, kind, name, slug, wikidata_id, created_at) VALUES (?, 'author', ?, ?, ?, ?)",
      verticalId,
      name,
      slug,
      wikidataId,
      NOW().toISOString(),
    );
  const post = (subjectId: number, body: string) => {
    const itemId = id(
      "INSERT INTO items (vertical_id, subject_id, kind, body, body_hash, status, created_at) VALUES (?, ?, 'quote', ?, ?, 'raw', ?)",
      verticalId,
      subjectId,
      body,
      `hash-${body.length}-${subjectId}`,
      NOW().toISOString(),
    );
    return id(
      "INSERT INTO posts (item_id, vertical_id, hook, body, alt_text, status, created_at) VALUES (?, ?, 'hook', 'body', 'alt', 'draft', ?)",
      itemId,
      verticalId,
      NOW().toISOString(),
    );
  };
  return { db, verticalId, subject, post };
}

const named = (title: string, mime: string, fileUrl: string) => ({ title, mime, fileUrl }) as never;

describe('imagePath', () => {
  it('names the original after the subject, the Commons title and a hash of the file url', () => {
    const dickens = 'https://upload.wikimedia.org/x/Charles_Dickens.jpg';
    expect(imagePath('charles-dickens', named('File:Charles Dickens LCCN2003653043.jpg', 'image/jpeg', dickens))).toBe(
      'source/charles-dickens-charles-dickens-lccn2003653043-' + hash8(dickens) + '.jpg',
    );
    const austen = 'https://upload.wikimedia.org/x/Memoir_scan.png';
    expect(imagePath('jane-austen', named('File:Memoir scan.png', 'image/png', austen))).toBe(
      'source/jane-austen-memoir-scan-' + hash8(austen) + '.png',
    );

    // Two titles that trim to the same name still get their own file.
    const long = 'x'.repeat(70);
    const first = named('File:' + long + ' one.jpg', 'image/jpeg', 'https://upload.wikimedia.org/x/one.jpg');
    const second = named('File:' + long + ' two.jpg', 'image/jpeg', 'https://upload.wikimedia.org/x/two.jpg');
    expect(imagePath('charles-dickens', first)).not.toBe(imagePath('charles-dickens', second));
  });
});

describe('mediaVertical', () => {
  it('downloads the chosen portrait, stores its provenance and links it to the post', async () => {
    const { db, verticalId, subject, post } = setup();
    const dickens = subject('Charles Dickens', 'charles-dickens', 'Q5686');
    const postId = post(dickens, 'It was the best of times, it was the worst of times.');
    const { get } = await wiki(DICKENS_ROUTES);
    const download = downloader();

    const report = await mediaVertical({ db, verticalId, get, endpoints: E, download: download.fn, mediaDir, limit: 10, now: NOW });
    expect(report).toEqual({
      considered: 1,
      attached: 1,
      reused: 0,
      failed: 0,
      noWikidataId: 0,
      items: [{ postId, author: 'Charles Dickens', outcome: { status: 'attached', imageId: expect.any(Number), title: 'File:Portrait.jpg', from: 'wikidata', refused: [] } }],
    });
    expect(download.calls).toEqual([{ url: PORTRAIT_URL, destPath: join(mediaDir, PORTRAIT_PATH) }]);
    expect(db.prepare('SELECT source_url, file_page_url, license, attribution, local_path, width, height, mime, bytes, sha256 FROM images').get()).toEqual({
      source_url: PORTRAIT_URL,
      file_page_url: 'https://commons.wikimedia.org/wiki/File:Portrait.jpg',
      license: 'public-domain',
      attribution: 'Popular Graphic Arts',
      local_path: PORTRAIT_PATH,
      width: 2000,
      height: 3000,
      mime: 'image/jpeg',
      bytes: BYTES,
      sha256: 'b'.repeat(64),
    });
    expect(db.prepare('SELECT image_id FROM posts WHERE id = ?').pluck().get(postId)).toBe(report.items[0]!.outcome.status === 'attached' ? report.items[0]!.outcome.imageId : null);
  });

  it('reuses one portrait for the same author and downloads nothing the second time', async () => {
    const { db, verticalId, subject, post } = setup();
    const dickens = subject('Charles Dickens', 'charles-dickens', 'Q5686');
    post(dickens, 'It was the best of times, it was the worst of times.');
    post(dickens, 'There is a wisdom of the head, and a wisdom of the heart.');
    const { get, hits } = await wiki(DICKENS_ROUTES);
    const download = downloader();

    const report = await mediaVertical({ db, verticalId, get, endpoints: E, download: download.fn, mediaDir, limit: 10, now: NOW });
    expect(report).toMatchObject({ considered: 2, attached: 1, reused: 1, failed: 0 });
    expect(download.calls).toHaveLength(1);
    expect(hits.filter((hit) => hit.includes('wbgetentities'))).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) FROM images').pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM posts WHERE image_id IS NULL').pluck().get()).toBe(0);
    expect(await mediaVertical({ db, verticalId, get, endpoints: E, download: download.fn, mediaDir, limit: 10, now: NOW })).toMatchObject({ considered: 0 });
  });

  it('fails the post when nothing on Commons passes the rules, and tries again next run', async () => {
    const { db, verticalId, subject, post } = setup();
    const dickens = subject('Charles Dickens', 'charles-dickens', 'Q5686');
    const postId = post(dickens, 'It was the best of times, it was the worst of times.');
    const { get } = await wiki({
      [pathOf(claimsUrl(E, 'Q5686'))]: entity('Q5686', ['Small.jpg']),
      [pathOf(imageInfoUrl(E, ['File:Small.jpg']))]: pages(file('File:Small.jpg', 814, 1190)),
      [pathOf(depictsSearchUrl(E, 'Q5686', DEPICTS_LIMIT))]: pages(file('File:Statue.jpg', 3000, 4000, 'cc-by-sa-4.0')),
    });
    const download = downloader();

    const report = await mediaVertical({ db, verticalId, get, endpoints: E, download: download.fn, mediaDir, limit: 10, now: NOW });
    expect(report).toMatchObject({ considered: 1, attached: 0, failed: 1 });
    expect(report.items[0]!.outcome).toEqual({ status: 'failed', reason: 'no Commons image for Q5686 meets the rules (2 refused)' });
    expect(download.calls).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) FROM images').pluck().get()).toBe(0);
    expect(db.prepare('SELECT image_id FROM posts WHERE id = ?').pluck().get(postId)).toBeNull();
    expect(await mediaVertical({ db, verticalId, get, endpoints: E, download: download.fn, mediaDir, limit: 10, now: NOW })).toMatchObject({ considered: 1, failed: 1 });
  });

  it('refuses a download whose size does not match Commons, and fails the post on a download error', async () => {
    const { db, verticalId, subject, post } = setup();
    const dickens = subject('Charles Dickens', 'charles-dickens', 'Q5686');
    post(dickens, 'It was the best of times, it was the worst of times.');
    const { get } = await wiki(DICKENS_ROUTES);

    const short = await mediaVertical({ db, verticalId, get, endpoints: E, download: downloader(BYTES - 1).fn, mediaDir, limit: 10, now: NOW });
    expect(short.items[0]!.outcome).toEqual({
      status: 'failed',
      reason: `File:Portrait.jpg downloaded as ${BYTES - 1} bytes, but Commons reported ${BYTES}`,
    });
    expect(db.prepare('SELECT COUNT(*) FROM images').pluck().get()).toBe(0);

    const failing: DownloadFn = async (url) => {
      throw new DownloadStatusError(url, 503, 4);
    };
    const failed = await mediaVertical({ db, verticalId, get, endpoints: E, download: failing, mediaDir, limit: 10, now: NOW });
    expect(failed).toMatchObject({ failed: 1 });
    expect(failed.items[0]!.outcome.status === 'failed' && failed.items[0]!.outcome.reason).toContain('download failed with HTTP 503');
  });

  it('fails one post when the network never answers, or when a lookup does not return 200', async () => {
    const { db, verticalId, subject, post } = setup();
    const dickens = subject('Charles Dickens', 'charles-dickens', 'Q5686');
    post(dickens, 'It was the best of times, it was the worst of times.');
    const { get } = await wiki(DICKENS_ROUTES);

    const unreachable: DownloadFn = async (url) => {
      throw new HttpError('fetch failed', url, 4);
    };
    const blip = await mediaVertical({ db, verticalId, get, endpoints: E, download: unreachable, mediaDir, limit: 10, now: NOW });
    expect(blip).toMatchObject({ considered: 1, attached: 0, failed: 1 });
    expect(blip.items[0]!.outcome.status === 'failed' && blip.items[0]!.outcome.reason).toBe('fetch failed');

    // Nothing is routed for Austen, so the claims lookup answers 404.
    const austen = subject('Jane Austen', 'jane-austen', 'Q36322');
    post(austen, 'It is a truth universally acknowledged, that a single man in possession of a good fortune.');
    const missing = await mediaVertical({ db, verticalId, get, endpoints: E, download: downloader().fn, mediaDir, limit: 10, now: NOW });
    expect(missing).toMatchObject({ considered: 2, attached: 1, failed: 1 });
    expect(missing.items[1]!.outcome.status === 'failed' && missing.items[1]!.outcome.reason).toContain('HTTP 404');
  });

  it('leaves no file behind when the download does not match the size, the host or the sha1 Commons reported', async () => {
    const { db, verticalId, subject, post } = setup();
    const dickens = subject('Charles Dickens', 'charles-dickens', 'Q5686');
    post(dickens, 'It was the best of times, it was the worst of times.');
    const { get } = await wiki(DICKENS_ROUTES);
    const dest = join(mediaDir, PORTRAIT_PATH);
    const writing =
      (bytes: number, contents: Buffer, finalUrl = PORTRAIT_URL): DownloadFn =>
      async (_url, destPath) => {
        mkdirSync(dirname(destPath), { recursive: true });
        writeFileSync(destPath, contents);
        return { bytes, sha256: 'c'.repeat(64), finalUrl };
      };
    const run = (download: DownloadFn) => mediaVertical({ db, verticalId, get, endpoints: E, download, mediaDir, limit: 10, now: NOW });
    const reasonOf = (report: Awaited<ReturnType<typeof run>>) =>
      report.items[0]!.outcome.status === 'failed' ? report.items[0]!.outcome.reason : 'attached';

    const short = await run(writing(BYTES - 1, PORTRAIT));
    expect(short).toMatchObject({ failed: 1 });
    expect(reasonOf(short)).toBe('File:Portrait.jpg downloaded as ' + (BYTES - 1) + ' bytes, but Commons reported ' + BYTES);
    expect(existsSync(dest)).toBe(false);

    const elsewhere = await run(writing(BYTES, PORTRAIT, 'https://example.invalid/Portrait.jpg'));
    expect(reasonOf(elsewhere)).toBe('File:Portrait.jpg was served from example.invalid, not upload.wikimedia.org');
    expect(existsSync(dest)).toBe(false);

    const tampered = Buffer.from('bytes that are not the ones Commons served');
    const wrongBytes = await run(writing(BYTES, tampered));
    expect(reasonOf(wrongBytes)).toContain('but Commons reported ' + PORTRAIT_SHA1);
    expect(existsSync(dest)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) FROM images').pluck().get()).toBe(0);
  });

  it('stops the run on any other error', async () => {
    const { db, verticalId, subject, post } = setup();
    const dickens = subject('Charles Dickens', 'charles-dickens', 'Q5686');
    post(dickens, 'It was the best of times, it was the worst of times.');
    const { get } = await wiki(DICKENS_ROUTES);
    const broken: DownloadFn = async () => {
      throw new Error('ENOSPC: no space left on device');
    };
    await expect(mediaVertical({ db, verticalId, get, endpoints: E, download: broken, mediaDir, limit: 10, now: NOW })).rejects.toThrow('ENOSPC');
  });
});
