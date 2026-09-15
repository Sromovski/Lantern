import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpGet, SourceStatusError } from '../../src/harvest/sources.js';
import {
  articleUrl,
  authorArticleTitle,
  DEFAULT_WIKI_ENDPOINTS,
  entitiesUrl,
  fetchArticle,
  foldTitle,
  revisionUrl,
  WikiLookupError,
  workArticle,
  workSearchTitle,
  workSearchUrl,
} from '../../src/enrich/wikipedia.js';

const UA = 'Lantern/test (test@example.invalid)';
const E = DEFAULT_WIKI_ENDPOINTS;
const servers: Server[] = [];
let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'lantern-wiki-'));
});

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const pathOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

/** A real HTTP server on 127.0.0.1:0 answering JSON by path and query, reached through a fetch that keeps the real host in the url. */
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

const entity = (id: string, label: string | null, enwiki: string | null) => ({
  type: 'item',
  id,
  labels: label === null ? {} : { en: { language: 'en', value: label } },
  sitelinks: enwiki === null ? {} : { enwiki: { site: 'enwiki', title: enwiki, badges: [] } },
});
const entities = (...list: ReturnType<typeof entity>[]) => ({ entities: Object.fromEntries(list.map((e) => [e.id, e])), success: 1 });
const search = (...ids: string[]) => ({ batchcomplete: true, query: { searchinfo: { totalhits: ids.length }, search: ids.map((title) => ({ ns: 0, title })) } });
const page = (title: string, qid: string, extract: string, revid: number, extra: Record<string, unknown> = {}) => ({
  batchcomplete: true,
  query: {
    ...extra,
    pages: [{ pageid: 1, ns: 0, title, extract, revisions: [{ revid, parentid: revid - 1, timestamp: '2026-09-14T09:16:06Z' }], pageprops: { wikibase_item: qid } }],
  },
});

const TALE_HITS = ['Q138515577', 'Q308918', 'Q4659960'];

describe('Wikidata and Wikipedia requests', () => {
  it('builds the recorded request urls', () => {
    expect(entitiesUrl(E, ['Q5686'])).toBe(
      'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q5686&props=labels|sitelinks&languages=en&sitefilter=enwiki&format=json',
    );
    expect(workSearchUrl(E, 'Q5686', 'A Tale of Two Cities')).toBe(
      'https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=haswbstatement%3AP50%3DQ5686%20%22A%20Tale%20of%20Two%20Cities%22&srlimit=10&format=json&formatversion=2',
    );
    expect(articleUrl(E, 'Charles Dickens')).toBe(
      'https://en.wikipedia.org/w/api.php?action=query&prop=extracts|revisions|pageprops&explaintext=1&rvprop=ids|timestamp&redirects=1&format=json&formatversion=2&titles=Charles_Dickens',
    );
    expect(revisionUrl(E, 'A Tale of Two Cities', 1374830091)).toBe('https://en.wikipedia.org/w/index.php?title=A_Tale_of_Two_Cities&oldid=1374830091');
  });

  it('names the work as Gutendex titles it: before a subtitle, without ", Complete"', () => {
    expect(workSearchTitle('Salom\u00E9: A Tragedy in One Act')).toBe('Salom\u00E9');
    expect(workSearchTitle('The Adventures of Tom Sawyer, Complete')).toBe('The Adventures of Tom Sawyer');
    expect(workSearchTitle("Lord Arthur Savile's Crime; The Portrait of Mr. W.H., and Other Stories")).toBe("Lord Arthur Savile's Crime");
    expect(workSearchTitle('A Tale of Two Cities')).toBe('A Tale of Two Cities');
    expect(foldTitle('Salom\u00E9')).toBe(foldTitle('Salome'));
    expect(foldTitle('Lady Windermere\u2019s  Fan')).toBe("lady windermere's fan");
  });
});

describe('authorArticleTitle', () => {
  it('reads the English Wikipedia title from the Wikidata sitelink', async () => {
    const { get } = await wiki({ [pathOf(entitiesUrl(E, ['Q5686']))]: entities(entity('Q5686', 'Charles Dickens', 'Charles Dickens')) });
    expect(await authorArticleTitle(get, E, 'Q5686')).toBe('Charles Dickens');
  });

  it('refuses an entity without an English article, and reports a Wikidata error without caching it', async () => {
    const { get, hits } = await wiki({
      [pathOf(entitiesUrl(E, ['Q7245']))]: { entities: { Q7245: { type: 'item', id: 'Q7245', labels: [], sitelinks: [] } }, success: 1 },
      [pathOf(entitiesUrl(E, ['Q999']))]: { error: { code: 'no-such-entity', info: 'Could not find an entity with the ID "Q999".' } },
    });
    await expect(authorArticleTitle(get, E, 'Q7245')).rejects.toThrow('Q7245 has no English Wikipedia article');
    await expect(authorArticleTitle(get, E, 'Q999')).rejects.toThrow(WikiLookupError);
    await expect(authorArticleTitle(get, E, 'Q999')).rejects.toThrow('no-such-entity');
    expect(hits.filter((hit) => hit.includes('Q999'))).toHaveLength(2);
    await expect(authorArticleTitle(get, E, 'Q5686|Q1')).rejects.toThrow('is not a Wikidata id');
  });
});

