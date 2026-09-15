# Phase 2 Wikimedia Image Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pipeline stage that gives a post its picture:

- **`lantern media --vertical literature [--limit 25] [--refresh]`** takes each post with no image, oldest first, and:
  1. Reuses the portrait already stored for that author, if there is one.
  2. Otherwise chooses one: the author's Wikidata images (`P18`) in rank order, and when none of those may be published, the files Commons records as *depicting* them (`P180`), largest first.
  3. Publishes only a public-domain or CC0 still image, at least 1500 px on its short edge, taller than it is wide, at most 64 MB, with no rights claim on the reproduction.
  4. Streams the original under `data/media/source/`, refusing it unless its size matches what Commons reported.
  5. Stores the file url, the Commons file page, the licence, the credit, the dimensions, the bytes and the sha256, and links the image to the post.

**User decisions this plan implements (2026-09-15):**

- **Fallback:** Wikidata `P18` first, then the Commons depicts search, filtered and largest first. Every pick is seen in review.
- **Rights claims:** a public-domain file whose Commons metadata mentions a copyright claim, personality rights or a trademark is skipped (spec §10: re-photographs and restorations can carry their own claims).
- **Licences:** public domain and CC0 only. `cc-by` leaves the whitelist, so a caption never carries a licence obligation. `claude.md` §10 and `plan.md` 2.5 change in this branch.
- **One portrait per author,** reused on all of that author's posts; composition (2.6) puts the quote over it.

**Architecture:**

- `src/media/commons.ts`: the lookups (Wikidata claims, Commons `imageinfo`, the depicts search) and the rules that decide whether an image may be published.
- `migrations/008_images.sql` and `src/db/images.ts`: the provenance columns, the rows, the posts that still need an image, and an attach that never replaces.
- `src/media/media.ts`: one run, its downloads and its report.
- `src/cli.ts`: `lantern media` through `runStage`, with the streaming download.

**Tech Stack:** Node 26, TypeScript 7 (strict, nodenext), vitest 5, better-sqlite3 13, zod 4, commander 15. No new dependencies: `downloadWithRetry` already streams, hashes and caps downloads, and `sharp` arrives with composition (2.6).

**Spec:** `claude.md`. The relevant sections are:

- §2.3: images must be public domain, CC0 or generated, with the licence and source url stored.
- §5, §6: a post's image row.
- §7: `lantern media` (this plan rewrites its paragraph).
- §9: never AI-generate a portrait of a real person.
- §10: image sourcing, resolution, and confirming the licence programmatically (this plan rewrites three of its paragraphs).
- §15: real response shapes, offline tests.

The parent plan is `plan.md` Part C, milestone 2.5, which also carries the **Binary downloads** prerequisite row (originals under `data/media/source/`, never the committed cache).

**Evidence gathered before this plan (2026-09-15; details in `.superpowers/sdd/phase-2-media/design-notes.md`):**

- **Every code block ran first.** Each block ran in a scratch worktree of `88244ff`: 575/575 tests across 42 files, typecheck exit 0.
- **Recorded response shapes:**
  - **Wikidata `wbgetentities&props=claims`**: `P18` is a list of statements whose `mainsnak.datavalue.value` is a file name, with `preferred`, `normal` and `deprecated` ranks. Dickens and Twain have two each.
  - **Commons `imageinfo`** (`iiprop=url|size|mime|sha1|extmetadata`) returns `url` (with a `utm_*` query that the bare url serves identically), `descriptionurl`, `size`, `width`, `height`, `mime`, `sha1`, and an `extmetadata` map whose values are HTML. The licence lives in `License` (`pd`, `cc0`, `cc-by-sa-4.0`, ...), the credit in `Artist` and `Credit`, and a rights claim appears in the text of `Credit` or `Permission` while `Restrictions` stays empty.
  - **The depicts search** (`generator=search&gsrnamespace=6&gsrsearch=haswbstatement:P180=<Q>`) returns files with their `imageinfo` in one request: 50 for Dickens, Twain and Wilde, 23 for Austen, mixing portraits with statues, plaques, book covers and group scenes.
