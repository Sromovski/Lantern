import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import type { HarvestAuthor } from '../../src/harvest/gutendex.js';
import {
  bookText,
  createHttpGet,
  gutendexBooks,
  SourceStatusError,
  wikiquoteListedSections,
  type Endpoints,
} from '../../src/harvest/sources.js';
import { WikiquotePageError } from '../../src/verify/wikiquote.js';

const UA = 'Lantern/test (test@example.invalid)';
const NOW = () => new Date('2026-09-15T00:00:00.000Z');
const DICKENS: HarvestAuthor = { name: 'Charles Dickens', gutendex_name: 'Dickens, Charles', wikidata_id: 'Q5686', birth_year: 1812, death_year: 1870 };
const TEXT = [
  '*** START OF THE PROJECT GUTENBERG EBOOK A TALE OF TWO CITIES ***',
  '',
  'CHAPTER I.',
  '',
  'It was the best of times, it was the worst of times.',
  '',
  '*** END OF THE PROJECT GUTENBERG EBOOK A TALE OF TWO CITIES ***',
].join('\r\n');
const DICKENS_PAGE = '/w/api.php?action=parse&format=json&formatversion=2&prop=wikitext&redirects=1&page=Charles_Dickens';

interface Route {
  status?: number;
  type?: string;
  body: string | ((origin: string) => string);
}

const servers: Server[] = [];
let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'lantern-sources-'));
});

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A real HTTP server on 127.0.0.1:0 answering by path and query. Records every request url. */
async function site(routes: Record<string, Route>) {
  const hits: string[] = [];
  let origin = '';
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const route = routes[req.url ?? ''];
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(route.status ?? 200, { 'content-type': route.type ?? 'application/json; charset=utf-8' });
    res.end(typeof route.body === 'function' ? route.body(origin) : route.body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, hits };
}

/** Sends every request to the local site while the client still sees the url it asked for, as a real host would answer it. */
function routedTo(origin: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const response = await fetch(`${origin}${url.pathname}${url.search}`, init);
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
}

const book = (id: number, textUrl: string) => ({
  id,
  title: `Book ${id}`,
  authors: [{ name: 'Dickens, Charles', birth_year: 1812, death_year: 1870 }],
  editors: [],
  translators: [],
  subjects: [],
  bookshelves: [],
  languages: ['en'],
  copyright: false,
  media_type: 'Text',
  formats: { 'text/plain; charset=utf-8': textUrl },
  download_count: 1,
});

