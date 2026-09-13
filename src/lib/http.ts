export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpOptions {
  userAgent: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
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

const DEFAULTS = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 30_000 } as const;

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

export function retryDelayMs(
  attempt: number,
  retryAfter: string | null,
  opts: { baseDelayMs: number; maxDelayMs: number; nowMs: number },
): number {
  if (retryAfter !== null) {
    const trimmed = retryAfter.trim();
    if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, opts.maxDelayMs);
    const at = Date.parse(trimmed);
    if (!Number.isNaN(at)) return Math.min(Math.max(0, at - opts.nowMs), opts.maxDelayMs);
  }
  return Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fetchWithRetry(req: HttpRequest, opts: HttpOptions): Promise<HttpResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
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
    try {
      res = await fetchImpl(req.url, {
        method: req.method ?? 'GET',
        headers: { ...req.headers, 'user-agent': opts.userAgent },
        body: req.body,
      });
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) await sleep(retryDelayMs(attempt, null, { ...delays, nowMs: now() }));
      continue;
    }
    const result: HttpResult = {
      url: req.url,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: await res.text(),
    };
    if (!isRetryableStatus(res.status) || attempt === maxAttempts) return result;
    await sleep(retryDelayMs(attempt, res.headers.get('retry-after'), { ...delays, nowMs: now() }));
  }

  throw new HttpError(`network failure after ${maxAttempts} attempts: ${req.url}`, req.url, maxAttempts, {
    cause: lastError,
  });
}