describe('workArticle', () => {
  it('takes the first hit whose English label is the title and that has an English article', async () => {
    const { get } = await wiki({
      [pathOf(workSearchUrl(E, 'Q5686', 'A Tale of Two Cities'))]: search(...TALE_HITS),
      [pathOf(entitiesUrl(E, TALE_HITS))]: entities(
        entity('Q138515577', null, null),
        entity('Q308918', 'A Tale of Two Cities', 'A Tale of Two Cities'),
        entity('Q4659960', 'A Tale of Two Cities', 'A Tale of Two Cities (musical)'),
      ),
    });
    expect(await workArticle(get, E, 'Q5686', 'A Tale of Two Cities')).toEqual({ qid: 'Q308918', title: 'A Tale of Two Cities' });
  });

  it('matches a label without its accents, searching the title before its subtitle', async () => {
    const { get } = await wiki({
      [pathOf(workSearchUrl(E, 'Q30875', 'Salom\u00E9'))]: search('Q64917984', 'Q1149498'),
      [pathOf(entitiesUrl(E, ['Q64917984', 'Q1149498']))]: entities(entity('Q64917984', 'Salom\u00E9', null), entity('Q1149498', 'Salome', 'Salome (play)')),
    });
    expect(await workArticle(get, E, 'Q30875', 'Salom\u00E9: A Tragedy in One Act')).toEqual({ qid: 'Q1149498', title: 'Salome (play)' });
  });

  it('returns null when the search finds nothing, or nothing it finds matches', async () => {
    const { get, hits } = await wiki({
      [pathOf(workSearchUrl(E, 'Q5686', 'No Such Work'))]: search(),
      [pathOf(workSearchUrl(E, 'Q7245', 'Editions Only'))]: search('Q1', 'Q2'),
      [pathOf(entitiesUrl(E, ['Q1', 'Q2']))]: entities(entity('Q1', null, null), entity('Q2', 'Editions Only', null)),
    });
    expect(await workArticle(get, E, 'Q5686', 'No Such Work')).toBeNull();
    expect(hits).toHaveLength(1);
    expect(await workArticle(get, E, 'Q7245', 'Editions Only')).toBeNull();
  });
});

describe('fetchArticle', () => {
  it('reads the text, the revision and its permanent link, following a redirect', async () => {
    const { get } = await wiki({
      [pathOf(articleUrl(E, 'Samuel Clemens'))]: page('Mark Twain', 'Q7245', 'Samuel Langhorne Clemens was an American writer.', 1374000000, {
        redirects: [{ from: 'Samuel Clemens', to: 'Mark Twain' }],
      }),
    });
    const article = await fetchArticle(get, E, 'Samuel Clemens', 'Q7245');
    expect(article).toMatchObject({
      title: 'Mark Twain',
      qid: 'Q7245',
      revid: 1374000000,
      extract: 'Samuel Langhorne Clemens was an American writer.',
      url: 'https://en.wikipedia.org/w/index.php?title=Mark_Twain&oldid=1374000000',
    });
    expect(article.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('refuses a missing article, an article linked to another item, and a non-200 answer', async () => {
    const { get } = await wiki({
      [pathOf(articleUrl(E, 'No such article'))]: { batchcomplete: true, query: { pages: [{ ns: 0, title: 'No such article', missing: true }] } },
      [pathOf(articleUrl(E, 'Charles Dickens'))]: page('Charles Dickens', 'Q5686', 'Charles John Huffam Dickens was an English novelist.', 1371883001),
    });
    await expect(fetchArticle(get, E, 'No such article', 'Q1')).rejects.toThrow('Wikipedia has no article No such article');
    await expect(fetchArticle(get, E, 'Charles Dickens', 'Q36322')).rejects.toThrow('the Wikipedia article Charles Dickens is Q5686, not Q36322');
    await expect(fetchArticle(get, E, 'Unrouted', 'Q1')).rejects.toThrow(SourceStatusError);
  });
});