describe('harvest sources', () => {
  it('follows Gutendex next links from a surname search, serving repeats from the cache', async () => {
    const { origin, hits } = await site({
      '/books/?languages=en&search=dickens': {
        body: (o) => JSON.stringify({ count: 2, next: `${o}/books/?languages=en&page=2&search=dickens`, previous: null, results: [book(98, 'x')] }),
      },
      '/books/?languages=en&page=2&search=dickens': { body: JSON.stringify({ count: 2, next: null, previous: null, results: [book(1400, 'y')] }) },
    });
    const get = createHttpGet({ cacheDir, http: { userAgent: UA }, secretValues: [] });
    const endpoints: Endpoints = { gutendex: origin, wikiquote: origin };
    expect((await gutendexBooks(get, endpoints, DICKENS)).map((b) => b.id)).toEqual([98, 1400]);
    expect((await gutendexBooks(get, endpoints, DICKENS)).map((b) => b.id)).toEqual([98, 1400]);
    expect(hits).toEqual(['/books/?languages=en&search=dickens', '/books/?languages=en&page=2&search=dickens']);
  });

  it('refuses a Gutendex page that is not the recorded shape, without caching it, or a next link to another origin', async () => {
    const { origin, hits } = await site({
      '/books/?languages=en&search=dickens': { body: JSON.stringify({ count: 1, next: 'https://elsewhere.example/books/?page=2', previous: null, results: [] }) },
      '/books/?languages=en&search=twain': { body: JSON.stringify({ detail: 'Too many requests' }) },
    });
    const get = createHttpGet({ cacheDir, http: { userAgent: UA }, secretValues: [] });
    const endpoints: Endpoints = { gutendex: origin, wikiquote: origin };
    await expect(gutendexBooks(get, endpoints, DICKENS)).rejects.toThrow('leaves');
    const twain = { ...DICKENS, gutendex_name: 'Twain, Mark' };
    await expect(gutendexBooks(get, endpoints, twain)).rejects.toThrow(ZodError);
    await expect(gutendexBooks(get, endpoints, twain)).rejects.toThrow(ZodError);
    expect(hits.filter((h) => h.includes('search=twain'))).toHaveLength(2);
  });

  it('caches only a complete book text and cites a text that is not on a primary-text host as nothing', async () => {
    const { origin, hits } = await site({
      '/complete.txt': { type: 'text/plain; charset=utf-8', body: TEXT },
      '/truncated.txt': { type: 'text/plain; charset=utf-8', body: TEXT.slice(0, 120) },
    });
    const get = createHttpGet({ cacheDir, http: { userAgent: UA }, secretValues: [] });
    const first = await bookText(get, `${origin}/complete.txt`);
    expect(first).toMatchObject({ text: TEXT, citedUrl: null, fromCache: false });
    expect(await bookText(get, `${origin}/complete.txt`)).toMatchObject({ fromCache: true });
    await bookText(get, `${origin}/truncated.txt`);
    expect(await bookText(get, `${origin}/truncated.txt`)).toMatchObject({ fromCache: false });
    expect(hits.filter((h) => h === '/truncated.txt')).toHaveLength(2);
  });

  it('cites the Project Gutenberg url of a text fetched from gutenberg.org', async () => {
    const { origin } = await site({ '/cache/epub/98/pg98.txt': { type: 'text/plain; charset=utf-8', body: TEXT } });
    const get = createHttpGet({ cacheDir, http: { userAgent: UA, fetchImpl: routedTo(origin) }, secretValues: [] });
    expect(await bookText(get, 'https://www.gutenberg.org/cache/epub/98/pg98.txt')).toMatchObject({
      citedUrl: 'https://www.gutenberg.org/cache/epub/98/pg98.txt',
    });
  });

  it('reads the listed sections of the author page from one Wikiquote request, with the time it was fetched', async () => {
    const page = { parse: { title: 'Charles Dickens', wikitext: '== Quotes ==\n* A quote.\n==Misattributed==\n* Every one for himself, and Providence for us all.' } };
    const { origin, hits } = await site({ [DICKENS_PAGE]: { body: JSON.stringify(page) } });
    const get = createHttpGet({ cacheDir, http: { userAgent: UA }, secretValues: [], now: NOW });
    expect(await wikiquoteListedSections(get, { gutendex: origin, wikiquote: origin }, 'Charles Dickens')).toEqual({
      sections: [
        { title: 'Charles Dickens', kind: 'Misattributed', anchor: 'Misattributed', entries: ['Every one for himself, and Providence for us all.'] },
      ],
      fetchedAt: '2026-09-15T00:00:00.000Z',
    });
    expect(hits).toHaveLength(1);
  });

  it('refuses a Wikiquote page that resolves to another title, and does not cache an error answered with 200', async () => {
    const { origin, hits } = await site({
      '/w/api.php?action=parse&format=json&formatversion=2&prop=wikitext&redirects=1&page=Samuel_Clemens': {
        body: JSON.stringify({ parse: { title: 'Mark Twain', wikitext: '==Misattributed==\n* A listed quotation of some length here.' } }),
      },
      '/w/api.php?action=parse&format=json&formatversion=2&prop=wikitext&redirects=1&page=Nobody': {
        body: JSON.stringify({ error: { code: 'missingtitle', info: "The page you specified doesn't exist." } }),
      },
    });
    const get = createHttpGet({ cacheDir, http: { userAgent: UA }, secretValues: [] });
    const endpoints = { gutendex: origin, wikiquote: origin };
    await expect(wikiquoteListedSections(get, endpoints, 'Samuel Clemens')).rejects.toThrow(WikiquotePageError);
    await expect(wikiquoteListedSections(get, endpoints, 'Nobody')).rejects.toThrow(ZodError);
    await expect(wikiquoteListedSections(get, endpoints, 'Nobody')).rejects.toThrow(ZodError);
    expect(hits.filter((h) => h.endsWith('page=Nobody'))).toHaveLength(2);
  });

  it('fails on a source that does not answer 200', async () => {
    const { origin } = await site({});
    const get = createHttpGet({ cacheDir, http: { userAgent: UA }, secretValues: [] });
    await expect(wikiquoteListedSections(get, { gutendex: origin, wikiquote: origin }, 'Nobody')).rejects.toThrow(SourceStatusError);
    await expect(bookText(get, `${origin}/missing.txt`)).rejects.toThrow(SourceStatusError);
  });
});
