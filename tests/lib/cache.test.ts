import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheCorruptError, cachedFetch, cacheKey, redactUrl, secretEnvValues } from '../../src/lib/cache.js';
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
  rmSync(dir, { recursive: true, force: true });
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
    const opts = { cacheDir: dir, source: 'gutendex', now: NOW, secretValues: [] };

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
    const opts = { cacheDir: dir, source: 'gutendex', now: NOW, secretValues: [] };
    await cachedFetch(req, opts, fetcher);
    expect(await cachedFetch(req, { ...opts, refresh: true }, fetcher)).toMatchObject({ body: '{"n":2}', fromCache: false });
    expect(await cachedFetch(req, opts, fetcher)).toMatchObject({ body: '{"n":2}', fromCache: true });
    expect(calls).toHaveLength(2);
  });

  it.each([503, 429])('never caches a %i', async (status) => {
    const { calls, fetcher } = countingFetcher({ status });
    const req = { url: 'https://example.test/flaky' };
    await cachedFetch(req, { cacheDir: dir, source: 'example', secretValues: [] }, fetcher);
    await cachedFetch(req, { cacheDir: dir, source: 'example', secretValues: [] }, fetcher);
    expect(calls).toHaveLength(2);
    expect(existsSync(join(dir, 'example'))).toBe(false);
  });

  it('caches a 404 because it is a real API answer', async () => {
    const { calls, fetcher } = countingFetcher({ status: 404, body: 'not found' });
    const req = { url: 'https://example.test/missing' };
    await cachedFetch(req, { cacheDir: dir, source: 'example', secretValues: [] }, fetcher);
    expect(await cachedFetch(req, { cacheDir: dir, source: 'example', secretValues: [] }, fetcher)).toMatchObject({
      status: 404,
      fromCache: true,
    });
    expect(calls).toHaveLength(1);
  });

  it.each(['../escape', 'Wiki Media', '', 'a/b'])('rejects the unsafe source name %j', async (source) => {
    const { fetcher } = countingFetcher();
    await expect(cachedFetch({ url: 'https://example.test/' }, { cacheDir: dir, source, secretValues: [] }, fetcher)).rejects.toThrow(
      /invalid cache source name/,
    );
  });

  it('never writes credentials into the cache', async () => {
    const { fetcher } = countingFetcher({
      headers: { 'content-type': 'text/plain', 'set-cookie': 'session=secret-cookie', authorization: 'Bearer secret-bearer' },
    });
    await cachedFetch(
      { url: 'https://user:secret-pw@api.example.test/items?api_key=secret-abc&q=dickens&access_token=secret-zzz', method: 'POST', body: 'password=secret-hunter2' },
      { cacheDir: dir, source: 'example', now: NOW, allowNonGet: true, secretValues: [] },
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

  it('stores only allowlisted response headers', async () => {
    const { fetcher } = countingFetcher({
      headers: {
        'content-type': 'application/json',
        etag: '"v1"',
        'x-api-key': 'leak-header-value',
        'www-authenticate': 'Bearer leak-realm',
      },
    });
    await cachedFetch({ url: 'https://example.test/h' }, { cacheDir: dir, source: 'example', now: NOW, secretValues: [] }, fetcher);
    const [file] = readdirSync(join(dir, 'example'));
    const stored = JSON.parse(readFileSync(join(dir, 'example', file!), 'utf8'));
    expect(Object.keys(stored.headers).sort()).toEqual(['content-type', 'etag']);
    expect(JSON.stringify(stored)).not.toMatch(/leak-/);
  });

  it('refuses to cache a response body that echoes a redacted credential, but still returns it', async () => {
    const req = { url: 'https://api.example.test/items?api_key=leak-echo-12345&q=dickens' };
    const { calls, fetcher } = countingFetcher({ body: '{"request":"/items?api_key=leak-echo-12345"}' });
    const first = await cachedFetch(req, { cacheDir: dir, source: 'example', secretValues: [] }, fetcher);
    expect(first).toMatchObject({ status: 200, fromCache: false });
    expect(existsSync(join(dir, 'example'))).toBe(false);
    await cachedFetch(req, { cacheDir: dir, source: 'example', secretValues: [] }, fetcher);
    expect(calls).toHaveLength(2);
  });

  it('stores pretty, LF-terminated JSON', async () => {
    const { fetcher } = countingFetcher();
    await cachedFetch({ url: 'https://gutendex.com/books/1400' }, { cacheDir: dir, source: 'gutendex', now: NOW, secretValues: [] }, fetcher);
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
    const opts = { cacheDir: dir, source: 'local-test', now: NOW, secretValues: [] };

    await cachedFetch({ url: `${base}/books` }, opts, fetcher);
    expect(await cachedFetch({ url: `${base}/books` }, opts, fetcher)).toMatchObject({ fromCache: true, body: '{"results":[]}' });
    await cachedFetch({ url: `${base}/missing` }, opts, fetcher);
    expect(await cachedFetch({ url: `${base}/missing` }, opts, fetcher)).toMatchObject({ fromCache: true, status: 404 });
    expect(hits).toEqual({ '/books': 1, '/missing': 1 });
  });

  it.each([304, 401, 403, 408])('never caches a %i', async (status) => {
    const { calls, fetcher } = countingFetcher({ status });
    const req = { url: 'https://example.test/denied' };
    await cachedFetch(req, { cacheDir: dir, source: 'example', secretValues: [] }, fetcher);
    await cachedFetch(req, { cacheDir: dir, source: 'example', secretValues: [] }, fetcher);
    expect(calls).toHaveLength(2);
    expect(existsSync(join(dir, 'example'))).toBe(false);
  });

  it('caches a 410 because the resource is permanently gone', async () => {
    const { calls, fetcher } = countingFetcher({ status: 410, body: 'gone' });
    const req = { url: 'https://example.test/gone' };
    await cachedFetch(req, { cacheDir: dir, source: 'example', secretValues: [] }, fetcher);
    expect(await cachedFetch(req, { cacheDir: dir, source: 'example', secretValues: [] }, fetcher)).toMatchObject({
      status: 410,
      fromCache: true,
    });
    expect(calls).toHaveLength(1);
  });

  it('honours a per-source cacheable veto', async () => {
    const { calls, fetcher } = countingFetcher({ body: '{"error":{"code":"mediawiki-api-error"}}' });
    const opts = {
      cacheDir: dir,
      source: 'wikiquote',
      secretValues: [],
      cacheable: (r: HttpResult) => !r.body.includes('mediawiki-api-error'),
    };
    await cachedFetch({ url: 'https://example.test/api' }, opts, fetcher);
    await cachedFetch({ url: 'https://example.test/api' }, opts, fetcher);
    expect(calls).toHaveLength(2);
    expect(existsSync(join(dir, 'wikiquote'))).toBe(false);
  });

  it('refuses to store an allowlisted Link header that echoes a URL credential', async () => {
    const { fetcher } = countingFetcher({
      headers: { 'content-type': 'application/json', link: '<https://api.example.test/next?access_token=leak-link-token>; rel="next"' },
    });
    await cachedFetch(
      { url: 'https://api.example.test/items?access_token=leak-link-token' },
      { cacheDir: dir, source: 'example', secretValues: [] },
      fetcher,
    );
    expect(existsSync(join(dir, 'example'))).toBe(false);
  });

  it.each([
    ['percent-encoded', '{"next":"items?api_key=leak%2Fecho-value"}'],
    ['JSON slash-escaped', '{"next":"items?api_key=leak\\/echo-value"}'],
  ])('refuses to store a %s credential echo', async (_label, body) => {
    const { fetcher } = countingFetcher({ body });
    await cachedFetch(
      { url: 'https://api.example.test/items?api_key=leak%2Fecho-value' },
      { cacheDir: dir, source: 'example', secretValues: [] },
      fetcher,
    );
    expect(existsSync(join(dir, 'example'))).toBe(false);
  });

  it('refuses to store a JSON-escaped echo of a secret that contains a quote', async () => {
    const { fetcher } = countingFetcher({ body: '{"echo":"env-secret\\"quoted"}' });
    await cachedFetch(
      { url: 'https://example.test/plain' },
      { cacheDir: dir, source: 'example', secretValues: ['env-secret"quoted'] },
      fetcher,
    );
    expect(existsSync(join(dir, 'example'))).toBe(false);
  });

  it('refuses to store secret values from secret-named env vars', async () => {
    const { fetcher } = countingFetcher({ body: '{"echo":"env-secret-value-123"}' });
    const result = await cachedFetch(
      { url: 'https://example.test/plain' },
      { cacheDir: dir, source: 'example', secretValues: ['env-secret-value-123'] },
      fetcher,
    );
    expect(result).toMatchObject({ status: 200, fromCache: false });
    expect(existsSync(join(dir, 'example'))).toBe(false);
  });

  it('refuses non-GET requests unless allowNonGet is set', async () => {
    const { fetcher } = countingFetcher();
    await expect(
      cachedFetch({ url: 'https://example.test/', method: 'POST', body: 'x=1' }, { cacheDir: dir, source: 'example', secretValues: [] }, fetcher),
    ).rejects.toThrow(/GET requests only/);
  });

  it.each([
    ['empty', ''],
    ['shape-invalid', '{}'],
  ])('throws CacheCorruptError for a %s entry', async (_label, content) => {
    const req = { url: 'https://example.test/corrupt' };
    mkdirSync(join(dir, 'example'), { recursive: true });
    writeFileSync(join(dir, 'example', `${cacheKey(req)}.json`), content);
    const { fetcher } = countingFetcher();
    await expect(
      cachedFetch(req, { cacheDir: dir, source: 'example', secretValues: [] }, fetcher),
    ).rejects.toThrow(CacheCorruptError);
  });

  it('stores a redacted finalUrl and returns it on a cache hit', async () => {
    const { fetcher } = countingFetcher({ finalUrl: 'https://mirror.example.test/books/98?api_key=leak-final-url-key' });
    const req = { url: 'https://gutendex.example.test/books/98' };
    const opts = { cacheDir: dir, source: 'gutendex', now: NOW, secretValues: [] };
    const fresh = await cachedFetch(req, opts, fetcher);
    expect(fresh.finalUrl).toBe('https://mirror.example.test/books/98?api_key=leak-final-url-key');
    const hit = await cachedFetch(req, opts, fetcher);
    expect(hit).toMatchObject({ fromCache: true, finalUrl: 'https://mirror.example.test/books/98?api_key=REDACTED' });
    const [file] = readdirSync(join(dir, 'gutendex'));
    expect(readFileSync(join(dir, 'gutendex', file!), 'utf8')).not.toMatch(/leak-/);
  });

  it('refuses to store an entry whose body echoes a credential that appears only in finalUrl', async () => {
    const { calls, fetcher } = countingFetcher({
      finalUrl: 'https://mirror.example.test/books/98?api_key=leak-final-only-key',
      body: '{"echo":"leak-final-only-key"}',
    });
    const req = { url: 'https://gutendex.example.test/books/98' };
    const opts = { cacheDir: dir, source: 'gutendex', now: NOW, secretValues: [] };

    await cachedFetch(req, opts, fetcher);
    await cachedFetch(req, opts, fetcher);
    expect(calls).toHaveLength(2);
  });

  it('reads an entry written before finalUrl existed', async () => {
    const req = { url: 'https://example.test/legacy' };
    mkdirSync(join(dir, 'example'), { recursive: true });
    writeFileSync(
      join(dir, 'example', `${cacheKey(req)}.json`),
      `${JSON.stringify({ request: { method: 'GET', url: req.url }, url: req.url, status: 200, headers: {}, body: 'old', fetchedAt: '2026-01-01T00:00:00.000Z' }, null, 2)}\n`,
    );
    const { calls, fetcher } = countingFetcher();
    const hit = await cachedFetch(req, { cacheDir: dir, source: 'example', secretValues: [] }, fetcher);
    expect(hit).toMatchObject({ fromCache: true, body: 'old' });
    expect(hit.finalUrl).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

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

  it('does not collapse different requests whose parameter names merely contain a credential word', () => {
    expect(cacheKey({ url: 'https://gutendex.com/books?author=Dickens' })).not.toBe(
      cacheKey({ url: 'https://gutendex.com/books?author=Austen' }),
    );
    const url = 'https://gutendex.com/books?author=Dickens&keyword=war&authority=lc&monkey=1';
    expect(redactUrl(url)).toBe(url);
  });

  it('redacts exact credential names regardless of case and separators', () => {
    const redacted = redactUrl(
      'https://x.example.test/a?API-KEY=leak-one&Access_Token=leak-two&sig=leak-three&X-Amz-Security-Token=leak-four&jwt=leak-five&q=1',
    );
    expect(redacted).not.toMatch(/leak-/);
    expect(redacted).toContain('q=1');
  });

  it('strips URL fragments, which servers never receive', () => {
    expect(redactUrl('https://x.example.test/cb#access_token=leak-frag&state=1')).toBe('https://x.example.test/cb');
  });

  it('collects only secret-named env var values of 8+ characters', () => {
    expect(
      secretEnvValues({
        ANTHROPIC_API_KEY: 'env-secret-value-123',
        FB_PAGE_ID_COMMONPLACE: '1234567890',
        SHORT_TOKEN: 'abc',
        LANTERN_CONTACT: 'test@example.invalid',
        UNSET_SECRET: undefined,
      }),
    ).toEqual(['env-secret-value-123']);
  });

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
});
