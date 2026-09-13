# Phase 2 Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Phase 2 groundwork that needs no user decision: harden text normalization and pin it with a golden hash (review M4), make quote location fast on novel-sized texts (review M5), and build the HTTP client and response cache every harvester will use (milestone C0).

**Architecture:** The normalization hardening and prepared-haystack work are additive changes to `src/verify/normalize.ts`. The existing dedupe and location contract stays intact: `normalizeText ≡ normalizeWithMap(x).text`. The HTTP client (`src/lib/http.ts`) retries only 5xx, 429 and network failures, and always sends a contact `User-Agent`. The cache (`src/lib/cache.ts`) is a read-through layer. It keys each request on a secret-redacted form of the request and stores responses as committed test fixtures under `data/cache/<source>/`.

**Tech Stack:** Node 26 built-in `fetch`, `node:http` (test servers), `node:crypto`, and `node:fs`. TypeScript 7 (strict, nodenext) and vitest 5 are already in the repo. No new dependencies.

**Spec:** `claude.md` (§4 stack, §8 verification, §15 working agreements). Parent plan: `plan.md` — Part C "C0 — HTTP client and response cache" and "Prerequisites carried from the Part B final review" (rows **Normalization hardening + golden hash** and **Large-text performance**).

## Global Constraints

- Node.js + TypeScript, **ESM**, **strict mode on**. Relative imports use `.js` extensions.
- **Unicode:** write every non-ASCII character in code and tests as a `\u` escape, never as a literal glyph. Transcription can silently fold typographic characters, which turns a test into one that asserts nothing.
- **Fail closed.** A changed `body_hash` wipes the rejection dedupe memory, so normalization changes must be deliberate and pinned by the golden-hash test.
- The HTTP client **never retries a 4xx that is not 429** (spec §11: "Never retry a 4xx that is not a rate limit — fix it instead").
- The `User-Agent` must carry a contact read from `LANTERN_CONTACT`. **Never hardcode an email address or URL** in code, tests or fixtures. Tests use `test@example.invalid`.
- Tests make **no real internet requests**. HTTP tests use a throwaway `node:http` server on `127.0.0.1` port 0.
- `data/cache/` is committed (test fixtures, spec §15). **Secrets must never be written into it.** Query parameters whose names look like credentials are redacted before keying and storing.
- Never commit `.env`, `data/lantern.db`, `data/media/`, `logs/`, or `.superpowers/`.
- Every commit message ends with a blank line and these two trailers, verified with `git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'` (must print `2`):
  - `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  - `Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v`
- Work on branch `phase-2-foundations`, which was created from `phase-2-verification-core` at 8dbe976. Baseline: 121 tests pass across 14 files.

### File map

```
src/verify/normalize.ts      # F1: delete \p{Cf}; F2: Uint32Array map, prepareHaystack, locateQuoteIn
tests/verify/normalize.test.ts
src/lib/http.ts              # F3: fetchWithRetry, retryDelayMs, buildUserAgent, HttpError
tests/lib/http.test.ts
src/lib/cache.ts             # F4: cachedFetch, cacheKey, redactUrl
tests/lib/cache.test.ts
.env.example                 # F3: LANTERN_CONTACT
claude.md                    # F4: §4 lib/ layout line
plan.md                      # F2, F4: status notes on the prerequisite rows and C0
```

---

## As built — where the committed code differs from the task code below

Per-task review found gaps in some of the reference code. Those gaps were fixed, so where the code and this plan disagree, **the committed code is authoritative**:

- **F2 — equivalence test.** The reference test "locateQuoteIn … matches locateQuote" compared the function with its own wrapper, so it could never fail. As built, it asserts exact hand-computed offsets (0..52, 65..78, 72..78, and `null` for a miss) plus one delegation check. It was proven to fail when the end-offset computation was deliberately broken.
- **F3 — `retryDelayMs`.** `Date.parse` runs only when the `Retry-After` value contains a letter. Bare numerics such as `1.5` or `-1`, which `Date.parse` reads as dates in 2001, now fall back to exponential backoff instead of retrying instantly.
- **F3 — body read inside the retry.** `res.text()` runs inside the same `try` as `fetch`. A truncated body is therefore retried, and if every attempt is truncated it is thrown as `HttpError` with the read error as `cause`.
- **F3 — User-Agent.** Headers are built with `new Headers(req.headers)` followed by `.set('user-agent', …)`, so a caller header of any letter case cannot be merged with the contact User-Agent.
- **F3 — `maxAttempts` guard.** `maxAttempts` must be an integer ≥ 1; otherwise a `RangeError` is thrown before any request.
- **F4 — exact-name redaction.** The reference substring regex matched `author` via `auth`, so `?author=Dickens` and `?author=Austen` shared one cache key and one author's response was served for the other. As built, credential parameters are matched by exact name after lowercasing and removing `-`/`_` (`key`, `apikey`, `token`, `accesstoken`, `sig`, `jwt`, `x-amz-*`/`x-goog-*` signatures, …). Ambiguous short names such as `code`, `sid` and `session` are deliberately not redacted, because that would recreate the collision.
- **F4 — fragments, headers, echoes.** URL fragments are stripped. Response headers are stored from an allowlist (`content-type`, `content-language`, `etag`, `last-modified`, `link`, `date`). A fresh body that contains any redacted credential value of 8 or more characters is returned but not cached.
- **Test counts.** F3 has 28 tests (not 19) and F4 has 20 (not 15), so the full-suite targets become 158 after F3 and 178 after F4 (not 149 and 164).

Deferred and recorded in `plan.md` Part C prerequisites:
- A request timeout / `AbortSignal`.
- Validating caller headers outside the retry `try`. An invalid header name is currently retried and then reported as a network `HttpError`.
- The cache echo guard inspects only the request URL. A credential sent in a POST body or request header would not be recognized if a response echoed it.

---

### Task F1: Normalization hardening and golden hash

**Files:**
- Modify: `src/verify/normalize.ts`
- Test: `tests/verify/normalize.test.ts` (append)

**Interfaces:**
- Consumes: the existing `normalizeWithMap`, `normalizeText`, `bodyHash`, `locateQuote`.
- Produces: no new exports. Behavior change: Unicode format characters (`\p{Cf}`, e.g. soft hyphen U+00AD, zero-width space/joiners U+200B–U+200D, word joiner U+2060, BOM U+FEFF, directional marks U+200E/U+200F) are **deleted** during normalization instead of acting as word separators.

Why: today `won\u00ADderful` normalizes to `won derful`. That splits one word into two, and it lets `'derful thing to see today'` be located mid-word. Deleting format characters produces no visible change and keeps words whole. This must land before Part C 2.1 inserts its first `items` row. Any normalization change after that shifts `body_hash` values, and the rejected-quote dedupe memory would stop matching.

- [ ] **Step 1: Write the tests** — append to `tests/verify/normalize.test.ts`

```ts
describe('normalization hardening', () => {
  it('pins the golden body hash so normalization changes are deliberate', () => {
    expect(bodyHash('It was the best of times, it was the worst of times.')).toBe(
      'af8da705bfd95621983e5cf4232ac1ca0c79b47122e3defd8a98fa9a4387d985',
    );
  });

  it('deletes soft hyphens and zero-width characters instead of splitting words', () => {
    expect(normalizeText('won\u00ADderful')).toBe('wonderful');
    expect(normalizeText('won\u200Bder\u200Dful\u2060ly')).toBe('wonderfully');
    expect(normalizeText('\uFEFFhello\u200E world')).toBe('hello world');
  });

  it('does not locate a quote that starts mid-word across a soft hyphen', () => {
    expect(locateQuote('derful thing to see today', 'a won\u00ADderful thing to see today')).toBeNull();
  });

  it('locates across a soft hyphen and keeps it in the excerpt', () => {
    expect(locateQuote('wonderful thing', 'a won\u00ADderful thing')).toEqual({
      start: 2,
      end: 18,
      excerpt: 'won\u00ADderful thing',
    });
  });

  it('handles astral characters, ligatures and dotted capital I', () => {
    expect(normalizeText('\u{1D518}nicorn')).toBe('unicorn');
    expect(normalizeText('\uFB01ne')).toBe('fine');
    expect(normalizeText('\u0130stanbul')).toBe('i\u0307stanbul');
  });

  it('maps excerpts correctly around astral characters and ligatures', () => {
    const text = 'the \u{1D518}nicorn has a \uFB01ne horn';
    expect(locateQuote('unicorn has a fine horn', text)).toEqual({
      start: 4,
      end: text.length,
      excerpt: '\u{1D518}nicorn has a \uFB01ne horn',
    });
  });
});
```

- [ ] **Step 2: Run tests to see which fail**

Run: `npx vitest run tests/verify/normalize.test.ts`

Expected, and record the output in the report:
- FAIL: "deletes soft hyphens…" (gets `'won derful'`), "does not locate … mid-word" (currently returns a hit), "locates across a soft hyphen…" (currently `null`).
- PASS already: the golden-hash pin, the astral/ligature/dotted-I cases and the astral excerpt mapping. These are characterization tests for behavior B1 already handles correctly; they lock it in.
- All 10 existing tests still pass.

- [ ] **Step 3: Implement** — in `src/verify/normalize.ts`

Add below `WORD_CHAR`:

```ts
const FORMAT_CHAR = /\p{Cf}/u;
```

Change the skip condition in `normalizeWithMap` from:

```ts
    if (!APOSTROPHES.has(ch)) {
```

to:

```ts
    if (!APOSTROPHES.has(ch) && !FORMAT_CHAR.test(ch)) {
```

Format characters are now dropped the same way apostrophes are. They emit nothing and do not set `pendingSpace`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/verify/normalize.test.ts && npm test && npm run typecheck`
Expected: 16 normalize tests pass; the full suite passes (121 → 127); typecheck exits 0.

Confirm no literal non-ASCII was introduced:
`LC_ALL=C grep -nP '[\x80-\xFF]' src/verify/normalize.ts tests/verify/normalize.test.ts` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/verify/normalize.ts tests/verify/normalize.test.ts
git commit -m "feat(verify): delete Unicode format chars in normalization; pin golden body hash

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task F2: Prepared haystack and compact offset map

**Files:**
- Modify: `src/verify/normalize.ts`
- Modify: `plan.md` (status note)
- Test: `tests/verify/normalize.test.ts` (append)

**Interfaces:**
- Consumes: F1's `normalizeWithMap`.
- Produces:
  - `interface NormalizedText { source: string; text: string; map: Uint32Array }`. The type of `map` changes from `number[]` to `Uint32Array`. Nothing outside `normalize.ts` reads `map`.
  - `type PreparedHaystack = NormalizedText`
  - `prepareHaystack(fullText: string): PreparedHaystack`
  - `locateQuoteIn(quote: string, hay: PreparedHaystack): Located | null`
  - `locateQuote(quote: string, fullText: string): Located | null`. Unchanged signature; it now delegates to `locateQuoteIn(quote, prepareHaystack(fullText))`.

Why: `locateQuote` re-normalizes the whole text on every call. On a 2 MB novel the final review measured about 700 ms and 90 MB per call; 20 candidate misses took 8.4 s. A harvester checks many candidate passages against the same work, so it should normalize the work once. A `Uint32Array` stores offsets in 4 bytes each instead of a boxed JS array.

- [ ] **Step 1: Write the failing tests** — append to `tests/verify/normalize.test.ts`

Change the import line at the top of the file to:

```ts
import { bodyHash, locateQuote, locateQuoteIn, normalizeText, prepareHaystack } from '../../src/verify/normalize.js';
```

Then append:

```ts
describe('prepared haystack', () => {
  const TEXT = 'It was the best of times,\r\nit was the worst of times, it was the age of wisdom';

  it('locateQuoteIn on a prepared haystack matches locateQuote', () => {
    const hay = prepareHaystack(TEXT);
    for (const q of [
      'it was the best of times, it was the worst of times',
      'age of wisdom',
      'call me ishmael',
      'wisdom',
    ]) {
      expect(locateQuoteIn(q, hay)).toEqual(locateQuote(q, TEXT));
    }
  });

  it('uses a compact typed offset map with one entry per normalized code unit', () => {
    const hay = prepareHaystack(TEXT);
    expect(hay.map).toBeInstanceOf(Uint32Array);
    expect(hay.map.length).toBe(hay.text.length);
  });

  it('locates many quotes in a novel-sized text within budget', () => {
    const para =
      'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness. ';
    const text =
      para.repeat(Math.ceil(2_000_000 / para.length)) + 'Call me Ishmael, said nobody in this book.';
    const started = performance.now();
    const hay = prepareHaystack(text);
    for (let i = 0; i < 20; i++) {
      expect(locateQuoteIn(`a line that is not present number ${i}`, hay)).toBeNull();
    }
    expect(locateQuoteIn('call me ishmael said nobody', hay)?.excerpt).toBe('Call me Ishmael, said nobody');
    expect(performance.now() - started).toBeLessThan(5000);
  }, 20_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/verify/normalize.test.ts`
Expected: FAIL — `prepareHaystack` / `locateQuoteIn` are not exported (import error, or `TypeError: prepareHaystack is not a function`).

- [ ] **Step 3: Implement** — replace everything in `src/verify/normalize.ts` from `export interface NormalizedText` to the end of the file with:

```ts
export interface NormalizedText {
  source: string;
  text: string;
  map: Uint32Array;
}

export type PreparedHaystack = NormalizedText;

class OffsetMap {
  private buf: Uint32Array;
  length = 0;

  constructor(capacity: number) {
    this.buf = new Uint32Array(Math.max(16, capacity));
  }

  push(offset: number): void {
    if (this.length === this.buf.length) {
      const grown = new Uint32Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf[this.length++] = offset;
  }

  finish(): Uint32Array {
    return this.buf.slice(0, this.length);
  }
}

export function normalizeWithMap(input: string): NormalizedText {
  const source = input.normalize('NFC');
  let text = '';
  const map = new OffsetMap(source.length);
  let pendingSpace = false;

  for (let i = 0; i < source.length; ) {
    const ch = String.fromCodePoint(source.codePointAt(i)!);
    if (!APOSTROPHES.has(ch) && !FORMAT_CHAR.test(ch)) {
      for (const out of ch.normalize('NFKC').toLowerCase()) {
        if (!WORD_CHAR.test(out)) {
          pendingSpace = true;
          continue;
        }
        if (pendingSpace && text.length > 0) {
          text += ' ';
          map.push(i);
        }
        pendingSpace = false;
        text += out;
        for (let k = 0; k < out.length; k++) map.push(i);
      }
    }
    i += ch.length;
  }
  return { source, text, map: map.finish() };
}

export function normalizeText(input: string): string {
  return normalizeWithMap(input).text;
}

export function bodyHash(input: string): string {
  return createHash('sha256').update(normalizeText(input)).digest('hex');
}

export interface Located {
  start: number;
  end: number;
  excerpt: string;
}

export function prepareHaystack(fullText: string): PreparedHaystack {
  return normalizeWithMap(fullText);
}

export function locateQuoteIn(quote: string, hay: PreparedHaystack): Located | null {
  const needle = normalizeText(quote);
  if (needle.length === 0) return null;

  for (let from = 0; ; ) {
    const at = hay.text.indexOf(needle, from);
    if (at === -1) return null;
    const after = at + needle.length;
    const wholeWord =
      (at === 0 || hay.text[at - 1] === ' ') && (after === hay.text.length || hay.text[after] === ' ');
    if (wholeWord) {
      const start = hay.map[at]!;
      const last = hay.map[after - 1]!;
      const end = last + String.fromCodePoint(hay.source.codePointAt(last)!).length;
      return { start, end, excerpt: hay.source.slice(start, end) };
    }
    from = at + 1;
  }
}

export function locateQuote(quote: string, fullText: string): Located | null {
  return locateQuoteIn(quote, prepareHaystack(fullText));
}
```

This keeps the lines above `NormalizedText` from F1: the `createHash` import, `APOSTROPHES`, `WORD_CHAR` and `FORMAT_CHAR`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/verify/normalize.test.ts && npm test && npm run typecheck`
Expected: 19 normalize tests pass, including the golden hash (unchanged); full suite 130; typecheck exits 0.

Record the wall-clock time vitest reports for the budget test in the report.

- [ ] **Step 5: Record status in `plan.md`**

In `plan.md`, directly under the heading `### Prerequisites carried from the Part B final review`, add this line (followed by a blank line):

```markdown
> **Status:** the **Normalization hardening + golden hash** and **Large-text performance** rows are done on branch `phase-2-foundations` (docs/plans/phase-2-foundations.md, Tasks F1–F2).
```

- [ ] **Step 6: Commit**

```bash
git add src/verify/normalize.ts tests/verify/normalize.test.ts plan.md
git commit -m "perf(verify): prepared haystack and Uint32Array offset map for large texts

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task F3: HTTP client with retry and contact User-Agent

**Files:**
- Create: `src/lib/http.ts`
- Modify: `.env.example`
- Test: `tests/lib/http.test.ts`

**Interfaces:**
- Consumes: nothing from the repo. Uses Node's global `fetch`.
- Produces:
  - `interface HttpRequest { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }`
  - `interface HttpResult { url: string; status: number; headers: Record<string, string>; body: string }`
  - `interface HttpOptions { userAgent: string; maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; sleep?: (ms: number) => Promise<void>; fetchImpl?: typeof fetch; now?: () => number }` — defaults: 4 attempts, 500 ms base, 30 000 ms cap
  - `class HttpError extends Error { url: string; attempts: number }` (the error `cause` is set)
  - `isRetryableStatus(status: number): boolean` — true for 429 and ≥ 500
  - `retryDelayMs(attempt: number, retryAfter: string | null, opts: { baseDelayMs: number; maxDelayMs: number; nowMs: number }): number`
  - `buildUserAgent(contact: string | undefined, version: string): string` — throws if the contact is blank
  - `fetchWithRetry(req: HttpRequest, opts: HttpOptions): Promise<HttpResult>`

Contract:
- Any final HTTP status is **returned**, not thrown. The caller decides what a 404 means.
- Only network failures are thrown, and only after every attempt is used up. They throw `HttpError`.
- 5xx and 429 are retried. A `Retry-After` header is honored, in seconds or as an HTTP date. Otherwise the backoff is exponential (500, 1000, 2000, …), capped at `maxDelayMs`.
- The last response is returned even if it is still retryable.
- `sleep`, `fetchImpl` and `now` are injectable so tests never wait in real time.

- [ ] **Step 1: Write the failing tests** — `tests/lib/http.test.ts`

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildUserAgent, fetchWithRetry, HttpError, retryDelayMs } from '../../src/lib/http.js';

type Scripted = { status: number; headers?: Record<string, string>; body?: string };
interface Seen {
  method: string;
  url: string;
  userAgent: string | undefined;
  body: string;
}

const UA = 'Lantern/test (test@example.invalid)';
const servers: Server[] = [];

/** Real HTTP server on 127.0.0.1:0. Replies with responses[n], repeating the last one. */
async function scriptedServer(responses: Scripted[]) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', userAgent: req.headers['user-agent'], body });
      const next = responses[Math.min(seen.length, responses.length) - 1]!;
      res.writeHead(next.status, next.headers ?? {});
      res.end(next.body ?? '');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, seen };
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

function recordingSleep() {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number) => {
      calls.push(ms);
    },
  };
}

describe('fetchWithRetry', () => {
  it('sends the User-Agent and returns status, headers and body', async () => {
    const srv = await scriptedServer([
      { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
    ]);
    const { sleep, calls } = recordingSleep();
    const res = await fetchWithRetry({ url: `${srv.base}/books?search=dickens` }, { userAgent: UA, sleep });
    expect(res).toMatchObject({ status: 200, body: '{"ok":true}', url: `${srv.base}/books?search=dickens` });
    expect(res.headers['content-type']).toBe('application/json');
    expect(srv.seen).toEqual([{ method: 'GET', url: '/books?search=dickens', userAgent: UA, body: '' }]);
    expect(calls).toEqual([]);
  });

  it('passes POST method and body through', async () => {
    const srv = await scriptedServer([{ status: 200 }]);
    const { sleep } = recordingSleep();
    await fetchWithRetry(
      { url: srv.base, method: 'POST', body: 'q=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      { userAgent: UA, sleep },
    );
    expect(srv.seen[0]).toMatchObject({ method: 'POST', body: 'q=1', userAgent: UA });
  });

  it('retries a 5xx with exponential backoff, then succeeds', async () => {
    const srv = await scriptedServer([{ status: 503 }, { status: 502 }, { status: 200, body: 'ok' }]);
    const { sleep, calls } = recordingSleep();
    const res = await fetchWithRetry({ url: srv.base }, { userAgent: UA, sleep });
    expect(res).toMatchObject({ status: 200, body: 'ok' });
    expect(srv.seen).toHaveLength(3);
    expect(calls).toEqual([500, 1000]);
  });

  it('honours Retry-After in seconds on a 429', async () => {
    const srv = await scriptedServer([{ status: 429, headers: { 'retry-after': '2' } }, { status: 200 }]);
    const { sleep, calls } = recordingSleep();
    const res = await fetchWithRetry({ url: srv.base }, { userAgent: UA, sleep });
    expect(res.status).toBe(200);
    expect(calls).toEqual([2000]);
  });

  it('honours Retry-After given as an HTTP date', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const srv = await scriptedServer([
      { status: 503, headers: { 'retry-after': 'Thu, 01 Jan 2026 00:00:03 GMT' } },
      { status: 200 },
    ]);
    const { sleep, calls } = recordingSleep();
    await fetchWithRetry({ url: srv.base }, { userAgent: UA, sleep, now: () => now });
    expect(calls).toEqual([3000]);
  });

  it('caps any delay at maxDelayMs', async () => {
    const srv = await scriptedServer([{ status: 429, headers: { 'retry-after': '3600' } }, { status: 200 }]);
    const { sleep, calls } = recordingSleep();
    await fetchWithRetry({ url: srv.base }, { userAgent: UA, sleep });
    expect(calls).toEqual([30_000]);
  });

  it.each([400, 401, 403, 404])('never retries a %i', async (status) => {
    const srv = await scriptedServer([{ status }, { status: 200 }]);
    const { sleep, calls } = recordingSleep();
    const res = await fetchWithRetry({ url: srv.base }, { userAgent: UA, sleep });
    expect(res.status).toBe(status);
    expect(srv.seen).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('returns the last response when retries are exhausted', async () => {
    const srv = await scriptedServer([{ status: 500 }]);
    const { sleep, calls } = recordingSleep();
    const res = await fetchWithRetry({ url: srv.base }, { userAgent: UA, sleep, maxAttempts: 3 });
    expect(res.status).toBe(500);
    expect(srv.seen).toHaveLength(3);
    expect(calls).toEqual([500, 1000]);
  });

  it('retries network failures, then throws HttpError carrying the cause', async () => {
    const boom = new TypeError('fetch failed');
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      throw boom;
    }) as unknown as typeof fetch;
    const { sleep, calls } = recordingSleep();
    const err = await fetchWithRetry(
      { url: 'http://127.0.0.1:1/' },
      { userAgent: UA, sleep, fetchImpl, maxAttempts: 3 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ attempts: 3, url: 'http://127.0.0.1:1/', cause: boom });
    expect(attempts).toBe(3);
    expect(calls).toEqual([500, 1000]);
  });
});

describe('retryDelayMs', () => {
  const opts = { baseDelayMs: 500, maxDelayMs: 30_000, nowMs: 0 };

  it('backs off exponentially without Retry-After', () => {
    expect([1, 2, 3, 4].map((a) => retryDelayMs(a, null, opts))).toEqual([500, 1000, 2000, 4000]);
  });

  it('falls back to backoff for an unparseable Retry-After', () => {
    expect(retryDelayMs(2, 'soon', opts)).toBe(1000);
  });

  it('never returns a negative delay for an HTTP date in the past', () => {
    expect(retryDelayMs(1, 'Thu, 01 Jan 1970 00:00:00 GMT', { ...opts, nowMs: 10_000 })).toBe(0);
  });
});

describe('buildUserAgent', () => {
  it('embeds the trimmed contact and version', () => {
    expect(buildUserAgent(' test@example.invalid ', '0.1.0')).toBe('Lantern/0.1.0 (test@example.invalid)');
  });

  it.each([undefined, '', '   '])('refuses a missing contact (%j)', (contact) => {
    expect(() => buildUserAgent(contact, '0.1.0')).toThrow(/LANTERN_CONTACT/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/http.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/http.js`.

- [ ] **Step 3: Write `src/lib/http.ts`**

```ts
export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpOptions {
  userAgent: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class HttpError extends Error {
  override name = 'HttpError';

  constructor(
    message: string,
    readonly url: string,
    readonly attempts: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const DEFAULTS = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 30_000 } as const;

export function buildUserAgent(contact: string | undefined, version: string): string {
  const trimmed = contact?.trim();
  if (!trimmed) {
    throw new Error(
      'LANTERN_CONTACT is not set: APIs such as Wikimedia require a contact (email or URL) in the User-Agent',
    );
  }
  return `Lantern/${version} (${trimmed})`;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function retryDelayMs(
  attempt: number,
  retryAfter: string | null,
  opts: { baseDelayMs: number; maxDelayMs: number; nowMs: number },
): number {
  if (retryAfter !== null) {
    const trimmed = retryAfter.trim();
    if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, opts.maxDelayMs);
    const at = Date.parse(trimmed);
    if (!Number.isNaN(at)) return Math.min(Math.max(0, at - opts.nowMs), opts.maxDelayMs);
  }
  return Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fetchWithRetry(req: HttpRequest, opts: HttpOptions): Promise<HttpResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
  const delays = {
    baseDelayMs: opts.baseDelayMs ?? DEFAULTS.baseDelayMs,
    maxDelayMs: opts.maxDelayMs ?? DEFAULTS.maxDelayMs,
  };
  const sleep = opts.sleep ?? realSleep;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(req.url, {
        method: req.method ?? 'GET',
        headers: { ...req.headers, 'user-agent': opts.userAgent },
        body: req.body,
      });
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) await sleep(retryDelayMs(attempt, null, { ...delays, nowMs: now() }));
      continue;
    }
    const result: HttpResult = {
      url: req.url,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: await res.text(),
    };
    if (!isRetryableStatus(res.status) || attempt === maxAttempts) return result;
    await sleep(retryDelayMs(attempt, res.headers.get('retry-after'), { ...delays, nowMs: now() }));
  }

  throw new HttpError(`network failure after ${maxAttempts} attempts: ${req.url}`, req.url, maxAttempts, {
    cause: lastError,
  });
}
```

- [ ] **Step 4: Add `LANTERN_CONTACT` to `.env.example`**

Append:

```
# Contact (email or URL) sent in the User-Agent; required by Wikimedia and similar APIs.
LANTERN_CONTACT=
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/lib/http.test.ts && npm test && npm run typecheck`
Expected: 19 http tests pass; the full suite passes (149); typecheck exits 0; the output has no "open handles" or server-close warnings.

If a test hangs on shutdown, the cause is a keep-alive socket: the `afterEach` must call `closeAllConnections()` before `close()`. Do not add `--no-threads` or other test flags.

- [ ] **Step 6: Commit**

```bash
git add src/lib/http.ts tests/lib/http.test.ts .env.example
git commit -m "feat(lib): HTTP client with 5xx/429 retry, Retry-After, and contact User-Agent

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task F4: Read-through response cache that never stores secrets

**Files:**
- Create: `src/lib/cache.ts`
- Modify: `claude.md` (§4 layout, the `lib/` line), `plan.md` (C0 status note)
- Test: `tests/lib/cache.test.ts`

**Interfaces:**
- Consumes (from F3): `HttpRequest`, `HttpResult`, `fetchWithRetry`, the last one only in the integration test.
- Produces:
  - `interface CacheOptions { cacheDir: string; source: string; refresh?: boolean; now?: () => Date }`
  - `interface CachedResult extends HttpResult { fromCache: boolean; fetchedAt: string }`
  - `redactUrl(url: string): string` replaces values of query params whose names match `/(key|token|secret|password|passwd|auth|signature)/i`, plus any URL userinfo, with `REDACTED`. It returns the input **unchanged byte-for-byte** when nothing needed redacting.
  - `cacheKey(req: HttpRequest): string` is the sha256 hex of `` `${method}\n${redactUrl(url)}\n${body ?? ''}` ``.
  - `cachedFetch(req: HttpRequest, cache: CacheOptions, fetcher: (req: HttpRequest) => Promise<HttpResult>): Promise<CachedResult>`

Contract:
- **File location.** Entries live at `<cacheDir>/<source>/<cacheKey>.json`. `source` must be a lowercase kebab-case name, so a source name can never write outside the cache directory.
- **What is cached.** Any status below 500 other than 429, which includes 404 because that is a real API answer. 5xx and 429 are never cached.
- **What a stored entry contains.** `request.method`, the redacted `request.url`, `request.bodySha256` when there is a body (never the body itself), the redacted response `url`, `status`, the response `headers` minus `set-cookie`, `set-cookie2`, `authorization` and `proxy-authorization`, `body`, and `fetchedAt`. The file is written as pretty JSON with LF line endings and a trailing newline. It goes to a temp file first and is then renamed into place, so a crash cannot leave a half-written fixture.
- **`refresh: true`** bypasses the read and overwrites the entry. This is the escape hatch that a later `lantern harvest --refresh` flag will expose.
- **Credential rotation.** Redaction happens before keying, so rotating an API key does not bust the cache.

- [ ] **Step 1: Write the failing tests** — `tests/lib/cache.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedFetch, cacheKey, redactUrl } from '../../src/lib/cache.js';
import { fetchWithRetry, type HttpRequest, type HttpResult } from '../../src/lib/http.js';

const NOW = () => new Date('2026-09-13T00:00:00.000Z');
const UA = 'Lantern/test (test@example.invalid)';
let dir: string;
const servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lantern-cache-'));
});

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** Our own fetcher interface, not a platform API. The real-HTTP path is covered by the last test. */
function countingFetcher(overrides: Partial<HttpResult> = {}) {
  const calls: HttpRequest[] = [];
  const fetcher = async (req: HttpRequest): Promise<HttpResult> => {
    calls.push(req);
    return {
      url: req.url,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: `{"n":${calls.length}}`,
      ...overrides,
    };
  };
  return { calls, fetcher };
}

