import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_ENRICH_FAILURES } from '../../src/db/posts.js';
import { insertHarvestedQuote, upsertAuthorSubject } from '../../src/db/quotes.js';
import { EnrichResponseError, type ModelFn } from '../../src/enrich/anthropic.js';
import type { Draft } from '../../src/enrich/draft.js';
import { enrichVertical, type EnrichOptions } from '../../src/enrich/enrich.js';
import { articleUrl, DEFAULT_WIKI_ENDPOINTS, entitiesUrl, workSearchUrl } from '../../src/enrich/wikipedia.js';
import type { HarvestAuthor } from '../../src/harvest/gutendex.js';
import { createHttpGet } from '../../src/harvest/sources.js';
import { verifyVertical } from '../../src/verify/run.js';
import type { CallTag } from '../../src/lib/usage.js';
import { testDb } from '../helpers/db.js';

const UA = 'Lantern/test (test@example.invalid)';
const E = DEFAULT_WIKI_ENDPOINTS;
const NOW = () => new Date('2026-09-15T00:00:00.000Z');
const BODY = 'A wonderful fact to reflect upon, that every human creature is constituted to be that profound secret and mystery to every other.';
const DICKENS: HarvestAuthor = { name: 'Charles Dickens', gutendex_name: 'Dickens, Charles', wikidata_id: 'Q5686', birth_year: 1812, death_year: 1870 };
const AUSTEN: HarvestAuthor = { name: 'Jane Austen', gutendex_name: 'Austen, Jane', wikidata_id: 'Q36322', birth_year: 1775, death_year: 1817 };
const VERTICAL = { voice: 'Warm and precise.', post_shape: { hook: '1 sentence', body: '2-4 short paragraphs', closer: '1 sentence' }, banned_topics: [] };
const ENRICH = { writer_model: 'claude-opus-5', checker_model: 'claude-sonnet-5', author_article_chars: 30_000, work_article_chars: 18_000 };
const PROMPTS = { write: 'WRITE {{voice}} {{hook}}', revise: 'REVISE {{body}}', check: 'CHECK' };

const S1 = 'Charles John Huffam Dickens (7 February 1812\u2013 9 June 1870) was an English novelist and social critic.';
const S2 = 'Dickens published A Tale of Two Cities in 1859 in his weekly journal All the Year Round.';
const S3 = 'The novel is set in London and Paris before and during the French Revolution.';
const DROPPED = 'A reference list entry that is long enough to count as a paragraph if it were kept.';

const entity = (id: string, label: string, enwiki: string | null) => ({
  type: 'item',
  id,
  labels: { en: { language: 'en', value: label } },
  sitelinks: enwiki === null ? {} : { enwiki: { site: 'enwiki', title: enwiki, badges: [] } },
});
const page = (title: string, qid: string, extract: string, revid: number) => ({
  batchcomplete: true,
  query: { pages: [{ pageid: 1, ns: 0, title, extract, revisions: [{ revid, parentid: revid - 1, timestamp: '2026-09-14T09:16:06Z' }], pageprops: { wikibase_item: qid } }] },
});
const pathOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

const ROUTES: Record<string, unknown> = {
  [pathOf(entitiesUrl(E, ['Q5686']))]: { entities: { Q5686: entity('Q5686', 'Charles Dickens', 'Charles Dickens') }, success: 1 },
  [pathOf(workSearchUrl(E, 'Q5686', 'A Tale of Two Cities'))]: { batchcomplete: true, query: { search: [{ ns: 0, title: 'Q308918' }] } },
  [pathOf(entitiesUrl(E, ['Q308918']))]: { entities: { Q308918: entity('Q308918', 'A Tale of Two Cities', 'A Tale of Two Cities') }, success: 1 },
  [pathOf(articleUrl(E, 'Charles Dickens'))]: page('Charles Dickens', 'Q5686', `${S1}\n${S2}\n\n\n== References ==\n\n${DROPPED}`, 1371883001),
  [pathOf(articleUrl(E, 'A Tale of Two Cities'))]: page('A Tale of Two Cities', 'Q308918', S3, 1374830091),
  [pathOf(entitiesUrl(E, ['Q36322']))]: { entities: { Q36322: entity('Q36322', 'Jane Austen', null) }, success: 1 },
};

