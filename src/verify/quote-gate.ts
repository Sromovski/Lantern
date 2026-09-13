import { normalizeText } from './normalize.js';
import { assertSourceAllowed, SourcePolicyError, type SourceInput, type SourceTier } from './source-policy.js';

export const MIN_QUOTE_WORDS = 5;

export type QuoteEvidence =
  | { kind: 'primary-text'; citation: string; url?: string; excerpt: string; authorMatches: boolean }
  | { kind: 'scholarly'; citation: string; url?: string; excerpt?: string }
  | { kind: 'reference'; citation: string; url?: string; excerpt?: string }
  | { kind: 'listed-misattributed'; citation: string; url?: string }
  | { kind: 'attribution-conflict'; citation: string; url?: string; otherAuthor: string };

export type QuoteRejectReason =
  | 'too-short'
  | 'misattributed'
  | 'attribution-conflict'
  | 'author-mismatch'
  | 'insufficient-evidence';

export type QuoteDecision =
  | { status: 'verified'; sources: SourceInput[] }
  | { status: 'rejected'; reason: QuoteRejectReason; detail: string };

const reject = (reason: QuoteRejectReason, detail: string): QuoteDecision => ({ status: 'rejected', reason, detail });

const toSource = (tier: SourceTier, e: { citation: string; url?: string; excerpt?: string }): SourceInput => ({
  tier,
  citation: e.citation,
  url: e.url ?? null,
  excerpt: e.excerpt ?? null,
});

/**
 * Positive evidence (primary-text, scholarly, reference) counts only if the source it would
 * become passes the insert-time policy at its intended tier: a banned, archive-wrapped,
 * reference-domain-at-tier-1/2, unparseable-url or blank-citation source counts for nothing.
 * This makes decideQuote total: every verified decision it returns is insertable.
 * Negative evidence (listed-misattributed, attribution-conflict) always counts, whatever its
 * url, because a hard-reject signal must not be dodgeable by a relative or protocol-relative
 * href -- exactly the shape MediaWiki output produces.
 */
const usableAs =
  (tier: SourceTier) =>
  (e: { citation: string; url?: string; excerpt?: string }): boolean => {
    try {
      assertSourceAllowed(toSource(tier, e));
      return true;
    } catch (err) {
      if (err instanceof SourcePolicyError) return false;
      throw err;
    }
  };

const excerptMatches = (quote: string, e: Extract<QuoteEvidence, { kind: 'primary-text' }>) =>
  normalizeText(e.excerpt) === normalizeText(quote);

export function decideQuote(quote: string, evidence: QuoteEvidence[]): QuoteDecision {
  const words = normalizeText(quote).split(' ').filter(Boolean).length;
  if (words < MIN_QUOTE_WORDS) return reject('too-short', `${words} words; minimum is ${MIN_QUOTE_WORDS}`);

  const of = <K extends QuoteEvidence['kind']>(kind: K) =>
    evidence.filter((e): e is Extract<QuoteEvidence, { kind: K }> => e.kind === kind);

  const listed = of('listed-misattributed');
  if (listed.length > 0) return reject('misattributed', listed.map((e) => e.citation).join('; '));

  const conflicts = of('attribution-conflict');
  if (conflicts.length > 0) {
    return reject('attribution-conflict', conflicts.map((e) => `also attributed to ${e.otherAuthor} (${e.citation})`).join('; '));
  }

  const primaries = of('primary-text').filter(usableAs(1)).filter((e) => excerptMatches(quote, e));
  const byAuthor = primaries.filter((e) => e.authorMatches);
  const scholarly = of('scholarly').filter(usableAs(2));
  const references = of('reference').filter(usableAs(3)).map((e) => toSource(3, e));

  if (byAuthor.length > 0) {
    return {
      status: 'verified',
      sources: [...byAuthor.map((e) => toSource(1, e)), ...scholarly.map((e) => toSource(2, e)), ...references],
    };
  }
  if (primaries.length > 0) {
    return reject('author-mismatch', `found only in works not by the attributed author: ${primaries.map((e) => e.citation).join('; ')}`);
  }
  if (scholarly.length > 0) {
    return { status: 'verified', sources: [...scholarly.map((e) => toSource(2, e)), ...references] };
  }
  return reject('insufficient-evidence', references.length > 0 ? 'reference sources only' : 'no usable evidence');
}
