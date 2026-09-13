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

  it('stores only allowlisted response headers', async () => {
    const { fetcher } = countingFetcher({
      headers: {
        'content-type': 'application/json',
        etag: '"v1"',
        'x-api-key': 'leak-header-value',
        'www-authenticate': 'Bearer leak-realm',
      },
    });
    await cachedFetch({ url: 'https://example.test/h' }, { cacheDir: dir, source: 'example', now: NOW }, fetcher);
    const [file] = readdirSync(join(dir, 'example'));
    const stored = JSON.parse(readFileSync(join(dir, 'example', file!), 'utf8'));
    expect(Object.keys(stored.headers).sort()).toEqual(['content-type', 'etag']);
    expect(JSON.stringify(stored)).not.toMatch(/leak-/);
  });

  it('refuses to cache a response body that echoes a redacted credential, but still returns it', async () => {
    const req = { url: 'https://api.example.test/items?api_key=leak-echo-12345&q=dickens' };
    const { calls, fetcher } = countingFetcher({ body: '{"request":"/items?api_key=leak-echo-12345"}' });
    const first = await cachedFetch(req, { cacheDir: dir, source: 'example' }, fetcher);
    expect(first).toMatchObject({ status: 200, fromCache: false });
    expect(existsSync(join(dir, 'example'))).toBe(false);
    await cachedFetch(req, { cacheDir: dir, source: 'example' }, fetcher);
    expect(calls).toHaveLength(2);
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
});
