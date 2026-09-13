# Phase 2 Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the `plan.md` Part C prerequisite rows that need no user decision and no network access, before the Phase 2 harvesters and adapters are built:

- A POST is never retried after it may have been processed. This is the retry half of **Unsafe-method retries and upload timeouts**.
- A streaming binary download (**Binary downloads**).
- Canonical cache keys and a Windows-safe cache write (**Cache write robustness and key canonicalization**).
- `verifyQuoteItem`, which takes evidence instead of a decision (**Apply takes evidence, not a decision**).
- A migration runner that can run table-rebuild migrations, plus a doctor guard-trigger check (Phase 1 **I4**).
- Migration checksums and a doctor drift check (**Migration drift**).
- Logging for mistyped CLI commands (**Unknown-command logging**).

**Architecture:** Every change is local to an existing module, except for one new module, `src/lib/download.ts`.

- `fetchWithRetry` gains `retryUnsafe`. Its option validation moves into an exported `resolveHttpOptions`, which `downloadWithRetry` reuses.
- `applyQuoteDecision` is replaced by `verifyQuoteItem(db, itemId, evidence)`. This is a deliberate breaking change: no caller can hand the database a decision that `decideQuote` never made.
- The migration runner switches foreign keys off around each migration's transaction and checks them before commit.
- `schema_migrations` gains a `checksum` column. The runner adds it (it owns that table), so there is no numbered migration.
- Doctor gains `db.triggers` and `db.drift`.

**Tech Stack:** Node 26 (built-in `fetch`, `AbortSignal.timeout`, `node:stream/promises`), TypeScript 7 (strict, nodenext), vitest 5, better-sqlite3 13 (SQLite 3.53), commander 15. No new dependencies.

**Spec:** `claude.md`. The relevant sections:
- §2 fail closed
- §4 stack, logs, "a cron job leaves a log"
- §7 `verify` and `doctor`
- §8 verification enforcement
- §10 image sourcing
- §11 retries: never double-post

The parent plan is `plan.md` Part C, with the rows named in the Goal.

**Deliberately NOT in this plan** (each needs a user decision, curated data, or its consumer milestone):
- Canonical quote body (spec §8 policy decision).
- Tier 1/2 host allowlists (curated lists, 2.1/2.2).
- Novel-sized fixtures (size policy tied to the Gutendex harvester, 2.1).
- Secret-protection scope (first credentialed source).
- Unattended retry visibility and run deadline (Phase 5 design).
- Doctor exit-code contract for warnings (decide before Phase 5).
- I6 channel identity, buffer definition, and missing channel credentials (Phase 4).
- Separate connect/idle upload timeouts (Phase 8).
- Numbers the numeric check cannot see (Phase 7).

**Probe evidence:** every design below was run in scratch probes on Node 26.0.0 and SQLite 3.53.4 before this plan was written:
- Migration foreign-key handling: 12/12.
- Populated 001 followed by the remaining real migrations: 0 foreign-key violations, 13 triggers.
- Canonical cache URL: 13/13.
- Streaming download (byte caps, stalled-body timeout, no temp files left): 5/5, plus truncated-body detection.
- Commander `exitOverride` codes: `commander.unknownCommand` exits 1, `commander.helpDisplayed` exits 0.

## Global Constraints

- **Language and modules.** Node.js + TypeScript, **ESM**, **strict mode on**. Relative imports use `.js` extensions.
- **Unicode in code and tests.** Write every non-ASCII character as a `\u` escape, never as a literal glyph. None of this plan's code needs any. Verify with `git diff | grep '^+' | grep -P '[^\x00-\x7F]'` on `.ts` files, which must print nothing. Markdown docs (`claude.md`, `plan.md`) are exempt, and their existing characters must not be re-encoded.
- **Fail closed.** When unsure, a request is not retried, a download is not kept, a quote is not verified, a migration is not committed, and doctor reports a failure.
- **No real internet.** HTTP tests use a throwaway `node:http` server on `127.0.0.1` port 0. Tests use OS temp dirs, never read or write under `data/`, and never touch `data/lantern.db`.
- **Never commit** `.env`, `data/`, `logs/`, or `.superpowers/`.
- **Commit trailers.** Every commit message ends with a blank line and two trailer lines:
  - `Co-Authored-By: <the authoring model's attribution line from its environment>` (for example `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`)
  - `Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v`

  Verify with `git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'`, which must print `2`.
- **Branch.** Work on `phase-2-prerequisites`, created from `phase-2-hardening` at dc0e859. Baseline: 314 tests pass across 16 files.

### File map

```
src/lib/http.ts                  # Q1: resolveHttpOptions (extracted), retryUnsafe
tests/lib/http.test.ts
src/lib/download.ts              # Q2: NEW downloadWithRetry, DownloadStatusError, DownloadTooLargeError
tests/lib/download.test.ts       # Q2: NEW
src/lib/cache.ts                 # Q3: canonicalUrl in cacheKey; publishEntry retries EPERM/EBUSY/EACCES renames
tests/lib/cache.test.ts
src/verify/apply.ts              # Q4: verifyQuoteItem replaces applyQuoteDecision
tests/verify/quote-gate.test.ts
src/db/migrate.ts                # Q5: FK-safe runner, expectedTriggers; Q6: checksums, migrationDrift
tests/db/migrate.test.ts
src/doctor/checks.ts             # Q5: db.triggers; Q6: db.drift
tests/doctor/checks.test.ts
src/cli.ts                       # Q7: exitOverride + logged CommanderError
tests/cli/cli.test.ts            # Q7: NEW (spawns the real CLI)
claude.md                        # Q8: section 4 layout, 7 doctor, 8 verifyQuoteItem, 11 POST retries
plan.md                          # Q8: status lines, 2.3 wording
```

### Test counts

| After | Suite |
|---|---|
| baseline | 314 |
| Q1 | 319 |
| Q2 | 329 |
| Q3 | 334 |
| Q4 | 336 |
| Q5 | 343 |
| Q6 | 349 |
| Q7 | 351 |
| Q8 | 351 |

---

### Task Q1: Never retry a POST that may have been processed