- **The rules were run against real data.** For the four configured authors the selection chose: Dickens the Library of Congress engraving 5340x6860 (48 refused, including his 814x1190 `P18` and a CC BY-SA bust); Austen the 1870 Memoir engraving 4862x8312 (17 refused, including the c.1810 portrait's rights claim); Twain and Wilde their `P18` photographs straight away.
- **The size ceiling came from that run:** Austen's largest scan is an 83 MB png, past `downloadWithRetry`'s 50 MiB default, so a 64 MB cap in the rules takes the next candidate instead.

**Deliberately NOT in this plan:**

- A live `lantern media` run. That is the user's, after `lantern migrate` applies 006, 007 and 008.
- Composition (2.6), captions (2.7) and the review UI.
- Other image sources (Library of Congress, the Met, NYPL, Openverse) and any AI generation: §9 forbids generating a portrait of a real person, and no author in scope needs one.
- Work-specific images (a title page, a manuscript page). Commons structured data has no reliable route to them, and the user chose one portrait per author.
- A failure cap like enrich's: a media failure costs one cached request, not a model call.

## Global Constraints

- **Language and modules:** Node.js + TypeScript, ESM, strict mode on. Relative imports use `.js` extensions.
- **Unicode:**
  - Every non-ASCII character in code and tests must be a `\u` escape. Verify with `git diff | grep '^+' | grep -P '[^\x00-\x7F]'` on `.ts` files (and `grep -P '[^\x00-\x7F]' FILE` on new ones); it must print nothing.
  - If your file-writing tool turns a typed backslash-u escape into the character itself, write that line with a script instead (for example `String.fromCharCode(92) + 'u2019'`), then run the check again.
  - Added lines in SQL and prompt files stay ASCII. Existing characters in `claude.md` and `plan.md` must not be re-encoded.
- **Line endings:** count CR bytes with `tr -cd '\r' < FILE | wc -c`; it must print `0`. Never use `grep $'\r'`, which misreports in this shell.
- **Fail closed:**
  - Only a public-domain or CC0 still image, at least 1500 px on its short edge, taller than wide, at most 64 MB and free of rights claims, may be published.
  - A download whose size does not match Commons is refused.
  - A post whose image cannot be found or downloaded keeps none and is reported.
  - An image is never replaced once a post has one.
  - Any other error stops the run.
- **No real internet in tests:** use `node:http` servers on `127.0.0.1:0`, with a `fetchImpl` that routes the real hosts to them. Downloads in tests go through an injected function, never the network. Nothing is written under the real `data/` or `logs/`.
- **Originals never enter the cache:** they are streamed under the media directory (`data/media/source/`), which is git-ignored (spec §15, plan's Binary downloads row).
- **Frozen migrations:** 001-007 are frozen. New schema goes in `migrations/008_images.sql`.
- **Never commit** `.env`, `data/`, `logs/`, or `.superpowers/`.
- **Commit trailers:** every commit message ends with a blank line, then `Co-Authored-By: <the authoring model's attribution line from its environment>` and `Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v`. Verify with `git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'`, which must print `2`.
- **Branch:** `phase-2-media`, created from `phase-2-enrich` at 88244ff. The baseline is 552 tests passing across 39 files. The controller pushes after the final review; implementers never push.

### File map

```
src/media/commons.ts                    # P1: Wikidata P18, Commons imageinfo, depicts fallback, the rules (new)
tests/media/commons.test.ts             # P1 (new)
migrations/008_images.sql               # P2: provenance columns and indexes (new)
src/db/images.ts                        # P2: insert, reuse, posts needing an image, attach (new)
tests/db/images.test.ts                 # P2 (new)
src/media/media.ts                      # P3: mediaVertical (new)
tests/media/media.test.ts               # P3 (new)
src/cli.ts                              # P4: the media command
tests/cli.test.ts                       # P4: 1 test
claude.md                               # P4: sections 6, 7 and 10
plan.md                                 # P4: milestone 2.5 and the status
tests/verify/quote-gate.test.ts         # P1: one timeout, see the ruling below
```

### Test counts

| After | Suite | Files |
|---|---|---|
| baseline | 552 | 39 |
| P1 | 566 | 40 |
| P2 | 568 | 41 |
| P3 | 574 | 42 |
| P4 | 575 | 42 |

### Rulings made while designing (the controller's pre-flight starts from these)

- **The licence whitelist shrinks.** `plan.md` 2.5 allowed `cc-by`; the user chose public domain and CC0 only, which also matches §2.3's non-negotiable. `claude.md` §10 changes with the code.
- **A rights claim beats the licence tag.** Commons tags the c.1810 Austen portrait public domain while its own credit says third parties claim rights in the reproduction. Any file whose metadata mentions a copyright claim, personality rights or a trademark is skipped, as is one with a `Restrictions` value.
- **Orientation.** A portrait must be taller than it is wide, so a landscape group scene never becomes a post's picture.
- **Size ceiling.** 64 MB, from the live run: Commons' best Austen scan is 83 MB, past the downloader's own cap and far past what a 1200 px rendition needs.
- **The depicts search reads one page** of 50 results and does not follow `continue`: Commons scores by relevance, and the rules keep only a handful.
- **One portrait per author.** `subjectImage` is consulted first, so a second post by the same author downloads nothing.
- **`attachImage` never replaces.** It updates only a post whose `image_id` is null, so an approved post keeps the image it was approved with (§10).
- **The slow property test gets its own timeout.** `tests/verify/quote-gate.test.ts`'s pool test needs about 3 s alone but more than vitest's 5 s default when the whole suite competes for the CPU, and it has now failed that way twice. P1 gives it 20 s rather than leaving a flake in the suite.

---

### Task P1: The Commons lookup and the publishing rules

**Files:**
- Create: `src/media/commons.ts`
- Test: `tests/media/commons.test.ts` (new)
- Modify: `tests/verify/quote-gate.test.ts` (one timeout)

**Interfaces:**
- **Consumes:** `HttpGet` and `SourceStatusError` from `src/harvest/sources.ts`; `HttpResult` from `src/lib/http.ts`.
- **Produces:**
  - `export interface MediaEndpoints { wikidata: string; commons: string }` and `export const DEFAULT_MEDIA_ENDPOINTS: MediaEndpoints`
  - `export class ImageLookupError extends Error`
  - `export type ImageLicense = 'public-domain' | 'cc0'`, `export const MIN_SHORT_EDGE = 1500`, `export const STILL_IMAGE_TYPES`, `export const MAX_IMAGE_BYTES`, `export const DEPICTS_LIMIT = 50`
  - `export function mappedLicense(value: string): ImageLicense | null`
  - `export function claimsUrl(endpoints, qid): string`, `export function imageInfoUrl(endpoints, titles): string`, `export function depictsSearchUrl(endpoints, qid, limit): string`
  - `export async function portraitTitles(get, endpoints, qid): Promise<string[]>`
  - `export interface CommonsImage { title; fileUrl; filePageUrl; mime; bytes; width; height; license; attribution }`
  - `export function imageRefusal(info, title): string | null`
  - `export interface PortraitChoice { image: CommonsImage; refused: string[]; from: 'wikidata' | 'depicts' }`
  - `export async function bestPortrait(get, endpoints, qid): Promise<PortraitChoice>`
- **Used by:** P3 (the run) and P4 (the CLI's endpoints and byte cap).

**Why:**

- **Identity, then eligibility.** The subject's own Wikidata images come first, in rank order, because they are the curated choice. The depicts search is the fallback, and only there does size decide.
- **Every refusal is a sentence.** `bestPortrait` returns the refusals it collected, so a run's log says why Commons' best-known portrait was not used.
- **Caching.** Lookups go through the existing cached GET (`data/cache/wikidata/`, `data/cache/commons/`), and only a 200 of the expected shape is cached, so an API error answered with 200 is fetched again.

- [ ] **Step 1: Write the failing tests**

Create `tests/media/commons.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/media/commons.test.ts`
Expected: FAIL, because `../../src/media/commons.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/media/commons.ts`:

```ts
import { z } from 'zod';
import { SourceStatusError, type HttpGet } from '../harvest/sources.js';
import type { HttpResult } from '../lib/http.js';

export interface MediaEndpoints {
  wikidata: string;
  commons: string;
}

export const DEFAULT_MEDIA_ENDPOINTS: MediaEndpoints = { wikidata: 'https://www.wikidata.org', commons: 'https://commons.wikimedia.org' };

/** Commons has no image for a subject that meets the rules, or an answer could not be used. */
export class ImageLookupError extends Error {
  override name = 'ImageLookupError';
}

/** Spec section 2.3 (user decision 2026-09-15): public domain or CC0 only, so a caption carries no licence obligation. */
export type ImageLicense = 'public-domain' | 'cc0';

/** A source image must survive being cropped to 1:1 and 9:16 (spec section 10). */
export const MIN_SHORT_EDGE = 1500;

/** Still images only: a video or an SVG is not a photograph of the subject, and a PDF or DjVu is a book scan. */
export const STILL_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/tiff'] as const;

/**
 * The largest original worth keeping. Commons holds archival scans of hundreds of megabytes (the 1870
 * Austen engraving is 83 MB), which are far past what a 1200 px rendition needs; the next candidate is
 * taken instead. The media stage passes the same cap to the download, so nothing larger arrives anyway.
 */
export const MAX_IMAGE_BYTES = 64 * 1024 ** 2;

/** Wording that means someone claims rights in this reproduction, whatever the licence tag says (spec section 10). */
const CLAIMED = /copyright claim|copyright is claimed|personality rights|trademark/i;

/** Commons licence values (extmetadata `License`) this project may publish. */
export function mappedLicense(value: string): ImageLicense | null {
  const license = value.trim().toLowerCase();
  if (/^pd(-|$)/.test(license)) return 'public-domain';
  if (/^cc0(-|$)/.test(license)) return 'cc0';
  return null;
}

const metadataSchema = z.record(z.string(), z.object({ value: z.unknown() }));
const imageInfoSchema = z.object({
  url: z.string(),
  descriptionurl: z.string(),
  mime: z.string(),
  size: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  sha1: z.string(),
  extmetadata: metadataSchema.optional(),
});
const pagesSchema = z.object({
  query: z.object({ pages: z.array(z.object({ title: z.string(), missing: z.literal(true).optional(), imageinfo: z.array(imageInfoSchema).optional() })) }),
});
const entitiesSchema = z.object({
  entities: z.record(z.string(), z.object({ id: z.string(), claims: z.record(z.string(), z.array(z.unknown())).optional() })),
});
const portraitClaimsSchema = z.array(z.object({ mainsnak: z.object({ datavalue: z.object({ value: z.string() }).optional() }), rank: z.string() }));
const apiErrorSchema = z.object({ error: z.object({ code: z.string(), info: z.string() }) });

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** A cached GET of a JSON answer. Only a 200 of the expected shape is cached, so an API error answered with 200 is fetched again. */
async function getJson<T>(get: HttpGet, url: string, source: string, schema: z.ZodType<T>): Promise<T> {
  const result = await get(url, source, (r: HttpResult) => r.status === 200 && schema.safeParse(parseJson(r.body)).success);
  if (result.status !== 200) throw new SourceStatusError(result.url, result.status);
  const body = parseJson(result.body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const error = apiErrorSchema.safeParse(body);
    throw new ImageLookupError(error.success ? `${error.data.error.code} from ${url}: ${error.data.error.info}` : `unexpected answer from ${url}`);
  }
  return parsed.data;
}

export function claimsUrl(endpoints: MediaEndpoints, qid: string): string {
  return `${endpoints.wikidata}/w/api.php?action=wbgetentities&ids=${qid}&props=claims&format=json`;
}

/** The file titles of a subject's Wikidata images (P18), preferred rank first, deprecated ones dropped. */
export async function portraitTitles(get: HttpGet, endpoints: MediaEndpoints, qid: string): Promise<string[]> {
  if (!/^Q[1-9]\d*$/.test(qid)) throw new ImageLookupError(`${qid} is not a Wikidata id`);
  const { entities } = await getJson(get, claimsUrl(endpoints, qid), 'wikidata', entitiesSchema);
  const claims = entities[qid]?.claims?.['P18'];
  if (claims === undefined) return [];
  const parsed = portraitClaimsSchema.safeParse(claims);
  if (!parsed.success) throw new ImageLookupError(`${qid} has P18 claims in an unexpected shape`);
  const ranked = parsed.data.filter((claim) => claim.rank !== 'deprecated' && claim.mainsnak.datavalue !== undefined);
  const preferred = ranked.filter((claim) => claim.rank === 'preferred');
  const rest = ranked.filter((claim) => claim.rank !== 'preferred');
  return [...preferred, ...rest].map((claim) => `File:${claim.mainsnak.datavalue!.value}`);
}

export function imageInfoUrl(endpoints: MediaEndpoints, titles: readonly string[]): string {
  const query = encodeURIComponent(titles.join('|'));
  return `${endpoints.commons}/w/api.php?action=query&prop=imageinfo&iiprop=url|size|mime|sha1|extmetadata&iiextmetadatalanguage=en&format=json&formatversion=2&titles=${query}`;
}

/** Files Commons records as depicting the subject (structured data P180). One page of results, best-scoring first. */
export function depictsSearchUrl(endpoints: MediaEndpoints, qid: string, limit: number): string {
  const search = encodeURIComponent(`haswbstatement:P180=${qid}`);
  return `${endpoints.commons}/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${search}&gsrlimit=${limit}&prop=imageinfo&iiprop=url|size|mime|sha1|extmetadata&iiextmetadatalanguage=en&format=json&formatversion=2`;
}

/** How many depicts results one lookup reads. Commons scores by relevance, and the rules keep only a few. */
export const DEPICTS_LIMIT = 50;

export interface CommonsImage {
  /** The Commons file title, "File:..." included. */
  title: string;
  /** The file itself, without the tracking query Commons appends. */
  fileUrl: string;
  /** The Commons file page, which shows the licence and the credit. */
  filePageUrl: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  license: ImageLicense;
  /** The creator as Commons states it, plain text; null when Commons names none. */
  attribution: string | null;
}

/** extmetadata values are HTML; this is the plain text, with runs of whitespace collapsed. */
function plainText(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const field = (metadata: Record<string, { value: unknown }> | undefined, name: string) => plainText(metadata?.[name]?.value);

/** Why an image cannot be used, or null when it can be (spec sections 2.3 and 10). */
export function imageRefusal(info: z.infer<typeof imageInfoSchema>, title: string): string | null {
  const metadata = info.extmetadata;
  const license = mappedLicense(field(metadata, 'License'));
  if (license === null) {
    const shown = field(metadata, 'License') || 'none';
    return `${title} is licensed ${shown}, not public domain or CC0`;
  }
  if (!STILL_IMAGE_TYPES.includes(info.mime as (typeof STILL_IMAGE_TYPES)[number])) return `${title} is ${info.mime}, not a still image`;
  const short = Math.min(info.width, info.height);
  if (short < MIN_SHORT_EDGE) return `${title} is ${info.width}x${info.height}; the short edge must be at least ${MIN_SHORT_EDGE} px`;
  if (info.height <= info.width) return `${title} is ${info.width}x${info.height}; a portrait must be taller than it is wide`;
  if (info.size > MAX_IMAGE_BYTES) return `${title} is ${info.size} bytes; the file must be at most ${MAX_IMAGE_BYTES} bytes`;
  const restrictions = field(metadata, 'Restrictions');
  if (restrictions !== '') return `${title} carries the Commons restriction ${restrictions}`;
  const text = Object.values(metadata ?? {})
    .map((entry) => plainText(entry.value))
    .join(' ');
  if (CLAIMED.test(text)) return `${title} carries a third-party rights claim on the reproduction`;
  return null;
}

function toImage(title: string, info: z.infer<typeof imageInfoSchema>): CommonsImage {
  const metadata = info.extmetadata;
  const artist = field(metadata, 'Artist');
  return {
    title,
    fileUrl: info.url.split('?')[0] ?? info.url,
    filePageUrl: info.descriptionurl,
    mime: info.mime,
    bytes: info.size,
    width: info.width,
    height: info.height,
    license: mappedLicense(field(metadata, 'License'))!,
    attribution: artist === '' ? null : artist,
  };
}

export interface ImageCandidate {
  title: string;
  info: z.infer<typeof imageInfoSchema>;
}

async function candidates(get: HttpGet, url: string): Promise<ImageCandidate[]> {
  const { query } = await getJson(get, url, 'commons', pagesSchema);
  return query.pages.flatMap((page) => {
    const info = page.imageinfo?.[0];
    return page.missing === true || info === undefined ? [] : [{ title: page.title, info }];
  });
}

export interface PortraitChoice {
  image: CommonsImage;
  /** Why each rejected candidate was rejected, in the order they were considered. */
  refused: string[];
  /** Whether the image came from Wikidata's P18 or from the Commons depicts search. */
  from: 'wikidata' | 'depicts';
}

/**
 * The portrait to publish for a subject (spec section 10, user decision 2026-09-15).
 *
 * Wikidata's own images (P18) are tried first, in rank order. If none of them passes the rules, the
 * files Commons records as depicting the subject are read in one search, and the largest that passes
 * wins. A subject with nothing usable raises ImageLookupError rather than settling for a file this
 * project may not publish; no image is ever generated for a person (spec section 9).
 */
export async function bestPortrait(get: HttpGet, endpoints: MediaEndpoints, qid: string): Promise<PortraitChoice> {
  const refused: string[] = [];
  const titles = await portraitTitles(get, endpoints, qid);
  if (titles.length > 0) {
    const named = await candidates(get, imageInfoUrl(endpoints, titles));
    // Commons answers in its own order, so the P18 order is restored here.
    for (const title of titles) {
      const candidate = named.find((entry) => entry.title === title);
      if (candidate === undefined) {
        refused.push(`${title} is not on Commons`);
        continue;
      }
      const refusal = imageRefusal(candidate.info, title);
      if (refusal === null) return { image: toImage(title, candidate.info), refused, from: 'wikidata' };
      refused.push(refusal);
    }
  }

  const depicted = await candidates(get, depictsSearchUrl(endpoints, qid, DEPICTS_LIMIT));
  const usable: CommonsImage[] = [];
  for (const candidate of depicted) {
    const refusal = imageRefusal(candidate.info, candidate.title);
    if (refusal === null) usable.push(toImage(candidate.title, candidate.info));
    else refused.push(refusal);
  }
  usable.sort((a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height));
  const best = usable[0];
  if (best === undefined) throw new ImageLookupError(`no Commons image for ${qid} meets the rules (${refused.length} refused)`);
  return { image: best, refused, from: 'depicts' };
}
```

- [ ] **Step 4: Give the slow property test its own timeout**

In `tests/verify/quote-gate.test.ts`, the pool test ends with `  });`. Replace exactly:

```ts
    }
    expect(verified).toBeGreaterThan(0);
  });
```

with:

```ts
    }
    expect(verified).toBeGreaterThan(0);
  }, 20_000);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/media/commons.test.ts tests/verify/quote-gate.test.ts`
Expected: PASS, 14 tests in the new file.

Run: `npx vitest run` and `npx tsc --noEmit -p .`
Expected: 566 tests pass across 40 files; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/media/commons.ts tests/media/commons.test.ts tests/verify/quote-gate.test.ts
git commit -m "feat(media): Commons portrait lookup with the publishing rules

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task P2: The images table and its rows

**Files:**
- Create: `migrations/008_images.sql`, `src/db/images.ts`
- Test: `tests/db/images.test.ts` (new)

**Interfaces:**
- **Consumes:** `ImageLicense` from `src/media/commons.ts` (P1).
- **Produces:**
  - `export interface NewImage { subjectId; origin: 'wikimedia'; sourceUrl; filePageUrl; license; attribution; localPath; width; height; mime; bytes; sha256 }`
  - `export interface StoredImage { id; sourceUrl; localPath; license }`
  - `export function insertImage(db, image, now?): number`
  - `export function subjectImage(db, subjectId): StoredImage | undefined`
  - `export interface PostNeedingImage { postId; itemId; subjectId; subjectSlug; author; wikidataId }`
  - `export function postsNeedingImage(db, verticalId, limit): PostNeedingImage[]`
  - `export function attachImage(db, postId, imageId): boolean`
- **Used by:** P3.

**Why:**

- **Provenance is the point (§2.3).** The row keeps the file url, the file page, the licence, the credit, the dimensions, the bytes and the sha256, so a licence can be re-checked later and the stored file proved to be the one Commons served.
- **A re-run downloads nothing.** `insertImage` returns the existing row for the same subject and url, and a unique index enforces it.
- **`attachImage` never replaces.** It updates only a post with no image, which is how §10's "never overwrites an image on an already-approved post" is kept.

- [ ] **Step 1: Write the failing tests**

Create `tests/db/images.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/images.test.ts`
Expected: FAIL, because `../../src/db/images.js` does not exist.

- [ ] **Step 3: Implement**

Create `migrations/008_images.sql`:

```sql
-- Image provenance for lantern media (spec sections 2.3 and 10): enough to re-check a licence
-- later, and to prove the stored file is the one Commons served.
ALTER TABLE images ADD COLUMN file_page_url TEXT;   -- the Commons file page, where the licence and credit are shown
ALTER TABLE images ADD COLUMN mime TEXT;
ALTER TABLE images ADD COLUMN bytes INTEGER;
ALTER TABLE images ADD COLUMN sha256 TEXT;          -- of the downloaded original

-- One row per source file per subject, so a re-run reuses the stored image instead of downloading it again.
CREATE UNIQUE INDEX idx_images_subject_source ON images(subject_id, source_url);
CREATE INDEX idx_images_item ON images(item_id);
```

Create `src/db/images.ts`:

```ts
import type { ImageLicense } from '../media/commons.js';
import type { Db } from './connection.js';

export interface NewImage {
  subjectId: number;
  /** Where the file came from (spec section 6); Commons is the only origin this stage uses. */
  origin: 'wikimedia';
  /** The file url, without any tracking query. */
  sourceUrl: string;
  /** The Commons file page, which shows the licence and the credit. */
  filePageUrl: string;
  license: ImageLicense;
  /** The creator as Commons states it, or null when it names none. */
  attribution: string | null;
  /** Where the original is kept, relative to the media directory. */
  localPath: string;
  width: number;
  height: number;
  mime: string;
  bytes: number;
  sha256: string;
}

export interface StoredImage {
  id: number;
  sourceUrl: string;
  localPath: string;
  license: string;
}

/** Inserts the image, or returns the row this subject already has for that source url (a re-run downloads nothing). */
export function insertImage(db: Db, image: NewImage, now: Date = new Date()): number {
  const existing = db.prepare('SELECT id FROM images WHERE subject_id = ? AND source_url = ?').pluck().get(image.subjectId, image.sourceUrl) as
    | number
    | undefined;
  if (existing !== undefined) return existing;
  return Number(
    db
      .prepare(
        `INSERT INTO images (subject_id, origin, source_url, file_page_url, license, attribution, local_path, width, height, mime, bytes, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        image.subjectId,
        image.origin,
        image.sourceUrl,
        image.filePageUrl,
        image.license,
        image.attribution,
        image.localPath,
        image.width,
        image.height,
        image.mime,
        image.bytes,
        image.sha256,
        now.toISOString(),
      ).lastInsertRowid,
  );
}

/** The image already stored for a subject, if any: the same portrait is reused for all of that subject's posts. */
export function subjectImage(db: Db, subjectId: number): StoredImage | undefined {
  return db
    .prepare('SELECT id, source_url AS sourceUrl, local_path AS localPath, license FROM images WHERE subject_id = ? ORDER BY id LIMIT 1')
    .get(subjectId) as StoredImage | undefined;
}

export interface PostNeedingImage {
  postId: number;
  itemId: number;
  subjectId: number;
  subjectSlug: string;
  author: string;
  wikidataId: string;
}

/**
 * Posts of a vertical that have no image yet, oldest first. A post that already has one is never
 * returned, so an approved post keeps the image it was approved with (spec section 10). A subject
 * without a Wikidata id cannot be looked up and is left out.
 */
export function postsNeedingImage(db: Db, verticalId: number, limit: number): PostNeedingImage[] {
  return db
    .prepare(
      `SELECT p.id AS postId, i.id AS itemId, s.id AS subjectId, s.slug AS subjectSlug, s.name AS author, s.wikidata_id AS wikidataId
       FROM posts p
       JOIN items i ON i.id = p.item_id
       JOIN subjects s ON s.id = i.subject_id
       WHERE p.vertical_id = ? AND p.image_id IS NULL AND s.wikidata_id IS NOT NULL
       ORDER BY p.id
       LIMIT ?`,
    )
    .all(verticalId, limit) as PostNeedingImage[];
}

/** Links an image to a post that has none. Returns false when the post already has one: an image is never replaced. */
export function attachImage(db: Db, postId: number, imageId: number): boolean {
  return db.prepare('UPDATE posts SET image_id = ? WHERE id = ? AND image_id IS NULL').run(imageId, postId).changes === 1;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/db/images.test.ts tests/db tests/doctor`
Expected: PASS; the new file has 2 tests, and the migration and doctor tests still pass with 008 applied.

Run: `npx vitest run` and `npx tsc --noEmit -p .`
Expected: 568 tests pass across 41 files; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add migrations/008_images.sql src/db/images.ts tests/db/images.test.ts
git commit -m "feat(db): image provenance columns, rows and the posts that still need a picture

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task P3: Give a vertical's posts their images

**Files:**
- Create: `src/media/media.ts`
- Test: `tests/media/media.test.ts` (new)

**Interfaces:**
- **Consumes:** P1's `bestPortrait`, `ImageLookupError`, `CommonsImage`, `MediaEndpoints`; P2's `attachImage`, `insertImage`, `postsNeedingImage`, `subjectImage`; `SourceStatusError` and `HttpGet` from `src/harvest/sources.ts`; `DownloadStatusError` and `DownloadTooLargeError` from `src/lib/download.ts`; `Logger`.
- **Produces:**
  - `export type DownloadFn = (url: string, destPath: string) => Promise<{ bytes: number; sha256: string }>`
  - `export interface MediaOptions { db; verticalId; get; endpoints; download; mediaDir; limit; now?; log? }`
  - `export type PostOutcome` (`attached` | `reused` | `failed`), `export interface PostImageReport`, `export interface MediaReport`
  - `export function imagePath(subjectSlug, image): string`
  - `export async function mediaVertical(options): Promise<MediaReport>`
- **Used by:** P4.

**Why:**

- **The download is injected,** so the tests exercise the whole run without a network: the real CLI passes `downloadWithRetry`.
- **The size check is the last gate.** Commons states a size; a file that arrives shorter or longer is refused rather than stored.
- **Errors by kind.** A lookup or download failure fails one post and the run moves on, so one missing portrait cannot stop a scheduled run; anything else stops it.

- [ ] **Step 1: Write the failing tests**

Create `tests/media/media.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpGet } from '../../src/harvest/sources.js';
import { DownloadStatusError } from '../../src/lib/download.js';
import { claimsUrl, DEFAULT_MEDIA_ENDPOINTS, DEPICTS_LIMIT, depictsSearchUrl, imageInfoUrl } from '../../src/media/commons.js';
import { imagePath, mediaVertical, type DownloadFn } from '../../src/media/media.js';
import { testDb } from '../helpers/db.js';

const UA = 'Lantern/test (test@example.invalid)';
const E = DEFAULT_MEDIA_ENDPOINTS;
const NOW = () => new Date('2026-09-15T00:00:00.000Z');
const BYTES = 3_875_170;
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
      sha1: 'f6198b4d72ea8e71ac08b93279ae9d5f7342d919',
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
    return { bytes, sha256: 'b'.repeat(64) };
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

describe('imagePath', () => {
  it('names the original after the subject and the Commons title', () => {
    expect(imagePath('charles-dickens', { title: 'File:Charles Dickens LCCN2003653043.jpg', mime: 'image/jpeg' } as never)).toBe(
      'source/charles-dickens-charles-dickens-lccn2003653043.jpg',
    );
    expect(imagePath('jane-austen', { title: 'File:Memoir scan.png', mime: 'image/png' } as never)).toBe('source/jane-austen-memoir-scan.png');
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
      items: [{ postId, author: 'Charles Dickens', outcome: { status: 'attached', imageId: expect.any(Number), title: 'File:Portrait.jpg', from: 'wikidata', refused: 0 } }],
    });
    expect(download.calls).toEqual([
      { url: 'https://upload.wikimedia.org/wikipedia/commons/a/aa/Portrait.jpg', destPath: join(mediaDir, 'source', 'charles-dickens-portrait.jpg') },
    ]);
    expect(db.prepare('SELECT source_url, file_page_url, license, attribution, local_path, width, height, mime, bytes, sha256 FROM images').get()).toEqual({
      source_url: 'https://upload.wikimedia.org/wikipedia/commons/a/aa/Portrait.jpg',
      file_page_url: 'https://commons.wikimedia.org/wiki/File:Portrait.jpg',
      license: 'public-domain',
      attribution: 'Popular Graphic Arts',
      local_path: 'source/charles-dickens-portrait.jpg',
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/media/media.test.ts`
Expected: FAIL, because `../../src/media/media.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/media/media.ts`:

```ts
import { join } from 'node:path';
import type { Db } from '../db/connection.js';
import { attachImage, insertImage, postsNeedingImage, subjectImage, type PostNeedingImage } from '../db/images.js';
import { SourceStatusError, type HttpGet } from '../harvest/sources.js';
import { DownloadStatusError, DownloadTooLargeError } from '../lib/download.js';
import type { Logger } from '../lib/log.js';
import { bestPortrait, ImageLookupError, type CommonsImage, type MediaEndpoints } from './commons.js';

/** Streams a url to a path and reports what landed there; `downloadWithRetry` has this shape. */
export type DownloadFn = (url: string, destPath: string) => Promise<{ bytes: number; sha256: string }>;

export interface MediaOptions {
  db: Db;
  verticalId: number;
  get: HttpGet;
  endpoints: MediaEndpoints;
  download: DownloadFn;
  /** The media directory; originals are kept under its `source/` folder, never in the cache. */
  mediaDir: string;
  /** The most posts to give an image in one run. */
  limit: number;
  now?: () => Date;
  log?: Logger;
}

export type PostOutcome =
  | { status: 'attached'; imageId: number; title: string; from: 'wikidata' | 'depicts'; refused: number }
  | { status: 'reused'; imageId: number }
  | { status: 'failed'; reason: string };

export interface PostImageReport {
  postId: number;
  author: string;
  outcome: PostOutcome;
}

export interface MediaReport {
  /** Posts without an image that this run took up. */
  considered: number;
  attached: number;
  reused: number;
  failed: number;
  items: PostImageReport[];
}

const EXTENSIONS: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/tiff': '.tif' };

/** Where a subject's original is kept, relative to the media directory: readable, and the same every run. */
export function imagePath(subjectSlug: string, image: CommonsImage): string {
  const name = image.title
    .replace(/^File:/, '')
    .replace(/\.[A-Za-z0-9]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return `source/${subjectSlug}-${name}${EXTENSIONS[image.mime] ?? '.bin'}`;
}

/**
 * Gives a vertical's posts their source image (spec section 7, `lantern media`).
 *
 * Each post without an image is taken oldest first. A subject whose image is already stored reuses it,
 * so one portrait serves all of that author's posts (user decision 2026-09-15) and nothing is
 * downloaded twice. Otherwise the portrait is chosen from Wikidata's P18, or from the files Commons
 * records as depicting the subject, and only a public-domain or CC0 still image large enough to crop
 * both ways can win (spec sections 2.3 and 10). The original is streamed under `data/media/source/`,
 * never into the response cache, and is refused when its size does not match what Commons reported.
 *
 * A post whose image cannot be found or downloaded is reported as failed and keeps no image; the run
 * continues, and the next run tries it again. Any other error stops the run.
 */
export async function mediaVertical(options: MediaOptions): Promise<MediaReport> {
  const now = options.now ?? (() => new Date());
  const posts = postsNeedingImage(options.db, options.verticalId, options.limit);
  const report: MediaReport = { considered: posts.length, attached: 0, reused: 0, failed: 0, items: [] };
  for (const post of posts) {
    let outcome: PostOutcome;
    try {
      outcome = await imageFor(options, post, now());
    } catch (err) {
      if (
        !(
          err instanceof ImageLookupError ||
          err instanceof SourceStatusError ||
          err instanceof DownloadStatusError ||
          err instanceof DownloadTooLargeError
        )
      ) {
        throw err;
      }
      outcome = { status: 'failed', reason: err.message };
    }
    if (outcome.status === 'attached') report.attached++;
    else if (outcome.status === 'reused') report.reused++;
    else report.failed++;
    report.items.push({ postId: post.postId, author: post.author, outcome });
    options.log?.info('media post', { postId: post.postId, outcome });
  }
  return report;
}

async function imageFor(options: MediaOptions, post: PostNeedingImage, now: Date): Promise<PostOutcome> {
  const stored = subjectImage(options.db, post.subjectId);
  if (stored !== undefined) {
    attachImage(options.db, post.postId, stored.id);
    return { status: 'reused', imageId: stored.id };
  }

  const choice = await bestPortrait(options.get, options.endpoints, post.wikidataId);
  const localPath = imagePath(post.subjectSlug, choice.image);
  const downloaded = await options.download(choice.image.fileUrl, join(options.mediaDir, localPath));
  if (downloaded.bytes !== choice.image.bytes) {
    throw new ImageLookupError(`${choice.image.title} downloaded as ${downloaded.bytes} bytes, but Commons reported ${choice.image.bytes}`);
  }
  options.log?.info('media downloaded an image', {
    subjectId: post.subjectId,
    title: choice.image.title,
    from: choice.from,
    refused: choice.refused,
  });
  const imageId = insertImage(
    options.db,
    {
      subjectId: post.subjectId,
      origin: 'wikimedia',
      sourceUrl: choice.image.fileUrl,
      filePageUrl: choice.image.filePageUrl,
      license: choice.image.license,
      attribution: choice.image.attribution,
      localPath,
      width: choice.image.width,
      height: choice.image.height,
      mime: choice.image.mime,
      bytes: downloaded.bytes,
      sha256: downloaded.sha256,
    },
    now,
  );
  attachImage(options.db, post.postId, imageId);
  return { status: 'attached', imageId, title: choice.image.title, from: choice.from, refused: choice.refused.length };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/media/media.test.ts`
Expected: PASS, 6 tests.

Run: `npx vitest run` and `npx tsc --noEmit -p .`
Expected: 574 tests pass across 42 files; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/media/media.ts tests/media/media.test.ts
git commit -m "feat(media): give a vertical's posts their public-domain portraits

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task P4: `lantern media`, spec and plan

**Files:**
- Modify: `src/cli.ts`, `tests/cli.test.ts`, `claude.md`, `plan.md`

**Interfaces:**
- **Consumes:** `mediaVertical` and `PostImageReport` (P3); `DEFAULT_MEDIA_ENDPOINTS` and `MAX_IMAGE_BYTES` (P1); `downloadWithRetry` from `src/lib/download.ts`.
- **Produces:** `lantern media --vertical <slug> [--limit 25] [--refresh]`, whose startup checks run in order before any fetch: the limit, pending migrations, then the vertical.
- **Used by:** the user's first live media run.

**Why:**

- **The command.** It runs through `runStage` (§7: every stage writes `run_log`) and streams originals with the same byte cap the rules use.
- **Exit code.** It exits 1 when any post could not be given an image, so a cron log shows it.
- **Docs.** §6, §7 and §10 change in the same branch as the code (§15), and `plan.md` records the decisions.

- [ ] **Step 1: Add the CLI test**

In `tests/cli.test.ts`, add this test just before the final `});` of the `describe('lantern CLI', ...)` block:

```ts
  it('media refuses a bad limit, pending migrations and an unknown vertical, and writes nothing when no post needs an image', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const badLimit = lantern(['media', '--vertical', 'literature', '--limit', '0'], scratch);
    expect(badLimit.code).toBe(1);
    expect(badLimit.out).toContain('--limit must be a positive integer, got 0');

    const pending = lantern(['media', '--vertical', 'literature'], scratch);
    expect(pending.code).toBe(1);
    expect(pending.out).toContain('run lantern migrate');

    expect(lantern(['migrate'], scratch).code).toBe(0);
    const unknown = lantern(['media', '--vertical', 'poetry'], scratch);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain('unknown vertical: poetry');

    const media = join(scratch, 'media');
    const res = lantern(['media', '--vertical', 'literature'], scratch, { env: { LANTERN_MEDIA: media, LANTERN_CACHE: join(scratch, 'cache') } });
    expect(res.code).toBe(0);
    expect(res.out).toContain('images: 0 downloaded, 0 reused; failed: 0');
    expect(existsSync(media)).toBe(false);
  }, 60_000);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL, because commander rejects the unknown command `media`.

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
import { MAX_ENRICH_FAILURES } from './db/posts.js';
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
import { downloadWithRetry } from './lib/download.js';
import { buildUserAgent } from './lib/http.js';
import { createLogger } from './lib/log.js';
import { findProjectRoot, resolvePaths } from './lib/paths.js';
import { runStage } from './lib/run-stage.js';
import { DEFAULT_MEDIA_ENDPOINTS, MAX_IMAGE_BYTES } from './media/commons.js';
import { mediaVertical, type PostImageReport } from './media/media.js';
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
      // Gutendex can take more than a minute to answer a search; Wikidata and Wikipedia answer far sooner.
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

function describeImage(item: PostImageReport): string {
  const head = `post ${item.postId} (${item.author})`;
  const outcome = item.outcome;
  if (outcome.status === 'failed') return `${head}: failed (${outcome.reason})`;
  if (outcome.status === 'reused') return `${head}: image ${outcome.imageId} reused`;
  return `${head}: image ${outcome.imageId} from ${outcome.title} (${outcome.from}; ${outcome.refused} refused)`;
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
  .option('--retry-failed', `also try quotes that have already failed ${MAX_ENRICH_FAILURES} times`)
  .action(async (opts: { vertical: string; limit: string; refresh?: boolean; retryFailed?: boolean }) => {
    const limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer, got ${opts.limit}`);
    const db = openMigratedDb();
    const { vertical, verticalId } = findVertical(db, opts.vertical);
    const enrich = vertical.enrich;
    if (enrich === undefined) throw new Error(`vertical ${vertical.slug} has no enrich section`);
    if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('ANTHROPIC_API_KEY is not set; the writer and the fact check need it');
    const prompts = loadEnrichPrompts(paths.root, vertical.slug);

    // A writer call can think for minutes before it answers (the SDK estimates up to 450 s for 16000 tokens).
    // A call only reads, so retrying it is safe.
    const client = new Anthropic({ timeout: 600_000, maxRetries: 2 });
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
        retryFailed: opts.retryFailed === true,
        log,
      }),
    );
    for (const item of report.items) console.log(describeItem(item));
    console.log(`posts: ${report.drafted} draft, ${report.needsReview} needs review; failed: ${report.failed}`);
    if (report.givenUp > 0) {
      console.log(`given up after ${MAX_ENRICH_FAILURES} failed attempts: ${report.givenUp} (run with --retry-failed to try them again)`);
    }
    if (report.failed > 0) process.exitCode = 1;
  });

program
  .command('media')
  .description('Give each post a public-domain source image from Wikimedia Commons; exits 1 if a post could not be given one')
  .requiredOption('--vertical <slug>', 'the vertical to give images')
  .option('--limit <n>', 'give an image to at most this many posts', '25')
  .option('--refresh', 'ignore cached Wikidata and Commons responses and fetch again')
  .action(async (opts: { vertical: string; limit: string; refresh?: boolean }) => {
    const limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer, got ${opts.limit}`);
    const db = openMigratedDb();
    const { verticalId } = findVertical(db, opts.vertical);
    const userAgent = buildUserAgent(process.env.LANTERN_CONTACT, USER_AGENT_VERSION);
    const report = await runStage(db, { stage: 'media', verticalId }, () =>
      mediaVertical({
        db,
        verticalId,
        get: cachedGet(opts.refresh === true),
        endpoints: DEFAULT_MEDIA_ENDPOINTS,
        // Originals are streamed under data/media/source/, never into the response cache.
        download: async (url, destPath) =>
          downloadWithRetry(url, destPath, {
            userAgent,
            maxBytes: MAX_IMAGE_BYTES,
            onRetry: (event) => log.warn('download retry', { ...event, url: redactUrl(event.url) }),
          }),
        mediaDir: paths.media,
        limit,
        log,
      }),
    );
    for (const item of report.items) console.log(describeImage(item));
    console.log(`images: ${report.attached} downloaded, ${report.reused} reused; failed: ${report.failed}`);
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

The changes: the `downloadWithRetry`, `DEFAULT_MEDIA_ENDPOINTS`/`MAX_IMAGE_BYTES` and `mediaVertical` imports, `describeImage`, and the `media` command before `doctor`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/cli.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: `claude.md`, section 6, the images row keeps its provenance**

Replace exactly:

```
  license       TEXT NOT NULL,          -- 'public-domain'|'cc0'|'cc-by'|'generated'
  attribution   TEXT,
  local_path    TEXT NOT NULL,
  width         INTEGER, height INTEGER,
  created_at    TEXT NOT NULL
);
```

with:

```
  license       TEXT NOT NULL,          -- 'public-domain'|'cc0'|'generated'
  attribution   TEXT,                   -- the creator as the source states it
  local_path    TEXT NOT NULL,          -- the original, relative to the media directory
  width         INTEGER, height INTEGER,
  file_page_url TEXT,                   -- the source's own page for the file, where the licence is shown
  mime          TEXT,
  bytes         INTEGER,
  sha256        TEXT,                   -- of the downloaded original
  created_at    TEXT NOT NULL
);
```

- [ ] **Step 6: `claude.md`, section 7, `lantern media`**

Replace exactly:

```
**`lantern media --vertical literature`**
Resolve a source image (§10). Public domain first, AI generation as fallback.
Stores license + attribution on the `images` row and links it to the post.
Never overwrites an image on an already-approved post.
```

with:

```
**`lantern media --vertical literature --limit 25`**
Give each post without an image a source image (§10). For an author, the
portrait comes from their Wikidata `P18`, and when none of those images may be
published, from the files Commons records as depicting them (`P180`), largest
first. Only a public-domain or CC0 still image, at least 1500 px on its short
edge, taller than it is wide and at most 64 MB, can win; anything carrying a
rights claim on the reproduction is skipped. The original is streamed under
`data/media/source/` (never into the response cache) and is refused unless its
size matches what Commons reported. The `images` row keeps the file url, the
file page, the licence, the credit, the dimensions and the sha256, and one
portrait serves every post about that author. A post whose image cannot be found
or downloaded keeps none, is reported, and is tried again on the next run; the
command then exits 1. An image is never replaced, so an approved post keeps the
image it was approved with.
```

- [ ] **Step 7: `claude.md`, section 10, the Commons fallback**

Replace exactly:

```
1. **Wikimedia Commons** — MediaWiki API. Resolve the subject's Wikidata
   Q-number, read the `P18` (image) property, then pull the file and its license
   metadata. This covers nearly every historical author.
```

with:

```
1. **Wikimedia Commons** — MediaWiki API. Resolve the subject's Wikidata
   Q-number, read the `P18` (image) property, then pull the file and its license
   metadata. This covers nearly every historical author. When no `P18` image is
   publishable — Dickens's is 814 px on its short edge, and the other is
   CC BY-SA — fall back to the files Commons records as *depicting* the subject
   (structured data `P180`), and take the largest that passes the rules.
```

- [ ] **Step 8: `claude.md`, section 10, licences and rights claims**

Replace exactly:

```
Always confirm the license programmatically from the API response. Never infer
"it's old so it's fine" — re-photographs and restorations can carry their own
claims. Store `license` and `attribution`, and render attribution in the caption
when the license asks for it.
```

with:

```
Always confirm the license programmatically from the API response. Only
`public-domain` and `cc0` may be published (§2.3), so a caption never carries a
licence obligation. Never infer "it's old so it's fine" — re-photographs and
restorations can carry their own claims, so a file whose metadata mentions a
copyright claim, personality rights or a trademark is skipped even when it is
tagged public domain, and so is one with a Commons `Restrictions` value. Store
`license` and `attribution`, and render attribution in the caption when the
license asks for it.
```

- [ ] **Step 9: `claude.md`, section 10, the size ceiling**

Replace exactly:

```
**Resolution matters more now.** A source image has to survive being cropped to
both 1:1 and 9:16. Reject sources below ~1500px on the short edge, and store
enough of the original that a re-crop never needs a re-download.
```

with:

```
**Resolution matters more now.** A source image has to survive being cropped to
both 1:1 and 9:16. Reject sources below ~1500px on the short edge, and store
enough of the original that a re-crop never needs a re-download. Reject the
other extreme too: Commons keeps archival scans of hundreds of megabytes, so
anything past 64 MB is skipped for the next usable candidate.
```

- [ ] **Step 10: `plan.md`, milestone 2.5, the licence whitelist**

Replace exactly:

```
- Wikidata `P18` → Commons `imageinfo` + `extmetadata`. Map the license to the whitelist (`public-domain` | `cc0` | `cc-by`); anything else is rejected. Store attribution.
```

with:

```
- Wikidata `P18` → Commons `imageinfo` + `extmetadata`. Map the license to the whitelist (`public-domain` | `cc0`, user decision 2026-09-15); anything else is rejected. Store attribution.
```

- [ ] **Step 11: `plan.md`, the Phase 2 status for media**

Replace exactly:

```
Everything is tested against local servers; two live smoke runs on 2026-09-15 drafted posts for two quotes each in about 45 s, and one of them exercised the revision.
```

with:

```
Everything is tested against local servers; two live smoke runs on 2026-09-15 drafted posts for two quotes each in about 45 s, and one of them exercised the revision.

> **Status:** the Wikimedia image lookup (2.5) is built on branch `phase-2-media` (docs/plans/phase-2-media.md, Tasks P1-P4). User decisions 2026-09-15: an author's portrait comes from Wikidata `P18` and then from the files Commons records as depicting them; only public domain and CC0 (not `cc-by`) may be published; a file carrying a third-party rights claim is skipped; one portrait serves all of that author's posts. Migration 008 keeps the file page, mime, bytes and sha256 on `images`. A live run of the selection code on 2026-09-15 chose a portrait for all four authors: Dickens and Austen through the depicts fallback (their `P18` images are too small, CC BY-SA, or rights-claimed), Twain and Wilde straight from `P18`.
```

- [ ] **Step 12: Run everything**

Run: `npx vitest run` and `npx tsc --noEmit -p .`
Expected: 575 tests pass across 42 files; typecheck exits 0.

Run: `git diff -- claude.md plan.md | grep '^[-+]' | grep -P '[^\x00-\x7F]'`
Expected: only the lines that already carried `§` or `—` in the passages being replaced; no existing line changes its characters.

- [ ] **Step 13: Commit**

```bash
git add src/cli.ts tests/cli.test.ts claude.md plan.md
git commit -m "feat(cli): lantern media; spec and plan record the image rules

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```
