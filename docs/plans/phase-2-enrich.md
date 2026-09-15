# Phase 2 Enrichment and Fact-Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pipeline stage that turns a verified quote into a platform-neutral post:

- **`lantern enrich --vertical literature [--limit 5] [--refresh]`** takes each verified quote without a post, authors taking turns, and:
  1. Reads the author's Wikipedia article (through the subject's Wikidata id) and the work's article (through a Wikidata search for the title). Their paragraphs, labelled S1, S2, ..., are the only facts offered.
  2. Has `claude-opus-5` write the hook, body paragraphs and closer, each with the labels it relies on.
  3. Judges the draft with program gates (shape, labels, repeated quotation, numbers) and a `claude-sonnet-5` fact check of every sentence against the paragraphs the draft cites.
  4. Gives a draft with any problem one revision, judged the same way.
  5. Stores the post as `draft` when its last round has no problems, or `needs_review` otherwise, with every round and the cited paragraphs as tier 3 sources of the quote.

**User decisions this plan implements (2026-09-15):**

- **Models:** `claude-opus-5` writes; `claude-sonnet-5` checks. The writer uses server-side fallback (`fallbacks: "default"` with the beta `server-side-fallback-2026-07-01`). If Opus 5 declines for policy reasons, the API's default substitute model answers, and the stored round records which model wrote the text.
- **Background facts:** Wikipedia extracts. The author's and the work's articles are found through Wikidata. The paragraphs a post cites are stored as reference (tier 3) sources. Every sentence is fact-checked, and what the sources do not support goes to `needs_review`.
- **Flagged claims:** one visible revision. The writer gets the problems and must fix or remove them from the sources alone; the revision is checked again; what remains goes to `needs_review`. Both rounds and every check are stored for review. `claude.md` §7 changes in this branch.

The user's database is at 005; `phase-2-commands` added 006 and this plan adds 007. The user applies both with `lantern migrate` before the first enrich.

**Architecture:**

- `src/enrich/wikipedia.ts`: cached reads of Wikidata (an author's English article; a work found by author and title) and Wikipedia (text, revision and Wikidata item in one request, refused when the article is not the item's).
- `src/enrich/context.ts`: an article's text as section-named paragraphs within a character budget, labelled S1..Sn, shown to the models, and stored as tier 3 sources with a permanent revision link.
- `src/enrich/draft.ts`: the writer's and the checker's output schemas, and sentence splitting.
- `src/enrich/gates.ts`: the problems a draft can have: shape, labels, a repeated quotation, numbers, and the checker's verdicts.
- `migrations/007_post_rounds.sql` and `src/db/posts.ts`: `post_rounds` and `post_sources`, the quotes waiting for a post, and the one-transaction post insert.
- `src/config/schema.ts` and `config/verticals/literature.yaml`: the `enrich:` section. `prompts/literature/enrich.md`, `prompts/literature/revise.md`, `prompts/shared/fact-check.md`: the prompts. `src/enrich/messages.ts`: prompt filling and message formats. `src/enrich/anthropic.ts`: the writer and checker adapters.
- `src/enrich/enrich.ts`: one run and its report.
- `src/cli.ts`: `lantern enrich` through `runStage`.

**Tech Stack:** Node 26, TypeScript 7 (strict, nodenext), vitest 5, better-sqlite3 13, zod 4, commander 15, `@anthropic-ai/sdk` 0.125.0. No new dependencies; sentences are split with the built-in `Intl.Segmenter`.

**Spec:** `claude.md`. The relevant sections are:

- §2.2: no invented facts; every claim traces to a stored source, and an unsupported claim fails the gate.
- §2.6: fail closed.
- §5 and §6: item, post, sources.
- §7: `lantern enrich` (this plan rewrites its paragraph).
- §8: tier 3 reference sources; the numbers check ("extract numerals from the draft, confirm each appears in a stored source excerpt").
- §9: voice, post shape and banned topics per vertical.
- §15: prompts in version-controlled files; real response shapes; offline tests.

The parent plan is `plan.md` Part C, milestone 2.4, and open decision #6.

**Evidence gathered before this plan (2026-09-15; details in `.superpowers/sdd/phase-2-enrich/design-notes.md`):**

- **Every code block ran first.** Each block ran in a scratch worktree of `f029afd`: 539/539 tests across 39 files, typecheck exit 0.
- **Recorded response shapes:**
  - **Wikidata `wbgetentities`** gives labels and sitelinks. An unknown id answers HTTP 200 with an `error` object, and an empty map can come back as `[]`.
  - **The author-and-title search** (`haswbstatement:P50=<author> "<title>"`): "A Tale of Two Cities" finds Q308918 among editions that have no English label or article. "Salom&eacute;" finds `Salome (play)`, whose label has no accent. "The Adventures of Tom Sawyer, Complete" finds nothing until ", Complete" is dropped. "Lord Arthur Savile's Crime; The Portrait of Mr. W.H., and Other Stories" finds the story once the subtitle is cut.
  - **Wikipedia `prop=extracts|revisions|pageprops`** returns the text, revision id and Wikidata item in one answer. It follows a redirect (Samuel Clemens to Mark Twain) and marks a missing page `missing: true`. Paragraphs are one per line and headings are `== Name ==`.
- **Five live prompt probes:**
  - The fact check caught the writer's small unsupported flourishes in 3/10, 1/8 and 1/10 sentences.
  - Giving every part (not just the body) its own labels let the checker verify a closer it could not before.
  - A forced revision rewrote only the flagged sentence and passed the re-check.
- **Two live smoke runs of this plan's code** (two quotes each; real Wikidata, Wikipedia and models; in-memory database):
  - Both posts were drafted in about 45 s.
  - In the second run, one Austen sentence ("published anonymously") was flagged, revised, and passed.
  - About $0.12 per post.
  - The writer runs long, so the prompt asks for under 180 words (drafts came back at about 200).

**Deliberately NOT in this plan:**

- A live enrich. The user runs it after `lantern harvest` and `lantern verify`.
- Images (2.5), composition (2.6), captions (2.7) and the review UI (Phase 3). The review UI will read `post_rounds` and `post_sources`.
- A word-count gate. Length is asked for in the prompt and seen in review.
- A lock against concurrent enrich runs (parked with the harvest lock, P6). A second concurrent run fails on `UNIQUE(item_id)`.

## Global Constraints

- **Language and modules:** Node.js + TypeScript, ESM, strict mode on. Relative imports use `.js` extensions.
- **Unicode:**
  - Every non-ASCII character in code and tests must be a `\u` escape. Verify with `git diff | grep '^+' | grep -P '[^\x00-\x7F]'` on `.ts` files (and on new files with `grep -P '[^\x00-\x7F]' FILE`); it must print nothing.
  - If your file-writing tool turns a typed backslash-u escape into the character itself, write that line with a script instead (for example `String.fromCharCode(92) + 'u2019'`), then run the check again.
  - Added lines in SQL, YAML and prompt files stay ASCII. The existing `§` and `—` characters in `src/config/schema.ts` and `config/verticals/literature.yaml` stay exactly as they are.
  - Existing characters in `claude.md` and `plan.md` must not be re-encoded.
- **Line endings:** count CR bytes with `tr -cd '\r' < FILE | wc -c`; it must print `0`. Never use `grep $'\r'`, which misreports in this shell.
- **Fail closed:**
  - A post is inserted only for a verified quote, and is `draft` only when its last round has no problems.
  - A quote whose Wikipedia articles cannot be read, or whose first draft or its fact check is refused or unreadable, gets no post and is reported as failed.
  - A revision that fails leaves the first round as a `needs_review` post.
  - Any other error (a rejected API key, the network) stops the run.
- **No real internet in tests:** use `node:http` servers on `127.0.0.1:0`. Tests may use a `fetchImpl` that routes a real host's url to that local server, and an Anthropic client whose `baseURL` is a local server. They never use a real API key, never make a real Anthropic call, and never write under the real `data/` or `logs/`. CLI tests that reach `enrich` either set `ANTHROPIC_API_KEY` to the empty string, so the command stops before any fetch, or run on an empty database, where nothing is fetched or called.
- **Frozen migrations:** migrations 001-006 are frozen. Never edit them. New schema goes in `migrations/007_post_rounds.sql`.
- **Prompts are content (spec §15):** the three prompt files are exact; copy them byte for byte.
- **Never commit** `.env`, `data/`, `logs/`, or `.superpowers/`.
- **Commit trailers:** every commit message ends with a blank line, then `Co-Authored-By: <the authoring model's attribution line from its environment>` and `Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v`. Verify with `git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'`, which must print `2`.
- **Branch:** `phase-2-enrich`, created from `phase-2-commands` at f029afd. The baseline is 481 tests passing across 30 files. The controller pushes after the final review; implementers never push.

### File map

```
src/enrich/wikipedia.ts                 # N1: Wikidata and Wikipedia reads (new)
tests/enrich/wikipedia.test.ts          # N1 (new)
src/enrich/context.ts                   # N2: paragraphs, labels, tier 3 sources (new)
src/enrich/draft.ts                     # N2: output schemas, sentences (new)
tests/enrich/context.test.ts            # N2 (new)
tests/enrich/draft.test.ts              # N2 (new)
src/enrich/gates.ts                     # N3: shape, label, number and check problems (new)
tests/enrich/gates.test.ts              # N3 (new)
migrations/007_post_rounds.sql          # N4: post_rounds, post_sources (new)
src/db/posts.ts                         # N4: itemsToEnrich, insertPost (new)
tests/db/posts.test.ts                  # N4 (new)
src/config/schema.ts                    # N5: enrich section
config/verticals/literature.yaml        # N5: enrich section
prompts/literature/enrich.md            # N5: writer prompt (new)
prompts/literature/revise.md            # N5: revision prompt (new)
prompts/shared/fact-check.md            # N5: fact-check prompt (new)
src/enrich/messages.ts                  # N5: prompt filling, message formats (new)
src/enrich/anthropic.ts                 # N5: writer and checker adapters (new)
tests/config/enrich-config.test.ts      # N5 (new)
tests/enrich/messages.test.ts           # N5 (new)
tests/enrich/anthropic.test.ts          # N5 (new)
src/enrich/enrich.ts                    # N6: enrichVertical (new)
tests/enrich/enrich.test.ts             # N6 (new)
src/cli.ts                              # N7: enrich command, shared cached GET
tests/cli.test.ts                       # N7: 2 tests
claude.md                               # N7: sections 6, 7 and 16
plan.md                                 # N7: status, milestone 2.4, open decision #6
```

### Test counts

| After | Suite | Files |
|---|---|---|
| baseline | 481 | 30 |
| N1 | 490 | 31 |
| N2 | 499 | 33 |
| N3 | 510 | 34 |
| N4 | 513 | 35 |
| N5 | 531 | 38 |
| N6 | 537 | 39 |
| N7 | 539 | 39 |

### Rulings made while designing (the controller's pre-flight starts from these)

- **What the checker sees.** `plan.md` 2.4 says the check gets "only the stored sources plus the draft". Here the stored sources of a post are exactly the paragraphs it cites, and the checker sees those (plus the quotation as `[Q]`) and the draft's numbered sentences. It never sees the other paragraphs the writer was offered.
- **`alt_text`.** `plan.md` 2.4 has the writer return `alt_text`. Alt text describes an image, and no image exists until the media stage (2.5). So the post gets fixed text built from the quote row (`Quotation from <work> by <author>: "<quote>"`), which states nothing new.
- **Shape counts come from `post_shape`.** The leading count of each entry ("1 sentence", "2-4 short paragraphs", "1 question") is the allowed range. A vertical whose entries do not start with a count stops the run before any call. Both configured verticals parse.
- **What triggers the revision.** Any problem does: shape, labels, a repeated quotation, numbers, or the checker's verdicts. A checker that skips or repeats a sentence counts as a problem (fail closed).
- **Numbers.** `unsupportedNumbers` runs over the whole draft against the quotation and the cited paragraphs, for every vertical (plan 2.4).
- **Sources.** Each cited paragraph (from any round) becomes a tier 3 `sources` row of the quote, with the revision's permanent link and the paragraph as the excerpt, and is linked to the post by its label. An identical row the quote already has is reused. Tier 3 rows never verify anything (spec §8), and the item triggers allow them on a verified quote.
- **Order.** Quotes waiting for a post are taken subject by subject in turns, by id within a subject, computed over the quotes still waiting.
- **Work article.** The work's article is the first search hit whose English label, compared without case, accents or curly apostrophes, is the work's title before any subtitle and without ", Complete", and which has an English article. No match means the author's article alone. A work article that is found but does not load fails the quote.
- **Exit code.** `lantern enrich` exits 1 when any quote failed; `needs_review` posts are the gate working, not failures.

---

### Task N1: Wikidata and Wikipedia reader

**Files:**
- Create: `src/enrich/wikipedia.ts`
- Test: `tests/enrich/wikipedia.test.ts` (new)

**Interfaces:**
- **Consumes:** `HttpGet` and `SourceStatusError` from `src/harvest/sources.ts`; `HttpResult` from `src/lib/http.ts`.
- **Produces:**
  - `export interface WikiEndpoints { wikidata: string; wikipedia: string }` and `export const DEFAULT_WIKI_ENDPOINTS: WikiEndpoints`
  - `export class WikiLookupError extends Error`
  - `export function entitiesUrl(endpoints: WikiEndpoints, ids: readonly string[]): string`
  - `export async function authorArticleTitle(get: HttpGet, endpoints: WikiEndpoints, qid: string): Promise<string>`
  - `export function workSearchTitle(workTitle: string): string` and `export function foldTitle(title: string): string`
  - `export function workSearchUrl(endpoints: WikiEndpoints, authorQid: string, title: string): string`
  - `export interface WorkArticle { qid: string; title: string }` and `export async function workArticle(get: HttpGet, endpoints: WikiEndpoints, authorQid: string, workTitle: string): Promise<WorkArticle | null>`
  - `export function articleUrl(endpoints: WikiEndpoints, title: string): string` and `export function revisionUrl(endpoints: WikiEndpoints, title: string, revid: number): string`
  - `export interface WikipediaArticle { title: string; qid: string; revid: number; extract: string; url: string; fetchedAt: string }`
  - `export async function fetchArticle(get: HttpGet, endpoints: WikiEndpoints, title: string, qid: string): Promise<WikipediaArticle>`
- **Used by:** N2 (`WikipediaArticle`), N6 (the reads), N7 (`DEFAULT_WIKI_ENDPOINTS`).

**Why:**

- **Identity, not names.** The author's article comes from their Wikidata id, and a fetched article must carry that id (`pageprops.wikibase_item`), so an article that now names something else is refused rather than read. This mirrors the Wikiquote title check in `harvest`.
- **Stable citations.** A post's sources are a revision (`oldid`) link, so the cited text never changes under its citation.
- **Caching.** Reads go through the existing cached GET (`data/cache/wikidata/`, `data/cache/wikipedia/`). Only a 200 with the expected shape is cached, so a Wikidata error answered with 200 is fetched again next run.

- [ ] **Step 1: Write the failing tests**

Create `tests/enrich/wikipedia.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/enrich/wikipedia.test.ts`
Expected: FAIL, because `../../src/enrich/wikipedia.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/enrich/wikipedia.ts`:

