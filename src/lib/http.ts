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

export interface RetryEvent {
  url: string;
  /** The attempt that just failed, 1-based. */
  attempt: number;
  delayMs: number;
  /** `HTTP <status>` for a retryable status, otherwise the error message. */
  reason: string;
}

export interface HttpOptions {
  userAgent: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Per-attempt timeout covering the request and the body read. Defaults to 60 000 ms. */
  timeoutMs?: number;
  /**
   * A POST is sent once: after a network error, timeout or 5xx it is not retried, because the server
   * may already have acted on it (spec section 11: never double-post). A 429 is still retried, since a
   * rate-limited request was not processed. Set true only when the server de-duplicates retries, for
   * example with an idempotency key.
   */
  retryUnsafe?: boolean;
  /** Called before each wait between attempts, so an unattended run can log why it is waiting (spec section 4). */
  onRetry?: (event: RetryEvent) => void;
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

export interface ResolvedHttpOptions {
  maxAttempts: number;
  timeoutMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  fetchImpl: typeof fetch;
  now: () => number;
  onRetry: (event: RetryEvent) => void;
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
    onRetry: opts.onRetry ?? (() => {}),
  };
}

/** A short, loggable description of a thrown value. */
export function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
        // A 429 or 5xx is judged by its status, not its error page: Gutendex answers a 503 with an
        // iso-8859-1 page, and refusing that body stopped a passing outage from being retried.
        if (!isRetryableStatus(res.status)) throw new UnsupportedBodyError(req.url, reason);
        body = '';
      } else {
        body = await res.text();
      }
    } catch (err) {
      if (err instanceof UnsupportedBodyError) throw err;
      if (!retryAll) {
        throw new HttpError(`${method} failed and was not retried because it may have been processed: ${req.url}`, req.url, attempt, {
          cause: err,
        });
      }
      lastError = err;
      if (attempt < o.maxAttempts) {
        const delayMs = retryDelayMs(attempt, null, { ...delays, nowMs: o.now() });
        o.onRetry({ url: req.url, attempt, delayMs, reason: errorReason(err) });
        await o.sleep(delayMs);
      }
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
    const delayMs = retryDelayMs(attempt, res.headers.get('retry-after'), { ...delays, nowMs: o.now() });
    o.onRetry({ url: req.url, attempt, delayMs, reason: `HTTP ${res.status}` });
    await o.sleep(delayMs);
  }

  throw new HttpError(`network failure after ${o.maxAttempts} attempts: ${req.url}`, req.url, o.maxAttempts, {
    cause: lastError,
  });
}
