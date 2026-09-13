import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownloadStatusError, DownloadTooLargeError, downloadWithRetry } from '../../src/lib/download.js';
import { HttpError, type RetryEvent } from '../../src/lib/http.js';

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

  it('does not re-download when only the final rename fails', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    });
    const { sleep, calls } = recordingSleep();
    const dest = join(dir, 'occupied.jpg');
    mkdirSync(join(dest, 'inside'), { recursive: true });
    const err = await downloadWithRetry(`${srv.base}/x.jpg`, dest, { userAgent: UA, sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(HttpError);
    expect(srv.requests()).toBe(1);
    expect(calls).toEqual([]);
    expect(existsSync(join(dest, 'inside'))).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it('reports a retry through onRetry', async () => {
    const srv = await serve((_req, res, n) => {
      if (n === 1) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PAYLOAD);
    });
    const events: RetryEvent[] = [];
    const { sleep } = recordingSleep();
    await downloadWithRetry(`${srv.base}/x.png`, join(dir, 'x.png'), { userAgent: UA, sleep, onRetry: (e) => events.push(e) });
    expect(events).toEqual([{ url: `${srv.base}/x.png`, attempt: 1, delayMs: 500, reason: 'HTTP 503' }]);
  });

  it('reports where a redirected download ended when it fails', async () => {
    const srv = await serve((req, res) => {
      if (req.url === '/old.jpg') {
        res.writeHead(302, { location: '/gone.jpg' });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const err = await downloadWithRetry(`${srv.base}/old.jpg`, join(dir, 'gone.jpg'), { userAgent: UA }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadStatusError);
    expect(err).toMatchObject({ status: 404, finalUrl: `${srv.base}/gone.jpg` });
  });
});