```ts
import { z } from 'zod';
import { SourceStatusError, type HttpGet } from '../harvest/sources.js';
import type { HttpResult } from '../lib/http.js';

export interface WikiEndpoints {
  wikidata: string;
  wikipedia: string;
}

export const DEFAULT_WIKI_ENDPOINTS: WikiEndpoints = { wikidata: 'https://www.wikidata.org', wikipedia: 'https://en.wikipedia.org' };

/** Wikidata or Wikipedia answered, but not with the article a post needs. */
export class WikiLookupError extends Error {
  override name = 'WikiLookupError';
}

const QID = /^Q[1-9]\d*$/;

// Wikidata writes an empty map as [] in some answers, so both forms are accepted.
const emptyMap = z.tuple([]);
const entitySchema = z.object({
  id: z.string(),
  labels: z.union([z.record(z.string(), z.object({ value: z.string() })), emptyMap]).optional(),
  sitelinks: z.union([z.record(z.string(), z.object({ title: z.string() })), emptyMap]).optional(),
});
const entitiesSchema = z.object({ entities: z.record(z.string(), entitySchema) });
const searchSchema = z.object({ query: z.object({ search: z.array(z.object({ title: z.string() })) }) });
const articleSchema = z.object({
  query: z.object({
    pages: z.array(
      z.object({
        title: z.string(),
        missing: z.literal(true).optional(),
        invalid: z.literal(true).optional(),
        extract: z.string().optional(),
        revisions: z.array(z.object({ revid: z.number().int(), timestamp: z.string() })).optional(),
        pageprops: z.object({ wikibase_item: z.string().optional() }).optional(),
      }),
    ),
  }),
});
const apiErrorSchema = z.object({ error: z.object({ code: z.string(), info: z.string() }) });

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** A cached GET of a JSON answer. Only a 200 with the expected shape is cached; an API error answered with 200 is fetched again next time. */
async function getJson<T>(get: HttpGet, url: string, source: string, schema: z.ZodType<T>): Promise<{ data: T; fetchedAt: string }> {
  const result = await get(url, source, (r: HttpResult) => r.status === 200 && schema.safeParse(parseJson(r.body)).success);
  if (result.status !== 200) throw new SourceStatusError(result.url, result.status);
  const body = parseJson(result.body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const error = apiErrorSchema.safeParse(body);
    throw new WikiLookupError(error.success ? `${error.data.error.code} from ${url}: ${error.data.error.info}` : `unexpected answer from ${url}`);
  }
  return { data: parsed.data, fetchedAt: result.fetchedAt };
}

export function entitiesUrl(endpoints: WikiEndpoints, ids: readonly string[]): string {
  return `${endpoints.wikidata}/w/api.php?action=wbgetentities&ids=${ids.join('|')}&props=labels|sitelinks&languages=en&sitefilter=enwiki&format=json`;
}

interface EntityInfo {
  label: string | null;
  enwiki: string | null;
}

async function entityInfo(get: HttpGet, endpoints: WikiEndpoints, ids: readonly string[]): Promise<Map<string, EntityInfo>> {
  const { data } = await getJson(get, entitiesUrl(endpoints, ids), 'wikidata', entitiesSchema);
  const info = new Map<string, EntityInfo>();
  for (const entity of Object.values(data.entities)) {
    const labels = Array.isArray(entity.labels) ? undefined : entity.labels;
    const sitelinks = Array.isArray(entity.sitelinks) ? undefined : entity.sitelinks;
    info.set(entity.id, { label: labels?.['en']?.value ?? null, enwiki: sitelinks?.['enwiki']?.title ?? null });
  }
  return info;
}

/** The English Wikipedia article title of a Wikidata entity (an author's subject). */
export async function authorArticleTitle(get: HttpGet, endpoints: WikiEndpoints, qid: string): Promise<string> {
  if (!QID.test(qid)) throw new WikiLookupError(`${qid} is not a Wikidata id`);
  const title = (await entityInfo(get, endpoints, [qid])).get(qid)?.enwiki ?? null;
  if (title === null) throw new WikiLookupError(`${qid} has no English Wikipedia article`);
  return title;
}

/** The part of a Gutendex title that names the work: before any subtitle, without a trailing ", Complete". */
export function workSearchTitle(workTitle: string): string {
  return (workTitle.split(/[:;]/)[0] ?? '')
    .replace(/,\s*complete\s*$/i, '')
    .replace(/"/g, '')
    .trim();
}

/** A title compared without case, accents, curly apostrophes or extra spaces, so an accented title matches its plain spelling. */
export function foldTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u2018\u2019]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function workSearchUrl(endpoints: WikiEndpoints, authorQid: string, title: string): string {
  const query = `haswbstatement:P50=${authorQid} "${title}"`;
  return `${endpoints.wikidata}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=10&format=json&formatversion=2`;
}

export interface WorkArticle {
  qid: string;
  title: string;
}

/**
 * The Wikipedia article about a work: the first Wikidata item by the author (P50) found for the work's
 * title whose English label is that title and which has an English article. Editions and translations
 * have no English label or article, so they never match. Null when nothing matches.
 */
export async function workArticle(get: HttpGet, endpoints: WikiEndpoints, authorQid: string, workTitle: string): Promise<WorkArticle | null> {
  if (!QID.test(authorQid)) throw new WikiLookupError(`${authorQid} is not a Wikidata id`);
  const title = workSearchTitle(workTitle);
  if (title.length === 0) return null;
  const { data } = await getJson(get, workSearchUrl(endpoints, authorQid, title), 'wikidata', searchSchema);
  const hits = data.query.search.map((hit) => hit.title).filter((id) => QID.test(id));
  if (hits.length === 0) return null;
  const entities = await entityInfo(get, endpoints, hits);
  const wanted = foldTitle(title);
  for (const qid of hits) {
    const entity = entities.get(qid);
    if (entity?.enwiki != null && entity.label !== null && foldTitle(entity.label) === wanted) return { qid, title: entity.enwiki };
  }
  return null;
}

export function articleUrl(endpoints: WikiEndpoints, title: string): string {
  const titles = encodeURIComponent(title.replace(/ /g, '_'));
  return `${endpoints.wikipedia}/w/api.php?action=query&prop=extracts|revisions|pageprops&explaintext=1&rvprop=ids|timestamp&redirects=1&format=json&formatversion=2&titles=${titles}`;
}

/** A permanent link to one revision of an article, so a stored source never changes under its citation. */
export function revisionUrl(endpoints: WikiEndpoints, title: string, revid: number): string {
  return `${endpoints.wikipedia}/w/index.php?title=${encodeURIComponent(title.replace(/ /g, '_'))}&oldid=${revid}`;
}

export interface WikipediaArticle {
  title: string;
  qid: string;
  revid: number;
  /** The plain text of the article, as the extracts API gives it. */
  extract: string;
  /** The permanent link to this revision. */
  url: string;
  /** When the article was fetched (UTC ISO-8601), which is earlier than now when it came from the cache. */
  fetchedAt: string;
}

/**
 * The plain text and current revision of a Wikipedia article, from one request. Redirects are followed,
 * and the article must be the one Wikidata links to `qid`, so a title that now names something else is
 * refused rather than read.
 */
export async function fetchArticle(get: HttpGet, endpoints: WikiEndpoints, title: string, qid: string): Promise<WikipediaArticle> {
  const { data, fetchedAt } = await getJson(get, articleUrl(endpoints, title), 'wikipedia', articleSchema);
  const page = data.query.pages[0];
  if (page === undefined || data.query.pages.length !== 1) throw new WikiLookupError(`expected one Wikipedia page for ${title}`);
  if (page.missing === true || page.invalid === true) throw new WikiLookupError(`Wikipedia has no article ${title}`);
  const item = page.pageprops?.wikibase_item;
  if (item !== qid) throw new WikiLookupError(`the Wikipedia article ${page.title} is ${item ?? 'not linked to Wikidata'}, not ${qid}`);
  const revision = page.revisions?.[0];
  if (revision === undefined || page.extract === undefined || page.extract.trim() === '') {
    throw new WikiLookupError(`the Wikipedia article ${page.title} has no text or no revision`);
  }
  return { title: page.title, qid, revid: revision.revid, extract: page.extract, url: revisionUrl(endpoints, page.title, revision.revid), fetchedAt };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/enrich/wikipedia.test.ts`
Expected: PASS, 9 tests.

Run: `npx vitest run` and `npx tsc --noEmit -p .`
Expected: 490 tests pass across 31 files; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/enrich/wikipedia.ts tests/enrich/wikipedia.test.ts
git commit -m "feat(enrich): cached Wikidata and Wikipedia reads for an author's and a work's articles

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task N2: Source paragraphs and draft shapes

**Files:**
- Create: `src/enrich/context.ts`, `src/enrich/draft.ts`
- Test: `tests/enrich/context.test.ts`, `tests/enrich/draft.test.ts` (new)

**Interfaces:**
- **Consumes:** `WikipediaArticle` from `src/enrich/wikipedia.ts` (N1); `SourceInput`, `assertSourceAllowed` and `SourcePolicyError` from `src/verify/source-policy.ts`.
- **Produces:**
  - `context.ts`: `DROPPED_SECTIONS`, `MIN_PARAGRAPH_CHARS = 40`, `export interface SourceParagraph { id: string; article: WikipediaArticle; section: string; text: string }`, `articleParagraphs(article, maxChars): Omit<SourceParagraph, 'id'>[]`, `labelParagraphs(groups): SourceParagraph[]`, `formatParagraph(paragraph): string`, `paragraphSource(paragraph): SourceInput`
  - `draft.ts`: `draftPartSchema`, `draftSchema`, `checkSchema`, types `DraftPart`, `Draft`, `Check`, `NamedPart`, `DraftSentence { n; part; text }`, `draftParts(draft): NamedPart[]`, `splitSentences(text): string[]`, `draftSentences(draft): DraftSentence[]`
- **Used by:** N3 (gates), N5 (messages, adapters), N6.

**Why:**

- **Paragraphs are the unit of evidence.** The extracts API gives one paragraph per line, so a paragraph is what the writer cites and what becomes a stored excerpt. Reference, link and adaptation sections are dropped; lines under 40 characters are captions or list entries. The budget (from config in N5) keeps the writer's input near the probed 19k tokens.
- **Labels are per run.** S1..Sn number the author's paragraphs, then the work's. The post keeps each label with its stored source (N4), so review can read a round's draft against its sources.
- **Sentences.** The checker judges numbered sentences, and the shape gate counts them. `Intl.Segmenter` splits sentences; a segment ending in an abbreviation or an initial ("Mr.", "J. M. W.", "c.") is joined to the next.

- [ ] **Step 1: Write the failing tests**

Create `tests/enrich/context.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { articleParagraphs, DROPPED_SECTIONS, formatParagraph, labelParagraphs, MIN_PARAGRAPH_CHARS, paragraphSource } from '../../src/enrich/context.js';
import type { WikipediaArticle } from '../../src/enrich/wikipedia.js';
import { assertSourceAllowed, SourcePolicyError } from '../../src/verify/source-policy.js';

const P = (n: number) => `Paragraph ${n} says something about the author at enough length to be worth citing.`;
const article = (title: string, qid: string, extract: string): WikipediaArticle => ({
  title,
  qid,
  revid: 1371883001,
  extract,
  url: `https://en.wikipedia.org/w/index.php?title=${title.replace(/ /g, '_')}&oldid=1371883001`,
  fetchedAt: '2026-09-15T00:00:00.000Z',
});

// The extracts API layout: one paragraph per line, "\n\n\n== Heading ==\n\n" before a section, "=== Sub ===" deeper.
const DICKENS = article(
  'Charles Dickens',
  'Q5686',
  [P(1), P(2), '', '', '== Early life ==', '', P(3), '=== Education ===', P(4), 'Short caption line.', '', '', '== References ==', '', P(5), '=== Sources ===', P(6), '', '', '== Legacy ==', '', P(7)].join('\n'),
);
const TALE = article('A Tale of Two Cities', 'Q308918', [P(8), '', '', '== Synopsis ==', '', P(9)].join('\n'));

describe('articleParagraphs', () => {
  it('keeps paragraphs with their sections, skipping reference sections and short lines', () => {
    expect(DROPPED_SECTIONS).toContain('References');
    expect('Short caption line.'.length).toBeLessThan(MIN_PARAGRAPH_CHARS);
    expect(articleParagraphs(DICKENS, 10_000).map((p) => [p.section, p.text])).toEqual([
      ['Lead', P(1)],
      ['Lead', P(2)],
      ['Early life', P(3)],
      ['Early life / Education', P(4)],
      ['Legacy', P(7)],
    ]);
  });

  it('stops before the paragraph that would pass the character budget', () => {
    expect(articleParagraphs(DICKENS, 3 * P(1).length - 1).map((p) => p.text)).toEqual([P(1), P(2)]);
  });
});

