import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpGet, SourceStatusError } from '../../src/harvest/sources.js';
import {
  bestPortrait,
  claimsUrl,
  DEFAULT_MEDIA_ENDPOINTS,
  DEPICTS_LIMIT,
  depictsSearchUrl,
  ImageLookupError,
  imageInfoUrl,
  imageRefusal,
  mappedLicense,
  MIN_SHORT_EDGE,
  portraitTitles,
} from '../../src/media/commons.js';

const UA = 'Lantern/test (test@example.invalid)';
const E = DEFAULT_MEDIA_ENDPOINTS;
const servers: Server[] = [];
let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'lantern-media-'));
});

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const pathOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

/** A real HTTP server on 127.0.0.1:0 answering JSON by path and query, reached through a fetch that keeps the real hosts. */
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

const claim = (file: string, rank = 'normal') => ({ mainsnak: { snaktype: 'value', datavalue: { value: file, type: 'string' } }, type: 'statement', rank });
const entity = (qid: string, files: { file: string; rank?: string }[]) => ({
  entities: { [qid]: { type: 'item', id: qid, claims: files.length === 0 ? {} : { P18: files.map((f) => claim(f.file, f.rank)) } } },
  success: 1,
});

interface FileOptions {
  license?: string;
  mime?: string;
  width?: number;
  height?: number;
  artist?: string;
  credit?: string;
  restrictions?: string;
  size?: number;
}

const meta = (value: string) => ({ value, source: 'commons-desc-page' });
const file = (title: string, options: FileOptions = {}) => ({
  title,
  imageinfo: [
    {
      size: options.size ?? 3_875_170,
      width: options.width ?? 2000,
      height: options.height ?? 3000,
      url: `https://upload.wikimedia.org/wikipedia/commons/a/aa/${encodeURIComponent(title.slice(5))}?utm_source=commons.wikimedia.org&utm_campaign=imageinfo`,
      descriptionurl: `https://commons.wikimedia.org/wiki/${title.replace(/ /g, '_')}`,
      descriptionshorturl: 'https://commons.wikimedia.org/w/index.php?curid=1',
      sha1: 'f6198b4d72ea8e71ac08b93279ae9d5f7342d919',
      mime: options.mime ?? 'image/jpeg',
      extmetadata: {
        License: { value: options.license ?? 'pd', source: 'commons-templates' },
        LicenseShortName: meta('Public domain'),
        Artist: meta(options.artist ?? '<a href="/wiki/x">Jeremiah&nbsp;Gurney</a>'),
        Credit: meta(options.credit ?? 'Heritage Auction Gallery'),
        Restrictions: meta(options.restrictions ?? ''),
      },
    },
  ],
});
const pages = (...list: ReturnType<typeof file>[]) => ({ batchcomplete: true, query: { pages: list } });

const CLAIM_CREDIT = 'one or more third parties have made copyright claims against Wikimedia Commons in relation to the work';
const info = (title: string, options: FileOptions = {}) => file(title, options).imageinfo[0]!;

describe('request urls and licence mapping', () => {
  it('builds the recorded request urls', () => {
    expect(claimsUrl(E, 'Q5686')).toBe('https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q5686&props=claims&format=json');
    expect(imageInfoUrl(E, ['File:A.jpg', 'File:B.jpg'])).toBe(
      'https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url|size|mime|sha1|extmetadata&iiextmetadatalanguage=en&format=json&formatversion=2&titles=File%3AA.jpg%7CFile%3AB.jpg',
    );
    expect(depictsSearchUrl(E, 'Q5686', DEPICTS_LIMIT)).toBe(
      'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=haswbstatement%3AP180%3DQ5686&gsrlimit=50&prop=imageinfo&iiprop=url|size|mime|sha1|extmetadata&iiextmetadatalanguage=en&format=json&formatversion=2',
    );
  });

  it('accepts only public domain and CC0 licences', () => {
    expect(mappedLicense('pd')).toBe('public-domain');
    expect(mappedLicense('PD-old-100')).toBe('public-domain');
    expect(mappedLicense('cc0')).toBe('cc0');
    expect(mappedLicense('cc-by-4.0')).toBeNull();
    expect(mappedLicense('cc-by-sa-4.0')).toBeNull();
    expect(mappedLicense('')).toBeNull();
  });
});

describe('imageRefusal', () => {
  it('accepts a large public-domain portrait', () => {
    expect(imageRefusal(info('File:Good.jpg', { width: 2000, height: 3000 }), 'File:Good.jpg')).toBeNull();
    expect(MIN_SHORT_EDGE).toBe(1500);
  });

  it.each([
    ['a licence that is not public domain or CC0', { license: 'cc-by-sa-4.0' }, 'is licensed cc-by-sa-4.0'],
    ['a file that is not a still image', { mime: 'application/pdf' }, 'is application/pdf'],
    ['a short edge under 1500 px', { width: 814, height: 1190 }, 'the short edge must be at least 1500 px'],
    ['an image wider than it is tall', { width: 3000, height: 2253 }, 'must be taller than it is wide'],
    ['a file past the size cap', { size: 83_043_402 }, 'is 83043402 bytes; the file must be at most 67108864 bytes'],
    ['a Commons restriction', { restrictions: 'trademarked' }, 'carries the Commons restriction trademarked'],
    ['a third-party rights claim', { credit: CLAIM_CREDIT }, 'carries a third-party rights claim'],
  ])('refuses %s', (_label, options: FileOptions, expected) => {
    expect(imageRefusal(info('File:X.jpg', options), 'File:X.jpg')).toContain(expected);
  });
});