describe('cachedFetch', () => {
  it('fetches once, writes the entry, then serves it from disk', async () => {
    const { calls, fetcher } = countingFetcher();
    const req = { url: 'https://gutendex.com/books?search=dickens' };
    const opts = { cacheDir: dir, source: 'gutendex', now: NOW };

    const first = await cachedFetch(req, opts, fetcher);
    expect(first).toMatchObject({ status: 200, body: '{"n":1}', fromCache: false, fetchedAt: '2026-09-13T00:00:00.000Z' });
    expect(existsSync(join(dir, 'gutendex', `${cacheKey(req)}.json`))).toBe(true);

    const second = await cachedFetch(req, opts, fetcher);
    expect(second).toMatchObject({ status: 200, body: '{"n":1}', fromCache: true, fetchedAt: '2026-09-13T00:00:00.000Z' });
    expect(calls).toHaveLength(1);
  });

  it('refresh bypasses the cached entry and overwrites it', async () => {
    const { calls, fetcher } = countingFetcher();
    const req = { url: 'https://gutendex.com/books/98' };
    const opts = { cacheDir: dir, source: 'gutendex', now: NOW };
    await cachedFetch(req, opts, fetcher);
    expect(await cachedFetch(req, { ...opts, refresh: true }, fetcher)).toMatchObject({ body: '{"n":2}', fromCache: false });
    expect(await cachedFetch(req, opts, fetcher)).toMatchObject({ body: '{"n":2}', fromCache: true });
    expect(calls).toHaveLength(2);
  });

  it.each([503, 429])('never caches a %i', async (status) => {
    const { calls, fetcher } = countingFetcher({ status });
    const req = { url: 'https://example.test/flaky' };
    await cachedFetch(req, { cacheDir: dir, source: 'example' }, fetcher);
    await cachedFetch(req, { cacheDir: dir, source: 'example' }, fetcher);
    expect(calls).toHaveLength(2);
    expect(existsSync(join(dir, 'example'))).toBe(false);
  });

  it('caches a 404 because it is a real API answer', async () => {
    const { calls, fetcher } = countingFetcher({ status: 404, body: 'not found' });
    const req = { url: 'https://example.test/missing' };
    await cachedFetch(req, { cacheDir: dir, source: 'example' }, fetcher);
    expect(await cachedFetch(req, { cacheDir: dir, source: 'example' }, fetcher)).toMatchObject({
      status: 404,
      fromCache: true,
    });
    expect(calls).toHaveLength(1);
  });

  it.each(['../escape', 'Wiki Media', '', 'a/b'])('rejects the unsafe source name %j', async (source) => {
    const { fetcher } = countingFetcher();
    await expect(cachedFetch({ url: 'https://example.test/' }, { cacheDir: dir, source }, fetcher)).rejects.toThrow(
      /invalid cache source name/,
    );
  });

  it('never writes credentials into the cache', async () => {
    const { fetcher } = countingFetcher({
      headers: { 'content-type': 'text/plain', 'set-cookie': 'session=secret-cookie', authorization: 'Bearer secret-bearer' },
    });
    await cachedFetch(
      { url: 'https://user:secret-pw@api.example.test/items?api_key=secret-abc&q=dickens&access_token=secret-zzz', method: 'POST', body: 'password=secret-hunter2' },
      { cacheDir: dir, source: 'example', now: NOW },
      fetcher,
    );
    const [file] = readdirSync(join(dir, 'example'));
    const stored = readFileSync(join(dir, 'example', file!), 'utf8');
    expect(stored).not.toMatch(/secret-/);
    expect(stored).toContain('REDACTED');
    expect(stored).toContain('q=dickens');
    expect(JSON.parse(stored).request).toMatchObject({ method: 'POST' });
    expect(JSON.parse(stored).request.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores pretty, LF-terminated JSON', async () => {
    const { fetcher } = countingFetcher();
    await cachedFetch({ url: 'https://gutendex.com/books/1400' }, { cacheDir: dir, source: 'gutendex', now: NOW }, fetcher);
    const [file] = readdirSync(join(dir, 'gutendex'));
    const text = readFileSync(join(dir, 'gutendex', file!), 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(text).toContain('\n  "status": 200');
  });

  it('serves a second identical real HTTP request from disk and attempts a 404 exactly once', async () => {
    const hits: Record<string, number> = {};
    const server = createServer((req, res) => {
      hits[req.url ?? ''] = (hits[req.url ?? ''] ?? 0) + 1;
      if (req.url === '/missing') {
        res.writeHead(404);
        res.end('nope');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"results":[]}');
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fetcher = (r: HttpRequest) => fetchWithRetry(r, { userAgent: UA, sleep: async () => {} });
    const opts = { cacheDir: dir, source: 'local-test', now: NOW };

    await cachedFetch({ url: `${base}/books` }, opts, fetcher);
    expect(await cachedFetch({ url: `${base}/books` }, opts, fetcher)).toMatchObject({ fromCache: true, body: '{"results":[]}' });
    await cachedFetch({ url: `${base}/missing` }, opts, fetcher);
    expect(await cachedFetch({ url: `${base}/missing` }, opts, fetcher)).toMatchObject({ fromCache: true, status: 404 });
    expect(hits).toEqual({ '/books': 1, '/missing': 1 });
  });
});

describe('cacheKey and redactUrl', () => {
  it('keys on method, url and body', () => {
    const get = cacheKey({ url: 'https://example.test/a' });
    expect(get).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey({ url: 'https://example.test/a' })).toBe(get);
    expect(cacheKey({ url: 'https://example.test/a', method: 'POST' })).not.toBe(get);
    expect(cacheKey({ url: 'https://example.test/a', method: 'POST', body: 'x=1' })).not.toBe(
      cacheKey({ url: 'https://example.test/a', method: 'POST', body: 'x=2' }),
    );
  });

  it('leaves URLs without credentials byte-for-byte unchanged', () => {
    const url = 'https://gutendex.com/books?search=dickens%20charles&page=2';
    expect(redactUrl(url)).toBe(url);
  });

  it('keeps the same key when only a credential value rotates', () => {
    expect(cacheKey({ url: 'https://api.example.test/x?api_key=one&q=1' })).toBe(
      cacheKey({ url: 'https://api.example.test/x?api_key=two&q=1' }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/cache.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/cache.js`.

- [ ] **Step 3: Write `src/lib/cache.ts`**

```ts
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpRequest, HttpResult } from './http.js';

export interface CacheOptions {
  cacheDir: string;
  source: string;
  refresh?: boolean;
  now?: () => Date;
}

export interface CachedResult extends HttpResult {
  fromCache: boolean;
  fetchedAt: string;
}

interface StoredEntry {
  request: { method: string; url: string; bodySha256?: string };
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  fetchedAt: string;
}

const SOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SECRET_PARAM = /(key|token|secret|password|passwd|auth|signature)/i;
const DROPPED_HEADERS = new Set(['set-cookie', 'set-cookie2', 'authorization', 'proxy-authorization']);

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let changed = false;
  if (parsed.username || parsed.password) {
    parsed.username = 'REDACTED';
    parsed.password = '';
    changed = true;
  }
  for (const name of new Set(parsed.searchParams.keys())) {
    if (SECRET_PARAM.test(name)) {
      parsed.searchParams.set(name, 'REDACTED');
      changed = true;
    }
  }
  return changed ? parsed.toString() : url;
}

export function cacheKey(req: HttpRequest): string {
  return sha256(`${req.method ?? 'GET'}\n${redactUrl(req.url)}\n${req.body ?? ''}`);
}

const isCacheable = (status: number) => status < 500 && status !== 429;

export async function cachedFetch(
  req: HttpRequest,
  cache: CacheOptions,
  fetcher: (req: HttpRequest) => Promise<HttpResult>,
): Promise<CachedResult> {
  if (!SOURCE_NAME.test(cache.source)) {
    throw new Error(`invalid cache source name: ${JSON.stringify(cache.source)}`);
  }
  const dir = join(cache.cacheDir, cache.source);
  const path = join(dir, `${cacheKey(req)}.json`);

  if (!cache.refresh && existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as StoredEntry;
    return {
      url: req.url,
      status: stored.status,
      headers: stored.headers,
      body: stored.body,
      fetchedAt: stored.fetchedAt,
      fromCache: true,
    };
  }

  const result = await fetcher(req);
  const fetchedAt = (cache.now ?? (() => new Date()))().toISOString();

  if (isCacheable(result.status)) {
    const entry: StoredEntry = {
      request: {
        method: req.method ?? 'GET',
        url: redactUrl(req.url),
        ...(req.body !== undefined ? { bodySha256: sha256(req.body) } : {}),
      },
      url: redactUrl(result.url),
      status: result.status,
      headers: Object.fromEntries(
        Object.entries(result.headers).filter(([name]) => !DROPPED_HEADERS.has(name.toLowerCase())),
      ),
      body: result.body,
      fetchedAt,
    };
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
    renameSync(tmp, path);
  }

  return { ...result, fetchedAt, fromCache: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lib/cache.test.ts && npm test && npm run typecheck`
Expected: 15 cache tests pass; the full suite passes (164); typecheck exits 0; no stray files appear under the repo's `data/cache/`. Every test uses an OS temp dir, so check with `git status --short`, which must show only this task's files.

- [ ] **Step 5: Update docs**

In `claude.md` §4's package-layout tree, change the `lib/` comment to:

```
    lib/                # logging, run_log stage wrapper, paths, http client + response cache
```

Keep the column alignment of the neighboring lines. Change nothing else in claude.md.

In `plan.md`, directly under the heading that begins `### C0 — HTTP client and response cache`, add (followed by a blank line):

```markdown
> **Status:** done on branch `phase-2-foundations` (docs/plans/phase-2-foundations.md, Tasks F3–F4). Beyond the text below, the cache redacts credential-like query params and URL userinfo, drops `Set-Cookie`/`Authorization` headers, and stores only a hash of request bodies, because `data/cache/` is committed. The `--refresh` flag is a `refresh` option today and becomes a CLI flag with `lantern harvest`.
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/cache.ts tests/lib/cache.test.ts claude.md plan.md
git commit -m "feat(lib): read-through response cache that never stores credentials

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

## Done when

- `npm test` passes with 164 tests, and `npm run typecheck` exits 0.
- No literal non-ASCII characters appear in any changed `src/` or `tests/` file.
- In `plan.md`, the Part C prerequisite rows for normalization hardening and large-text performance, and milestone C0, all carry status notes pointing here.
- Every commit carries both attribution trailers.
