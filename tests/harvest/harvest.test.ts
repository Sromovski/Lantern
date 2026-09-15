import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarvestConfig } from '../../src/config/schema.js';
import { loadEvidence } from '../../src/db/evidence.js';
import { harvestVertical, type HarvestOptions } from '../../src/harvest/harvest.js';
import type { PickFn } from '../../src/harvest/picker.js';
import { createHttpGet, type Endpoints } from '../../src/harvest/sources.js';
import { verifyVertical } from '../../src/verify/run.js';
import { testDb } from '../helpers/db.js';

const UA = 'Lantern/test (test@example.invalid)';
const NOW = () => new Date('2026-09-15T00:00:00.000Z');
const LISTED = 'Well, every one for himself, and Providence for us all, as the elephant said when he danced among the chickens.';
const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one'];
const PROSE = WORDS.map((w) => `Sentence ${w} tells of the river and the town and the people who lived beside it.`);

const HARVEST: HarvestConfig = {
  authors: [{ name: 'Charles Dickens', gutendex_name: 'Dickens, Charles', wikidata_id: 'Q5686', birth_year: 1812, death_year: 1870 }],
  picker: { model: 'claude-sonnet-5', batch_size: 150, max_batches_per_work: 6, picks_per_batch: 3 },
};

const gutenberg = (title: string, lines: string[]) =>
  [
    `*** START OF THE PROJECT GUTENBERG EBOOK ${title.toUpperCase()} ***`,
    '',
    'PREFACE BY THE EDITOR',
    '',
    'This edition follows the text of the first edition, and the editor has corrected obvious misprints silently.',
    '',
    ...lines,
    '',
    `*** END OF THE PROJECT GUTENBERG EBOOK ${title.toUpperCase()} ***`,
  ].join('\r\n');

const NOVEL = gutenberg('A Tale of Two Cities', [
  'CHAPTER I.',
  '',
  ...PROSE,
  LISTED,
  '',
  'TRANSCRIBER\'S NOTES',
  '',
  'Obvious printing errors in this edition have been corrected by the transcriber without comment.',
]);