const servers: Server[] = [];
let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'lantern-enrich-'));
});

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A real HTTP server on 127.0.0.1:0 standing in for Wikidata and Wikipedia, reached through a fetch that keeps the real hosts in the url. */
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

const part = (text: string, sources: string[]) => ({ text, sources });
const GOOD: Draft = {
  hook: part('Dickens set this reflection in a novel about secrets.', ['S3']),
  body: [part('Charles Dickens was an English novelist who lived from 1812 to 1870.', ['S1']), part('He published A Tale of Two Cities in 1859, setting it in London and Paris.', ['S2', 'S3'])],
  closer: part('The novel keeps returning to what people hide.', []),
};
const FLAWED: Draft = { ...GOOD, body: [part(`${GOOD.body[0]!.text} He was UNSUPPORTED the most famous man alive.`, ['S1']), GOOD.body[1]!] };
const NUMBERED: Draft = { ...GOOD, closer: part('The novel has 45 chapters.', ['S2']) };
const AUTHOR_ONLY: Draft = { ...GOOD, hook: part(GOOD.hook.text, []), body: [GOOD.body[0]!, part('He published A Tale of Two Cities in 1859.', ['S2'])] };
const refusal = (what: string) => new EnrichResponseError(`the ${what} stopped with refusal and no usable output`);

/** A writer that answers with each draft in turn (repeating the last), or throws a given error. */
function writer(...answers: (Draft | Error)[]) {
  const calls: { system: string; user: string; tag?: CallTag }[] = [];
  const fn: ModelFn = async (system, user, tag) => {
    calls.push({ system, user, tag });
    const next = answers[Math.min(calls.length, answers.length) - 1]!;
    if (next instanceof Error) throw next;
    return { value: next, model: 'claude-opus-5', inputTokens: 100, outputTokens: 50 };
  };
  return { fn, calls };
}

/** A checker that judges the numbered sentences it is sent, finding unsupported only those marked UNSUPPORTED. */
function checker() {
  const calls: { system: string; user: string; tag?: CallTag }[] = [];
  const fn: ModelFn = async (system, user, tag) => {
    calls.push({ system, user, tag });
    const sentences = [...user.matchAll(/^\((\d+)\) (.*)$/gm)].map((m) => ({ id: Number(m[1]), text: m[2]! }));
    const verdicts = sentences.map(({ id, text }) => {
      const flagged = text.includes('UNSUPPORTED');
      return { id, kind: 'fact', supported: !flagged, sources: flagged ? [] : ['S1'], problem: flagged ? 'the sources do not say he was the most famous man alive' : '' };
    });
    return { value: { sentences: verdicts }, model: 'claude-sonnet-5', inputTokens: 40, outputTokens: 20 };
  };
  return { fn, calls };
}

async function setup(routes = ROUTES) {
  const db = testDb();
  const verticalId = Number(
    db.prepare("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'Literature', 'config/verticals/literature.yaml')").run()
      .lastInsertRowid,
  );
  const quote = (author: HarvestAuthor, body: string, workTitle: string) => {
    const subjectId = upsertAuthorSubject(db, verticalId, author, NOW());
    const evidence = [
      {
        kind: 'primary-text' as const,
        citation: `${author.name}, ${workTitle} (Project Gutenberg)`,
        url: 'https://www.gutenberg.org/ebooks/98.txt.utf-8',
        excerpt: body,
        location: 'characters 10-140 after the Project Gutenberg header',
        authorMatches: true,
      },
    ];
    const { itemId } = insertHarvestedQuote(
      db,
      { verticalId, subjectId, author: author.name, body, workTitle, evidence, wikiquotePage: author.name, wikiquoteCheckedAt: NOW().toISOString() },
      NOW(),
    );
    verifyVertical(db, verticalId, { now: NOW });
    return itemId;
  };
  const { get, hits } = await wiki(routes);
  const enrich = (write: ModelFn, check: ModelFn, extra: Partial<EnrichOptions> = {}) =>
    enrichVertical({ db, verticalId, vertical: VERTICAL, enrich: ENRICH, get, endpoints: E, write, check, prompts: PROMPTS, limit: 5, now: NOW, ...extra });
  return { db, quote, enrich, hits };
}

