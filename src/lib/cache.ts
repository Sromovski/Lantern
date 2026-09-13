import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpRequest, HttpResult } from './http.js';

export interface CacheOptions {
  cacheDir: string;
  source: string;
  refresh?: boolean;
  now?: () => Date;
  /** Per-source veto, checked after the status allowlist. Return false to return the result without caching it. */
  cacheable?: (result: HttpResult) => boolean;
  /** cachedFetch caches GET only; set true to allow caching another method. */
  allowNonGet?: boolean;
  /** Secret values to keep out of fixtures. Defaults to secretEnvValues(process.env). */
  secretValues?: readonly string[];
}

export interface CachedResult extends HttpResult {
  fromCache: boolean;
  fetchedAt: string;
}

interface StoredEntry {
  request: { method: string; url: string; bodySha256?: string };
  url: string;
  finalUrl?: string;
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

export class CacheCorruptError extends Error {
  override name = 'CacheCorruptError';

  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${message}: ${path}`);
  }
}

const SECRET_ENV_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/i;

/** Values of env vars whose names look like credentials (e.g. ANTHROPIC_API_KEY, *_TOKEN), 8+ chars. */
export function secretEnvValues(env: Record<string, string | undefined>): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= MIN_ECHO_LENGTH && SECRET_ENV_NAME.test(name)) values.push(trimmed);
  }
  return values;
}

/** The raw value plus the encodings in which APIs commonly echo it back. */
function encodedForms(secret: string): string[] {
  const percent = encodeURIComponent(secret);
  return [...new Set([secret, percent, percent.replace(/%20/g, '+'), JSON.stringify(secret).slice(1, -1), secret.replaceAll('/', '\\/')])];
}

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

const isCacheableStatus = (status: number) => (status >= 200 && status < 300) || status === 404 || status === 410;

function readEntry(path: string): StoredEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new CacheCorruptError(path, `unreadable cache entry (${(err as Error).message})`);
  }
  const e = parsed as Partial<StoredEntry> | null;
  if (
    e === null ||
    typeof e !== 'object' ||
    typeof e.status !== 'number' ||
    typeof e.body !== 'string' ||
    typeof e.fetchedAt !== 'string' ||
    (e.finalUrl !== undefined && typeof e.finalUrl !== 'string') ||
    typeof e.headers !== 'object' ||
    e.headers === null
  ) {
    throw new CacheCorruptError(path, 'cache entry is missing status, headers, body or fetchedAt');
  }
  return e as StoredEntry;
}

export async function cachedFetch(
  req: HttpRequest,
  cache: CacheOptions,
  fetcher: (req: HttpRequest) => Promise<HttpResult>,
): Promise<CachedResult> {
  if (!SOURCE_NAME.test(cache.source)) {
    throw new Error(`invalid cache source name: ${JSON.stringify(cache.source)}`);
  }
  if ((req.method ?? 'GET') !== 'GET' && !cache.allowNonGet) {
    throw new Error('cachedFetch caches GET requests only; pass allowNonGet: true to cache another method');
  }
  const dir = join(cache.cacheDir, cache.source);
  const path = join(dir, `${cacheKey(req)}.json`);

  if (!cache.refresh && existsSync(path)) {
    const stored = readEntry(path);
    return {
      url: req.url,
      ...(stored.finalUrl !== undefined ? { finalUrl: stored.finalUrl } : {}),
      status: stored.status,
      headers: stored.headers,
      body: stored.body,
      fetchedAt: stored.fetchedAt,
      fromCache: true,
    };
  }

  const result = await fetcher(req);
  const fetchedAt = (cache.now ?? (() => new Date()))().toISOString();

  if (isCacheableStatus(result.status) && (cache.cacheable?.(result) ?? true)) {
    const entry: StoredEntry = {
      request: {
        method: req.method ?? 'GET',
        url: redactUrl(req.url),
        ...(req.body !== undefined ? { bodySha256: sha256(req.body) } : {}),
      },
      url: redactUrl(result.url),
      ...(result.finalUrl !== undefined ? { finalUrl: redactUrl(result.finalUrl) } : {}),
      status: result.status,
      headers: Object.fromEntries(
        Object.entries(result.headers).filter(([name]) => STORED_HEADERS.has(name.toLowerCase())),
      ),
      body: result.body,
      fetchedAt,
    };
    const serialized = `${JSON.stringify(entry, null, 2)}\n`;
    // Scan the raw stored fields as well as the serialized text: JSON serialization double-escapes
    // backslashes and quotes, so an echo such as `leak\/value` in a body is not a substring of `serialized`.
    const haystack = [serialized, entry.request.url, entry.url, entry.finalUrl ?? '', ...Object.values(entry.headers), entry.body].join('\n');
    const secrets = [
      ...redactWithSecrets(req.url).secrets,
      ...(result.finalUrl !== undefined ? redactWithSecrets(result.finalUrl).secrets : []),
      ...(cache.secretValues ?? secretEnvValues(process.env)),
    ];
    const leaks = secrets.some((secret) => encodedForms(secret).some((form) => haystack.includes(form)));
    if (!leaks) {
      mkdirSync(dir, { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, serialized);
      renameSync(tmp, path);
    }
  }

  return { ...result, fetchedAt, fromCache: false };
}
