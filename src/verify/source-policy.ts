export const BANNED_SOURCE_DOMAINS = [
  'brainyquote.com',
  'goodreads.com',
  'azquotes.com',
  'quotefancy.com',
  'quotes.net',
  'quotemaster.org',
  'quotationspage.com',
  'wisdomquotes.com',
  'everydaypower.com',
  'quotegarden.com',
  'quotepark.info',
  'inspiringquotes.us',
] as const;

/** Useful leads, never verification on their own (spec §8). Capped at tier 3. */
export const REFERENCE_DOMAINS = ['wikiquote.org', 'wikipedia.org'] as const;

export type SourceTier = 1 | 2 | 3;

export interface SourceInput {
  tier: SourceTier;
  url?: string | null;
  citation: string;
  excerpt?: string | null;
}

export class SourcePolicyError extends Error {
  override name = 'SourcePolicyError';
}

const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return null;
  }
}

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Source URLs longer than this are refused; nothing legitimate in scope approaches it. */
export const MAX_SOURCE_URL_LENGTH = 16_384;
const MAX_EMBEDDED_CANDIDATES = 256;
const AUTHORITY_WINDOW = 1024;
const EMBEDDED_SCHEME = /^https?:[\\/]+/i;
const AUTHORITY_END = /[\s"'<>]/;
const URL_IGNORED = /[\t\n\r]/g;

export interface HostScan {
  hosts: string[];
  truncated: boolean;
}

/** The URL percent-decoded up to three times, with the tab/LF/CR characters URL parsers ignore removed. */
function decodedText(url: string): string {
  let text = url.slice(0, MAX_SOURCE_URL_LENGTH);
  for (let i = 0; i < 3; i++) text = safeDecode(text);
  return text.replace(URL_IGNORED, '');
}

/**
 * Every http(s) host a URL refers to: its own host plus the host of any URL embedded in it
 * (archive or proxy targets). The text is percent-decoded up to three times, with tab/LF/CR
 * removed, then scanned for embedded schemes written with any run of slashes or backslashes
 * (https://, https:/, https:\\, https:\\/\\/) and for protocol-relative "//host" not already part
 * of a scheme. Each candidate is parsed from at most AUTHORITY_WINDOW characters. A URL longer than
 * MAX_SOURCE_URL_LENGTH, or one with more than MAX_EMBEDDED_CANDIDATES embedded candidates, is
 * marked truncated: callers treat that as a refusal (fail closed), which also keeps the scan's cost
 * linear. Scheme-less embedded targets are not hosts to this scan; `mentionedDomain` covers them
 * for the banned and reference lists.
 */
export function scanHosts(url: string): HostScan {
  const hosts = new Set<string>();
  const outer = hostOf(url);
  if (outer !== null) hosts.add(outer);
  let truncated = url.length > MAX_SOURCE_URL_LENGTH;
  const text = decodedText(url);
  const lower = text.toLowerCase();
  let candidates = 0;
  const consider = (candidate: string) => {
    const host = hostOf(candidate);
    if (host !== null) hosts.add(host);
  };

  for (let from = 0; ; ) {
    const at = lower.indexOf('http', from);
    if (at === -1) break;
    from = at + 4;
    const scheme = EMBEDDED_SCHEME.exec(text.slice(at, at + 16));
    if (scheme === null) continue;
    if (candidates >= MAX_EMBEDDED_CANDIDATES) {
      truncated = true;
      break;
    }
    candidates++;
    const name = scheme[0].slice(0, scheme[0].indexOf(':') + 1);
    const start = at + scheme[0].length;
    consider(`${name}//${text.slice(start, start + AUTHORITY_WINDOW).split(AUTHORITY_END)[0] ?? ''}`);
  }

  for (let from = 0; ; ) {
    const at = text.indexOf('//', from);
    if (at === -1) break;
    from = at + 2;
    const prev = at > 0 ? text[at - 1] : '';
    if (prev === ':' || prev === '/' || prev === '\\') continue;
    if (candidates >= MAX_EMBEDDED_CANDIDATES) {
      truncated = true;
      break;
    }
    candidates++;
    consider(`https://${text.slice(at + 2, at + 2 + AUTHORITY_WINDOW).split(AUTHORITY_END)[0] ?? ''}`);
  }

  return { hosts: [...hosts], truncated };
}

export function hostsIn(url: string): string[] {
  return scanHosts(url).hosts;
}

/**
 * The first domain in `domains` that appears anywhere in the URL, raw or decoded (lowercased, with
 * tab/LF/CR removed). This mirrors the migration 002 trigger (`lower(url) LIKE '%domain%'`), so
 * every URL this module accepts is also insertable, and it catches scheme-less wrapped targets such
 * as `web.archive.org/web/2020/en.wikiquote.org/...` that the host scan cannot see. It can refuse
 * a URL that merely mentions a domain in a query or path; that refusal is deliberate (fail closed).
 */
function mentionedDomain(url: string, domains: readonly string[]): string | undefined {
  const texts = [url.replace(URL_IGNORED, '').toLowerCase(), decodedText(url).toLowerCase()];
  return domains.find((domain) => texts.some((text) => text.includes(domain)));
}

export function isBannedSource(url: string): boolean {
  const { hosts, truncated } = scanHosts(url);
  return (
    truncated ||
    hosts.some((host) => BANNED_SOURCE_DOMAINS.some((d) => onDomain(host, d))) ||
    mentionedDomain(url, BANNED_SOURCE_DOMAINS) !== undefined
  );
}

export function assertSourceAllowed(src: SourceInput): void {
  if (src.citation.trim().length === 0) throw new SourcePolicyError('source citation must not be empty');
  if (![1, 2, 3].includes(src.tier)) throw new SourcePolicyError(`invalid source tier ${src.tier}`);
  if (src.url == null) return;

  const host = hostOf(src.url);
  if (host === null) throw new SourcePolicyError(`source url is not a valid http(s) url: ${src.url}`);
  if (src.url.length > MAX_SOURCE_URL_LENGTH) {
    throw new SourcePolicyError(`source url is longer than ${MAX_SOURCE_URL_LENGTH} characters`);
  }
  const { hosts, truncated } = scanHosts(src.url);
  if (truncated) throw new SourcePolicyError('source url embeds too many urls to check');
  const banned = hosts.find((h) => BANNED_SOURCE_DOMAINS.some((d) => onDomain(h, d))) ?? mentionedDomain(src.url, BANNED_SOURCE_DOMAINS);
  if (banned !== undefined) throw new SourcePolicyError(`banned source domain: ${banned}`);
  if (src.tier < 3) {
    const reference = hosts.find((h) => REFERENCE_DOMAINS.some((d) => onDomain(h, d))) ?? mentionedDomain(src.url, REFERENCE_DOMAINS);
    if (reference !== undefined) {
      throw new SourcePolicyError(`${reference} is a reference source and cannot be tier ${src.tier}`);
    }
  }
}
