export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResult {
  url: string;
  /** The URL after redirects (response.url), or the request URL when the response does not report one. */
  finalUrl?: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpOptions {
  userAgent: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Per-attempt timeout covering the request and the body read. Defaults to 60 000 ms. */
  timeoutMs?: number;
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

export class UnsupportedBodyError extends Error {
  override name = 'UnsupportedBodyError';

  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`${reason} for ${url}: only UTF-8 or US-ASCII text bodies are supported; binary needs a streaming download`);
  }
}

const TEXT_CHARSETS = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii']);

/** Returns a reason string when the body must not be decoded as text, or null when it is safe. */
export function unsupportedBodyReason(contentType: string | null): string | null {
  if (!contentType) return null;
  const [mediaType = '', ...params] = contentType.split(';').map((part) => part.trim().toLowerCase());
  const [type = '', subtype = ''] = mediaType.split('/');
  const textual =
    type === 'text' ||
    subtype === 'json' ||
    subtype === 'xml' ||
    subtype === 'javascript' ||
    subtype === 'x-www-form-urlencoded' ||
    subtype.endsWith('+json') ||
    subtype.endsWith('+xml');
  if (!textual) return `non-text media type "${mediaType}"`;
  const charsetParam = params.find((p) => p.startsWith('charset='));
  const charset = charsetParam?.slice('charset='.length).replace(/^"|"$/g, '');
  if (charset && !TEXT_CHARSETS.has(charset)) return `unsupported charset "${charset}"`;
  return null;
}

const DEFAULTS = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 30_000, timeoutMs: 60_000 } as const;

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

const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function retryAfterMs(retryAfter: string | null, nowMs: number): number | null {
  if (retryAfter === null) return null;
  const trimmed = retryAfter.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  if (IMF_FIXDATE.test(trimmed)) {
    const at = Date.parse(trimmed);
    if (!Number.isNaN(at)) return Math.max(0, at - nowMs);
  }
  return null;
}

export function retryDelayMs(
  attempt: number,
  retryAfter: string | null,
  opts: { baseDelayMs: number; maxDelayMs: number; nowMs: number },
): number {
  const header = retryAfterMs(retryAfter, opts.nowMs);
  if (header !== null) return Math.min(header, opts.maxDelayMs);
  return Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fetchWithRetry(req: HttpRequest, opts: HttpOptions): Promise<HttpResult> {
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
  const headers = new Headers(req.headers);
  headers.set('user-agent', opts.userAgent);
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
    let body: string;
    try {
      res = await fetchImpl(req.url, {
        method: req.method ?? 'GET',
        headers,
        body: req.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const reason = unsupportedBodyReason(res.headers.get('content-type'));
      if (reason !== null) {
        await res.body?.cancel().catch(() => {});
        throw new UnsupportedBodyError(req.url, reason);
      }
      body = await res.text();
    } catch (err) {
      if (err instanceof UnsupportedBodyError) throw err;
      lastError = err;
      if (attempt < maxAttempts) await sleep(retryDelayMs(attempt, null, { ...delays, nowMs: now() }));
      continue;
    }
    const result: HttpResult = {
      url: req.url,
      finalUrl: res.url || req.url,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body,
    };
    if (!isRetryableStatus(res.status) || attempt === maxAttempts) return result;
    const header = retryAfterMs(res.headers.get('retry-after'), now());
    if (header !== null && header > delays.maxDelayMs) return result;
    await sleep(retryDelayMs(attempt, res.headers.get('retry-after'), { ...delays, nowMs: now() }));
  }

  throw new HttpError(`network failure after ${maxAttempts} attempts: ${req.url}`, req.url, maxAttempts, {
    cause: lastError,
  });
}