describe('labelParagraphs and formatParagraph', () => {
  it('labels paragraphs across articles in order, and shows each with its article and section', () => {
    const labelled = labelParagraphs([articleParagraphs(DICKENS, 10_000).slice(0, 2), articleParagraphs(TALE, 10_000)]);
    expect(labelled.map((p) => p.id)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(formatParagraph(labelled[3]!)).toBe(`[S4] (A Tale of Two Cities: Synopsis) ${P(9)}`);
  });
});

describe('paragraphSource', () => {
  it('stores a paragraph as a tier 3 Wikipedia source cited by article, section and revision', () => {
    const [lead, , , education] = labelParagraphs([articleParagraphs(DICKENS, 10_000)]);
    expect(paragraphSource(education!)).toEqual({
      tier: 3,
      url: 'https://en.wikipedia.org/w/index.php?title=Charles_Dickens&oldid=1371883001',
      citation: 'Wikipedia, "Charles Dickens", section "Early life / Education", revision 1371883001',
      excerpt: P(4),
    });
    expect(paragraphSource(lead!).citation).toBe('Wikipedia, "Charles Dickens", lead section, revision 1371883001');
    expect(() => assertSourceAllowed(paragraphSource(lead!))).not.toThrow();
    expect(() => assertSourceAllowed({ ...paragraphSource(lead!), tier: 2 })).toThrow(SourcePolicyError);
  });
});
```

Create `tests/enrich/draft.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { checkSchema, draftParts, draftSchema, draftSentences, splitSentences, type Draft } from '../../src/enrich/draft.js';

const part = (text: string, sources: string[] = ['S1']) => ({ text, sources });

describe('splitSentences', () => {
  it('splits at sentence ends but not after abbreviations, initials or decimals', () => {
    expect(splitSentences('Mr. Dickens wrote it in 1859. It sold widely!')).toEqual(['Mr. Dickens wrote it in 1859.', 'It sold widely!']);
    expect(splitSentences('J. M. W. Turner painted it. St. Paul\u2019s was near.')).toEqual(['J. M. W. Turner painted it.', 'St. Paul\u2019s was near.']);
    expect(splitSentences('It weighed 3.5 tons in c. 1850. Nobody knows why.')).toEqual(['It weighed 3.5 tons in c. 1850.', 'Nobody knows why.']);
  });

  it('keeps closing quotation marks with their sentence, and returns nothing for blank text', () => {
    expect(splitSentences('He said, \u201CNo.\u201D Then he left.')).toEqual(['He said, \u201CNo.\u201D', 'Then he left.']);
    expect(splitSentences('   ')).toEqual([]);
  });
});

describe('draftParts and draftSentences', () => {
  const draft: Draft = {
    hook: part('A novel of secrets.'),
    body: [part('Dickens published it in 1859. It is set in London and Paris.'), part('The line is a reading of privacy.', [])],
    closer: part('The book keeps testing it.'),
  };

  it('names the parts in order', () => {
    expect(draftParts(draft).map((p) => p.name)).toEqual(['hook', 'body paragraph 1', 'body paragraph 2', 'closer']);
  });

  it('numbers every sentence across the parts', () => {
    expect(draftSentences(draft)).toEqual([
      { n: 1, part: 'hook', text: 'A novel of secrets.' },
      { n: 2, part: 'body paragraph 1', text: 'Dickens published it in 1859.' },
      { n: 3, part: 'body paragraph 1', text: 'It is set in London and Paris.' },
      { n: 4, part: 'body paragraph 2', text: 'The line is a reading of privacy.' },
      { n: 5, part: 'closer', text: 'The book keeps testing it.' },
    ]);
  });
});

describe('draft and check schemas', () => {
  it('accept the recorded answer shapes and refuse others', () => {
    expect(draftSchema.safeParse({ hook: part('h'), body: [part('b')], closer: part('c') }).success).toBe(true);
    expect(draftSchema.safeParse({ hook: part('h'), body: [part('b')] }).success).toBe(false);
    const verdict = { id: 1, kind: 'fact', supported: true, sources: ['S1'], problem: '' };
    expect(checkSchema.safeParse({ sentences: [verdict] }).success).toBe(true);
    expect(checkSchema.safeParse({ sentences: [{ ...verdict, kind: 'opinion' }] }).success).toBe(false);
    expect(checkSchema.safeParse({ sentences: [{ ...verdict, id: 1.5 }] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/enrich/context.test.ts tests/enrich/draft.test.ts`
Expected: FAIL, because `../../src/enrich/context.js` and `../../src/enrich/draft.js` do not exist.

- [ ] **Step 3: Implement**

Create `src/enrich/context.ts`:

```ts
import type { SourceInput } from '../verify/source-policy.js';
import type { WikipediaArticle } from './wikipedia.js';

/** Sections that list references, links or adaptations instead of saying anything about the author or the work. */
export const DROPPED_SECTIONS = [
  'See also',
  'Notes',
  'References',
  'Sources',
  'Further reading',
  'External links',
  'Works cited',
  'Bibliography',
  'Adaptations',
  'Citations',
  'Footnotes',
] as const;

/** Shorter lines are captions, list entries or stray headings, not paragraphs worth citing. */
export const MIN_PARAGRAPH_CHARS = 40;

export interface SourceParagraph {
  /** The label the writer and the checker cite: S1, S2, ... */
  id: string;
  article: WikipediaArticle;
  /** The section heading ("Lead" before the first one), with any subsection after " / ". */
  section: string;
  text: string;
}

const HEADING = /^(={2,})\s*(.*?)\s*\1$/;

/**
 * An article's paragraphs in order, with their sections, until the next paragraph would take the total
 * past `maxChars`. The extracts API puts one paragraph on a line and headings as "== Name ==" (deeper
 * levels with more "="). Dropped sections and their subsections are skipped, and so are short lines.
 */
export function articleParagraphs(article: WikipediaArticle, maxChars: number): Omit<SourceParagraph, 'id'>[] {
  const dropped = new Set<string>(DROPPED_SECTIONS.map((name) => name.toLowerCase()));
  const paragraphs: Omit<SourceParagraph, 'id'>[] = [];
  let top = 'Lead';
  let section = 'Lead';
  let dropping = false;
  let used = 0;
  for (const raw of article.extract.split('\n')) {
    const line = raw.trim();
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const name = heading[2] ?? '';
      if ((heading[1] ?? '').length === 2) {
        top = name;
        section = name;
        dropping = dropped.has(name.toLowerCase());
      } else {
        section = `${top} / ${name}`;
      }
      continue;
    }
    if (dropping || line.length < MIN_PARAGRAPH_CHARS) continue;
    if (used + line.length > maxChars) break;
    used += line.length;
    paragraphs.push({ article, section, text: line });
  }
  return paragraphs;
}

/** Labels the paragraphs of every article S1, S2, ... in order. */
export function labelParagraphs(groups: readonly Omit<SourceParagraph, 'id'>[][]): SourceParagraph[] {
  return groups.flat().map((paragraph, i) => ({ id: `S${i + 1}`, ...paragraph }));
}

/** How a paragraph is shown to the writer and the checker. */
export function formatParagraph(paragraph: SourceParagraph): string {
  return `[${paragraph.id}] (${paragraph.article.title}: ${paragraph.section}) ${paragraph.text}`;
}

/** A paragraph as a stored source: tier 3 reference (spec section 8), the revision's permanent link, the paragraph as the excerpt. */
export function paragraphSource(paragraph: SourceParagraph): SourceInput {
  const where = paragraph.section === 'Lead' ? 'lead section' : `section "${paragraph.section}"`;
  return {
    tier: 3,
    url: paragraph.article.url,
    citation: `Wikipedia, "${paragraph.article.title}", ${where}, revision ${paragraph.article.revid}`,
    excerpt: paragraph.text,
  };
}
```

Create `src/enrich/draft.ts`:

```ts
import { z } from 'zod';

/** One part of a draft: its text and the labels (S1, S2, ...) of the source paragraphs its facts come from. */
export const draftPartSchema = z.object({ text: z.string(), sources: z.array(z.string()) });

/** The writer's structured output: the platform-neutral post (spec section 5). */
export const draftSchema = z.object({ hook: draftPartSchema, body: z.array(draftPartSchema), closer: draftPartSchema });

/** The fact checker's structured output: one verdict per numbered sentence of the draft. */
export const checkSchema = z.object({
  sentences: z.array(
    z.object({
      id: z.number().int(),
      kind: z.enum(['fact', 'interpretation', 'other']),
      supported: z.boolean(),
      sources: z.array(z.string()),
      problem: z.string(),
    }),
  ),
});

export type DraftPart = z.infer<typeof draftPartSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type Check = z.infer<typeof checkSchema>;

export interface NamedPart {
  /** "hook", "body paragraph 1", ..., "closer" */
  name: string;
  part: DraftPart;
}

export function draftParts(draft: Draft): NamedPart[] {
  return [
    { name: 'hook', part: draft.hook },
    ...draft.body.map((part, i) => ({ name: `body paragraph ${i + 1}`, part })),
    { name: 'closer', part: draft.closer },
  ];
}

const SENTENCES = new Intl.Segmenter('en', { granularity: 'sentence' });
/** A segment ending like this stopped at an abbreviation or an initial, not at the end of a sentence. */
const ABBREVIATION_END = /(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|St|Messrs|Mme|Mlle|Col|Capt|Gen|Rev|Hon|Esq|Jr|Sr|Mt|No|Vol|Ch|ca?|vs|[A-Z])\.$/;

/** The sentences of a text, keeping "Mr. Dickens" and "J. M. W. Turner" whole. */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let carry = '';
  for (const { segment } of SENTENCES.segment(text)) {
    carry += segment;
    if (ABBREVIATION_END.test(carry.trimEnd())) continue;
    if (carry.trim() !== '') sentences.push(carry.trim());
    carry = '';
  }
  if (carry.trim() !== '') sentences.push(carry.trim());
  return sentences;
}

export interface DraftSentence {
  /** 1-based, across the whole draft. */
  n: number;
  part: string;
  text: string;
}

/** Every sentence of the draft in order, numbered as the checker sees them. */
export function draftSentences(draft: Draft): DraftSentence[] {
  let n = 0;
  return draftParts(draft).flatMap(({ name, part }) => splitSentences(part.text).map((text) => ({ n: ++n, part: name, text })));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/enrich/context.test.ts tests/enrich/draft.test.ts`
Expected: PASS, 4 and 5 tests.

Run: `npx vitest run` and `npx tsc --noEmit -p .`
Expected: 499 tests pass across 33 files; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/enrich/context.ts src/enrich/draft.ts tests/enrich/context.test.ts tests/enrich/draft.test.ts
git commit -m "feat(enrich): labelled Wikipedia paragraphs as tier 3 sources, draft and check schemas, sentence splitting

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task N3: Draft gates

**Files:**
- Create: `src/enrich/gates.ts`
- Test: `tests/enrich/gates.test.ts` (new)

**Interfaces:**
- **Consumes:** `normalizeText` from `src/verify/normalize.ts`; `unsupportedNumbers` from `src/verify/numbers.ts`; `SourceParagraph` and `labelParagraphs` (N2); `draftParts`, `splitSentences`, `draftSentences`, `Draft`, `Check`, `DraftSentence` (N2); `loadConfig` (test only).
- **Produces:**
  - `export interface Range { min: number; max: number }` and `export interface PostShape { hook: Range; body: Range; closer: Range }`
  - `parseShapeRange(text): Range` and `parsePostShape(shape: { hook: string; body: string; closer: string }): PostShape`
  - `shapeProblems(draft, shape, labels: ReadonlySet<string>, quotation): string[]`
  - `citedParagraphs(draft, paragraphs): SourceParagraph[]`
  - `numberProblems(draft, quotation, cited): string[]`
  - `checkProblems(check, sentences): string[]`
- **Used by:** N6.

**Why:**

- **Problems are sentences a person and a model can read.** The same strings go to the reviser (N6) and are stored for review (N4), so each names the sentence or part and what is wrong.
- **Program checks first.** The shape and label checks and the §8 numbers check need no model and cannot be talked out of a verdict. The checker's verdicts are read strictly: a sentence it skipped or judged twice is a problem.

- [ ] **Step 1: Write the failing tests**

Create `tests/enrich/gates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.js';
import { labelParagraphs, type SourceParagraph } from '../../src/enrich/context.js';
import { draftSentences, type Check, type Draft } from '../../src/enrich/draft.js';
import { checkProblems, citedParagraphs, numberProblems, parsePostShape, parseShapeRange, shapeProblems } from '../../src/enrich/gates.js';
import type { WikipediaArticle } from '../../src/enrich/wikipedia.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const QUOTE = 'A wonderful fact to reflect upon, that every human creature is constituted to be that profound secret and mystery to every other.';
const SHAPE = parsePostShape({ hook: '1 sentence', body: '2-4 short paragraphs', closer: '1 sentence pointing back to the work itself' });

const ARTICLE: WikipediaArticle = {
  title: 'A Tale of Two Cities',
  qid: 'Q308918',
  revid: 1374830091,
  extract: '',
  url: 'https://en.wikipedia.org/w/index.php?title=A_Tale_of_Two_Cities&oldid=1374830091',
  fetchedAt: '2026-09-15T00:00:00.000Z',
};
const PARAGRAPHS: SourceParagraph[] = labelParagraphs([
  [
    { article: ARTICLE, section: 'Lead', text: 'A Tale of Two Cities is an 1859 historical novel by Charles Dickens, set in London and Paris.' },
    { article: ARTICLE, section: 'Synopsis', text: 'Doctor Manette was imprisoned in the Bastille for 18 years.' },
    { article: ARTICLE, section: 'Background', text: 'Dickens published the novel in weekly instalments in All the Year Round.' },
  ],
]);
const LABELS = new Set(PARAGRAPHS.map((p) => p.id));

const part = (text: string, sources: string[]) => ({ text, sources });
const CLEAN: Draft = {
  hook: part('Dickens set this reflection in a novel full of secrets.', ['S1']),
  body: [part('Dickens published the novel in 1859. It is set in London and Paris.', ['S1', 'S3']), part('The line reads privacy as a condition.', [])],
  closer: part('Doctor Manette spends 18 years in the Bastille.', ['S2']),
};

describe('parseShapeRange and parsePostShape', () => {
  it('reads the count a post_shape entry starts with', () => {
    expect(parseShapeRange('1 sentence')).toEqual({ min: 1, max: 1 });
    expect(parseShapeRange('2-4 short paragraphs')).toEqual({ min: 2, max: 4 });
    expect(parseShapeRange('3\u20135 short paragraphs')).toEqual({ min: 3, max: 5 });
    expect(parseShapeRange('1 question')).toEqual({ min: 1, max: 1 });
  });

  it.each(['one sentence', '4-2 paragraphs', '0 sentences'])('refuses "%s"', (entry) => {
    expect(() => parseShapeRange(entry)).toThrow('post_shape entry');
  });

  it('reads the post shape of every configured vertical', () => {
    for (const vertical of loadConfig(ROOT).verticals) expect(() => parsePostShape(vertical.post_shape)).not.toThrow();
  });
});

describe('shapeProblems', () => {
  it('finds nothing wrong with a draft of the right shape', () => {
    expect(shapeProblems(CLEAN, SHAPE, LABELS, QUOTE)).toEqual([]);
  });

  it('reports wrong counts, empty parts, unknown labels and a repeated quotation', () => {
    const draft: Draft = {
      hook: part('It is a novel. It has secrets.', ['S1', 'S9', 'S9']),
      body: [part(`As he wrote: "${QUOTE.toUpperCase()}"`, ['S1'])],
      closer: part('  ', []),
    };
    expect(shapeProblems(draft, SHAPE, LABELS, QUOTE)).toEqual([
      'the hook has 2 sentences; the post shape allows 1',
      'the body has 1 paragraph; the post shape allows 2 to 4',
      'the closer has 0 sentences; the post shape allows 1',
      'the hook cites S9, which is not one of the source paragraphs',
      'the closer is empty',
      'the draft repeats the whole quotation, which the post already shows',
    ]);
  });
});

describe('citedParagraphs and numberProblems', () => {
  it('returns the cited paragraphs once each, in source order', () => {
    expect(citedParagraphs(CLEAN, PARAGRAPHS).map((p) => p.id)).toEqual(['S1', 'S2', 'S3']);
  });

  it('accepts numbers in the quotation or a cited paragraph and reports the rest', () => {
    expect(numberProblems(CLEAN, QUOTE, citedParagraphs(CLEAN, PARAGRAPHS))).toEqual([]);
    const draft: Draft = { ...CLEAN, closer: part('Manette spends 18 years in the Bastille, across 45 chapters.', ['S2']) };
    expect(numberProblems(draft, QUOTE, citedParagraphs(draft, PARAGRAPHS))).toEqual([
      'the number 45 is not in the quotation or in any cited source paragraph',
    ]);
    expect(numberProblems(draft, QUOTE, PARAGRAPHS.slice(0, 1))).toEqual([
      'the number 18 is not in the quotation or in any cited source paragraph',
      'the number 45 is not in the quotation or in any cited source paragraph',
    ]);
  });
});

describe('checkProblems', () => {
  const sentences = draftSentences(CLEAN);
  const verdict = (id: number, supported = true, problem = '') => ({ id, kind: 'fact' as const, supported, sources: supported ? ['S1'] : [], problem });

  it('finds nothing when every sentence is supported', () => {
    expect(checkProblems({ sentences: sentences.map((s) => verdict(s.n)) }, sentences)).toEqual([]);
  });

  it('reports unsupported sentences with the detail, and any sentence not judged exactly once', () => {
    const check: Check = {
      sentences: [verdict(1), verdict(2, false, 'the year is not in the cited paragraph'), verdict(3, false, ' '), verdict(4), verdict(4), verdict(9)],
    };
    expect(checkProblems(check, sentences)).toEqual([
      '"Dickens published the novel in 1859." is not supported by the source paragraphs: the year is not in the cited paragraph',
      '"It is set in London and Paris." is not supported by the source paragraphs: the fact check gave no detail',
      'the fact check gave 2 verdicts for "The line reads privacy as a condition."',
      'the fact check gave 0 verdicts for "Doctor Manette spends 18 years in the Bastille."',
      'the fact check judged a sentence 9, which the draft does not have',
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/enrich/gates.test.ts`
Expected: FAIL, because `../../src/enrich/gates.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/enrich/gates.ts`:

```ts
import { normalizeText } from '../verify/normalize.js';
import { unsupportedNumbers } from '../verify/numbers.js';
import type { SourceParagraph } from './context.js';
import { draftParts, splitSentences, type Check, type Draft, type DraftSentence } from './draft.js';

export interface Range {
  min: number;
  max: number;
}

/** The counts a vertical's post_shape allows: sentences in the hook and closer, paragraphs in the body. */
export interface PostShape {
  hook: Range;
  body: Range;
  closer: Range;
}

const LEADING_RANGE = /^\s*(\d+)(?:\s*[-\u2013]\s*(\d+))?(?!\d)/;

/** The count a post_shape entry starts with: "1 sentence" is 1 to 1, "2-4 short paragraphs" is 2 to 4. */
export function parseShapeRange(text: string): Range {
  const match = LEADING_RANGE.exec(text);
  if (match === null) throw new Error(`post_shape entry "${text}" does not start with a count such as "1" or "2-4"`);
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  if (min < 1 || max < min) throw new Error(`post_shape entry "${text}" is not a usable range`);
  return { min, max };
}

export function parsePostShape(shape: { hook: string; body: string; closer: string }): PostShape {
  return { hook: parseShapeRange(shape.hook), body: parseShapeRange(shape.body), closer: parseShapeRange(shape.closer) };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const allowed = (range: Range) => (range.min === range.max ? `${range.min}` : `${range.min} to ${range.max}`);
const outside = (n: number, range: Range) => n < range.min || n > range.max;

/**
 * Problems a program can see without a model: a part with the wrong number of sentences or paragraphs,
 * an empty part, a label that is not one of the source paragraphs, and the whole quotation repeated
 * (the post shows it separately).
 */
export function shapeProblems(draft: Draft, shape: PostShape, labels: ReadonlySet<string>, quotation: string): string[] {
  const problems: string[] = [];
  const hook = splitSentences(draft.hook.text).length;
  if (outside(hook, shape.hook)) problems.push(`the hook has ${plural(hook, 'sentence', 'sentences')}; the post shape allows ${allowed(shape.hook)}`);
  if (outside(draft.body.length, shape.body)) {
    problems.push(`the body has ${plural(draft.body.length, 'paragraph', 'paragraphs')}; the post shape allows ${allowed(shape.body)}`);
  }
  const closer = splitSentences(draft.closer.text).length;
  if (outside(closer, shape.closer)) {
    problems.push(`the closer has ${plural(closer, 'sentence', 'sentences')}; the post shape allows ${allowed(shape.closer)}`);
  }
  for (const { name, part } of draftParts(draft)) {
    if (part.text.trim() === '') problems.push(`the ${name} is empty`);
    for (const label of new Set(part.sources)) {
      if (!labels.has(label)) problems.push(`the ${name} cites ${label}, which is not one of the source paragraphs`);
    }
  }
  const quote = normalizeText(quotation);
  const text = normalizeText(draftParts(draft).map(({ part }) => part.text).join(' '));
  if (quote.length > 0 && text.includes(quote)) problems.push('the draft repeats the whole quotation, which the post already shows');
  return problems;
}

/** The source paragraphs the draft cites, in source order. */
export function citedParagraphs(draft: Draft, paragraphs: readonly SourceParagraph[]): SourceParagraph[] {
  const cited = new Set(draftParts(draft).flatMap(({ part }) => part.sources));
  return paragraphs.filter((paragraph) => cited.has(paragraph.id));
}

/** Numbers in the draft that are neither in the quotation nor in a cited paragraph (spec section 8, applied to every vertical). */
export function numberProblems(draft: Draft, quotation: string, cited: readonly SourceParagraph[]): string[] {
  const text = draftParts(draft)
    .map(({ part }) => part.text)
    .join('\n');
  return unsupportedNumbers(text, [quotation, ...cited.map((paragraph) => paragraph.text)]).map(
    (n) => `the number ${n} is not in the quotation or in any cited source paragraph`,
  );
}

/** Sentences the checker found unsupported, and any sentence it did not judge exactly once (fail closed). */
export function checkProblems(check: Check, sentences: readonly DraftSentence[]): string[] {
  const problems: string[] = [];
  for (const sentence of sentences) {
    const verdicts = check.sentences.filter((verdict) => verdict.id === sentence.n);
    const verdict = verdicts[0];
    if (verdict === undefined || verdicts.length > 1) {
      problems.push(`the fact check gave ${verdicts.length} verdicts for "${sentence.text}"`);
    } else if (!verdict.supported) {
      problems.push(`"${sentence.text}" is not supported by the source paragraphs: ${verdict.problem.trim() || 'the fact check gave no detail'}`);
    }
  }
  const numbers = new Set(sentences.map((sentence) => sentence.n));
  for (const id of new Set(check.sentences.map((verdict) => verdict.id))) {
    if (!numbers.has(id)) problems.push(`the fact check judged a sentence ${id}, which the draft does not have`);
  }
  return problems;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/enrich/gates.test.ts`
Expected: PASS, 11 tests.

Run: `npx vitest run` and `npx tsc --noEmit -p .`
Expected: 510 tests pass across 34 files; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/enrich/gates.ts tests/enrich/gates.test.ts
git commit -m "feat(enrich): draft gates for post shape, labels, repeated quotations, numbers and fact-check verdicts

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task N4: Post rounds and post sources

**Files:**
- Create: `migrations/007_post_rounds.sql`, `src/db/posts.ts`
- Test: `tests/db/posts.test.ts` (new)

**Interfaces:**
- **Consumes:** `insertSource` from `src/db/sources.ts`; `SourceInput` from `src/verify/source-policy.ts`; in tests, `insertHarvestedQuote` and `upsertAuthorSubject` from `src/db/quotes.ts` and `verifyVertical` from `src/verify/run.ts`.
- **Produces:**
  - `export interface ItemToEnrich { itemId: number; subjectId: number; body: string; workTitle: string; author: string; wikidataId: string }`
  - `export function itemsToEnrich(db: Db, verticalId: number, limit: number): ItemToEnrich[]`
  - `export interface PostRound { round: 1 | 2; draft: unknown; check: unknown; problems: string[]; writerModel: string; checkerModel: string }`
  - `export interface PostSource { label: string; source: SourceInput; retrievedAt: Date }`
  - `export interface NewPost { itemId; verticalId; hook; body; closer; altText; status: 'draft' | 'needs_review'; rounds: PostRound[]; sources: PostSource[] }`
  - `export class PostRuleError extends Error`
  - `export function insertPost(db: Db, post: NewPost, now?: Date): number`
- **Used by:** N6.

**Why:**

- **Review needs the whole story (user decision).** `post_rounds` keeps each round's draft, check and problems; `post_sources` keeps which stored source each label meant.
- **The post row obeys the rules itself.** `insertPost` refuses a post for a quote that is not verified (§2.1) and a `draft` whose last round has problems (§2.6), inside the transaction, so no caller can store a post that skipped the gates.
- **Sources are item evidence (§2.2).** Cited paragraphs are inserted through `insertSource`, so the source policy applies (Wikipedia can only ever be tier 3).

- [ ] **Step 1: Write the failing tests**

Create `tests/db/posts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { insertPost, itemsToEnrich, PostRuleError, type NewPost } from '../../src/db/posts.js';
import { insertHarvestedQuote, upsertAuthorSubject } from '../../src/db/quotes.js';
import { insertSource } from '../../src/db/sources.js';
import type { HarvestAuthor } from '../../src/harvest/gutendex.js';
import type { QuoteEvidence } from '../../src/verify/quote-gate.js';
import { verifyVertical } from '../../src/verify/run.js';
import { testDb } from '../helpers/db.js';

const NOW = () => new Date('2026-09-15T00:00:00.000Z');
const DICKENS: HarvestAuthor = { name: 'Charles Dickens', gutendex_name: 'Dickens, Charles', wikidata_id: 'Q5686', birth_year: 1812, death_year: 1870 };
const AUSTEN: HarvestAuthor = { name: 'Jane Austen', gutendex_name: 'Austen, Jane', wikidata_id: 'Q36322', birth_year: 1775, death_year: 1817 };
const URL_S1 = 'https://en.wikipedia.org/w/index.php?title=Charles_Dickens&oldid=1371883001';

function setup() {
  const db = testDb();
  const verticalId = Number(
    db.prepare("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'Literature', 'config/verticals/literature.yaml')").run()
      .lastInsertRowid,
  );
  const quote = (author: HarvestAuthor, body: string, workTitle: string, verified = true) => {
    const subjectId = upsertAuthorSubject(db, verticalId, author, NOW());
    const evidence: QuoteEvidence[] = verified
      ? [
          {
            kind: 'primary-text',
            citation: `${author.name}, ${workTitle} (Project Gutenberg)`,
            url: 'https://www.gutenberg.org/ebooks/98.txt.utf-8',
            excerpt: body,
            location: 'characters 10-140 after the Project Gutenberg header',
            authorMatches: true,
          },
        ]
      : [{ kind: 'reference', citation: `Wikiquote, ${author.name}`, url: 'https://en.wikiquote.org/wiki/Charles_Dickens' }];
    return insertHarvestedQuote(
      db,
      { verticalId, subjectId, author: author.name, body, workTitle, evidence, wikiquotePage: author.name, wikiquoteCheckedAt: NOW().toISOString() },
      NOW(),
    ).itemId;
  };
  return { db, verticalId, quote };
}

const round = (problems: string[] = []) => ({
  round: 1 as const,
  draft: { hook: { text: 'A hook.', sources: ['S1'] }, body: [], closer: { text: 'A closer.', sources: [] } },
  check: { sentences: [] },
  problems,
  writerModel: 'claude-opus-5',
  checkerModel: 'claude-sonnet-5',
});

const post = (itemId: number, verticalId: number, overrides: Partial<NewPost> = {}): NewPost => ({
  itemId,
  verticalId,
  hook: 'A hook.',
  body: 'First paragraph.\n\nSecond paragraph.',
  closer: 'A closer.',
  altText: 'Quotation from A Tale of Two Cities by Charles Dickens: "..."',
  status: 'draft',
  rounds: [round()],
  sources: [
    {
      label: 'S1',
      source: { tier: 3, url: URL_S1, citation: 'Wikipedia, "Charles Dickens", lead section, revision 1371883001', excerpt: 'Charles Dickens was an English novelist.' },
      retrievedAt: new Date('2026-09-14T00:00:00.000Z'),
    },
    {
      label: 'S7',
      source: { tier: 3, url: URL_S1, citation: 'Wikipedia, "Charles Dickens", section "Early life", revision 1371883001', excerpt: 'Dickens was born in Portsmouth.' },
      retrievedAt: new Date('2026-09-14T00:00:00.000Z'),
    },
  ],
  ...overrides,
});

describe('itemsToEnrich', () => {
  it('lists verified quotes without a post, every author taking a turn before anyone gets a second', () => {
    const { db, verticalId, quote } = setup();
    const d1 = quote(DICKENS, 'It was the best of times, it was the worst of times, it was the age of wisdom.', 'A Tale of Two Cities');
    const d2 = quote(DICKENS, 'There is a wisdom of the head, and a wisdom of the heart, and they are not the same.', 'Hard Times');
    quote(DICKENS, 'This passage has only a reference behind it and will be rejected by verify.', 'Hard Times', false);
    const a1 = quote(AUSTEN, 'It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.', 'Pride and Prejudice');
    verifyVertical(db, verticalId, { now: NOW });

    expect(itemsToEnrich(db, verticalId, 10).map((i) => i.itemId)).toEqual([d1, a1, d2]);
    expect(itemsToEnrich(db, verticalId, 2)[1]).toEqual({
      itemId: a1,
      subjectId: expect.any(Number),
      body: 'It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.',
      workTitle: 'Pride and Prejudice',
      author: 'Jane Austen',
      wikidataId: 'Q36322',
    });

    insertPost(db, post(d1, verticalId), NOW());
    expect(itemsToEnrich(db, verticalId, 10).map((i) => i.itemId)).toEqual([d2, a1]);
  });
});

describe('insertPost', () => {
  it('stores the post, its rounds and its cited paragraphs as tier 3 sources linked by label', () => {
    const { db, verticalId, quote } = setup();
    const itemId = quote(DICKENS, 'It was the best of times, it was the worst of times, it was the age of wisdom.', 'A Tale of Two Cities');
    verifyVertical(db, verticalId, { now: NOW });
    const existing = insertSource(db, itemId, post(itemId, verticalId).sources[0]!.source, NOW());

    const postId = insertPost(db, post(itemId, verticalId, { status: 'needs_review', rounds: [round(['a problem']), { ...round(), round: 2 }] }), NOW());

    expect(db.prepare('SELECT item_id, hook, body, closer, status, created_at FROM posts WHERE id = ?').get(postId)).toEqual({
      item_id: itemId,
      hook: 'A hook.',
      body: 'First paragraph.\n\nSecond paragraph.',
      closer: 'A closer.',
      status: 'needs_review',
      created_at: '2026-09-15T00:00:00.000Z',
    });
    const linked = db.prepare('SELECT label, source_id FROM post_sources WHERE post_id = ? ORDER BY label').all(postId) as { label: string; source_id: number }[];
    expect(linked.map((l) => l.label)).toEqual(['S1', 'S7']);
    expect(linked[0]!.source_id).toBe(existing);
    expect(db.prepare('SELECT tier, retrieved_at FROM sources WHERE id = ?').get(linked[1]!.source_id)).toEqual({ tier: 3, retrieved_at: '2026-09-14T00:00:00.000Z' });
    expect(db.prepare('SELECT COUNT(*) FROM sources WHERE item_id = ?').pluck().get(itemId)).toBe(3);
    const rounds = db.prepare('SELECT round, draft_json, check_json, problems_json, writer_model, checker_model FROM post_rounds WHERE post_id = ? ORDER BY round').all(postId) as {
      round: number;
      draft_json: string;
      check_json: string;
      problems_json: string;
      writer_model: string;
      checker_model: string;
    }[];
    expect(rounds.map((r) => [r.round, JSON.parse(r.problems_json), r.writer_model, r.checker_model])).toEqual([
      [1, ['a problem'], 'claude-opus-5', 'claude-sonnet-5'],
      [2, [], 'claude-opus-5', 'claude-sonnet-5'],
    ]);
    expect(JSON.parse(rounds[0]!.draft_json)).toEqual(round().draft);
    expect(JSON.parse(rounds[0]!.check_json)).toEqual({ sentences: [] });
  });

  it('refuses a post for a quote that is not verified, a draft whose last round has problems, and a second post', () => {
    const { db, verticalId, quote } = setup();
    const raw = quote(DICKENS, 'This raw passage has never been decided by verify, so it cannot have a post.', 'Hard Times');
    expect(() => insertPost(db, post(raw, verticalId), NOW())).toThrow(PostRuleError);

    const itemId = quote(DICKENS, 'It was the best of times, it was the worst of times, it was the age of wisdom.', 'A Tale of Two Cities');
    verifyVertical(db, verticalId, { now: NOW });
    expect(() => insertPost(db, post(itemId, verticalId, { rounds: [round(['still unsupported'])] }), NOW())).toThrow(
      'a draft post cannot have problems in its last round',
    );
    expect(() => insertPost(db, post(itemId, verticalId, { rounds: [] }), NOW())).toThrow('a post needs at least one round');
    expect(db.prepare('SELECT COUNT(*) FROM posts').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM sources WHERE tier = 3').pluck().get()).toBe(0);

    insertPost(db, post(itemId, verticalId), NOW());
    expect(() => insertPost(db, post(itemId, verticalId), NOW())).toThrow(/UNIQUE/);
    expect(db.prepare('SELECT COUNT(*) FROM post_sources').pluck().get()).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/posts.test.ts`
Expected: FAIL, because `../../src/db/posts.js` does not exist.

- [ ] **Step 3: Implement**

Create `migrations/007_post_rounds.sql`:

```sql
-- Enrichment state behind each post (spec section 7, lantern enrich).

-- One writing round of a post: the draft the writer returned, the fact check of it, and every
-- problem the gates found. Round 2 exists only when round 1 had problems: the writer gets one
-- revision (user decision 2026-09-15), and both rounds stay visible in review.
CREATE TABLE post_rounds (
  id             INTEGER PRIMARY KEY,
  post_id        INTEGER NOT NULL REFERENCES posts(id),
  round          INTEGER NOT NULL CHECK (round IN (1, 2)),
  draft_json     TEXT NOT NULL,
  check_json     TEXT NOT NULL,
  problems_json  TEXT NOT NULL,     -- JSON array of strings; empty when the round passed every gate
  writer_model   TEXT NOT NULL,
  checker_model  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE(post_id, round)
);

-- The stored sources a post's drafts cite, under the label the drafts use (S1, S2, ...).
CREATE TABLE post_sources (
  id         INTEGER PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES posts(id),
  source_id  INTEGER NOT NULL REFERENCES sources(id),
  label      TEXT NOT NULL CHECK (length(trim(label)) > 0),
  UNIQUE(post_id, label),
  UNIQUE(post_id, source_id)
);
```

Create `src/db/posts.ts`:

```ts
import type { SourceInput } from '../verify/source-policy.js';
import type { Db } from './connection.js';
import { insertSource } from './sources.js';

export interface ItemToEnrich {
  itemId: number;
  subjectId: number;
  body: string;
  workTitle: string;
  author: string;
  wikidataId: string;
}

/**
 * Verified quotes in a vertical with no post yet, at most `limit`, with their author. Subjects take
 * turns: every subject's oldest waiting quote comes before any subject's second, so a small limit still
 * mixes authors. Quotes without a work title or an author Wikidata id cannot be given sources and are
 * not returned; harvest always records both.
 */
export function itemsToEnrich(db: Db, verticalId: number, limit: number): ItemToEnrich[] {
  return db
    .prepare(
      `SELECT itemId, subjectId, body, workTitle, author, wikidataId FROM (
         SELECT i.id AS itemId, s.id AS subjectId, i.body AS body, i.work_title AS workTitle, s.name AS author, s.wikidata_id AS wikidataId,
                ROW_NUMBER() OVER (PARTITION BY i.subject_id ORDER BY i.id) AS turn
         FROM items i JOIN subjects s ON s.id = i.subject_id
         WHERE i.vertical_id = ? AND i.kind = 'quote' AND i.status = 'verified'
           AND i.work_title IS NOT NULL AND s.wikidata_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.item_id = i.id)
       )
       ORDER BY turn, subjectId, itemId
       LIMIT ?`,
    )
    .all(verticalId, limit) as ItemToEnrich[];
}

export interface PostRound {
  round: 1 | 2;
  draft: unknown;
  check: unknown;
  /** Every problem the gates found in this round; empty when it passed. */
  problems: string[];
  writerModel: string;
  checkerModel: string;
}

export interface PostSource {
  /** The label the drafts cite it by (S1, S2, ...). */
  label: string;
  source: SourceInput;
  retrievedAt: Date;
}

export interface NewPost {
  itemId: number;
  verticalId: number;
  hook: string;
  /** Body paragraphs separated by a blank line. */
  body: string;
  closer: string;
  altText: string;
  status: 'draft' | 'needs_review';
  rounds: PostRound[];
  sources: PostSource[];
}

/** A post that would break the enrichment rules: nothing was written. */
export class PostRuleError extends Error {
  override name = 'PostRuleError';
}

/**
 * Inserts a post with its rounds and cited sources in one transaction. The quote must be verified
 * (spec section 2.1), and a 'draft' post's last round must have no problems (spec section 2.6). Each
 * cited paragraph becomes a source of the quote (spec section 2.2: every claim traces to a stored
 * source), reusing an identical source row the quote already has, and is linked to the post under its
 * label.
 */
export function insertPost(db: Db, post: NewPost, now: Date = new Date()): number {
  return db.transaction((): number => {
    const status = db.prepare('SELECT status FROM items WHERE id = ?').pluck().get(post.itemId) as string | undefined;
    if (status !== 'verified') throw new PostRuleError(`item ${post.itemId} is ${status ?? 'missing'}, not verified`);
    const last = post.rounds[post.rounds.length - 1];
    if (last === undefined) throw new PostRuleError('a post needs at least one round');
    if (post.status === 'draft' && last.problems.length > 0) throw new PostRuleError('a draft post cannot have problems in its last round');

    const postId = Number(
      db
        .prepare('INSERT INTO posts (item_id, vertical_id, hook, body, closer, alt_text, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(post.itemId, post.verticalId, post.hook, post.body, post.closer, post.altText, post.status, now.toISOString()).lastInsertRowid,
    );
    const existing = db
      .prepare('SELECT id FROM sources WHERE item_id = ? AND tier = ? AND url IS ? AND citation = ? AND excerpt IS ? ORDER BY id LIMIT 1')
      .pluck();
    const link = db.prepare('INSERT INTO post_sources (post_id, source_id, label) VALUES (?, ?, ?)');
    for (const { label, source, retrievedAt } of post.sources) {
      const found = existing.get(post.itemId, source.tier, source.url ?? null, source.citation, source.excerpt ?? null) as number | undefined;
      link.run(postId, found ?? insertSource(db, post.itemId, source, retrievedAt), label);
    }
    const round = db.prepare(
      'INSERT INTO post_rounds (post_id, round, draft_json, check_json, problems_json, writer_model, checker_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of post.rounds) {
      round.run(postId, r.round, JSON.stringify(r.draft), JSON.stringify(r.check), JSON.stringify(r.problems), r.writerModel, r.checkerModel, now.toISOString());
    }
    return postId;
  })();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/db/posts.test.ts tests/db tests/doctor`
Expected: PASS; `tests/db/posts.test.ts` has 3 tests, and the migration and doctor tests still pass with 007 applied.

Run: `npx vitest run` and `npx tsc --noEmit -p .`
Expected: 513 tests pass across 35 files; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add migrations/007_post_rounds.sql src/db/posts.ts tests/db/posts.test.ts
git commit -m "feat(db): post rounds and post sources, quotes waiting for a post, one-transaction post insert

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task N5: Enrich config, prompts and model adapters

**Files:**
- Modify: `src/config/schema.ts`, `config/verticals/literature.yaml`
- Create: `prompts/literature/enrich.md`, `prompts/literature/revise.md`, `prompts/shared/fact-check.md`, `src/enrich/messages.ts`, `src/enrich/anthropic.ts`
- Test: `tests/config/enrich-config.test.ts`, `tests/enrich/messages.test.ts`, `tests/enrich/anthropic.test.ts` (new)

**Interfaces:**
- **Consumes:** `VerticalConfig` from `src/config/schema.ts`; `formatParagraph` and `SourceParagraph` (N2); `Draft`, `DraftSentence`, `draftSchema`, `checkSchema` (N2); `zodOutputFormat` from `@anthropic-ai/sdk/helpers/zod`.
- **Produces:**
  - `schema.ts`: `export const enrichSchema` (`writer_model`, `checker_model`, `author_article_chars`, `work_article_chars`), `enrich: enrichSchema.optional()` on the vertical, `export type EnrichConfig`
  - `messages.ts`: `export type VerticalVoice = Pick<VerticalConfig, 'voice' | 'post_shape' | 'banned_topics'>`, `export interface QuoteContext { body; author; workTitle }`, `fillPrompt(template, vertical): string`, `writerMessage(quote, paragraphs): string`, `reviseMessage(quote, paragraphs, draft, problems): string`, `checkerMessage(quote, cited, sentences): string`
  - `anthropic.ts`: `export interface EnrichPrompts { write; revise; check }`, `enrichPromptPaths(verticalSlug): EnrichPrompts`, `loadEnrichPrompts(root, verticalSlug): EnrichPrompts`, `export interface ModelAnswer { value: unknown; model: string; inputTokens: number; outputTokens: number }`, `export type ModelFn = (system: string, user: string) => Promise<ModelAnswer>`, `export class EnrichResponseError extends Error`, `export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'`, `anthropicWriter(client, model): ModelFn`, `anthropicChecker(client, model): ModelFn`
- **Used by:** N6 and N7.

**Why:**

- **Models are config (user decision).** `claude-opus-5` writes and `claude-sonnet-5` checks; the article budgets are the probed 30000 and 18000 characters.
- **The writer's request** follows the `claude-api` skill for Opus 5:
  - structured output from `draftSchema`
  - `effort: 'medium'`
  - `max_tokens: 16000`, because thinking is on by default and shares the budget with the answer
  - server-side fallback, with the answering model read from the last `fallback` content block
- **Only an unusable answer is an `EnrichResponseError`:** a refusal, a truncated answer, or text that is not JSON. A request error (the key, the network, rate limits after the SDK's retries) propagates and stops the run, as the picker does.
- **Prompts are content (§15).** They were tuned in five live probes, and the vertical's voice, post shape and banned topics are filled in (§9). An unknown placeholder is refused, so a typo never reaches the model.

- [ ] **Step 1: Write the failing tests**

Create `tests/config/enrich-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.js';
import { enrichSchema } from '../../src/config/schema.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const valid = { writer_model: 'claude-opus-5', checker_model: 'claude-sonnet-5', author_article_chars: 30000, work_article_chars: 18000 };

describe('enrich config', () => {
  it('loads the chosen writer and checker models for literature, and no enrich section for science', () => {
    const verticals = loadConfig(ROOT).verticals;
    expect(verticals.find((v) => v.slug === 'literature')?.enrich).toEqual(valid);
    expect(verticals.find((v) => v.slug === 'science-curious')?.enrich).toBeUndefined();
  });

  it('accepts a valid enrich section', () => {
    expect(enrichSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['an empty writer model', { writer_model: '' }],
    ['an article budget under 1000 characters', { author_article_chars: 500 }],
    ['a fractional article budget', { work_article_chars: 1000.5 }],
    ['an unknown key', { extra: true }],
  ])('rejects %s', (_label, change) => {
    expect(enrichSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});
```

Create `tests/enrich/messages.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.js';
import { loadEnrichPrompts } from '../../src/enrich/anthropic.js';
import type { SourceParagraph } from '../../src/enrich/context.js';
import type { Draft } from '../../src/enrich/draft.js';
import { checkerMessage, fillPrompt, reviseMessage, writerMessage } from '../../src/enrich/messages.js';
import type { WikipediaArticle } from '../../src/enrich/wikipedia.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VOICE = { voice: '  Warm and precise.\n', post_shape: { hook: '1 sentence', body: '2-4 short paragraphs', closer: '1 question' }, banned_topics: [] };
const QUOTE = { body: 'It was the best of times.', author: 'Charles Dickens', workTitle: 'A Tale of Two Cities' };
const ARTICLE: WikipediaArticle = {
  title: 'Charles Dickens',
  qid: 'Q5686',
  revid: 1,
  extract: '',
  url: 'https://en.wikipedia.org/w/index.php?title=Charles_Dickens&oldid=1',
  fetchedAt: '2026-09-15T00:00:00.000Z',
};
const PARAGRAPHS: SourceParagraph[] = [
  { id: 'S1', article: ARTICLE, section: 'Lead', text: 'Dickens was an English novelist.' },
  { id: 'S2', article: ARTICLE, section: 'Early life', text: 'Dickens was born in Portsmouth.' },
];
const DRAFT: Draft = { hook: { text: 'A hook.', sources: ['S1'] }, body: [], closer: { text: 'A closer?', sources: [] } };

describe('fillPrompt', () => {
  it('fills the voice, the post shape and the banned topics', () => {
    expect(fillPrompt('{{voice}} | {{hook}} | {{body}} | {{closer}}\n{{banned_topics}}', VOICE)).toBe(
      'Warm and precise. | 1 sentence | 2-4 short paragraphs | 1 question\n- none',
    );
    expect(fillPrompt('{{banned_topics}}', { ...VOICE, banned_topics: ['politics', 'weapons'] })).toBe('- politics\n- weapons');
    expect(fillPrompt('{{voice}}', { ...VOICE, voice: 'Costs $1 and $& nothing.' })).toBe('Costs $1 and $& nothing.');
  });

  it('refuses an unknown placeholder', () => {
    expect(() => fillPrompt('Write in {{tone}}.', VOICE)).toThrow('prompt has an unknown placeholder {{tone}}');
  });

  it('fills every committed prompt with every configured vertical', () => {
    const prompts = loadEnrichPrompts(ROOT, 'literature');
    for (const vertical of loadConfig(ROOT).verticals) {
      for (const prompt of [prompts.write, prompts.revise, prompts.check]) expect(fillPrompt(prompt, vertical)).not.toContain('{{');
    }
  });
});

describe('model messages', () => {
  it('gives the writer the quotation, author, work and labelled paragraphs', () => {
    expect(writerMessage(QUOTE, PARAGRAPHS)).toBe(
      [
        'Quotation: It was the best of times.',
        'Author: Charles Dickens',
        'Work: A Tale of Two Cities',
        '',
        'Source paragraphs:',
        '',
        '[S1] (Charles Dickens: Lead) Dickens was an English novelist.',
        '',
        '[S2] (Charles Dickens: Early life) Dickens was born in Portsmouth.',
      ].join('\n'),
    );
  });

  it('gives the reviser the same, then the draft and the problems', () => {
    expect(reviseMessage(QUOTE, PARAGRAPHS, DRAFT, ['first problem', 'second problem'])).toBe(
      `${writerMessage(QUOTE, PARAGRAPHS)}\n\nDraft:\n${JSON.stringify(DRAFT, null, 2)}\n\nProblems the reviewer found:\n- first problem\n- second problem`,
    );
  });

  it('gives the checker only the quotation, the cited paragraphs and the numbered sentences', () => {
    const sentences = [
      { n: 1, part: 'hook', text: 'A hook.' },
      { n: 2, part: 'closer', text: 'A closer?' },
    ];
    expect(checkerMessage(QUOTE, PARAGRAPHS.slice(1), sentences)).toBe(
      [
        'Source paragraphs:',
        '',
        '[Q] (the quotation, from the book) It was the best of times.',
        '',
        '[S2] (Charles Dickens: Early life) Dickens was born in Portsmouth.',
        '',
        'Draft sentences:',
        '(1) A hook.',
        '(2) A closer?',
      ].join('\n'),
    );
  });
});
```

Create `tests/enrich/anthropic.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {
  anthropicChecker,
  anthropicWriter,
  EnrichResponseError,
  enrichPromptPaths,
  FALLBACK_BETA,
  loadEnrichPrompts,
} from '../../src/enrich/anthropic.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const message = (content: unknown[], stopReason = 'end_turn', model = 'claude-opus-5') => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model,
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 1200, output_tokens: 300 },
});
const text = (value: string) => ({ type: 'text', text: value });

/** A real HTTP server on 127.0.0.1:0 standing in for the Messages API. Replies with replies[n], repeating the last. */
async function fakeApi(replies: { status: number; body: unknown }[]) {
  const requests: { url: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(data) as Record<string, unknown> });
      const reply = replies[Math.min(requests.length, replies.length) - 1]!;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { client: new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 }), requests };
}

const DRAFT = '{"hook":{"text":"h","sources":["S1"]},"body":[],"closer":{"text":"c","sources":[]}}';

describe('anthropicWriter', () => {
  it('asks for a structured draft with server-side fallback, and returns the answer, model and token use', async () => {
    const { client, requests } = await fakeApi([{ status: 200, body: message([text(DRAFT)]) }]);
    expect(await anthropicWriter(client, 'claude-opus-5')('system prompt', 'user message')).toEqual({
      value: JSON.parse(DRAFT),
      model: 'claude-opus-5',
      inputTokens: 1200,
      outputTokens: 300,
    });
    expect(requests[0]!.headers['anthropic-beta']).toBe(FALLBACK_BETA);
    expect(requests[0]!.body).toMatchObject({
      model: 'claude-opus-5',
      fallbacks: 'default',
      max_tokens: 16000,
      system: 'system prompt',
      messages: [{ role: 'user', content: 'user message' }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } }, effort: 'medium' },
    });
    expect(requests[0]!.body).not.toHaveProperty('betas');
  });

  it('reports the fallback model when a fallback wrote the answer', async () => {
    const fallback = { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-sonnet-5' }, trigger: { type: 'refusal' } };
    const { client } = await fakeApi([{ status: 200, body: message([fallback, text(DRAFT)]) }]);
    expect((await anthropicWriter(client, 'claude-opus-5')('s', 'u')).model).toBe('claude-sonnet-5');
  });

  it('turns a refusal, a truncated answer or text that is not JSON into an EnrichResponseError', async () => {
    const { client } = await fakeApi([
      { status: 200, body: message([], 'refusal') },
      { status: 200, body: message([text('{"hook":')], 'max_tokens') },
      { status: 200, body: message([text('Here is a draft.')]) },
    ]);
    const write = anthropicWriter(client, 'claude-opus-5');
    await expect(write('s', 'u')).rejects.toThrow('the writer stopped with refusal and no usable output');
    await expect(write('s', 'u')).rejects.toThrow('the writer stopped with max_tokens and no usable output');
    await expect(write('s', 'u')).rejects.toThrow(EnrichResponseError);
  });

  it('lets API errors through so the run stops', async () => {
    const { client } = await fakeApi([{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }]);
    await expect(anthropicWriter(client, 'claude-opus-5')('s', 'u')).rejects.toThrow(Anthropic.AuthenticationError);
  });
});

describe('anthropicChecker', () => {
  it('asks for structured verdicts without the fallback beta, and returns the answer', async () => {
    const verdicts = '{"sentences":[{"id":1,"kind":"fact","supported":true,"sources":["S1"],"problem":""}]}';
    const { client, requests } = await fakeApi([
      { status: 200, body: message([text(verdicts)], 'end_turn', 'claude-sonnet-5') },
      { status: 200, body: message([text('not json')], 'end_turn', 'claude-sonnet-5') },
    ]);
    const check = anthropicChecker(client, 'claude-sonnet-5');
    expect(await check('check prompt', 'sentences')).toEqual({ value: JSON.parse(verdicts), model: 'claude-sonnet-5', inputTokens: 1200, outputTokens: 300 });
    expect(requests[0]!.headers['anthropic-beta']).toBeUndefined();
    expect(requests[0]!.body).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 16000,
      system: 'check prompt',
      output_config: { format: { type: 'json_schema' }, effort: 'medium' },
    });
    expect(requests[0]!.body).not.toHaveProperty('fallbacks');
    await expect(check('s', 'u')).rejects.toThrow("the fact check's output is not JSON");
  });
});

describe('enrich prompts', () => {
  it('loads the committed writer, reviser and fact-check prompts', () => {
    expect(enrichPromptPaths('literature')).toEqual({
      write: 'prompts/literature/enrich.md',
      revise: 'prompts/literature/revise.md',
      check: 'prompts/shared/fact-check.md',
    });
    const prompts = loadEnrichPrompts(ROOT, 'literature');
    expect(prompts.write).toContain('the source paragraphs are the only facts you have');
    expect(prompts.write).toContain('{{voice}}');
    expect(prompts.revise).toContain('{{body}}');
    expect(prompts.check).toContain('You have no other knowledge for this task.');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/config/enrich-config.test.ts tests/enrich/messages.test.ts tests/enrich/anthropic.test.ts`
Expected: FAIL, because `enrichSchema`, `../../src/enrich/messages.js` and `../../src/enrich/anthropic.js` do not exist.

- [ ] **Step 3: Implement**

Replace `src/config/schema.ts` with:

```ts
import { z } from 'zod';

export const PLATFORMS = ['facebook', 'pinterest', 'youtube', 'instagram', 'tiktok'] as const;
export const RENDITION_FORMATS = ['square', 'portrait', 'pin', 'short', 'landscape'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type RenditionFormat = (typeof RENDITION_FORMATS)[number];

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24h)');

export const harvestAuthorSchema = z
  .strictObject({
    name: z.string().min(1),
    /** Exactly as Gutendex lists the author ("Surname, Given"); matched with the years to set authorMatches. */
    gutendex_name: z.string().regex(/^[^,]+, [^,]+$/, 'must be "Surname, Given" as Gutendex lists it'),
    wikidata_id: z.string().regex(/^Q[1-9]\d*$/, 'must be a Wikidata Q-number'),
    birth_year: z.number().int(),
    death_year: z.number().int(),
  })
  .refine((a) => a.death_year >= a.birth_year, { message: 'death_year must not be before birth_year', path: ['death_year'] });

export const harvestSchema = z.strictObject({
  authors: z.array(harvestAuthorSchema).min(1),
  picker: z.strictObject({
    model: z.string().min(1),
    batch_size: z.number().int().min(10).max(500),
    max_batches_per_work: z.number().int().min(1).max(50),
    picks_per_batch: z.number().int().min(1).max(10),
  }),
});

export const enrichSchema = z.strictObject({
  /** Writes each draft and its one revision. */
  writer_model: z.string().min(1),
  /** Checks every sentence of a draft against the paragraphs it cites. */
  checker_model: z.string().min(1),
  /** The most characters of paragraphs offered to the writer from the author's Wikipedia article. */
  author_article_chars: z.number().int().min(1000).max(100_000),
  /** The same for the work's article. */
  work_article_chars: z.number().int().min(1000).max(100_000),
});

export const verticalSchema = z
  .strictObject({
    slug,
    name: z.string().min(1),
    kid_safe: z.boolean(),
    audience: z.strictObject({
      reading_level: z.string().regex(/^grade-\d{1,2}$/).optional(),
      age_range: z.tuple([z.number().int(), z.number().int()]).optional(),
    }),
    voice: z.string().min(1),
    post_shape: z.strictObject({ hook: z.string(), body: z.string(), closer: z.string() }),
    banned_topics: z.array(z.string().min(1)).default([]),
    image: z.strictObject({
      style: z.string().min(1),
      generated_disclosure: z.literal(true),
    }),
    harvest: harvestSchema.optional(),
    enrich: enrichSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kid_safe && (!v.audience.reading_level || v.banned_topics.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['kid_safe'],
        message: 'kid_safe verticals require audience.reading_level and at least one banned_topics entry',
      });
    }
  });

export const channelSchema = z
  .strictObject({
    vertical: slug,
    platform: z.enum(PLATFORMS),
    handle: z.string().min(1).optional(),
    account_ref: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an env var NAME, not a value'),
    formats: z.array(z.enum(RENDITION_FORMATS)).min(1),
    cadence: z.strictObject({
      posts_per_day: z.number().int().min(1).max(2),
      times: z.array(hhmm).min(1),
    }),
    made_for_kids: z.boolean().optional(),
    caption: z.strictObject({
      title_max: z.number().int().positive().optional(),
      text_max: z.number().int().positive(),
    }),
  })
  .superRefine((c, ctx) => {
    if (c.cadence.times.length !== c.cadence.posts_per_day) {
      ctx.addIssue({
        code: 'custom',
        path: ['cadence', 'times'],
        message: `must list exactly posts_per_day (${c.cadence.posts_per_day}) times`,
      });
    }
    if (c.platform === 'youtube' && c.made_for_kids === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['made_for_kids'],
        message: 'youtube channels must set made_for_kids explicitly (spec §11)',
      });
    }
  });

export type VerticalConfig = z.infer<typeof verticalSchema>;
export type ChannelConfig = z.infer<typeof channelSchema>;
export type HarvestConfig = z.infer<typeof harvestSchema>;
export type EnrichConfig = z.infer<typeof enrichSchema>;
```

The only changes are `enrichSchema`, the `enrich` key on `verticalSchema`, and the `EnrichConfig` type. The existing `§11` in the youtube message is unchanged.

Replace `config/verticals/literature.yaml` with (the `enrich:` section is new):

```yaml
slug: literature
name: The Commonplace Book          # working name — see spec §3 / §16
kid_safe: false
audience: {}
voice: |
  Warm, precise, quietly enthusiastic — a well-read friend, not a lecturer.
  Say who wrote it, what was happening in their life and the world when they
  did, and what the line actually means. Every claim traces to a stored source.
  Never: inspirational-poster tone, invented anecdotes, "timeless wisdom" filler.
post_shape:
  hook: 1 sentence
  body: 2-4 short paragraphs
  closer: 1 sentence pointing back to the work itself
banned_topics: []
image:
  style: public-domain author portrait, title page, manuscript page, or period image of the setting
  generated_disclosure: true
harvest:
  # Wikidata years equal Gutendex's author years; both must match for authorMatches (spec section 8).
  authors:
    - { name: Charles Dickens, gutendex_name: "Dickens, Charles", wikidata_id: Q5686, birth_year: 1812, death_year: 1870 }
    - { name: Jane Austen, gutendex_name: "Austen, Jane", wikidata_id: Q36322, birth_year: 1775, death_year: 1817 }
    - { name: Mark Twain, gutendex_name: "Twain, Mark", wikidata_id: Q7245, birth_year: 1835, death_year: 1910 }
    - { name: Oscar Wilde, gutendex_name: "Wilde, Oscar", wikidata_id: Q30875, birth_year: 1854, death_year: 1900 }
  picker:
    model: claude-sonnet-5        # user's choice, 2026-09-13
    batch_size: 150               # candidates per Claude call (~45 input tokens each)
    max_batches_per_work: 6       # spend cap per book
    picks_per_batch: 3            # most sentences the model may choose from one batch
enrich:
  writer_model: claude-opus-5         # user's choice, 2026-09-15
  checker_model: claude-sonnet-5      # user's choice, 2026-09-15
  author_article_chars: 30000         # Wikipedia paragraphs offered to the writer, per article
  work_article_chars: 18000
```

Create `prompts/literature/enrich.md`:

```md
You write the short text that goes with one quotation from classic literature on a page for adult readers who love books.

You receive:
- the quotation, exactly as the author wrote it;
- the author and the work;
- numbered source paragraphs from Wikipedia articles about the author and the work.

Write:
- hook ({{hook}}): make a reader stop and look at the quotation.
- body ({{body}}), each paragraph of two or three sentences: say who wrote it, what was happening in the author's life and the world when they wrote it, and what the line means.
- closer ({{closer}}).
With the hook, with each body paragraph and with the closer, list the ids of the paragraphs its facts come from.
Keep the whole text, hook to closer, under 180 words. Pick the few facts that matter most for this line; leave the rest out.

Voice:
{{voice}}

Never write about:
{{banned_topics}}

The rule that matters most: the source paragraphs are the only facts you have. A reviewer will check every sentence against the paragraphs you cite, and any detail they do not contain sends the post back.
- Every fact (a date, an age, an amount, an event, a person, a place, a circumstance of writing or publication, where a line falls in the book) must be stated in a paragraph you cite for that part (the hook, each body paragraph, the closer). List those ids with the part.
- Do not add details from memory, however well known or certain. Do not sharpen a source's wording into something stronger ("popular" is not "the most famous", "a time" is not "for years").
- You are not told where the quotation falls in the book, so do not say.
- What the line means is your reading. You may give it, as a reading of the text, without attributing intentions to the author that no source states.
- Never change, shorten or paraphrase the quotation, and do not repeat it in full; the post shows it separately.
- Plain, exact sentences. No inspirational-poster tone, no "timeless wisdom", no rhetorical questions, no exclamation marks.
```

Create `prompts/literature/revise.md`:

```md
You revise a short draft about a quotation from classic literature so that every sentence is supported by its source paragraphs and the draft keeps its shape.

You receive the quotation, the author and the work, the numbered source paragraphs, the draft (the hook, the body paragraphs and the closer, each with the ids of the paragraphs it relies on), and the problems a reviewer found. A problem names a sentence and the detail the sources do not contain, a number that neither the quotation nor a cited paragraph contains, or a part with the wrong number of sentences or paragraphs.

Fix only what the reviewer found:
- For an unsupported sentence, remove the unsupported detail, or restate the sentence so it says only what a source paragraph states, and cite that paragraph.
- For a number, write it exactly as a paragraph you cite writes it, or remove it.
- If a sentence cannot be supported, delete it and adjust the neighbouring sentence so the paragraph still reads well.
- Keep every other sentence as it is, word for word.
- Do not add any new fact, and do not repeat the quotation in full.

Keep the shape:
- hook: {{hook}}
- body: {{body}}
- closer: {{closer}}

Return the whole revised draft, with the ids of the paragraphs each part relies on.
```

Create `prompts/shared/fact-check.md`:

```md
You check a short draft for a post against the only sources it may rely on.

You receive the numbered source paragraphs, with the item the post is about (a quotation or a fact) marked [Q], and the draft, split into numbered sentences.

For every sentence, return one verdict with its number as the id, and decide:
- kind: "fact" if it states anything checkable about the world (a date, an event, a person, a place, a number, what happened when the work was written or published, what a character does in the book); "interpretation" if it only offers a reading of what the item means; "other" for anything else (a transition, a pointer to the work).
- supported: for a fact, true only if the source paragraphs state it. Wording may differ, but every detail must be there: a name, a year, a number or a cause that is not in the sources makes the sentence unsupported. For an interpretation, true unless it states a fact that the sources do not support. For other, true unless it states an unsupported fact.
- sources: the ids of the paragraphs that support it (empty when unsupported or not needed).
- problem: for an unsupported sentence, the exact detail that is not in the sources; otherwise an empty string.

You have no other knowledge for this task. Something you believe is true but the sources do not say is unsupported.
```

Create `src/enrich/messages.ts`:

```ts
import type { VerticalConfig } from '../config/schema.js';
import { formatParagraph, type SourceParagraph } from './context.js';
import type { Draft, DraftSentence } from './draft.js';

export type VerticalVoice = Pick<VerticalConfig, 'voice' | 'post_shape' | 'banned_topics'>;

export interface QuoteContext {
  body: string;
  author: string;
  workTitle: string;
}

/**
 * A prompt file with the vertical's voice, post shape and banned topics filled in (spec section 9). An
 * unknown {{placeholder}} is refused, so a typo in a prompt never reaches the model.
 */
export function fillPrompt(template: string, vertical: VerticalVoice): string {
  const values: Record<string, string> = {
    voice: vertical.voice.trim(),
    hook: vertical.post_shape.hook,
    body: vertical.post_shape.body,
    closer: vertical.post_shape.closer,
    banned_topics: vertical.banned_topics.length === 0 ? '- none' : vertical.banned_topics.map((topic) => `- ${topic}`).join('\n'),
  };
  for (const [whole, name] of template.matchAll(/\{\{([a-z_]+)\}\}/g)) {
    if (!(name! in values)) throw new Error(`prompt has an unknown placeholder ${whole}`);
  }
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_whole, name: string) => values[name]!);
}

export function writerMessage(quote: QuoteContext, paragraphs: readonly SourceParagraph[]): string {
  return [
    `Quotation: ${quote.body}`,
    `Author: ${quote.author}`,
    `Work: ${quote.workTitle}`,
    '',
    'Source paragraphs:',
    '',
    paragraphs.map(formatParagraph).join('\n\n'),
  ].join('\n');
}

export function reviseMessage(quote: QuoteContext, paragraphs: readonly SourceParagraph[], draft: Draft, problems: readonly string[]): string {
  return [
    writerMessage(quote, paragraphs),
    '',
    'Draft:',
    JSON.stringify(draft, null, 2),
    '',
    'Problems the reviewer found:',
    problems.map((problem) => `- ${problem}`).join('\n'),
  ].join('\n');
}

/** The checker sees only the quotation, the paragraphs the draft cites, and the draft's numbered sentences (spec section 7). */
export function checkerMessage(quote: QuoteContext, cited: readonly SourceParagraph[], sentences: readonly DraftSentence[]): string {
  return [
    'Source paragraphs:',
    '',
    `[Q] (the quotation, from the book) ${quote.body}`,
    ...cited.map((paragraph) => `\n${formatParagraph(paragraph)}`),
    '',
    'Draft sentences:',
    sentences.map((sentence) => `(${sentence.n}) ${sentence.text}`).join('\n'),
  ].join('\n');
}
```

Create `src/enrich/anthropic.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { checkSchema, draftSchema } from './draft.js';

/** Spec section 15: prompts are content and live in version-controlled files. The writer's are per vertical; the fact check is shared. */
export function enrichPromptPaths(verticalSlug: string): EnrichPrompts {
  return {
    write: `prompts/${verticalSlug}/enrich.md`,
    revise: `prompts/${verticalSlug}/revise.md`,
    check: 'prompts/shared/fact-check.md',
  };
}

export interface EnrichPrompts {
  write: string;
  revise: string;
  check: string;
}

export function loadEnrichPrompts(root: string, verticalSlug: string): EnrichPrompts {
  const paths = enrichPromptPaths(verticalSlug);
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  return { write: read(paths.write), revise: read(paths.revise), check: read(paths.check) };
}

/** A model's answer: the JSON it returned (validated by the caller), the model that wrote it, and its token use. */
export interface ModelAnswer {
  value: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export type ModelFn = (system: string, user: string) => Promise<ModelAnswer>;

/** A model answered without usable output: a refusal, a truncated answer, text that is not JSON, or JSON of the wrong shape. */
export class EnrichResponseError extends Error {
  override name = 'EnrichResponseError';
}

/** The beta that lets the API answer with a substitute model when the requested model declines for policy reasons. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function parseAnswer(role: string, stopReason: string | null, text: string): unknown {
  if (stopReason !== 'end_turn') throw new EnrichResponseError(`the ${role} stopped with ${String(stopReason)} and no usable output`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EnrichResponseError(`the ${role}'s output is not JSON`);
  }
}

/**
 * The writer, backed by the Messages API with structured output built from draftSchema and server-side
 * fallback. The reported model is the one that wrote the text: the last fallback hop's model when a
 * fallback answered. Errors making the request (the key, the network, rate limits after the SDK's
 * retries) propagate and stop the run; only an unusable answer becomes an EnrichResponseError.
 */
export function anthropicWriter(client: Anthropic, model: string): ModelFn {
  const { schema } = zodOutputFormat(draftSchema);
  return async (system, user) => {
    const response = await client.beta.messages.create({
      model,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      // Thinking is on by default and shares max_tokens with the answer.
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema }, effort: 'medium' },
    });
    const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    const answeredBy = response.content.flatMap((block) => (block.type === 'fallback' ? [block.to.model] : [])).at(-1);
    return {
      value: parseAnswer('writer', response.stop_reason, text),
      model: answeredBy ?? response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  };
}

/** The fact checker, backed by the Messages API with structured output built from checkSchema. Errors are handled as for the writer. */
export function anthropicChecker(client: Anthropic, model: string): ModelFn {
  const { schema } = zodOutputFormat(checkSchema);
  return async (system, user) => {
    const response = await client.messages.create({
      model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema }, effort: 'medium' },
    });
    const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    return {
      value: parseAnswer('fact check', response.stop_reason, text),
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/config tests/enrich/messages.test.ts tests/enrich/anthropic.test.ts`
Expected: PASS; the new files have 6, 6 and 6 tests, and the existing config tests still pass.

Run: `npx vitest run` and `npx tsc --noEmit -p .`
Expected: 531 tests pass across 38 files; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts config/verticals/literature.yaml prompts/literature/enrich.md prompts/literature/revise.md prompts/shared/fact-check.md src/enrich/messages.ts src/enrich/anthropic.ts tests/config/enrich-config.test.ts tests/enrich/messages.test.ts tests/enrich/anthropic.test.ts
git commit -m "feat(enrich): enrich config, writer, revision and fact-check prompts, Opus 5 writer with fallback and Sonnet 5 checker

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task N6: Enrich a vertical

**Files:**
- Create: `src/enrich/enrich.ts`
- Test: `tests/enrich/enrich.test.ts` (new)

**Interfaces:**
- **Consumes:** everything from N1-N5; `SourceStatusError` and `HttpGet` from `src/harvest/sources.ts`; `Logger` from `src/lib/log.ts`.
- **Produces:**
  - `export interface EnrichOptions { db; verticalId; vertical: VerticalVoice; enrich: EnrichConfig; get: HttpGet; endpoints: WikiEndpoints; write: ModelFn; check: ModelFn; prompts: EnrichPrompts; limit: number; now?: () => Date; log?: Logger }`
  - `export type ItemOutcome = { status: 'draft' | 'needs_review'; postId: number; rounds: number; problems: string[]; workArticle: string | null } | { status: 'failed'; reason: string }`
  - `export interface ItemReport { itemId: number; author: string; workTitle: string; outcome: ItemOutcome }`
  - `export interface EnrichReport { considered: number; drafted: number; needsReview: number; failed: number; items: ItemReport[] }`
  - `export async function enrichVertical(options: EnrichOptions): Promise<EnrichReport>`
  - `export function altText(quote: QuoteContext): string`
- **Used by:** N7.

**Why:**

- **One path from quote to post.** The steps are sources, write, judge, at most one revision, then store, with fail-closed handling at each step, as listed in Global Constraints.
- **Errors by kind.** A quote-level failure (`WikiLookupError`, `SourceStatusError`, `EnrichResponseError`) is reported and the run moves on. The quote gets no post, so the next run tries it again. Any other error stops the run.
- **Logging.** Each model call is logged with its model and token use (P6 asked for usage logging).

- [ ] **Step 1: Write the failing tests**

Create `tests/enrich/enrich.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertHarvestedQuote, upsertAuthorSubject } from '../../src/db/quotes.js';
import { EnrichResponseError, type ModelFn } from '../../src/enrich/anthropic.js';
import type { Draft } from '../../src/enrich/draft.js';
import { enrichVertical } from '../../src/enrich/enrich.js';
import { articleUrl, DEFAULT_WIKI_ENDPOINTS, entitiesUrl, workSearchUrl } from '../../src/enrich/wikipedia.js';
import type { HarvestAuthor } from '../../src/harvest/gutendex.js';
import { createHttpGet } from '../../src/harvest/sources.js';
import { verifyVertical } from '../../src/verify/run.js';
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

/** A writer that answers with each draft in turn (repeating the last), or throws a given error. */
function writer(...answers: (Draft | Error)[]) {
  const calls: { system: string; user: string }[] = [];
  const fn: ModelFn = async (system, user) => {
    calls.push({ system, user });
    const next = answers[Math.min(calls.length, answers.length) - 1]!;
    if (next instanceof Error) throw next;
    return { value: next, model: 'claude-opus-5', inputTokens: 100, outputTokens: 50 };
  };
  return { fn, calls };
}

/** A checker that judges the numbered sentences it is sent, finding unsupported only those marked UNSUPPORTED. */
function checker() {
  const calls: { system: string; user: string }[] = [];
  const fn: ModelFn = async (system, user) => {
    calls.push({ system, user });
    const sentences = [...user.matchAll(/^\((\d+)\) (.*)$/gm)].map((m) => ({ id: Number(m[1]), text: m[2]! }));
    const verdicts = sentences.map(({ id, text }) => {
      const flagged = text.includes('UNSUPPORTED');
      return { id, kind: 'fact', supported: !flagged, sources: [], problem: flagged ? 'the sources do not say he was the most famous man alive' : '' };
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
  const enrich = (write: ModelFn, check: ModelFn) =>
    enrichVertical({ db, verticalId, vertical: VERTICAL, enrich: ENRICH, get, endpoints: E, write, check, prompts: PROMPTS, limit: 5, now: NOW });
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
    expect(check.calls[0]!.user).toContain(`[Q] (the quotation, from the book) ${BODY}`);
    expect(check.calls[0]!.user).toContain('(4) The novel keeps returning to what people hide.');

    expect(await enrich(write.fn, check.fn)).toMatchObject({ considered: 0, drafted: 0 });
    expect(write.calls).toHaveLength(1);
  });

  it('gives a draft with an unsupported sentence one revision and keeps both rounds', async () => {
    const { db, quote, enrich } = await setup();
    quote(DICKENS, BODY, 'A Tale of Two Cities');
    const write = writer(FLAWED, GOOD);

    const report = await enrich(write.fn, checker().fn);
    expect(report.items[0]!.outcome).toMatchObject({ status: 'draft', rounds: 2, problems: [] });
    expect(write.calls[1]!.system).toBe('REVISE 2-4 short paragraphs');
    expect(write.calls[1]!.user).toContain('Problems the reviewer found:\n- "He was UNSUPPORTED the most famous man alive." is not supported by the source paragraphs: the sources do not say he was the most famous man alive');
    expect(write.calls[1]!.user).toContain(JSON.stringify(FLAWED, null, 2));
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
    const authorOnly: Draft = { ...GOOD, hook: part(GOOD.hook.text, []), body: [GOOD.body[0]!, part('He published A Tale of Two Cities in 1859.', ['S2'])] };
    await expect(enrich(writer(new Error('socket hang up')).fn, checker().fn)).rejects.toThrow('socket hang up');

    const write = writer(authorOnly);
    const report = await enrich(write.fn, checker().fn);
    expect(report.items[0]!.outcome).toMatchObject({ status: 'draft', rounds: 1, workArticle: null });
    expect(write.calls[0]!.user).not.toContain('[S3]');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/enrich/enrich.test.ts`
Expected: FAIL, because `../../src/enrich/enrich.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/enrich/enrich.ts`:

```ts
import type { z } from 'zod';
import type { EnrichConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { insertPost, itemsToEnrich, type ItemToEnrich, type PostRound } from '../db/posts.js';
import { SourceStatusError, type HttpGet } from '../harvest/sources.js';
import type { Logger } from '../lib/log.js';
import { EnrichResponseError, type EnrichPrompts, type ModelAnswer, type ModelFn } from './anthropic.js';
import { articleParagraphs, labelParagraphs, paragraphSource, type SourceParagraph } from './context.js';
import { checkSchema, draftSchema, draftSentences, type Check, type Draft } from './draft.js';
import { checkProblems, citedParagraphs, numberProblems, parsePostShape, shapeProblems, type PostShape } from './gates.js';
import { checkerMessage, fillPrompt, reviseMessage, writerMessage, type QuoteContext, type VerticalVoice } from './messages.js';
import { authorArticleTitle, fetchArticle, WikiLookupError, workArticle, type WikiEndpoints, type WikipediaArticle } from './wikipedia.js';

export interface EnrichOptions {
  db: Db;
  verticalId: number;
  vertical: VerticalVoice;
  enrich: EnrichConfig;
  get: HttpGet;
  endpoints: WikiEndpoints;
  write: ModelFn;
  check: ModelFn;
  /** The prompt files as loaded; the vertical's voice, post shape and banned topics are filled in here. */
  prompts: EnrichPrompts;
  /** The most verified quotes to write posts for in one run. */
  limit: number;
  now?: () => Date;
  log?: Logger;
}

export type ItemOutcome =
  | {
      status: 'draft' | 'needs_review';
      postId: number;
      /** 2 when the first draft had problems and was revised. */
      rounds: number;
      /** The problems left in the last round; empty for a draft. */
      problems: string[];
      /** The work's Wikipedia article, or null when only the author's article was used. */
      workArticle: string | null;
    }
  | { status: 'failed'; reason: string };

export interface ItemReport {
  itemId: number;
  author: string;
  workTitle: string;
  outcome: ItemOutcome;
}

export interface EnrichReport {
  /** Verified quotes without a post that this run took up. */
  considered: number;
  drafted: number;
  needsReview: number;
  failed: number;
  items: ItemReport[];
}

interface Round extends PostRound {
  draft: Draft;
  check: Check;
}

interface Run {
  options: EnrichOptions;
  now: () => Date;
  shape: PostShape;
  prompts: EnrichPrompts;
  articles: Map<string, WikipediaArticle>;
}

/**
 * Writes posts for a vertical's verified quotes (spec section 7, `lantern enrich`).
 *
 * For each verified quote without a post (authors taking turns, at most `limit`):
 * 1. The author's Wikipedia article is found through their Wikidata id, and the work's through a
 *    Wikidata search for its title. Their paragraphs, labelled S1, S2, ..., are the only facts offered.
 * 2. The writer returns a hook, body paragraphs and a closer, each with the labels it relies on.
 * 3. The gates judge the draft: its shape and labels, every number against the quotation and the cited
 *    paragraphs, and a separate fact check of every sentence that sees only the cited paragraphs.
 * 4. A draft with any problem gets one revision with the problems listed, judged the same way
 *    (user decision 2026-09-15).
 * 5. The post is stored as 'draft' when its last round has no problems and as 'needs_review' otherwise,
 *    with every round, and with the cited paragraphs as tier 3 sources of the quote.
 *
 * A quote whose articles cannot be read, or whose first draft or its fact check is refused or
 * unreadable, is reported as failed and gets no post, so the next run tries it again. A revision that
 * fails leaves the first round as a post to review. Any other error (a rejected API key, the network)
 * stops the run.
 */
export async function enrichVertical(options: EnrichOptions): Promise<EnrichReport> {
  const run: Run = {
    options,
    now: options.now ?? (() => new Date()),
    shape: parsePostShape(options.vertical.post_shape),
    prompts: {
      write: fillPrompt(options.prompts.write, options.vertical),
      revise: fillPrompt(options.prompts.revise, options.vertical),
      check: fillPrompt(options.prompts.check, options.vertical),
    },
    articles: new Map(),
  };
  const items = itemsToEnrich(options.db, options.verticalId, options.limit);
  const report: EnrichReport = { considered: items.length, drafted: 0, needsReview: 0, failed: 0, items: [] };
  for (const item of items) {
    let outcome: ItemOutcome;
    try {
      outcome = await enrichItem(run, item);
    } catch (err) {
      if (!(err instanceof WikiLookupError || err instanceof SourceStatusError || err instanceof EnrichResponseError)) throw err;
      outcome = { status: 'failed', reason: err.message };
    }
    if (outcome.status === 'draft') report.drafted++;
    else if (outcome.status === 'needs_review') report.needsReview++;
    else report.failed++;
    report.items.push({ itemId: item.itemId, author: item.author, workTitle: item.workTitle, outcome });
    options.log?.info('enrich item', { itemId: item.itemId, outcome });
  }
  return report;
}

/** Deterministic alt text until the media stage chooses an image: it says nothing the quote row does not. */
export function altText(quote: QuoteContext): string {
  return `Quotation from ${quote.workTitle} by ${quote.author}: "${quote.body}"`;
}

async function article(run: Run, qid: string, title: () => Promise<string>): Promise<WikipediaArticle> {
  const known = run.articles.get(qid);
  if (known !== undefined) return known;
  const fetched = await fetchArticle(run.options.get, run.options.endpoints, await title(), qid);
  run.articles.set(qid, fetched);
  return fetched;
}

async function sourceParagraphs(run: Run, item: ItemToEnrich): Promise<{ paragraphs: SourceParagraph[]; work: WikipediaArticle | null }> {
  const { get, endpoints, enrich } = run.options;
  const author = await article(run, item.wikidataId, () => authorArticleTitle(get, endpoints, item.wikidataId));
  const found = await workArticle(get, endpoints, item.wikidataId, item.workTitle);
  const work = found === null || found.qid === item.wikidataId ? null : await article(run, found.qid, async () => found.title);
  const paragraphs = labelParagraphs([
    articleParagraphs(author, enrich.author_article_chars),
    work === null ? [] : articleParagraphs(work, enrich.work_article_chars),
  ]);
  if (paragraphs.length === 0) throw new WikiLookupError(`no usable paragraphs in the Wikipedia article ${author.title}`);
  return { paragraphs, work };
}

async function call(run: Run, itemId: number, role: string, fn: ModelFn, system: string, message: string): Promise<ModelAnswer> {
  const answer = await fn(system, message);
  run.options.log?.info('enrich call', { itemId, role, model: answer.model, inputTokens: answer.inputTokens, outputTokens: answer.outputTokens });
  return answer;
}

function parsed<T>(schema: z.ZodType<T>, answer: ModelAnswer, what: string): T {
  const result = schema.safeParse(answer.value);
  if (!result.success) throw new EnrichResponseError(`${what} is not the expected shape`);
  return result.data;
}

async function judgedRound(run: Run, item: ItemToEnrich, n: 1 | 2, system: string, message: string, paragraphs: readonly SourceParagraph[]): Promise<Round> {
  const quote: QuoteContext = { body: item.body, author: item.author, workTitle: item.workTitle };
  const written = await call(run, item.itemId, n === 1 ? 'writer' : 'reviser', run.options.write, system, message);
  const draft = parsed(draftSchema, written, n === 1 ? 'the draft' : 'the revised draft');
  const cited = citedParagraphs(draft, paragraphs);
  const sentences = draftSentences(draft);
  const checked = await call(run, item.itemId, 'checker', run.options.check, run.prompts.check, checkerMessage(quote, cited, sentences));
  const check = parsed(checkSchema, checked, 'the fact check');
  const problems = [
    ...shapeProblems(draft, run.shape, new Set(paragraphs.map((paragraph) => paragraph.id)), item.body),
    ...numberProblems(draft, item.body, cited),
    ...checkProblems(check, sentences),
  ];
  return { round: n, draft, check, problems, writerModel: written.model, checkerModel: checked.model };
}

async function enrichItem(run: Run, item: ItemToEnrich): Promise<ItemOutcome> {
  const { paragraphs, work } = await sourceParagraphs(run, item);
  const quote: QuoteContext = { body: item.body, author: item.author, workTitle: item.workTitle };
  const first = await judgedRound(run, item, 1, run.prompts.write, writerMessage(quote, paragraphs), paragraphs);
  const rounds: Round[] = [first];
  if (first.problems.length > 0) {
    try {
      rounds.push(await judgedRound(run, item, 2, run.prompts.revise, reviseMessage(quote, paragraphs, first.draft, first.problems), paragraphs));
    } catch (err) {
      if (!(err instanceof EnrichResponseError)) throw err;
      first.problems.push(`the revision failed: ${err.message}`);
    }
  }
  const last = rounds[rounds.length - 1]!;
  const status = last.problems.length === 0 ? 'draft' : 'needs_review';
  const cited = new Set(rounds.flatMap((round) => citedParagraphs(round.draft, paragraphs).map((paragraph) => paragraph.id)));
  const postId = insertPost(
    run.options.db,
    {
      itemId: item.itemId,
      verticalId: run.options.verticalId,
      hook: last.draft.hook.text.trim(),
      body: last.draft.body.map((part) => part.text.trim()).join('\n\n'),
      closer: last.draft.closer.text.trim(),
      altText: altText(quote),
      status,
      rounds,
      sources: paragraphs
        .filter((paragraph) => cited.has(paragraph.id))
        .map((paragraph) => ({ label: paragraph.id, source: paragraphSource(paragraph), retrievedAt: new Date(paragraph.article.fetchedAt) })),
    },
    run.now(),
  );
  return { status, postId, rounds: rounds.length, problems: last.problems, workArticle: work?.title ?? null };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/enrich/enrich.test.ts`
Expected: PASS, 6 tests.

Run: `npx vitest run` and `npx tsc --noEmit -p .`
Expected: 537 tests pass across 39 files; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/enrich/enrich.ts tests/enrich/enrich.test.ts
git commit -m "feat(enrich): enrich a vertical's verified quotes with gated drafts and one revision

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task N7: `lantern enrich`, spec and plan

**Files:**
- Modify: `src/cli.ts`, `tests/cli.test.ts`, `claude.md`, `plan.md`

**Interfaces:**
- **Consumes:** `enrichVertical` and `ItemReport` (N6); `anthropicWriter`, `anthropicChecker` and `loadEnrichPrompts` (N5); `DEFAULT_WIKI_ENDPOINTS` (N1).
- **Produces:**
  - `lantern enrich --vertical <slug> [--limit 5] [--refresh]`. Its startup checks run in order, before any fetch: the limit, pending migrations, the vertical, its `enrich` section, `ANTHROPIC_API_KEY`, then the prompt files.
  - `cachedGet(refresh)`, shared by `harvest` and `enrich`.
- **Used by:** the user's first live enrich.

**Why:**

- **The command.** `lantern enrich` is the §7 stage. It runs through `runStage` (§7: every stage writes `run_log`) and uses an explicit client timeout of 300 s with 2 retries, because a writer call can think for minutes and a call only reads.
- **Exit code.** It exits 1 when any quote failed, so a cron log shows it.
- **Docs.** `claude.md` §6 and §7 change in the same branch as the code (§15). Open question §16 on the model tier is closed.

- [ ] **Step 1: Add the CLI tests**

In `tests/cli.test.ts`, add these tests just before the final `});` of the `describe('lantern CLI', ...)` block:

```ts
  it('enrich refuses a bad limit, pending migrations, a vertical without an enrich section, and a missing API key, without fetching anything', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const badLimit = lantern(['enrich', '--vertical', 'literature', '--limit', '0'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(badLimit.code).toBe(1);
    expect(badLimit.out).toContain('--limit must be a positive integer, got 0');
    const pending = lantern(['enrich', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(pending.code).toBe(1);
    expect(pending.out).toContain('run lantern migrate');
    expect(lantern(['migrate'], scratch).code).toBe(0);
    const science = lantern(['enrich', '--vertical', 'science-curious'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(science.code).toBe(1);
    expect(science.out).toContain('vertical science-curious has no enrich section');
    const cache = join(scratch, 'cache');
    const noKey = lantern(['enrich', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: '', LANTERN_CACHE: cache } });
    expect(noKey.code).toBe(1);
    expect(noKey.out).toContain('ANTHROPIC_API_KEY is not set');
    expect(existsSync(cache)).toBe(false);
  }, 60_000);

  it('enrich writes nothing when no verified quote is waiting for a post', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    expect(lantern(['migrate'], scratch).code).toBe(0);
    const cache = join(scratch, 'cache');
    const res = lantern(['enrich', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: 'test-key-never-sent', LANTERN_CACHE: cache } });
    expect(res.code).toBe(0);
    expect(res.out).toContain('posts: 0 draft, 0 needs review; failed: 0');
    expect(existsSync(cache)).toBe(false);
  }, 30_000);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL, because commander rejects the unknown command `enrich`.

- [ ] **Step 3: Implement**

Replace `src/cli.ts` with:

```ts
#!/usr/bin/env node
import Anthropic from '@anthropic-ai/sdk';
import { Command, CommanderError } from 'commander';
import { config as loadDotenv } from 'dotenv';
import { join, resolve } from 'node:path';
import { loadConfig } from './config/load.js';
import { openDb, type Db } from './db/connection.js';
import { migrate, pendingMigrations } from './db/migrate.js';
import { syncConfig } from './db/sync.js';
import { runChecks } from './doctor/checks.js';
import { exitCode, formatReport } from './doctor/report.js';
import { anthropicChecker, anthropicWriter, loadEnrichPrompts } from './enrich/anthropic.js';
import { enrichVertical, type ItemReport } from './enrich/enrich.js';
import { DEFAULT_WIKI_ENDPOINTS } from './enrich/wikipedia.js';
import { anthropicPick, loadPickPrompt } from './harvest/anthropic-picker.js';
import { harvestVertical, type AuthorReport } from './harvest/harvest.js';
import { createHttpGet, DEFAULT_ENDPOINTS } from './harvest/sources.js';
import { redactUrl } from './lib/cache.js';
import { buildUserAgent } from './lib/http.js';
import { createLogger } from './lib/log.js';
import { findProjectRoot, resolvePaths } from './lib/paths.js';
import { runStage } from './lib/run-stage.js';
import { verifyVertical } from './verify/run.js';

const USER_AGENT_VERSION = '0.1';

const root = resolve(process.env.LANTERN_ROOT ?? findProjectRoot());
loadDotenv({ path: join(root, '.env'), quiet: true });
const paths = resolvePaths(process.env, root);
const log = createLogger({ dir: paths.logs });

const program = new Command()
  .name('lantern')
  .description('Automated educational social content engine')
  .exitOverride();

/** Opens the database for a pipeline stage, refusing one with pending migrations. */
function openMigratedDb(): Db {
  const db = openDb(paths.db);
  const pending = pendingMigrations(db, paths.migrations);
  if (pending.length > 0) throw new Error(`the database has pending migrations (${pending.join(', ')}); run lantern migrate`);
  return db;
}

function findVertical(db: Db, slug: string) {
  const vertical = loadConfig(paths.root).verticals.find((v) => v.slug === slug);
  if (vertical === undefined) throw new Error(`unknown vertical: ${slug}`);
  const verticalId = db.prepare('SELECT id FROM verticals WHERE slug = ?').pluck().get(slug) as number | undefined;
  if (verticalId === undefined) throw new Error(`vertical ${slug} is not in the database; run lantern migrate`);
  return { vertical, verticalId };
}

/** Cached GETs for a stage, with a log line for every retry so an unattended run can be read back. */
function cachedGet(refresh: boolean) {
  return createHttpGet({
    cacheDir: paths.cache,
    refresh,
    http: {
      userAgent: buildUserAgent(process.env.LANTERN_CONTACT, USER_AGENT_VERSION),
      // Gutendex can take more than a minute to answer a search.
      timeoutMs: 180_000,
      onRetry: (event) => log.warn('http retry', { ...event, url: redactUrl(event.url) }),
    },
  });
}

function describeAuthor(author: AuthorReport): string {
  if (author.error !== null) return `${author.author}: skipped (${author.error})`;
  if (!author.loaded) return `${author.author}: not reached before the limit`;
  const count = (status: string) => author.books.filter((b) => b.outcome.status === status).length;
  const sum = (key: 'inserted' | 'conflicts' | 'conflictsWithDecided') =>
    author.books.reduce((n, b) => n + (b.outcome.status === 'harvested' ? b.outcome[key] : 0), 0);
  return `${author.author}: ${author.listedEntries} listed on Wikiquote; books harvested ${count('harvested')}, already picked ${count('already-picked')}, skipped ${count('skipped')}, failed ${count('failed')}; quotes inserted ${sum('inserted')}; attribution conflicts ${sum('conflicts')} recorded, ${sum('conflictsWithDecided')} with decided quotes`;
}

function describeItem(item: ItemReport): string {
  const head = `quote ${item.itemId} (${item.author}, ${item.workTitle})`;
  const outcome = item.outcome;
  if (outcome.status === 'failed') return `${head}: failed (${outcome.reason})`;
  const revised = outcome.rounds > 1 ? ', after one revision' : '';
  if (outcome.status === 'draft') return `${head}: post ${outcome.postId} drafted${revised}`;
  return `${head}: post ${outcome.postId} needs review${revised}: ${outcome.problems.join('; ')}`;
}

program
  .command('migrate')
  .description('Apply pending migrations and sync config/ into the database')
  .action(async () => {
    const db = openDb(paths.db);
    const { applied } = migrate(db, paths.migrations);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'migrations: up to date');
    const counts = await runStage(db, { stage: 'migrate' }, () => syncConfig(db, loadConfig(paths.root)));
    console.log(`verticals: ${JSON.stringify(counts.verticals)}`);
    console.log(`channels:  ${JSON.stringify(counts.channels)}`);
    log.info('migrate complete', { applied, counts });
  });

program
  .command('harvest')
  .description('Pull raw quotes from public-domain texts for a vertical; exits 1 if an author was skipped, a book failed, or a passage clashes with a decided quote')
  .requiredOption('--vertical <slug>', 'the vertical to harvest')
  .option('--limit <n>', 'start no new book once this many quotes have been inserted', '25')
  .option('--refresh', 'ignore cached responses and fetch again')
  .action(async (opts: { vertical: string; limit: string; refresh?: boolean }) => {
    const limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer, got ${opts.limit}`);
    const db = openMigratedDb();
    const { vertical, verticalId } = findVertical(db, opts.vertical);
    const harvest = vertical.harvest;
    if (harvest === undefined) throw new Error(`vertical ${vertical.slug} has no harvest section`);
    if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('ANTHROPIC_API_KEY is not set; the passage picker needs it');

    const get = cachedGet(opts.refresh === true);
    // A pick only reads, so retrying it is safe; the timeout keeps one stuck batch from stalling a cron run.
    const client = new Anthropic({ timeout: 120_000, maxRetries: 3 });
    const report = await runStage(db, { stage: 'harvest', verticalId }, () =>
      harvestVertical({
        db,
        verticalId,
        harvest,
        get,
        endpoints: DEFAULT_ENDPOINTS,
        pick: anthropicPick(client, harvest.picker.model),
        prompt: loadPickPrompt(paths.root),
        limit,
        log,
      }),
    );
    for (const author of report.authors) console.log(describeAuthor(author));
    console.log(`inserted: ${report.inserted}`);
    const trouble = report.authors.some(
      (a) =>
        a.error !== null ||
        a.books.some((b) => b.outcome.status === 'failed' || (b.outcome.status === 'harvested' && b.outcome.conflictsWithDecided > 0)),
    );
    if (trouble) process.exitCode = 1;
  });

program
  .command('verify')
  .description('Decide raw quotes for a vertical with the attribution gates; exits 1 if a quote has malformed evidence')
  .requiredOption('--vertical <slug>', 'the vertical to verify')
  .option('--retry-insufficient', 'first reopen quotes rejected only for insufficient evidence')
  .action(async (opts: { vertical: string; retryInsufficient?: boolean }) => {
    const db = openMigratedDb();
    const { verticalId } = findVertical(db, opts.vertical);
    const report = await runStage(db, { stage: 'verify', verticalId }, () =>
      verifyVertical(db, verticalId, { retryInsufficient: opts.retryInsufficient === true, log }),
    );
    if (report.reopened > 0) console.log(`reopened: ${report.reopened}`);
    console.log(`verified: ${report.verified}`);
    console.log(`rejected: ${JSON.stringify(report.rejected)}`);
    console.log(`left raw: ${report.unchecked} without a Wikiquote check, ${report.malformed} with malformed evidence`);
    if (report.malformed > 0) process.exitCode = 1;
  });

program
  .command('enrich')
  .description('Write posts for verified quotes from Wikipedia paragraphs, fact-check every sentence and allow one revision; exits 1 if a quote could not be written')
  .requiredOption('--vertical <slug>', 'the vertical to enrich')
  .option('--limit <n>', 'write posts for at most this many verified quotes', '5')
  .option('--refresh', 'ignore cached Wikidata and Wikipedia responses and fetch again')
  .action(async (opts: { vertical: string; limit: string; refresh?: boolean }) => {
    const limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer, got ${opts.limit}`);
    const db = openMigratedDb();
    const { vertical, verticalId } = findVertical(db, opts.vertical);
    const enrich = vertical.enrich;
    if (enrich === undefined) throw new Error(`vertical ${vertical.slug} has no enrich section`);
    if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('ANTHROPIC_API_KEY is not set; the writer and the fact check need it');
    const prompts = loadEnrichPrompts(paths.root, vertical.slug);

    // A writer call can think for minutes before it answers. A call only reads, so retrying it is safe.
    const client = new Anthropic({ timeout: 300_000, maxRetries: 2 });
    const report = await runStage(db, { stage: 'enrich', verticalId }, () =>
      enrichVertical({
        db,
        verticalId,
        vertical,
        enrich,
        get: cachedGet(opts.refresh === true),
        endpoints: DEFAULT_WIKI_ENDPOINTS,
        write: anthropicWriter(client, enrich.writer_model),
        check: anthropicChecker(client, enrich.checker_model),
        prompts,
        limit,
        log,
      }),
    );
    for (const item of report.items) console.log(describeItem(item));
    console.log(`posts: ${report.drafted} draft, ${report.needsReview} needs review; failed: ${report.failed}`);
    if (report.failed > 0) process.exitCode = 1;
  });

program
  .command('doctor')
  .description('Report system health; exits 1 if any check fails')
  .option('--json', 'emit JSON instead of a table')
  .action((opts: { json?: boolean }) => {
    const db = openDb(paths.db);
    const results = runChecks({
      db,
      root: paths.root,
      migrationsDir: paths.migrations,
      env: process.env,
      now: new Date(),
    });
    console.log(opts.json ? JSON.stringify(results, null, 2) : formatReport(results));
    log.info('doctor complete', { results });
    process.exitCode = exitCode(results);
  });

program.parseAsync().catch((err: unknown) => {
  if (err instanceof CommanderError) {
    // Commander has already printed its message (unknown command, bad option, help) to the terminal.
    if (err.exitCode !== 0) log.error('command rejected', { code: err.code, message: err.message });
    process.exitCode = err.exitCode;
    return;
  }
  log.error('command failed', { err });
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
```

The changes:
- the three enrich imports
- `cachedGet`, which the `harvest` action now calls instead of building its own cached GET
- `describeItem`
- the `enrich` command before `doctor`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: `claude.md`, section 6, the enrichment tables after `posts`**

Replace exactly:

```
  created_at    TEXT NOT NULL,
  UNIQUE(item_id)
);
```

with:

```
  created_at    TEXT NOT NULL,
  UNIQUE(item_id)
);

-- One writing round behind a post: the draft, its fact check and the problems the gates
-- found. Round 2 exists only when round 1 had problems (one revision, then review).
CREATE TABLE post_rounds (
  id             INTEGER PRIMARY KEY,
  post_id        INTEGER NOT NULL REFERENCES posts(id),
  round          INTEGER NOT NULL,      -- 1 | 2
  draft_json     TEXT NOT NULL,         -- hook, body paragraphs, closer, each with its labels
  check_json     TEXT NOT NULL,         -- one verdict per sentence
  problems_json  TEXT NOT NULL,         -- empty array when the round passed every gate
  writer_model   TEXT NOT NULL,
  checker_model  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE(post_id, round)
);

-- The stored sources a post's drafts cite, under the label the drafts use (S1, S2, ...).
CREATE TABLE post_sources (
  id            INTEGER PRIMARY KEY,
  post_id       INTEGER NOT NULL REFERENCES posts(id),
  source_id     INTEGER NOT NULL REFERENCES sources(id),
  label         TEXT NOT NULL,
  UNIQUE(post_id, label),
  UNIQUE(post_id, source_id)
);
```

- [ ] **Step 6: `claude.md`, section 7, `lantern enrich`**

Replace exactly:

```
**`lantern enrich --vertical literature --limit 5`**
Claude call. Given the item, its subject, and its stored sources, write the
platform-neutral post: hook, body, closer. Structured output. The prompt is in
the vertical config so each vertical has its own voice. A second Claude call
(different prompt, sources-only context) checks the draft for claims not
supported by the provided sources; unsupported claims send the post to
`needs_review` rather than silently dropping the sentence.
```

with:

```
**`lantern enrich --vertical literature --limit 5`**
Claude calls. For each verified quote without a post (authors taking turns), the
author's Wikipedia article (found through the subject's Wikidata id) and the
work's article (found through a Wikidata search for the title) are fetched and
cached. Their paragraphs, labelled S1, S2, ..., are the only facts the writer
gets. The writer (`enrich.writer_model`, with server-side fallback) returns the
platform-neutral post as structured output: hook, body paragraphs and closer,
each with the labels it relies on. The prompts live in `prompts/<vertical>/` and
`prompts/shared/`; the vertical config supplies the voice, post shape and banned
topics, so each vertical has its own voice. Gates then judge the draft: its shape
and labels, every number against the quotation and the cited paragraphs (§8),
and a second Claude call (`enrich.checker_model`, a different prompt,
sources-only context) that judges every sentence against the paragraphs the draft
cites. A draft with any problem gets one revision with the problems listed, and
the revision is judged the same way. Problems that remain send the post to
`needs_review` with the reasons stored, rather than silently dropping a
sentence. Both rounds and every check are kept in `post_rounds` for review, and
the cited paragraphs become tier 3 sources of the quote, linked to the post
through `post_sources`. A quote whose articles cannot be read, or whose first
draft or its check is refused, gets no post and is tried again on the next run;
the command then exits 1.
```

- [ ] **Step 7: `claude.md`, section 16, the model tier is decided**

Delete exactly these lines:

```
- Which Claude model tier for enrichment vs. the fact-check pass; the check pass
  can likely be a cheaper model with a tight rubric.
```

- [ ] **Step 8: `plan.md`, the Phase 2 status for enrichment**

Replace exactly:

```
Everything is tested against local servers; the first live harvest is the user's to run.
```

with:

```
Everything is tested against local servers; the first live harvest is the user's to run.

> **Status:** enrichment and fact-check (2.4) are built on branch `phase-2-enrich` (docs/plans/phase-2-enrich.md, Tasks N1-N7). User decisions 2026-09-15: `claude-opus-5` writes, with server-side fallback, and `claude-sonnet-5` checks; the only background facts are paragraphs of the author's and the work's Wikipedia articles, found through Wikidata and stored as tier 3 sources of the quote; a draft with problems gets one visible revision before `needs_review`. Where the build differs from the bullets below: the fact check sees the paragraphs the draft cites rather than every stored source, the gates also check the post shape and the cited labels, and `alt_text` is fixed text built from the quote until the media stage chooses an image. Everything is tested against local servers; a live smoke run on 2026-09-15 drafted posts for two quotes in 45 s.
```

- [ ] **Step 9: `plan.md`, milestone 2.4, the model tier**

Replace exactly:

```
- Model tier for each call is an open decision (below).
```

with:

```
- Model tier: `claude-opus-5` writes and `claude-sonnet-5` checks (open decision #6, decided 2026-09-15).
```

- [ ] **Step 10: `plan.md`, open decision #6**

Replace exactly:

```
| 6 | Claude model tier for enrichment vs. fact-check | Phase 2.4 | Consult the `claude-api` skill; the fact-check can likely use a cheaper model with a tight rubric |
```

with:

```
| 6 | Claude model tier for enrichment vs. fact-check | Phase 2.4 | **Decided 2026-09-15:** `claude-opus-5` writes (server-side fallback), `claude-sonnet-5` checks; Wikipedia paragraphs are the background sources; one visible revision before `needs_review` |
```

- [ ] **Step 11: Run everything**

Run: `npx vitest run` and `npx tsc --noEmit -p .`
Expected: 539 tests pass across 39 files; typecheck exits 0.

Run: `git diff -- claude.md plan.md | grep '^[-+]' | grep -P '[^\x00-\x7F]'`
Expected: only the added `§8` in the `claude.md` §7 paragraph; no existing line changed its characters.

- [ ] **Step 12: Commit**

```bash
git add src/cli.ts tests/cli.test.ts claude.md plan.md
git commit -m "feat(cli): lantern enrich; spec and plan record the enrichment stage and the model decision

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```