describe('portraitTitles', () => {
  it('returns the P18 files, preferred rank first, and nothing when there are none', async () => {
    const { get } = await wiki({
      [pathOf(claimsUrl(E, 'Q5686'))]: entity('Q5686', [
        { file: 'Small.jpg' },
        { file: 'Bust.jpg', rank: 'preferred' },
        { file: 'Old.jpg', rank: 'deprecated' },
      ]),
      [pathOf(claimsUrl(E, 'Q1'))]: entity('Q1', []),
    });
    expect(await portraitTitles(get, E, 'Q5686')).toEqual(['File:Bust.jpg', 'File:Small.jpg']);
    expect(await portraitTitles(get, E, 'Q1')).toEqual([]);
    await expect(portraitTitles(get, E, 'Q5686|Q1')).rejects.toThrow(ImageLookupError);
  });
});

describe('bestPortrait', () => {
  it('takes the first Wikidata image that passes the rules', async () => {
    const titles = ['File:Bust.jpg', 'File:Portrait.jpg'];
    const { get, hits } = await wiki({
      [pathOf(claimsUrl(E, 'Q5686'))]: entity('Q5686', [{ file: 'Bust.jpg', rank: 'preferred' }, { file: 'Portrait.jpg' }]),
      [pathOf(imageInfoUrl(E, titles))]: pages(
        file('File:Portrait.jpg', { width: 2000, height: 3000, artist: 'Jeremiah Gurney' }),
        file('File:Bust.jpg', { license: 'cc-by-sa-4.0' }),
      ),
    });
    const choice = await bestPortrait(get, E, 'Q5686');
    expect(choice.from).toBe('wikidata');
    expect(choice.image).toEqual({
      title: 'File:Portrait.jpg',
      fileUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/aa/Portrait.jpg',
      filePageUrl: 'https://commons.wikimedia.org/wiki/File:Portrait.jpg',
      mime: 'image/jpeg',
      bytes: 3_875_170,
      width: 2000,
      height: 3000,
      license: 'public-domain',
      attribution: 'Jeremiah Gurney',
    });
    expect(choice.refused).toEqual(['File:Bust.jpg is licensed cc-by-sa-4.0, not public domain or CC0']);
    expect(hits.some((hit) => hit.includes('gsrsearch'))).toBe(false);
  });

  it('falls back to the files Commons says depict the subject, largest first, skipping claimed reproductions', async () => {
    const { get } = await wiki({
      [pathOf(claimsUrl(E, 'Q5686'))]: entity('Q5686', [{ file: 'Small.jpg' }]),
      [pathOf(imageInfoUrl(E, ['File:Small.jpg']))]: pages(file('File:Small.jpg', { width: 814, height: 1190 })),
      [pathOf(depictsSearchUrl(E, 'Q5686', DEPICTS_LIMIT))]: pages(
        file('File:Statue.jpg', { license: 'cc-by-sa-4.0', width: 3000, height: 4000 }),
        file('File:Claimed.jpg', { width: 4000, height: 5000, credit: CLAIM_CREDIT }),
        file('File:Medium.jpg', { width: 1600, height: 2000 }),
        file('File:Largest.jpg', { width: 5340, height: 6860, artist: 'Popular Graphic Arts' }),
      ),
    });
    const choice = await bestPortrait(get, E, 'Q5686');
    expect(choice.from).toBe('depicts');
    expect(choice.image).toMatchObject({ title: 'File:Largest.jpg', width: 5340, height: 6860, attribution: 'Popular Graphic Arts' });
    expect(choice.refused).toEqual([
      'File:Small.jpg is 814x1190; the short edge must be at least 1500 px',
      'File:Statue.jpg is licensed cc-by-sa-4.0, not public domain or CC0',
      'File:Claimed.jpg carries a third-party rights claim on the reproduction',
    ]);
  });

  it('refuses when nothing passes, when a P18 file is not on Commons, and reports a non-200', async () => {
    const { get } = await wiki({
      [pathOf(claimsUrl(E, 'Q7245'))]: entity('Q7245', [{ file: 'Gone.jpg' }]),
      [pathOf(imageInfoUrl(E, ['File:Gone.jpg']))]: { batchcomplete: true, query: { pages: [{ title: 'File:Gone.jpg', missing: true }] } },
      [pathOf(depictsSearchUrl(E, 'Q7245', DEPICTS_LIMIT))]: { batchcomplete: true, query: { pages: [] } },
      [pathOf(claimsUrl(E, 'Q30875'))]: entity('Q30875', []),
    });
    await expect(bestPortrait(get, E, 'Q7245')).rejects.toThrow('no Commons image for Q7245 meets the rules (1 refused)');
    await expect(bestPortrait(get, E, 'Q30875')).rejects.toThrow(SourceStatusError);
  });
});