**Files:**
- Modify: `src/lib/http.ts`
- Test: `tests/lib/http.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `HttpOptions.retryUnsafe?: boolean`.
  - `export interface ResolvedHttpOptions { maxAttempts: number; timeoutMs: number; baseDelayMs: number; maxDelayMs: number; sleep: (ms: number) => Promise<void>; fetchImpl: typeof fetch; now: () => number }`.
  - `export function resolveHttpOptions(opts: HttpOptions): ResolvedHttpOptions`. Q2 uses it.

**Why:** Final review I3. With the per-attempt timeout, a slow POST the server has already processed is sent again, up to 4 times. A Facebook `POST /{page-id}/photos` would create duplicate Page posts, and `UNIQUE(post_id, channel_id)` cannot prevent that remotely (spec §11). A 429 means the request was not processed, so a 429 is still retried.

- [ ] **Step 1: Write the failing tests**

In `tests/lib/http.test.ts`, add this `describe` block directly after the closing `});` of `describe('fetchWithRetry', ...)` and before `describe('retryDelayMs', ...)`:

```ts
describe('fetchWithRetry with a non-idempotent method', () => {
  it('does not retry a POST after a network failure', async () => {
    let attempts = 0;
    const boom = new Error('socket hang up');
    const fetchImpl = (async () => {
      attempts++;
      throw boom;
    }) as unknown as typeof fetch;
    const { sleep, calls } = recordingSleep();
    const err = await fetchWithRetry(
      { url: 'http://127.0.0.1:1/', method: 'POST', body: 'x=1' },
      { userAgent: UA, sleep, fetchImpl },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ attempts: 1, url: 'http://127.0.0.1:1/', cause: boom });
    expect(attempts).toBe(1);
    expect(calls).toEqual([]);
  });

  it('sends a timed-out POST exactly once', async () => {
    let received = 0;
    const server = createServer((req, res) => {
      received++;
      req.resume();
      setTimeout(() => res.end('late'), 300);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const { sleep } = recordingSleep();
    const err = await fetchWithRetry({ url, method: 'POST', body: 'x=1' }, { userAgent: UA, sleep, timeoutMs: 100 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ attempts: 1 });
    expect(received).toBe(1);
  });

  it('returns a POST 503 without retrying', async () => {
    const srv = await scriptedServer([{ status: 503 }, { status: 200 }]);
    const { sleep, calls } = recordingSleep();
    const res = await fetchWithRetry({ url: srv.base, method: 'POST', body: 'x=1' }, { userAgent: UA, sleep });
    expect(res.status).toBe(503);
    expect(srv.seen).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('still retries a POST that was rate limited', async () => {
    const srv = await scriptedServer([{ status: 429, headers: { 'retry-after': '1' } }, { status: 200 }]);
    const { sleep, calls } = recordingSleep();
    const res = await fetchWithRetry({ url: srv.base, method: 'POST', body: 'x=1' }, { userAgent: UA, sleep });
    expect(res.status).toBe(200);
    expect(srv.seen.map((s) => s.body)).toEqual(['x=1', 'x=1']);
    expect(calls).toEqual([1000]);
  });

  it('retries a POST 503 when the caller opts in with retryUnsafe', async () => {
    const srv = await scriptedServer([{ status: 503 }, { status: 200 }]);
    const { sleep, calls } = recordingSleep();
    const res = await fetchWithRetry(
      { url: srv.base, method: 'POST', body: 'x=1' },
      { userAgent: UA, sleep, retryUnsafe: true },
    );
    expect(res.status).toBe(200);
    expect(srv.seen).toHaveLength(2);
    expect(calls).toEqual([500]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/http.test.ts`

Expected:
- **Typecheck error** on `retryUnsafe`: vitest does not typecheck, so this surfaces only in `npm run typecheck`. Record it.
- **Fail:** the network-failure test (4 attempts), the timed-out test (`received` is 4 or `attempts` is 4), and the 503 test (2 requests seen).
- **Pass:** the 429 test and the `retryUnsafe` test already pass, because GET and POST are currently treated the same. Record that.

- [ ] **Step 3: Implement**

In `src/lib/http.ts`, add `retryUnsafe` to `HttpOptions`, directly after `timeoutMs`:

```ts
  /**
   * A POST is sent once: after a network error, timeout or 5xx it is not retried, because the server
   * may already have acted on it (spec section 11: never double-post). A 429 is still retried, since a
   * rate-limited request was not processed. Set true only when the server de-duplicates retries, for
   * example with an idempotency key.
   */
  retryUnsafe?: boolean;
```

Replace the whole `fetchWithRetry` function, and the `realSleep` line above it, with:

```ts
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ResolvedHttpOptions {
  maxAttempts: number;
  timeoutMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  fetchImpl: typeof fetch;
  now: () => number;
}

/** Validates and defaults the options shared by fetchWithRetry and downloadWithRetry. */
export function resolveHttpOptions(opts: HttpOptions): ResolvedHttpOptions {
  const maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be an integer >= 1, got ${maxAttempts}`);
  }
  if (!opts.userAgent.trim()) {
    throw new TypeError('userAgent must be a non-empty contact User-Agent (see buildUserAgent)');
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`timeoutMs must be a positive finite number, got ${timeoutMs}`);
  }
  return {
    maxAttempts,
    timeoutMs,
    baseDelayMs: opts.baseDelayMs ?? DEFAULTS.baseDelayMs,
    maxDelayMs: opts.maxDelayMs ?? DEFAULTS.maxDelayMs,
    sleep: opts.sleep ?? realSleep,
    fetchImpl: opts.fetchImpl ?? fetch,
    now: opts.now ?? Date.now,
  };
}

export async function fetchWithRetry(req: HttpRequest, opts: HttpOptions): Promise<HttpResult> {
  const o = resolveHttpOptions(opts);
  const method = req.method ?? 'GET';
  const retryAll = method === 'GET' || opts.retryUnsafe === true;
  const headers = new Headers(req.headers);
  headers.set('user-agent', opts.userAgent);
  const delays = { baseDelayMs: o.baseDelayMs, maxDelayMs: o.maxDelayMs };
  let lastError: unknown;

  for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
    let res: Response;
    let body: string;
    try {
      res = await o.fetchImpl(req.url, {
        method,
        headers,
        body: req.body,
        signal: AbortSignal.timeout(o.timeoutMs),
      });
      const reason = unsupportedBodyReason(res.headers.get('content-type'));
      if (reason !== null) {
        await res.body?.cancel().catch(() => {});
        throw new UnsupportedBodyError(req.url, reason);
      }
      body = await res.text();
    } catch (err) {
      if (err instanceof UnsupportedBodyError) throw err;
      if (!retryAll) {
        throw new HttpError(`${method} failed and was not retried because it may have been processed: ${req.url}`, req.url, attempt, {
          cause: err,
        });
      }
      lastError = err;
      if (attempt < o.maxAttempts) await o.sleep(retryDelayMs(attempt, null, { ...delays, nowMs: o.now() }));
      continue;
    }
    const result: HttpResult = {
      url: req.url,
      finalUrl: res.url || req.url,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body,
    };
    if (!isRetryableStatus(res.status) || attempt === o.maxAttempts) return result;
    if (!retryAll && res.status !== 429) return result;
    const header = retryAfterMs(res.headers.get('retry-after'), o.now());
    if (header !== null && header > delays.maxDelayMs) return result;
    await o.sleep(retryDelayMs(attempt, res.headers.get('retry-after'), { ...delays, nowMs: o.now() }));
  }

  throw new HttpError(`network failure after ${o.maxAttempts} attempts: ${req.url}`, req.url, o.maxAttempts, {
    cause: lastError,
  });
}
```

The validation order stays the same: maxAttempts, then userAgent, then timeoutMs, then headers. Existing tests rely on it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/http.test.ts && npm test && npm run typecheck`

Expected:
- The 5 new tests pass, and every existing http test passes unchanged.
- The full suite has **319** tests.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/http.ts tests/lib/http.test.ts
git commit -m "fix(lib): never retry a POST that may have been processed; extract resolveHttpOptions

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task Q2: Streaming binary download

**Files:**
- Create: `src/lib/download.ts`
- Test: `tests/lib/download.test.ts` (new)

**Interfaces:**
- Consumes (from Q1): `resolveHttpOptions`, `HttpOptions`, `HttpError`, `isRetryableStatus`, `retryAfterMs`, `retryDelayMs`, all from `./http.js`.
- Produces:
  - `downloadWithRetry(url: string, destPath: string, opts: DownloadOptions): Promise<DownloadResult>`
  - `DownloadOptions extends HttpOptions { maxBytes?: number }`
  - `DownloadResult { url; finalUrl; status; headers; path; bytes; sha256 }`
  - `DownloadStatusError { url; status; attempts }`
  - `DownloadTooLargeError { url; maxBytes }`

  Milestone 2.5 (Wikimedia images) will call this with a path under `data/media/source/`, never under the committed cache.

**Why:** `fetchWithRetry` refuses non-text bodies (`UnsupportedBodyError`). Source images need a separate download (plan.md row **Binary downloads**) with these properties:
- It streams to disk instead of buffering.
- It uses the same retry and User-Agent rules.
- A partial download never looks finished: the body is written to a temp file and renamed into place only when complete.
- The size is capped, and an oversized body is not retried.

Downloads are GET-only.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/download.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadStatusError, DownloadTooLargeError, downloadWithRetry } from '../../src/lib/download.js';
import { HttpError } from '../../src/lib/http.js';

const UA = 'Lantern/test (test@example.invalid)';
const PAYLOAD = Buffer.alloc(64_000, 7);
let dir: string;
const servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lantern-download-'));
});

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Real HTTP server on 127.0.0.1:0; the handler gets the 1-based request number. */
async function serve(handler: (req: IncomingMessage, res: ServerResponse, n: number) => void) {
  let n = 0;
  const userAgents: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    n++;
    userAgents.push(req.headers['user-agent']);
    handler(req, res, n);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => n, userAgents };
}

function recordingSleep() {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number) => {
      calls.push(ms);
    },
  };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const leftovers = () =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.tmp'));

describe('downloadWithRetry', () => {
  it('streams a binary body to the destination and reports its size and sha256', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    });
    const dest = join(dir, 'source', 'dickens.jpg');
    const out = await downloadWithRetry(`${srv.base}/dickens.jpg`, dest, { userAgent: UA });
    expect(out).toMatchObject({
      url: `${srv.base}/dickens.jpg`,
      finalUrl: `${srv.base}/dickens.jpg`,
      status: 200,
      path: dest,
      bytes: PAYLOAD.length,
      sha256: sha(PAYLOAD),
    });
    expect(out.headers['content-type']).toBe('image/jpeg');
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
    expect(srv.userAgents).toEqual([UA]);
    expect(leftovers()).toEqual([]);
  });

  it('reports the final URL after a redirect', async () => {
    const srv = await serve((req, res) => {
      if (req.url === '/old.jpg') {
        res.writeHead(302, { location: '/new.jpg' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(PAYLOAD);
    });
    const out = await downloadWithRetry(`${srv.base}/old.jpg`, join(dir, 'a.jpg'), { userAgent: UA });
    expect(out.finalUrl).toBe(`${srv.base}/new.jpg`);
  });

  it('retries a 503 and then succeeds', async () => {
    const srv = await serve((_req, res, n) => {
      if (n === 1) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PAYLOAD);
    });
    const { sleep, calls } = recordingSleep();
    const out = await downloadWithRetry(`${srv.base}/x.png`, join(dir, 'x.png'), { userAgent: UA, sleep });
    expect(out.bytes).toBe(PAYLOAD.length);
    expect(srv.requests()).toBe(2);
    expect(calls).toEqual([500]);
  });

  it('throws DownloadStatusError for a 404 without retrying or writing a file', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('missing');
    });
    const { sleep, calls } = recordingSleep();
    const dest = join(dir, 'missing.jpg');
    const err = await downloadWithRetry(`${srv.base}/missing.jpg`, dest, { userAgent: UA, sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadStatusError);
    expect(err).toMatchObject({ status: 404, attempts: 1 });
    expect(srv.requests()).toBe(1);
    expect(calls).toEqual([]);
    expect(existsSync(dest)).toBe(false);
  });

  it('throws DownloadStatusError after the last retryable attempt', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const { sleep } = recordingSleep();
    const err = await downloadWithRetry(`${srv.base}/x.jpg`, join(dir, 'x.jpg'), { userAgent: UA, sleep, maxAttempts: 3 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DownloadStatusError);
    expect(err).toMatchObject({ status: 503, attempts: 3 });
    expect(srv.requests()).toBe(3);
  });

  it('refuses a declared Content-Length over maxBytes before reading, without retrying', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    });
    const dest = join(dir, 'big.jpg');
    const err = await downloadWithRetry(`${srv.base}/big.jpg`, dest, { userAgent: UA, maxBytes: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadTooLargeError);
    expect(srv.requests()).toBe(1);
    expect(existsSync(dest)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('refuses a streamed body that grows past maxBytes and leaves no partial file', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.write(PAYLOAD);
      res.end(PAYLOAD);
    });
    const dest = join(dir, 'chunked.jpg');
    const err = await downloadWithRetry(`${srv.base}/chunked.jpg`, dest, { userAgent: UA, maxBytes: PAYLOAD.length + 10 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DownloadTooLargeError);
    expect(srv.requests()).toBe(1);
    expect(existsSync(dest)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('retries a body cut off mid-stream and keeps only the complete download', async () => {
    const srv = await serve((_req, res, n) => {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(PAYLOAD.length) });
      if (n === 1) {
        res.write(PAYLOAD.subarray(0, 1000));
        setImmediate(() => res.socket?.destroy());
        return;
      }
      res.end(PAYLOAD);
    });
    const { sleep, calls } = recordingSleep();
    const dest = join(dir, 'cut.jpg');
    const out = await downloadWithRetry(`${srv.base}/cut.jpg`, dest, { userAgent: UA, sleep });
    expect(out.bytes).toBe(PAYLOAD.length);
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true);
    expect(srv.requests()).toBe(2);
    expect(calls).toEqual([500]);
    expect(leftovers()).toEqual([]);
  });

  it('gives up on a stalled body after the per-attempt timeout', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.write(PAYLOAD.subarray(0, 1000));
    });
    const { sleep } = recordingSleep();
    const dest = join(dir, 'stall.jpg');
    const err = await downloadWithRetry(`${srv.base}/stall.jpg`, dest, {
      userAgent: UA,
      sleep,
      timeoutMs: 100,
      maxAttempts: 2,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ attempts: 2 });
    expect(srv.requests()).toBe(2);
    expect(existsSync(dest)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('rejects an invalid maxBytes before making a request', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    await expect(downloadWithRetry(`${srv.base}/x`, join(dir, 'x'), { userAgent: UA, maxBytes: 0 })).rejects.toThrow(RangeError);
    expect(srv.requests()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/download.test.ts`

Expected: the file fails to import because `src/lib/download.ts` does not exist. Record the error.

- [ ] **Step 3: Implement**

Create `src/lib/download.ts`:

```ts
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  HttpError,
  isRetryableStatus,
  resolveHttpOptions,
  retryAfterMs,
  retryDelayMs,
  type HttpOptions,
} from './http.js';

export interface DownloadOptions extends HttpOptions {
  /** Refuse bodies larger than this many bytes. Defaults to 50 MiB. */
  maxBytes?: number;
}

export interface DownloadResult {
  url: string;
  /** The URL after redirects (response.url), or the request URL when the response does not report one. */
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  path: string;
  bytes: number;
  sha256: string;
}

export class DownloadStatusError extends Error {
  override name = 'DownloadStatusError';

  constructor(
    readonly url: string,
    readonly status: number,
    readonly attempts: number,
  ) {
    super(`download failed with HTTP ${status} after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${url}`);
  }
}

export class DownloadTooLargeError extends Error {
  override name = 'DownloadTooLargeError';

  constructor(
    readonly url: string,
    readonly maxBytes: number,
  ) {
    super(`download is larger than ${maxBytes} bytes: ${url}`);
  }
}

const DEFAULT_MAX_BYTES = 50 * 1024 ** 2;
/** Whole-attempt timeout for downloads; a large original takes longer than a JSON API call. */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000;

async function writeBody(
  res: Response,
  tmp: string,
  url: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ bytes: number; sha256: string }> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new DownloadTooLargeError(url, maxBytes);
  }
  if (res.body === null) throw new Error(`response has no body: ${url}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new DownloadTooLargeError(url, maxBytes));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), meter, createWriteStream(tmp), { signal });
  return { bytes, sha256: hash.digest('hex') };
}

/**
 * Streams a GET response body to destPath. The body is written to a temporary file beside it and
 * renamed into place only when complete, so a partial download never looks like a finished one.
 * Retry, backoff, timeout and User-Agent rules match fetchWithRetry. A non-2xx response throws
 * DownloadStatusError. A body over maxBytes throws DownloadTooLargeError and is not retried.
 */
export async function downloadWithRetry(url: string, destPath: string, opts: DownloadOptions): Promise<DownloadResult> {
  const o = resolveHttpOptions({ ...opts, timeoutMs: opts.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS });
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(`maxBytes must be an integer >= 1, got ${maxBytes}`);
  }
  const headers = new Headers({ 'user-agent': opts.userAgent });
  const delays = { baseDelayMs: o.baseDelayMs, maxDelayMs: o.maxDelayMs };
  mkdirSync(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.${process.pid}.tmp`;
  let lastError: unknown;

  for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
    const signal = AbortSignal.timeout(o.timeoutMs);
    try {
      const res = await o.fetchImpl(url, { headers, signal });
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel().catch(() => {});
        const retryAfter = res.headers.get('retry-after');
        const header = retryAfterMs(retryAfter, o.now());
        if (!isRetryableStatus(res.status) || attempt === o.maxAttempts || (header !== null && header > delays.maxDelayMs)) {
          throw new DownloadStatusError(url, res.status, attempt);
        }
        await o.sleep(retryDelayMs(attempt, retryAfter, { ...delays, nowMs: o.now() }));
        continue;
      }
      const { bytes, sha256 } = await writeBody(res, tmp, url, maxBytes, signal);
      renameSync(tmp, destPath);
      return {
        url,
        finalUrl: res.url || url,
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        path: destPath,
        bytes,
        sha256,
      };
    } catch (err) {
      rmSync(tmp, { force: true });
      if (err instanceof DownloadStatusError || err instanceof DownloadTooLargeError) throw err;
      lastError = err;
      if (attempt < o.maxAttempts) await o.sleep(retryDelayMs(attempt, null, { ...delays, nowMs: o.now() }));
    }
  }

  throw new HttpError(`network failure after ${o.maxAttempts} attempts: ${url}`, url, o.maxAttempts, { cause: lastError });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/download.test.ts && npm test && npm run typecheck`

Expected:
- 10/10 download tests pass.
- The full suite has **329** tests.
- Typecheck exits 0.
- There are no open-handle warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/download.ts tests/lib/download.test.ts
git commit -m "feat(lib): streaming binary download with retry, size cap and atomic rename

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task Q3: Canonical cache keys and a Windows-safe cache write

**Files:**
- Modify: `src/lib/cache.ts`
- Test: `tests/lib/cache.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `CacheOptions.rename?: (from: string, to: string) => void` and `CacheOptions.sleep?: (ms: number) => Promise<void>`. Both are test hooks.
  - `cacheKey` now canonicalizes the query string.

**Why:** This is the plan.md row **Cache write robustness and key canonicalization**.
- **Rename failures:** on Windows, `renameSync` throws `EPERM`, `EBUSY` or `EACCES` while another process (an editor, a virus scanner, a parallel run) holds the file.
- **Duplicate keys:** parameter order and `%20` vs `+` currently produce different keys for the same request.
- **Rules kept:** repeated parameters keep their relative order, because it can matter. A literal plus (`%2B`) stays distinct from a space.
- **Fixtures:** no committed fixtures exist yet (`data/cache/` is absent), so no stored key is invalidated.
- **After retries run out:** the temp file is removed and the error is rethrown. The failure is loud, and a re-run fetches again.

- [ ] **Step 1: Write the failing tests**

In `tests/lib/cache.test.ts`, add `renameSync` to the `node:fs` import so it reads:

```ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
```

Add these three tests at the end of `describe('cachedFetch', ...)`, just before its closing `});`:

```ts
  it('retries a rename refused with EPERM and then serves the entry', async () => {
    const { calls, fetcher } = countingFetcher();
    const req = { url: 'https://example.test/locked' };
    let refusals = 0;
    const waits: number[] = [];
    const opts = {
      cacheDir: dir,
      source: 'example',
      now: NOW,
      secretValues: [],
      rename: (from: string, to: string) => {
        if (refusals < 2) {
          refusals++;
          throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
        }
        renameSync(from, to);
      },
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    };
    await cachedFetch(req, opts, fetcher);
    expect(waits).toEqual([50, 100]);
    expect(await cachedFetch(req, opts, fetcher)).toMatchObject({ fromCache: true });
    expect(calls).toHaveLength(1);
  });

  it('gives up after five refused renames, removes the temp file and throws', async () => {
    const { fetcher } = countingFetcher();
    const waits: number[] = [];
    let attempts = 0;
    const opts = {
      cacheDir: dir,
      source: 'example',
      now: NOW,
      secretValues: [],
      rename: () => {
        attempts++;
        throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      },
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    };
    await expect(cachedFetch({ url: 'https://example.test/busy' }, opts, fetcher)).rejects.toThrow(/resource busy/);
    expect(attempts).toBe(5);
    expect(waits).toEqual([50, 100, 200, 400]);
    expect(readdirSync(join(dir, 'example'))).toEqual([]);
  });

  it('does not retry a rename that fails for another reason', async () => {
    const { fetcher } = countingFetcher();
    let attempts = 0;
    const opts = {
      cacheDir: dir,
      source: 'example',
      now: NOW,
      secretValues: [],
      rename: () => {
        attempts++;
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      },
      sleep: async () => {},
    };
    await expect(cachedFetch({ url: 'https://example.test/full' }, opts, fetcher)).rejects.toThrow(/no space left/);
    expect(attempts).toBe(1);
    expect(readdirSync(join(dir, 'example'))).toEqual([]);
  });
```

Add these two tests at the end of `describe('cacheKey and redactUrl', ...)`, just before its closing `});`:

```ts
  it('shares one key across query parameter order and space encodings', () => {
    expect(cacheKey({ url: 'https://gutendex.com/books/?search=charles%20dickens&languages=en' })).toBe(
      cacheKey({ url: 'https://gutendex.com/books/?languages=en&search=charles+dickens' }),
    );
  });

  it('keeps distinct keys when repeated parameters are reordered or a plus is literal', () => {
    expect(cacheKey({ url: 'https://x.example.test/?tag=a&tag=b' })).not.toBe(
      cacheKey({ url: 'https://x.example.test/?tag=b&tag=a' }),
    );
    expect(cacheKey({ url: 'https://x.example.test/?q=a%2Bb' })).not.toBe(cacheKey({ url: 'https://x.example.test/?q=a+b' }));
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/cache.test.ts`

Expected RED:
- **Fail:** the three rename tests. The hooks are ignored, so the real `renameSync` succeeds: `waits` is `[]`, and the give-up tests do not reject. The shared-key test also fails, because the keys differ.
- **Pass:** the distinct-keys test already passes. Record it.

- [ ] **Step 3: Implement**

In `src/lib/cache.ts`:

1. Change the `node:fs` import to include `rmSync`:

   ```ts
   import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
   ```

2. Add to `CacheOptions`, after `secretValues`:

   ```ts
     /** Test hook: publishes a written entry. Defaults to fs.renameSync. */
     rename?: (from: string, to: string) => void;
     /** Test hook: waits between rename attempts. */
     sleep?: (ms: number) => Promise<void>;
   ```

3. Replace the `cacheKey` function with:

   ```ts
   /**
    * Query parameters sorted by name and re-encoded one way, so equivalent requests share one key:
    * `?b=2&a=1` and `?a=1&b=2`, `%20` and `+`. Repeated names keep their relative order, and a literal
    * plus (`%2B`) stays distinct from a space. An unparseable URL is used as-is.
    */
   function canonicalUrl(url: string): string {
     let parsed: URL;
     try {
       parsed = new URL(url);
     } catch {
       return url;
     }
     const entries = [...parsed.searchParams.entries()];
     entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
     parsed.search = new URLSearchParams(entries).toString();
     return parsed.toString();
   }

   export function cacheKey(req: HttpRequest): string {
     return sha256(`${req.method ?? 'GET'}\n${canonicalUrl(redactUrl(req.url))}\n${req.body ?? ''}`);
   }
   ```

4. Add this helper directly above `export async function cachedFetch`:

   ```ts
   /** Windows reports these while another process (an editor, a virus scanner, a parallel run) holds the file. */
   const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
   const RENAME_ATTEMPTS = 5;

   async function publishEntry(tmp: string, path: string, cache: CacheOptions): Promise<void> {
     const rename = cache.rename ?? renameSync;
     const sleep = cache.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
     for (let attempt = 1; ; attempt++) {
       try {
         rename(tmp, path);
         return;
       } catch (err) {
         const code = (err as NodeJS.ErrnoException).code;
         if (code === undefined || !RENAME_RETRY_CODES.has(code) || attempt === RENAME_ATTEMPTS) {
           rmSync(tmp, { force: true });
           throw err;
         }
         await sleep(50 * 2 ** (attempt - 1));
       }
     }
   }
   ```

5. In `cachedFetch`, replace `renameSync(tmp, path);` with `await publishEntry(tmp, path, cache);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/cache.test.ts && npm test && npm run typecheck`

Expected:
- The 5 new tests pass, and every existing cache test passes unchanged.
- The full suite has **334** tests.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cache.ts tests/lib/cache.test.ts
git commit -m "fix(lib): canonical cache keys; retry cache renames refused by a locked file

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task Q4: `verifyQuoteItem` takes evidence, not a decision

**Files:**
- Modify: `src/verify/apply.ts`
- Test: `tests/verify/quote-gate.test.ts`

**Interfaces:**
- Consumes: `decideQuote`, `QuoteDecision` and `QuoteEvidence` from `./quote-gate.js`.
- Produces: `verifyQuoteItem(db: Db, itemId: number, evidence: QuoteEvidence[], now?: Date): QuoteDecision`. It returns the decision it applied.
- Removes: `applyQuoteDecision`. This is a deliberate breaking change. No `src/` caller exists yet; `lantern verify` (2.3) is not built.
- Unchanged: `ItemNotFoundError`, `ItemNotRawError` (its message keeps "only raw items"), `NotAQuoteError`, `NotReopenableError`, `parseRejectReason`, `reopenInsufficientEvidence`.

**Why:** Review I2c. `applyQuoteDecision` accepts any hand-built `QuoteDecision`, so a caller could write a `verified` decision without ever running `decideQuote`. `verifyQuoteItem` does three things inside the write transaction:
1. It reads the stored body.
2. It runs `decideQuote` against that body.
3. It writes the result.

The only way to verify a quote is then to supply evidence that passes the gate against the text actually stored.

- [ ] **Step 1: Write the failing tests**

Edit `tests/verify/quote-gate.test.ts`:

1. **Import.** Replace the `apply.js` import block with:

   ```ts
   import {
     ItemNotFoundError,
     ItemNotRawError,
     NotAQuoteError,
     NotReopenableError,
     parseRejectReason,
     reopenInsufficientEvidence,
     verifyQuoteItem,
   } from '../../src/verify/apply.js';
   ```

2. **Property test.** In `'only ever returns verified decisions whose sources pass the insert policy'`, replace the line `expect(() => applyQuoteDecision(db, itemId, d)).not.toThrow();` with:

   ```ts
         expect(verifyQuoteItem(db, itemId, evidence)).toEqual(d);
   ```

3. **Companion-URL test.** In `'verifies on the primary source and drops a companion url that only the trigger used to refuse'`, replace the line `expect(() => applyQuoteDecision(db, itemId, d)).not.toThrow();` with:

   ```ts
       expect(
         verifyQuoteItem(db, itemId, [primary(), { ...scholarly, url: 'https://www.gutenberg.org/ebooks/98?utm_source=goodreads.com' }]),
       ).toEqual(d);
   ```

4. **Describe block.** Rename `describe('applyQuoteDecision', () => {` to `describe('verifyQuoteItem', () => {`.

5. **Every other call.** Everywhere in the file, including `describe('reopenInsufficientEvidence', ...)`, replace each call of the form `applyQuoteDecision(db, <id>, decideQuote(QUOTE, <evidence array>))` with `verifyQuoteItem(db, <id>, <evidence array>)`. For example, `applyQuoteDecision(db, itemId, decideQuote(QUOTE, [wikiquote]))` becomes `verifyQuoteItem(db, itemId, [wikiquote])`, and `applyQuoteDecision(db, factId, decideQuote(QUOTE, [primary()]))` becomes `verifyQuoteItem(db, factId, [primary()])`. Keep each surrounding `expect(() => ...)` wrapper exactly as it is.

6. **Forged-decision test.** Delete the whole test `it('rolls back entirely if any source violates policy', ...)`. That test hands in a forged decision, which is no longer possible. Put these three tests in its place:

   ```ts
     it('returns the decision it applied', () => {
       const db = testDb();
       const { itemId } = seedItem(db, QUOTE);
       expect(verifyQuoteItem(db, itemId, [primary(), wikiquote])).toEqual(decideQuote(QUOTE, [primary(), wikiquote]));
     });

     it('decides against the stored body, not against whatever the evidence quotes', () => {
       const db = testDb();
       const { itemId } = seedItem(db, 'Please, sir, I want some more of the gruel');
       expect(verifyQuoteItem(db, itemId, [primary()])).toMatchObject({ status: 'rejected', reason: 'insufficient-evidence' });
       expect(statusOf(db, itemId)).toMatchObject({ status: 'rejected' });
       expect(db.prepare('SELECT COUNT(*) FROM sources').pluck().get()).toBe(0);
     });

     it('rolls back entirely if a source insert fails part-way', () => {
       const db = testDb();
       const { itemId } = seedItem(db, QUOTE);
       db.exec(
         "CREATE TRIGGER test_refuse_tier3 BEFORE INSERT ON sources WHEN NEW.tier = 3 BEGIN SELECT RAISE(ABORT, 'test: tier 3 refused'); END;",
       );
       expect(() => verifyQuoteItem(db, itemId, [primary(), wikiquote])).toThrow(/test: tier 3 refused/);
       expect(statusOf(db, itemId)).toMatchObject({ status: 'raw' });
       expect(db.prepare('SELECT COUNT(*) FROM sources').pluck().get()).toBe(0);
     });
   ```

7. **Unused imports.** `SourcePolicyError` was used only by the deleted forged-decision test. Change the `source-policy.js` import to `import { assertSourceAllowed } from '../../src/verify/source-policy.js';`.

Check: `grep -c applyQuoteDecision tests/verify/quote-gate.test.ts` must print `0`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/verify/quote-gate.test.ts`

Expected: failure, because `verifyQuoteItem` is not exported from `apply.ts`. Every test that calls it throws `TypeError: verifyQuoteItem is not a function`. Record which tests failed and which passed; the pure `decideQuote` and `parseRejectReason` tests still pass.

- [ ] **Step 3: Implement**

Replace `src/verify/apply.ts` from the first import line through the end of `applyQuoteDecision` (everything above `reopenInsufficientEvidence`'s doc comment) as follows:
- Change the imports.
- Add `body` to the row type and the query.
- Replace `applyQuoteDecision` with `verifyQuoteItem`.
- Leave the four error classes and `parseRejectReason` exactly as they are.

The new imports:

```ts
import { insertSource } from '../db/sources.js';
import type { Db } from '../db/connection.js';
import { decideQuote, type QuoteDecision, type QuoteEvidence } from './quote-gate.js';
```

The new row type, `loadQuote` and `verifyQuoteItem`:

```ts
interface ItemRow {
  status: string;
  kind: string;
  body: string;
  reject_reason: string | null;
}

function loadQuote(db: Db, itemId: number): ItemRow {
  const item = db.prepare('SELECT status, kind, body, reject_reason FROM items WHERE id = ?').get(itemId) as
    | ItemRow
    | undefined;
  if (!item) throw new ItemNotFoundError(itemId);
  if (item.kind !== 'quote') throw new NotAQuoteError(itemId, item.kind);
  return item;
}

/**
 * The only code path that moves a quote item out of 'raw'. The decision is computed here, from the
 * stored body and the given evidence, inside the same transaction that writes it, so no caller can
 * hand in a decision that decideQuote never made. Returns the decision it applied.
 */
export function verifyQuoteItem(db: Db, itemId: number, evidence: QuoteEvidence[], now: Date = new Date()): QuoteDecision {
  return db.transaction(() => {
    const item = loadQuote(db, itemId);
    if (item.status !== 'raw') throw new ItemNotRawError(itemId, item.status);
    const decision = decideQuote(item.body, evidence);

    if (decision.status === 'verified') {
      for (const source of decision.sources) insertSource(db, itemId, source, now);
      db.prepare("UPDATE items SET status = 'verified', reject_reason = NULL WHERE id = ?").run(itemId);
    } else {
      db.prepare("UPDATE items SET status = 'rejected', reject_reason = ? WHERE id = ?").run(
        `${decision.reason}: ${decision.detail}`,
        itemId,
      );
    }
    return decision;
  })();
}
```

`reopenInsufficientEvidence` still calls `loadQuote` and needs no change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/verify/quote-gate.test.ts && npm test && npm run typecheck`

Expected:
- Every quote-gate test passes. There is a net +2 tests (one removed, three added).
- The `/only raw items/` assertion still matches.
- `grep -rn applyQuoteDecision src tests` prints nothing.
- The full suite has **336** tests.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/verify/apply.ts tests/verify/quote-gate.test.ts
git commit -m "fix(verify): verifyQuoteItem decides from evidence against the stored body; remove applyQuoteDecision

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task Q5: Table-rebuild-safe migration runner and a doctor guard-trigger check

**Files:**
- Modify: `src/db/migrate.ts`, `src/doctor/checks.ts`
- Test: `tests/db/migrate.test.ts`, `tests/doctor/checks.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `migrate` runs each migration with foreign keys off around its transaction, and throws `migration <file> leaves N foreign key violation(s): ...` before commit.
  - `expectedTriggers(db: Db, dir: string): string[]` returns names sorted by JS string order.
  - The doctor check `db.triggers`.
- Q6 builds on this `migrate`.

**Why:** Phase 1 review I4. `PRAGMA foreign_keys = OFF` is a no-op inside a transaction, so a table-rebuild migration fails as soon as it drops a referenced table. The probe got `FOREIGN KEY constraint failed`. Rebuilding a table also silently drops its triggers (probe), and the 002-004 guard triggers are part of the §8 backstop. Doctor must therefore notice when any trigger is missing.

- [ ] **Step 1: Write the failing tests**

In `tests/db/migrate.test.ts`:

1. Change the imports to:

   ```ts
   import { describe, it, expect } from 'vitest';
   import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
   import { tmpdir } from 'node:os';
   import { join } from 'node:path';
   import { openDb } from '../../src/db/connection.js';
   import { expectedTriggers, migrate, pendingMigrations, MIGRATIONS_DIR } from '../../src/db/migrate.js';
   import { testDb, seedPublicationChain } from '../helpers/db.js';
   ```

2. Add these tests at the end of `describe('migrate', ...)`, before its closing `});`:

   ```ts
     it('runs a table-rebuild migration on a populated database without breaking foreign keys', () => {
       const dir = tempMigrationsDir({
         '001_parent.sql':
           'CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));',
         '002_seed.sql': "INSERT INTO parent VALUES (1, 'a'); INSERT INTO child VALUES (1, 1);",
         '003_rebuild_parent.sql':
           'CREATE TABLE parent_new (id INTEGER PRIMARY KEY, name TEXT, extra TEXT); INSERT INTO parent_new (id, name) SELECT id, name FROM parent; DROP TABLE parent; ALTER TABLE parent_new RENAME TO parent;',
       });
       const db = openDb(':memory:');
       expect(migrate(db, dir).applied).toEqual(['001_parent.sql', '002_seed.sql', '003_rebuild_parent.sql']);
       expect(db.prepare('SELECT COUNT(*) FROM child JOIN parent ON parent.id = child.parent_id').pluck().get()).toBe(1);
       expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
       expect(() => db.prepare('INSERT INTO child VALUES (2, 999)').run()).toThrow(/FOREIGN KEY/);
     });

     it('rolls back a migration that leaves a dangling foreign key and restores enforcement', () => {
       const dir = tempMigrationsDir({
         '001_parent.sql':
           'CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id)); INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1, 1);',
         '002_orphan.sql': 'DELETE FROM parent;',
       });
       const db = openDb(':memory:');
       expect(() => migrate(db, dir)).toThrow(/002_orphan\.sql leaves 1 foreign key violation/);
       expect(db.prepare('SELECT COUNT(*) FROM parent').pluck().get()).toBe(1);
       expect(pendingMigrations(db, dir)).toEqual(['002_orphan.sql']);
       expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
     });

     it('restores foreign key enforcement after a migration with a syntax error', () => {
       const dir = tempMigrationsDir({ '001_broken.sql': 'CREATE TABLE broken (' });
       const db = openDb(':memory:');
       expect(() => migrate(db, dir)).toThrow();
       expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
     });

     it('applies the remaining real migrations to a database populated after 001', () => {
       const only001 = tempMigrationsDir({});
       copyFileSync(join(MIGRATIONS_DIR, '001_initial.sql'), join(only001, '001_initial.sql'));
       const db = openDb(':memory:');
       migrate(db, only001);
       const seeded = seedPublicationChain(db);
       const rest = readdirSync(MIGRATIONS_DIR)
         .filter((f) => f.endsWith('.sql'))
         .sort()
         .slice(1);
       expect(migrate(db, MIGRATIONS_DIR).applied).toEqual(rest);
       expect(db.pragma('foreign_key_check')).toEqual([]);
       expect(db.prepare('SELECT body FROM items WHERE id = ?').pluck().get(seeded.itemId)).toBe('It was the best of times');
     });

     it('lists the triggers the applied migrations leave in place', () => {
       const db = testDb();
       const present = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").pluck().all();
       expect(expectedTriggers(db, MIGRATIONS_DIR)).toEqual(present);
       expect(present).toContain('items_verified_not_reopened');
     });

     it('replays CREATE TRIGGER and DROP TRIGGER in order', () => {
       const dir = tempMigrationsDir({
         '001_t.sql':
           'CREATE TABLE t (id INTEGER PRIMARY KEY); CREATE TRIGGER t_a BEFORE INSERT ON t BEGIN SELECT 1; END; CREATE TRIGGER t_b BEFORE DELETE ON t BEGIN SELECT 1; END;',
         '002_drop.sql': 'DROP TRIGGER t_a; CREATE TRIGGER IF NOT EXISTS t_c BEFORE UPDATE ON t BEGIN SELECT 1; END;',
       });
       const db = openDb(':memory:');
       migrate(db, dir);
       expect(expectedTriggers(db, dir)).toEqual(['t_b', 't_c']);
     });
   ```

In `tests/doctor/checks.test.ts`, add this test at the end of `describe('runChecks', ...)`, before its closing `});`:

```ts
  it('fails when a guard trigger is missing', () => {
    const ctx = healthyCtx();
    ctx.db.exec('DROP TRIGGER items_verified_not_reopened');
    const r = byName(ctx, 'db.triggers');
    expect(r).toMatchObject({ status: 'fail' });
    expect(r?.detail).toContain('items_verified_not_reopened');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/migrate.test.ts tests/doctor/checks.test.ts`

Expected RED:
- The file fails to import `expectedTriggers`. If you add a temporary stub to see per-test results, here is what happens against the current runner:
  - **Rebuild test:** fails with `FOREIGN KEY constraint failed`.
  - **Dangling test:** fails, because the thrown message is `FOREIGN KEY constraint failed`, not the new message.
  - **Doctor test:** fails, because there is no `db.triggers` check.
  - **Syntax-error test and populated-001 test:** already pass, as guards.

Record what you observe.

- [ ] **Step 3: Implement**

In `src/db/migrate.ts`, replace the `migrate` function with the version below and add `expectedTriggers` after it:

```ts
/**
 * Each migration runs in its own transaction with foreign keys switched off around it (the pragma is a
 * no-op inside a transaction), so a table-rebuild migration can drop and recreate a referenced table.
 * `PRAGMA foreign_key_check` must come back empty before the transaction commits, and enforcement is
 * restored afterwards, even on failure. Rebuilding a table drops its triggers: a rebuild of `items` or
 * `sources` must recreate the 002-004 guard triggers, and `lantern doctor` fails if any are missing.
 */
export function migrate(db: Db, dir: string): { applied: string[]; current: string | null } {
  const pending = pendingMigrations(db, dir);
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  for (const file of pending) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(sql);
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `migration ${file} leaves ${violations.length} foreign key violation(s): ${JSON.stringify(violations.slice(0, 5))}`,
          );
        }
        record.run(file, new Date().toISOString());
      })();
    } finally {
      db.pragma(`foreign_keys = ${foreignKeys === 1 ? 'ON' : 'OFF'}`);
    }
  }
  return { applied: pending, current: migrationFiles(dir).at(-1) ?? null };
}

const CREATE_TRIGGER = /\bCREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
const DROP_TRIGGER = /\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;

/** Trigger names the applied migrations should have left in place: CREATE and DROP TRIGGER replayed in order. */
export function expectedTriggers(db: Db, dir: string): string[] {
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[]);
  const names = new Set<string>();
  for (const file of migrationFiles(dir).filter((f) => applied.has(f))) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const events = [
      ...[...sql.matchAll(CREATE_TRIGGER)].map((m) => ({ at: m.index ?? 0, name: m[1] ?? '', create: true })),
      ...[...sql.matchAll(DROP_TRIGGER)].map((m) => ({ at: m.index ?? 0, name: m[1] ?? '', create: false })),
    ].sort((a, b) => a.at - b.at);
    for (const event of events) {
      if (event.create) names.add(event.name);
      else names.delete(event.name);
    }
  }
  return [...names].sort();
}
```

In `src/doctor/checks.ts`:

1. Change the migrate import to `import { expectedTriggers, pendingMigrations } from '../db/migrate.js';`.

2. Directly after the `try { ... } catch { ... }` block that pushes `db.migrations`, add:

   ```ts
     if (pending !== undefined && pending.length === 0) {
       const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").pluck().all() as string[]);
       const missing = expectedTriggers(db, ctx.migrationsDir).filter((name) => !present.has(name));
       out.push(
         missing.length === 0
           ? result('db.triggers', 'ok', `${present.size} triggers present`)
           : result('db.triggers', 'fail', `missing guard triggers: ${missing.join(', ')}; the schema was changed outside lantern migrate`),
       );
     }
   ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/db/migrate.test.ts tests/doctor/checks.test.ts && npm test && npm run typecheck`

Expected:
- The 6 new migrate tests and 1 new doctor test pass.
- The healthy-system doctor test still has no warnings or failures.
- The full suite has **343** tests.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrate.ts src/doctor/checks.ts tests/db/migrate.test.ts tests/doctor/checks.test.ts
git commit -m "fix(db): run table-rebuild migrations with foreign keys checked, not enforced mid-rebuild; doctor checks guard triggers

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task Q6: Migration checksums and a doctor drift check

**Files:**
- Modify: `src/db/migrate.ts`, `src/doctor/checks.ts`
- Test: `tests/db/migrate.test.ts`, `tests/doctor/checks.test.ts`

**Interfaces:**
- Consumes (from Q5): `migrate`, `expectedTriggers`, and the `db.triggers` check.
- Produces:
  - `migrationChecksum(sql: string): string`: SHA-256 hex of the text with CRLF folded to LF.
  - `interface MigrationDrift { edited: string[]; unknown: string[]; unrecorded: string[] }`.
  - `migrationDrift(db: Db, dir: string): MigrationDrift`.
  - A `schema_migrations.checksum` column, added by the runner.
  - The doctor check `db.drift`.

**Why:** Phase 1 review Minor 6. Doctor cannot currently detect either of these:
- An applied migration file that was edited afterwards, so a fresh environment would build a different schema.
- A database that is ahead of the code.

The runner owns `schema_migrations`, so it adds the column itself (`ALTER TABLE ... ADD COLUMN` is not a rebuild). It records checksums on apply and backfills rows that have none: the file present at the first `lantern migrate` after this change is trusted.

Doctor statuses:
- **fail:** a file was edited, or an applied migration is missing from `migrations/`.
- **warn:** a checksum was never recorded. Running `lantern migrate` records it.

- [ ] **Step 1: Write the failing tests**

In `tests/db/migrate.test.ts`:

1. Change the `node:fs` import to `import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';`.
2. Change the connection import to `import { openDb, type Db } from '../../src/db/connection.js';`.
3. Change the migrate import to `import { expectedTriggers, migrate, migrationDrift, pendingMigrations, MIGRATIONS_DIR } from '../../src/db/migrate.js';`.
4. Add these tests at the end of `describe('migrate', ...)`:

```ts
  it('records a line-ending-independent checksum for each applied migration', () => {
    const lf = tempMigrationsDir({ '001_t.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);\nCREATE TABLE u (id INTEGER PRIMARY KEY);\n' });
    const crlf = tempMigrationsDir({
      '001_t.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);\r\nCREATE TABLE u (id INTEGER PRIMARY KEY);\r\n',
    });
    const a = openDb(':memory:');
    migrate(a, lf);
    const b = openDb(':memory:');
    migrate(b, crlf);
    const checksumOf = (db: Db) => db.prepare('SELECT checksum FROM schema_migrations').pluck().get();
    expect(checksumOf(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(checksumOf(a)).toBe(checksumOf(b));
  });

  it('backfills checksums on a database migrated before checksums existed', () => {
    const dir = tempMigrationsDir({
      '001_t.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
      '002_u.sql': 'CREATE TABLE u (id INTEGER PRIMARY KEY);',
    });
    const db = openDb(':memory:');
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL); CREATE TABLE t (id INTEGER PRIMARY KEY);');
    db.prepare("INSERT INTO schema_migrations VALUES ('001_t.sql', '2026-01-01T00:00:00.000Z')").run();
    expect(migrationDrift(db, dir).unrecorded).toEqual(['001_t.sql']);
    expect(migrate(db, dir).applied).toEqual(['002_u.sql']);
    expect(migrationDrift(db, dir)).toEqual({ edited: [], unknown: [], unrecorded: [] });
  });

  it('reports a migration file edited after it was applied', () => {
    const dir = tempMigrationsDir({ '001_t.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);' });
    const db = openDb(':memory:');
    migrate(db, dir);
    writeFileSync(join(dir, '001_t.sql'), 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);');
    expect(migrationDrift(db, dir)).toEqual({ edited: ['001_t.sql'], unknown: [], unrecorded: [] });
  });

  it('reports an applied migration that is missing from the directory', () => {
    const dir = tempMigrationsDir({
      '001_t.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
      '002_u.sql': 'CREATE TABLE u (id INTEGER PRIMARY KEY);',
    });
    const db = openDb(':memory:');
    migrate(db, dir);
    rmSync(join(dir, '002_u.sql'));
    expect(migrationDrift(db, dir)).toEqual({ edited: [], unknown: ['002_u.sql'], unrecorded: [] });
  });
```

In `tests/doctor/checks.test.ts`:

1. Change the `node:fs` import to `import { appendFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';`.
2. Add these tests at the end of `describe('runChecks', ...)`:

```ts
  it('fails when an applied migration file was edited afterwards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lantern-migrations-'));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const ctx = healthyCtx({ migrationsDir: dir });
    appendFileSync(join(dir, '004_item_guards.sql'), '\n-- edited after being applied\n');
    const r = byName(ctx, 'db.drift');
    expect(r).toMatchObject({ status: 'fail' });
    expect(r?.detail).toContain('004_item_guards.sql');
  });

  it('warns when applied migrations have no recorded checksum', () => {
    const ctx = healthyCtx();
    ctx.db.prepare('UPDATE schema_migrations SET checksum = NULL').run();
    expect(byName(ctx, 'db.drift')).toMatchObject({ status: 'warn' });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/migrate.test.ts tests/doctor/checks.test.ts`

Expected: the tests fail to import `migrationDrift`. With a temporary stub:
- **Checksum test:** fails, because there is no `checksum` column.
- **Two doctor tests:** fail, because there is no `db.drift` check.

Record what you observe.

- [ ] **Step 3: Implement**

In `src/db/migrate.ts`:

1. Add `import { createHash } from 'node:crypto';` as the first import.

2. Replace `ensureTable` with:

   ```ts
   function ensureTable(db: Db): void {
     db.exec(
       'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT)',
     );
   }

   const hasChecksumColumn = (db: Db) =>
     (db.prepare("SELECT COUNT(*) FROM pragma_table_info('schema_migrations') WHERE name = 'checksum'").pluck().get() as number) === 1;

   /** SHA-256 of a migration file with CRLF folded to LF, so a Windows checkout hashes like any other. */
   export function migrationChecksum(sql: string): string {
     return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
   }
   ```

3. In `migrate`, replace these two lines:

   ```ts
     const pending = pendingMigrations(db, dir);
     const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
   ```

   with:

   ```ts
     const pending = pendingMigrations(db, dir);
     if (!hasChecksumColumn(db)) db.exec('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT');
     // Trust on first use: a migration applied before checksums existed gets the checksum of its file as it is now.
     const files = new Set(migrationFiles(dir));
     const backfill = db.prepare('UPDATE schema_migrations SET checksum = ? WHERE name = ? AND checksum IS NULL');
     for (const name of db.prepare('SELECT name FROM schema_migrations WHERE checksum IS NULL').pluck().all() as string[]) {
       if (files.has(name)) backfill.run(migrationChecksum(readFileSync(join(dir, name), 'utf8')), name);
     }
     const record = db.prepare('INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)');
   ```

   Then change `record.run(file, new Date().toISOString());` to `record.run(file, new Date().toISOString(), migrationChecksum(sql));`.

4. Add after `expectedTriggers`:

   ```ts
   export interface MigrationDrift {
     /** Applied migrations whose file changed after it was applied. */
     edited: string[];
     /** Applied migrations with no file in the directory: the database is ahead of this code. */
     unknown: string[];
     /** Applied migrations with no checksum yet; the next `lantern migrate` records one. */
     unrecorded: string[];
   }

   export function migrationDrift(db: Db, dir: string): MigrationDrift {
     ensureTable(db);
     const files = new Set(migrationFiles(dir));
     const rows = (
       hasChecksumColumn(db)
         ? db.prepare('SELECT name, checksum FROM schema_migrations ORDER BY name').all()
         : db.prepare('SELECT name, NULL AS checksum FROM schema_migrations ORDER BY name').all()
     ) as { name: string; checksum: string | null }[];
     const drift: MigrationDrift = { edited: [], unknown: [], unrecorded: [] };
     for (const row of rows) {
       if (!files.has(row.name)) drift.unknown.push(row.name);
       else if (row.checksum === null) drift.unrecorded.push(row.name);
       else if (row.checksum !== migrationChecksum(readFileSync(join(dir, row.name), 'utf8'))) drift.edited.push(row.name);
     }
     return drift;
   }
   ```

In `src/doctor/checks.ts`:

1. Change the migrate import to `import { expectedTriggers, migrationDrift, pendingMigrations } from '../db/migrate.js';`.

2. Directly after the `db.triggers` block from Q5, add:

   ```ts
     if (pending !== undefined) {
       const drift = migrationDrift(db, ctx.migrationsDir);
       if (drift.edited.length > 0 || drift.unknown.length > 0) {
         const parts = [
           ...(drift.edited.length > 0 ? [`edited after being applied: ${drift.edited.join(', ')}`] : []),
           ...(drift.unknown.length > 0 ? [`applied but not in migrations/: ${drift.unknown.join(', ')}`] : []),
         ];
         out.push(result('db.drift', 'fail', parts.join('; ')));
       } else if (drift.unrecorded.length > 0) {
         out.push(result('db.drift', 'warn', `no checksum recorded for ${drift.unrecorded.join(', ')}; run lantern migrate to record them`));
       } else {
         out.push(result('db.drift', 'ok', 'applied migrations match their files'));
       }
     }
   ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/db/migrate.test.ts tests/doctor/checks.test.ts && npm test && npm run typecheck`

Expected:
- The 4 new migrate tests and 2 new doctor tests pass.
- The healthy-system doctor test still has no warnings or failures.
- The full suite has **349** tests.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrate.ts src/doctor/checks.ts tests/db/migrate.test.ts tests/doctor/checks.test.ts
git commit -m "feat(db): record migration checksums; doctor reports edited or unknown applied migrations

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task Q7: Log a mistyped CLI command

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli/cli.test.ts` (new)

**Interfaces:**
- Consumes: `CommanderError` from `commander`.
- Produces: a log record `{ level: 'error', msg: 'command rejected', code, message }` for any commander error with a non-zero exit code. The CLI's exit codes are unchanged.

**Why:** Phase 1 review Minor 2. A mistyped scheduled command exits 1 with nothing in `logs/`, which defeats the "a cron job leaves a log" rationale (§4).

With `exitOverride()`, commander throws a `CommanderError` instead of calling `process.exit`. The probe on commander 15 showed:
- An unknown command gives `commander.unknownCommand`, exit 1.
- An unknown option gives `commander.unknownOption`, exit 1.
- `--help` gives `commander.helpDisplayed`, exit 0.
- No arguments gives `commander.help`, exit 1.

Commander has already printed its own message to stderr before throwing.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/cli.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the real CLI from the project root, with logs and database redirected to a temp dir. */
function runCli(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LANTERN_LOGS: join(dir, 'logs'), LANTERN_DB: join(dir, 'lantern.db') },
    timeout: 60_000,
  });
}

function logRecords(): Record<string, unknown>[] {
  const logs = join(dir, 'logs');
  if (!existsSync(logs)) return [];
  return readdirSync(logs).flatMap((file) =>
    readFileSync(join(logs, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}

describe('lantern CLI', () => {
  it('logs a mistyped command to logs/ and exits 1', () => {
    const run = runCli('doctr');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("unknown command 'doctr'");
    expect(logRecords()).toEqual([
      expect.objectContaining({ level: 'error', msg: 'command rejected', code: 'commander.unknownCommand' }),
    ]);
  }, 60_000);

  it('exits 0 for --help without logging an error', () => {
    const run = runCli('--help');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Usage: lantern');
    expect(logRecords().filter((r) => r.level === 'error')).toEqual([]);
  }, 60_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/cli/cli.test.ts`

Expected RED:
- **Fail:** the mistyped-command test. Commander calls `process.exit(1)` without logging, so `logRecords()` is `[]`.
- **Pass:** the `--help` test already passes. Record it.

- [ ] **Step 3: Implement**

In `src/cli.ts`:

1. Change the commander import to `import { Command, CommanderError } from 'commander';`.

2. Replace the `const program = ...` line with:

   ```ts
   const program = new Command()
     .name('lantern')
     .description('Automated educational social content engine')
     .exitOverride();
   ```

3. Replace the final `program.parseAsync().catch(...)` block with:

   ```ts
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/cli/cli.test.ts && npm test && npm run typecheck`

Expected:
- 2/2 CLI tests pass.
- The full suite has **351** tests across 18 files.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli/cli.test.ts
git commit -m "fix(cli): log rejected commands (unknown command or option) to logs/

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task Q8: Docs

**Files:**
- Modify: `claude.md`, `plan.md`

**Interfaces:** none.

**Why:** Spec §15 says a stale CLAUDE.md is worse than none:
- §8 names `applyQuoteDecision`, which Q4 removed.
- §11 does not state the POST retry rule from Q1.
- The §4 layout and the §7 doctor description predate Q2, Q5 and Q6.
- `plan.md` rows need status lines, and milestone 2.3 names the removed function.

Both files are Markdown and already contain non-ASCII characters. Do not re-encode them, do not reflow paragraphs, and change nothing but the edits below.

- [ ] **Step 1: Edit `claude.md`**

1. **§8.** Replace `` `applyQuoteDecision`, which are authoritative) `` with `` `verifyQuoteItem`, which are authoritative) ``.

2. **§4 package layout.** In the line that starts `    lib/` and contains `http client + response cache`, replace `http client + response cache` with `http client + response cache + streaming download`.

3. **§7 doctor.** The `lantern doctor` paragraph wraps "DB" and "integrity" onto separate lines (`quota headroom, DB` / `integrity, queue depth, last successful publish, disk usage. Run it daily; it is`). On the second of those lines, replace `integrity, queue depth,` with `integrity (including missing guard triggers and migration files edited after they were applied), queue depth,`. Then re-wrap only that one paragraph to about 80 columns.

4. **§11 "Rate limiting & retries".** Directly after the sentence ending `Never retry a 4xx that is not a rate limit — fix it instead.`, add this sentence on the same line or the next wrapped line:

   ```
   A POST is sent once: after a network error, timeout or 5xx it is not retried, because the platform may already have acted on it; only a 429 is retried, unless the adapter opts in with an idempotency key.
   ```

   Keep the wrapping at about 80 columns, like the surrounding text.

- [ ] **Step 2: Edit `plan.md`**

1. **Phase 1 status line.** Directly under the heading `### Prerequisites carried from the Phase 1 final review`, insert a blank line and then:

   ```markdown
   > **Status:** the **I4** row (foreign-key-safe migration runner and the doctor guard-trigger check; a future rebuild of `items` or `sources` must still recreate the 002-004 triggers in the same migration), **Unknown-command logging** and **Migration drift** rows are done on branch `phase-2-prerequisites` (docs/plans/phase-2-prerequisites.md, Tasks Q5-Q7).
   ```

   If the heading is already followed by a blank line, keep exactly one blank line on each side of the new status line.

2. **Part B status line.** Under `### Prerequisites carried from the Part B final review`, directly after the existing status line that names Tasks H1-H4, insert a blank line and then:

   ```markdown
   > **Status:** the **Apply takes evidence, not a decision**, **Binary downloads** and **Cache write robustness and key canonicalization** rows are done on branch `phase-2-prerequisites` (Tasks Q2-Q4). The retry half of **Unsafe-method retries and upload timeouts** is done (Task Q1); separate connect/idle timeouts for long uploads remain for Phase 8.
   ```

3. **Milestone 2.3.** In the milestone 2.3 bullet, replace `` calls `decideQuote`, then `applyQuoteDecision`. `` with `` calls `verifyQuoteItem`, which runs `decideQuote` against the stored body inside the write transaction. ``

- [ ] **Step 3: Verify**

```bash
grep -c 'applyQuoteDecision' claude.md plan.md
grep -c 'verifyQuoteItem' claude.md
grep -c 'A POST is sent once' claude.md
grep -c 'phase-2-prerequisites' plan.md
git diff --stat
```

Expected:
- `applyQuoteDecision` count is `0` for `claude.md`. In `plan.md` it stays in historical text (the Part B task write-ups and the **Apply takes evidence** row describe what was built then); only the milestone 2.3 bullet changes, so the `plan.md` count drops by exactly 1. Report both counts.
- `verifyQuoteItem` in `claude.md`: `1`.
- `A POST is sent once` in `claude.md`: `1`.
- `phase-2-prerequisites` in `plan.md`: `2`.
- The diff touches only `claude.md` and `plan.md`.

- [ ] **Step 4: Commit**

```bash
git add claude.md plan.md
git commit -m "docs: verifyQuoteItem, POST retry rule, doctor trigger and drift checks; prerequisite status

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

## Done when

- Tasks Q1-Q8 are committed on `phase-2-prerequisites`.
- The full suite has **351** tests across 18 files, and all pass.
- `npm run typecheck` exits 0.
- `grep -rn applyQuoteDecision src tests claude.md` prints nothing.
- No new non-ASCII characters appear in `.ts` files.
- The user's real `data/lantern.db` is untouched. Their next `lantern migrate` applies 002-004, adds `schema_migrations.checksum`, and records checksums for all applied files.
