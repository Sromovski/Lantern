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

/**
 * Every http(s) host a URL refers to: its own host plus the host of any URL embedded in it,
 * such as an archive (web.archive.org/web/2019/https://...) or proxy (?u=https%3A%2F%2F...) target.
 * The text is percent-decoded up to twice, then scanned from every position where "http://" or
 * "https://" starts, so an embedded URL is never swallowed by the outer one.
 */
export function hostsIn(url: string): string[] {
  const hosts = new Set<string>();
  const outer = hostOf(url);
  if (outer !== null) hosts.add(outer);
  let text = url;
  for (let i = 0; i < 2; i++) text = safeDecode(text);
  const lower = text.toLowerCase();
  for (let from = 0; ; ) {
    const http = lower.indexOf('http://', from);
    const https = lower.indexOf('https://', from);
    const at = http === -1 ? https : https === -1 ? http : Math.min(http, https);
    if (at === -1) break;
    const host = hostOf(text.slice(at).split(' ')[0] ?? '');
    if (host !== null) hosts.add(host);
    from = at + 1;
  }
  return [...hosts];
}

export function isBannedSource(url: string): boolean {
  return hostsIn(url).some((host) => BANNED_SOURCE_DOMAINS.some((d) => onDomain(host, d)));
}

export function assertSourceAllowed(src: SourceInput): void {
  if (src.citation.trim().length === 0) throw new SourcePolicyError('source citation must not be empty');
  if (![1, 2, 3].includes(src.tier)) throw new SourcePolicyError(`invalid source tier ${src.tier}`);
  if (src.url == null) return;

  const host = hostOf(src.url);
  if (host === null) throw new SourcePolicyError(`source url is not a valid http(s) url: ${src.url}`);
  const hosts = hostsIn(src.url);
  const banned = hosts.find((h) => BANNED_SOURCE_DOMAINS.some((d) => onDomain(h, d)));
  if (banned !== undefined) throw new SourcePolicyError(`banned source domain: ${banned}`);
  if (src.tier < 3) {
    const reference = hosts.find((h) => REFERENCE_DOMAINS.some((d) => onDomain(h, d)));
    if (reference !== undefined) {
      throw new SourcePolicyError(`${reference} is a reference source and cannot be tier ${src.tier}`);
    }
  }
}
