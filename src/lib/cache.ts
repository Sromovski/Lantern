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
