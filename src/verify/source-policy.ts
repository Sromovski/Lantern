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
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function isBannedSource(url: string): boolean {
  const host = hostOf(url);
  return host !== null && BANNED_SOURCE_DOMAINS.some((d) => onDomain(host, d));
}

export function assertSourceAllowed(src: SourceInput): void {
  if (src.citation.trim().length === 0) throw new SourcePolicyError('source citation must not be empty');
  if (![1, 2, 3].includes(src.tier)) throw new SourcePolicyError(`invalid source tier ${src.tier}`);
  if (src.url == null) return;

  const host = hostOf(src.url);
  if (host === null) throw new SourcePolicyError(`source url is not a valid http(s) url: ${src.url}`);
  if (isBannedSource(src.url)) throw new SourcePolicyError(`banned source domain: ${host}`);
  if (src.tier < 3 && REFERENCE_DOMAINS.some((d) => onDomain(host, d))) {
    throw new SourcePolicyError(`${host} is a reference source and cannot be tier ${src.tier}`);
  }
}
