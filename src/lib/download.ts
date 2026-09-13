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
