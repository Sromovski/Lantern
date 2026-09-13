import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildUserAgent,
  fetchWithRetry,
  HttpError,
  retryAfterMs,
  retryDelayMs,
  UnsupportedBodyError,
} from '../../src/lib/http.js';

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

/** First `truncateFirst` requests get headers + a partial body, then the socket is destroyed. */
async function truncatingServer(truncateFirst: number) {
  let count = 0;
  const server = createServer((_req, res) => {
    count++;
    if (count <= truncateFirst) {
      res.writeHead(200, { 'content-length': '100' });
      res.write('partial');
      setImmediate(() => res.socket?.destroy());
    } else {
      res.writeHead(200);
      res.end('ok');
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, count: () => count };
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

  it('returns the response instead of retrying early when Retry-After exceeds maxDelayMs', async () => {
    const srv = await scriptedServer([{ status: 429, headers: { 'retry-after': '3600' } }, { status: 200 }]);
    const { sleep, calls } = recordingSleep();
    const res = await fetchWithRetry({ url: srv.base }, { userAgent: UA, sleep });
    expect(res.status).toBe(429);
    expect(srv.seen).toHaveLength(1);
    expect(calls).toEqual([]);
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

  it('lets the contact User-Agent win over a caller header of any case and keeps other headers', async () => {
    let captured: IncomingHttpHeaders = {};
    const server = createServer((req, res) => {
      captured = req.headers;
      res.writeHead(200);
      res.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { sleep } = recordingSleep();
    await fetchWithRetry(
      { url: base, headers: { 'User-Agent': 'CallerUA/1.0', Accept: 'application/json' } },
      { userAgent: UA, sleep },
    );
    expect(captured['user-agent']).toBe(UA);
    expect(captured.accept).toBe('application/json');
  });

  it('retries a response whose body is cut off mid-stream', async () => {
    const srv = await truncatingServer(1);
    const { sleep, calls } = recordingSleep();
    const res = await fetchWithRetry({ url: srv.base }, { userAgent: UA, sleep });
    expect(res).toMatchObject({ status: 200, body: 'ok' });
    expect(srv.count()).toBe(2);
    expect(calls).toEqual([500]);
  });

  it('throws HttpError when every response body is cut off', async () => {
    const srv = await truncatingServer(99);
    const { sleep, calls } = recordingSleep();
    const err = await fetchWithRetry({ url: srv.base }, { userAgent: UA, sleep, maxAttempts: 2 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ attempts: 2 });
    expect((err as HttpError).cause).toBeInstanceOf(Error);
    expect(calls).toEqual([500]);
  });

  it.each([0, -1, 1.5])('rejects maxAttempts %s without making a request', async (maxAttempts) => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error('unreachable');
    }) as unknown as typeof fetch;
    await expect(
      fetchWithRetry({ url: 'http://127.0.0.1:1/' }, { userAgent: UA, fetchImpl, maxAttempts }),
    ).rejects.toThrow(RangeError);
    expect(called).toBe(false);
  });

  it.each(['', '   '])('rejects a blank userAgent (%j) without making a request', async (userAgent) => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error('unreachable');
    }) as unknown as typeof fetch;
    await expect(fetchWithRetry({ url: 'http://127.0.0.1:1/' }, { userAgent, fetchImpl })).rejects.toThrow(TypeError);
    expect(called).toBe(false);
  });

  it.each(['text/plain; charset=iso-8859-1', 'image/png'])(
    'fails closed without retrying on an undecodable body (%s)',
    async (contentType) => {
      const srv = await scriptedServer([{ status: 200, headers: { 'content-type': contentType }, body: 'x' }]);
      const { sleep, calls } = recordingSleep();
      await expect(fetchWithRetry({ url: srv.base }, { userAgent: UA, sleep })).rejects.toThrow(UnsupportedBodyError);
      expect(srv.seen).toHaveLength(1);
      expect(calls).toEqual([]);
    },
  );

  it.each(['application/json', 'application/ld+json', 'text/html; charset=UTF-8'])(
    'accepts the text body type %s',
    async (contentType) => {
      const srv = await scriptedServer([{ status: 200, headers: { 'content-type': contentType }, body: 'ok' }]);
      const { sleep } = recordingSleep();
      expect(await fetchWithRetry({ url: srv.base }, { userAgent: UA, sleep })).toMatchObject({ status: 200, body: 'ok' });
    },
  );
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

  it.each(['1.5', '-1'])('treats the malformed Retry-After %j as absent', (value) => {
    expect(retryDelayMs(2, value, { ...opts, nowMs: Date.parse('2026-01-01T00:00:00Z') })).toBe(1000);
  });

  it('trims whitespace around a numeric Retry-After', () => {
    expect(retryDelayMs(1, ' 2 ', opts)).toBe(2000);
  });
});

describe('retryAfterMs', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  it('reads delta-seconds uncapped', () => {
    expect(retryAfterMs('3600', now)).toBe(3_600_000);
  });

  it('reads an IMF-fixdate', () => {
    expect(retryAfterMs('Thu, 01 Jan 2026 00:00:03 GMT', now)).toBe(3000);
  });

  it.each(['May 1', 'Mon 2', 'a 1', '1.5', '-1', 'soon', '2026-01-01T00:00:03Z'])(
    'treats %j as absent',
    (value) => {
      expect(retryAfterMs(value, now)).toBeNull();
    },
  );
});

describe('buildUserAgent', () => {
  it('embeds the trimmed contact and version', () => {
    expect(buildUserAgent(' test@example.invalid ', '0.1.0')).toBe('Lantern/0.1.0 (test@example.invalid)');
  });

  it.each([undefined, '', '   '])('refuses a missing contact (%j)', (contact) => {
    expect(() => buildUserAgent(contact, '0.1.0')).toThrow(/LANTERN_CONTACT/);
  });
});