const book = (id: number, title: string, textUrl: string, authors = HARVEST.authors.map((a) => ({ name: a.gutendex_name, birth_year: a.birth_year, death_year: a.death_year }))) => ({
  id,
  title,
  authors,
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

const WIKIQUOTE_PAGE = {
  parse: {
    title: 'Charles Dickens',
    wikitext: `== Quotes ==\n* It was the best of times.\n==Misattributed==\n* "Well, every one for himself, and Providence for us all--as the elephant said when he danced among the chickens."\n** [[Charles Reade]], ''A Simpleton'' (1873)\n{{Misattributed end}}`,
  },
};

const WIKIQUOTE_PATH = '/w/api.php?action=parse&format=json&formatversion=2&prop=wikitext&page=Charles_Dickens';
const SEARCH_PATH = '/books/?languages=en&search=dickens';

const servers: Server[] = [];
let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'lantern-harvest-'));
});

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A real HTTP server on 127.0.0.1:0 answering by path and query; `hits` records each request. */
async function site(routes: Record<string, { type?: string; body: string }>) {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const route = routes[req.url ?? ''];
    res.writeHead(route === undefined ? 404 : 200, { 'content-type': route?.type ?? 'application/json; charset=utf-8' });
    res.end(route?.body ?? '{}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

/** Sends every request to the local site while the client sees the url it asked for, as the real host would answer it. */
function routedTo(origin: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const response = await fetch(`${origin}${url.pathname}${url.search}`, init);
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
}

/** A picker that chooses, by number, the candidates whose text passes `choose`. */
const pickWhere =
  (choose: (text: string) => boolean): PickFn =>
  async (_system, user) => ({
    picks: user
      .split('\n')
      .map((line) => /^\[(\d+)\] (.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null && choose(match[2]!))
      .slice(0, 3)
      .map((match) => ({ id: Number(match[1]), reason: 'stands alone' })),
  });

async function setup(routes: Record<string, { type?: string; body: string }>, pick: PickFn, overrides: Partial<HarvestOptions> = {}) {
  const { origin, hits } = await site(routes);
  const db = testDb();
  const verticalId = Number(
    db.prepare("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'Literature', 'config/verticals/literature.yaml')").run()
      .lastInsertRowid,
  );
  const endpoints: Endpoints = { gutendex: 'https://gutendex.com', wikiquote: 'https://en.wikiquote.org' };
  const options: HarvestOptions = {
    db,
    verticalId,
    harvest: HARVEST,
    get: createHttpGet({ cacheDir, http: { userAgent: UA, fetchImpl: routedTo(origin) }, secretValues: [] }),
    endpoints,
    pick,
    prompt: 'You can only choose by number.',
    limit: 25,
    now: NOW,
    ...overrides,
  };
  return { db, verticalId, hits, options };
}

const standardRoutes = {
  [WIKIQUOTE_PATH]: { body: JSON.stringify(WIKIQUOTE_PAGE) },
  [SEARCH_PATH]: {
    body: JSON.stringify({
      count: 2,
      next: null,
      previous: null,
      results: [
        book(98, 'A Tale of Two Cities', 'https://www.gutenberg.org/ebooks/98.txt.utf-8'),
        book(3178, 'The Gilded Age', 'https://www.gutenberg.org/ebooks/3178.txt.utf-8', [
          { name: 'Dickens, Charles', birth_year: 1812, death_year: 1870 },
          { name: 'Warner, Charles Dudley', birth_year: 1829, death_year: 1900 },
        ]),
      ],
    }),
  },
  '/ebooks/98.txt.utf-8': { type: 'text/plain; charset=utf-8', body: NOVEL },
};

describe('harvestVertical', () => {
  it('harvests picked passages with their evidence, and verify then decides them', async () => {
    const { db, verticalId, hits, options } = await setup(standardRoutes, pickWhere((t) => t.startsWith('Sentence one ') || t === LISTED));
    const report = await harvestVertical(options);

    expect(report.inserted).toBe(2);
    expect(report.authors).toEqual([
      {
        author: 'Charles Dickens',
        error: null,
        listedEntries: 1,
        books: [
          {
            gutenbergId: 98,
            title: 'A Tale of Two Cities',
            outcome: expect.objectContaining({ status: 'harvested', heading: 'CHAPTER I.', picked: 2, inserted: 2, duplicates: 0, listed: 1 }),
          },
        ],
      },
    ]);
    expect(hits).not.toContain('/ebooks/3178.txt.utf-8');

    const items = db.prepare('SELECT id, body, work_title FROM items ORDER BY id').all() as { id: number; body: string; work_title: string }[];
    expect(items.map((i) => i.body)).toEqual([PROSE[0], LISTED]);
    const [primary] = loadEvidence(db, items[0]!.id);
    expect(primary).toMatchObject({
      kind: 'primary-text',
      citation: 'Charles Dickens, A Tale of Two Cities (Project Gutenberg #98)',
      url: 'https://www.gutenberg.org/ebooks/98.txt.utf-8',
      excerpt: PROSE[0],
      authorMatches: true,
    });
    expect(primary).toHaveProperty('location', expect.stringMatching(/^characters \d+-\d+ after the Project Gutenberg header$/));
    expect(loadEvidence(db, items[1]!.id).map((e) => e.kind)).toEqual(['primary-text', 'listed-misattributed']);
    expect(JSON.stringify(db.prepare('SELECT body FROM items').pluck().all())).not.toContain('editor');

    expect(verifyVertical(db, verticalId, { now: NOW })).toEqual({
      considered: 2,
      verified: 1,
      rejected: { misattributed: 1 },
      unchecked: 0,
      malformed: 0,
      reopened: 0,
    });
  });

  it('spends nothing on a book already picked with the same prompt and model', async () => {
    const { db, options } = await setup(standardRoutes, pickWhere((t) => t.startsWith('Sentence one ')));
    await harvestVertical(options);
    const again = await harvestVertical({
      ...options,
      pick: async () => {
        throw new Error('the picker must not be called again');
      },
    });
    expect(again.inserted).toBe(0);
    expect(again.authors[0]!.books).toEqual([{ gutenbergId: 98, title: 'A Tale of Two Cities', outcome: { status: 'already-picked' } }]);
    expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(1);
  });

  it('skips an author whose Wikiquote page cannot be read, before any book is fetched', async () => {
    const { db, hits, options } = await setup({ [SEARCH_PATH]: standardRoutes[SEARCH_PATH] }, pickWhere(() => true));
    const report = await harvestVertical(options);
    expect(report.authors[0]).toMatchObject({ author: 'Charles Dickens', error: expect.stringContaining('HTTP 404'), books: [] });
    expect(hits.some((h) => h.startsWith('/books/'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(0);
  });

  it('starts no new book once the limit is reached', async () => {
    const routes = {
      ...standardRoutes,
      [SEARCH_PATH]: {
        body: JSON.stringify({
          count: 2,
          next: null,
          previous: null,
          results: [
            book(98, 'A Tale of Two Cities', 'https://www.gutenberg.org/ebooks/98.txt.utf-8'),
            book(1400, 'Great Expectations', 'https://www.gutenberg.org/ebooks/1400.txt.utf-8'),
          ],
        }),
      },
    };
    const { hits, options } = await setup(routes, pickWhere((t) => t.startsWith('Sentence one ')), { limit: 1 });
    const report = await harvestVertical(options);
    expect(report.inserted).toBe(1);
    expect(report.authors[0]!.books.map((b) => b.gutenbergId)).toEqual([98]);
    expect(hits).not.toContain('/ebooks/1400.txt.utf-8');
  });

  it('skips a book without a usable body or primary-text url, marks a book failed when the picker output is unusable, and moves on', async () => {
    const routes = {
      [WIKIQUOTE_PATH]: standardRoutes[WIKIQUOTE_PATH],
      [SEARCH_PATH]: {
        body: JSON.stringify({
          count: 3,
          next: null,
          previous: null,
          results: [
            book(902, 'The Happy Prince', 'https://www.gutenberg.org/ebooks/902.txt.utf-8'),
            book(903, 'A Mirror Copy', 'https://mirror.example/ebooks/903.txt'),
            book(98, 'A Tale of Two Cities', 'https://www.gutenberg.org/ebooks/98.txt.utf-8'),
          ],
        }),
      },
      '/ebooks/902.txt.utf-8': { type: 'text/plain; charset=utf-8', body: gutenberg('The Happy Prince', PROSE) },
      '/ebooks/903.txt': { type: 'text/plain; charset=utf-8', body: NOVEL },
      '/ebooks/98.txt.utf-8': standardRoutes['/ebooks/98.txt.utf-8'],
    };
    let calls = 0;
    const { db, options } = await setup(routes, async () => {
      calls++;
      return { picks: 'none' };
    });
    const report = await harvestVertical(options);
    // harvestableBooks returns books in id order.
    expect(report.authors[0]!.books.map((b) => [b.gutenbergId, b.outcome.status])).toEqual([
      [98, 'failed'],
      [902, 'skipped'],
      [903, 'skipped'],
    ]);
    expect(calls).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM book_picks').pluck().get()).toBe(0);
  });

  it('stops the run when the picker fails for another reason, such as a rejected key', async () => {
    const { options } = await setup(standardRoutes, async () => {
      throw new Error('invalid x-api-key');
    });
    await expect(harvestVertical(options)).rejects.toThrow('invalid x-api-key');
  });
});