const tier3 = (db: ReturnType<typeof testDb>) => db.prepare('SELECT COUNT(*) FROM sources WHERE tier = 3').pluck().get();

describe('enrichVertical', () => {
  it('writes a draft post from the cited paragraphs when every gate passes, and skips it on the next run', async () => {
    const { db, quote, enrich } = await setup();
    const itemId = quote(DICKENS, BODY, 'A Tale of Two Cities');
    const write = writer(GOOD);
    const check = checker();

    const report = await enrich(write.fn, check.fn);
    expect(report).toEqual({
      considered: 1,
      drafted: 1,
      needsReview: 0,
      failed: 0,
      givenUp: 0,
      items: [
        {
          itemId,
          author: 'Charles Dickens',
          workTitle: 'A Tale of Two Cities',
          outcome: { status: 'draft', postId: expect.any(Number), rounds: 1, problems: [], workArticle: 'A Tale of Two Cities' },
        },
      ],
    });
    expect(db.prepare('SELECT hook, body, closer, alt_text, status FROM posts').get()).toEqual({
      hook: GOOD.hook.text,
      body: `${GOOD.body[0]!.text}\n\n${GOOD.body[1]!.text}`,
      closer: GOOD.closer.text,
      alt_text: `Quotation from A Tale of Two Cities by Charles Dickens: "${BODY}"`,
      status: 'draft',
    });
    expect(db.prepare('SELECT label FROM post_sources ORDER BY label').pluck().all()).toEqual(['S1', 'S2', 'S3']);
    expect(db.prepare('SELECT citation FROM sources WHERE tier = 3 ORDER BY id').pluck().all()).toEqual([
      'Wikipedia, "Charles Dickens", lead section, revision 1371883001',
      'Wikipedia, "Charles Dickens", lead section, revision 1371883001',
      'Wikipedia, "A Tale of Two Cities", lead section, revision 1374830091',
    ]);

    expect(write.calls[0]!.system).toBe('WRITE Warm and precise. 1 sentence');
    expect(write.calls[0]!.user).toContain(`[S3] (A Tale of Two Cities: Lead) ${S3}`);
    expect(write.calls[0]!.user).not.toContain(DROPPED);
    expect(check.calls[0]!.system).toBe('CHECK');
    expect(check.calls[0]!.user).toContain(`[Q] (the quotation, from A Tale of Two Cities by Charles Dickens) ${BODY}`);
    expect(db.prepare('SELECT prompt_sha256 FROM post_rounds').pluck().get()).toBe(
      createHash('sha256').update('WRITE Warm and precise. 1 sentence\n\nCHECK').digest('hex'),
    );
    expect(check.calls[0]!.user).toContain('(4) The novel keeps returning to what people hide.');

    expect(await enrich(write.fn, check.fn)).toMatchObject({ considered: 0, drafted: 0 });
    expect(write.calls).toHaveLength(1);
  });

  it('reads each article once for two quotes from the same work, and gives both posts its paragraphs', async () => {
    const { db, quote, enrich, hits } = await setup();
    quote(DICKENS, BODY, 'A Tale of Two Cities');
    quote(DICKENS, 'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness.', 'A Tale of Two Cities');

    expect(await enrich(writer(GOOD).fn, checker().fn)).toMatchObject({ considered: 2, drafted: 2, failed: 0 });
    expect(hits.filter((hit) => hit.includes('prop=extracts'))).toHaveLength(2);
    const citations = db
      .prepare('SELECT p.post_id, s.citation FROM post_sources p JOIN sources s ON s.id = p.source_id WHERE p.label = ? ORDER BY p.post_id')
      .all('S3') as { post_id: number; citation: string }[];
    expect(citations.map((c) => c.citation)).toEqual([
      'Wikipedia, "A Tale of Two Cities", lead section, revision 1374830091',
      'Wikipedia, "A Tale of Two Cities", lead section, revision 1374830091',
    ]);
  });

  it('gives a draft with an unsupported sentence one revision and keeps both rounds', async () => {
    const { db, quote, enrich } = await setup();
    quote(DICKENS, BODY, 'A Tale of Two Cities');
    const write = writer(FLAWED, GOOD);

    const check = checker();
    const report = await enrich(write.fn, check.fn);
    expect(report.items[0]!.outcome).toMatchObject({ status: 'draft', rounds: 2, problems: [] });
    expect(write.calls[1]!.system).toBe('REVISE 2-4 short paragraphs');
    expect(write.calls[1]!.user).toContain('Problems the reviewer found:\n- "He was UNSUPPORTED the most famous man alive." is not supported by the source paragraphs: the sources do not say he was the most famous man alive');
    expect(write.calls[1]!.user).toContain(JSON.stringify(FLAWED, null, 2));
    // Every call is tagged with its quote and role, so its tokens are charged to that quote.
    const itemId = report.items[0]!.itemId;
    expect(write.calls.map((c) => c.tag)).toEqual([
      { stage: 'enrich', role: 'writer', itemId },
      { stage: 'enrich', role: 'reviser', itemId },
    ]);
    expect(check.calls.map((c) => c.tag)).toEqual([
      { stage: 'enrich', role: 'checker', itemId },
      { stage: 'enrich', role: 'checker', itemId },
    ]);
    const rounds = db.prepare('SELECT round, problems_json FROM post_rounds ORDER BY round').all() as { round: number; problems_json: string }[];
    expect(rounds.map((r) => [r.round, JSON.parse(r.problems_json).length])).toEqual([
      [1, 1],
      [2, 0],
    ]);
  });

  it('sends the post to review when the revision still has a problem, such as a number not in the sources', async () => {
    const { db, quote, enrich } = await setup();
    quote(DICKENS, BODY, 'A Tale of Two Cities');
    const report = await enrich(writer(NUMBERED).fn, checker().fn);
    expect(report).toMatchObject({ drafted: 0, needsReview: 1, failed: 0 });
    expect(report.items[0]!.outcome).toMatchObject({
      status: 'needs_review',
      rounds: 2,
      problems: ['the number 45 is not in the quotation or in any cited source paragraph'],
    });
    expect(db.prepare('SELECT status FROM posts').pluck().get()).toBe('needs_review');
  });

  it('keeps the first round for review when the revision itself fails', async () => {
    const { quote, enrich } = await setup();
    quote(DICKENS, BODY, 'A Tale of Two Cities');
    const report = await enrich(writer(FLAWED, new EnrichResponseError('the writer stopped with refusal and no usable output')).fn, checker().fn);
    expect(report.items[0]!.outcome).toMatchObject({ status: 'needs_review', rounds: 1 });
    expect(report.items[0]!.outcome.status === 'needs_review' && report.items[0]!.outcome.problems.at(-1)).toBe(
      'the revision failed: the writer stopped with refusal and no usable output',
    );
  });

  it('reports a quote as failed, with no post, when its author has no article or its first draft is refused, and tries it again next run', async () => {
    const { db, quote, enrich } = await setup();
    const dickens = quote(DICKENS, BODY, 'A Tale of Two Cities');
    const austen = quote(AUSTEN, 'It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.', 'Pride and Prejudice');

    const refused = await enrich(writer(new EnrichResponseError('the writer stopped with refusal and no usable output')).fn, checker().fn);
    expect(refused.items.map((i) => [i.itemId, i.outcome])).toEqual([
      [dickens, { status: 'failed', reason: 'the writer stopped with refusal and no usable output' }],
      [austen, { status: 'failed', reason: 'Q36322 has no English Wikipedia article' }],
    ]);
    expect(db.prepare('SELECT COUNT(*) FROM posts').pluck().get()).toBe(0);
    expect(tier3(db)).toBe(0);

    const retried = await enrich(writer(GOOD).fn, checker().fn);
    expect(retried).toMatchObject({ considered: 2, drafted: 1, failed: 1 });
  });

  it('uses the author article alone when no work article matches, and stops the run on any other error', async () => {
    const routes = { ...ROUTES, [pathOf(workSearchUrl(E, 'Q5686', 'A Tale of Two Cities'))]: { batchcomplete: true, query: { search: [] } } };
    const { quote, enrich } = await setup(routes);
    quote(DICKENS, BODY, 'A Tale of Two Cities');
    await expect(enrich(writer(new Error('socket hang up')).fn, checker().fn)).rejects.toThrow('socket hang up');

    const write = writer(AUTHOR_ONLY);
    const report = await enrich(write.fn, checker().fn);
    expect(report.items[0]!.outcome).toMatchObject({ status: 'draft', rounds: 1, workArticle: null });
    expect(write.calls[0]!.user).not.toContain('[S3]');
  });

  it('uses the author article alone when the work article turns out to be another item', async () => {
    const routes = { ...ROUTES, [pathOf(articleUrl(E, 'A Tale of Two Cities'))]: page('A Tale of Two Cities (disambiguation)', 'Q999', S3, 1) };
    const { quote, enrich } = await setup(routes);
    quote(DICKENS, BODY, 'A Tale of Two Cities');
    const write = writer(AUTHOR_ONLY);
    expect((await enrich(write.fn, checker().fn)).items[0]!.outcome).toMatchObject({ status: 'draft', workArticle: null });
    expect(write.calls[0]!.user).not.toContain('[S3]');
  });

  it('fails the quote when the first fact check is refused, and sends it to review when the revision check is', async () => {
    const { db, quote, enrich } = await setup();
    quote(DICKENS, BODY, 'A Tale of Two Cities');
    const refusing: ModelFn = async () => {
      throw refusal('fact check');
    };
    expect((await enrich(writer(GOOD).fn, refusing)).items[0]!.outcome).toEqual({
      status: 'failed',
      reason: 'the fact check stopped with refusal and no usable output',
    });
    expect(db.prepare('SELECT COUNT(*) FROM posts').pluck().get()).toBe(0);

    const good = checker();
    let calls = 0;
    const refusesSecond: ModelFn = async (system, user) => {
      calls++;
      if (calls === 2) throw refusal('fact check');
      return good.fn(system, user);
    };
    const report = await enrich(writer(FLAWED, GOOD).fn, refusesSecond);
    expect(report.items[0]!.outcome).toMatchObject({ status: 'needs_review', rounds: 1 });
    expect(report.items[0]!.outcome.status === 'needs_review' && report.items[0]!.outcome.problems.at(-1)).toBe(
      'the revision failed: the fact check stopped with refusal and no usable output',
    );
  });

  it('stops offering a quote that failed too often, counts it as given up, and tries it again when asked', async () => {
    const { db, quote, enrich } = await setup();
    const austen = quote(AUSTEN, 'It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.', 'Pride and Prejudice');
    for (let n = 1; n < MAX_ENRICH_FAILURES; n++) expect(await enrich(writer(GOOD).fn, checker().fn)).toMatchObject({ considered: 1, failed: 1, givenUp: 0 });
    expect(await enrich(writer(GOOD).fn, checker().fn)).toMatchObject({ considered: 1, failed: 1, givenUp: 1 });
    expect(await enrich(writer(GOOD).fn, checker().fn)).toMatchObject({ considered: 0, failed: 0, givenUp: 1 });
    expect(await enrich(writer(GOOD).fn, checker().fn, { retryFailed: true })).toMatchObject({ considered: 1, failed: 1, givenUp: 0 });
    expect(db.prepare('SELECT COUNT(*) FROM enrich_failures WHERE item_id = ?').pluck().get(austen)).toBe(MAX_ENRICH_FAILURES + 1);
  });
});
