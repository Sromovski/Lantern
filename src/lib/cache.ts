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

/** Exact credential parameter names, compared after lowercasing and removing '-' and '_'.
 *  Ambiguous short names (code, sid, session) are deliberately excluded: redacting a
 *  non-secret parameter would make different requests share one cache key. */
const CREDENTIAL_PARAMS = new Set([
  'key', 'apikey', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'auth',
  'secret', 'clientsecret', 'password', 'passwd', 'pwd', 'signature', 'sig', 'jwt', 'bearer',
  'xamzsecuritytoken', 'xamzsignature', 'xamzcredential', 'xgoogsignature', 'xgoogcredential',
]);
/** Response headers worth keeping in a committed fixture; everything else is dropped. */
const STORED_HEADERS = new Set(['content-type', 'content-language', 'etag', 'last-modified', 'link', 'date']);
/** Shorter redacted values are too likely to appear in a body by coincidence. */
const MIN_ECHO_LENGTH = 8;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const normalizeParamName = (name: string) => name.toLowerCase().replace(/[-_]/g, '');
const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

function redactWithSecrets(url: string): { url: string; secrets: string[] } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, secrets: [] };
  }
  const secrets: string[] = [];
  let changed = false;
  if (parsed.username || parsed.password) {
    secrets.push(safeDecode(parsed.username), safeDecode(parsed.password));
    parsed.username = 'REDACTED';
    parsed.password = '';
    changed = true;
  }
  if (parsed.hash) {
    for (const value of new URLSearchParams(parsed.hash.slice(1)).values()) secrets.push(value);
    parsed.hash = '';
    changed = true;
  }
  for (const name of new Set(parsed.searchParams.keys())) {
    if (CREDENTIAL_PARAMS.has(normalizeParamName(name))) {
      secrets.push(...parsed.searchParams.getAll(name));
      parsed.searchParams.set(name, 'REDACTED');
      changed = true;
    }
  }
  return { url: changed ? parsed.toString() : url, secrets: secrets.filter((s) => s.length >= MIN_ECHO_LENGTH) };
}

export function redactUrl(url: string): string {
  return redactWithSecrets(url).url;
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

  const echoesCredential = redactWithSecrets(req.url).secrets.some((secret) => result.body.includes(secret));
  if (isCacheable(result.status) && !echoesCredential) {
    const entry: StoredEntry = {
      request: {
        method: req.method ?? 'GET',
        url: redactUrl(req.url),
        ...(req.body !== undefined ? { bodySha256: sha256(req.body) } : {}),
      },
      url: redactUrl(result.url),
      status: result.status,
      headers: Object.fromEntries(
        Object.entries(result.headers).filter(([name]) => STORED_HEADERS.has(name.toLowerCase())),
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
