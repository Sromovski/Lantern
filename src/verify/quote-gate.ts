import { normalizeText } from './normalize.js';
import { assertSourceAllowed, SourcePolicyError, type SourceInput, type SourceTier } from './source-policy.js';

export const MIN_QUOTE_WORDS = 5;

export type QuoteEvidence =
  | { kind: 'primary-text'; citation: string; url?: string; excerpt: string; location?: string; authorMatches: boolean }
  | { kind: 'scholarly'; citation: string; url?: string; excerpt?: string; authorMatches: boolean }
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

const toSource = (
  tier: SourceTier,
  e: { citation: string; url?: string; excerpt?: string; location?: string },
): SourceInput => ({
  tier,
  citation: e.location === undefined ? e.citation : `${e.citation}, ${e.location}`,
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

  // authorMatches must be a real boolean: evidence without one (for example untyped harvester output) is
  // unusable, so the item ends as a reopenable insufficient-evidence rejection rather than a final one.
  const hasAuthorVerdict = (e: { authorMatches: boolean }) => typeof e.authorMatches === 'boolean';
  const primaries = of('primary-text')
    .filter(usableAs(1))
    .filter(hasAuthorVerdict)
    .filter((e) => excerptMatches(quote, e));
  const byAuthor = primaries.filter((e) => e.authorMatches === true);
  const scholarly = of('scholarly').filter(usableAs(2)).filter(hasAuthorVerdict);
  const scholarlyByAuthor = scholarly.filter((e) => e.authorMatches === true);
  const scholarlyOtherAuthor = scholarly.filter((e) => e.authorMatches === false);
  const references = of('reference').filter(usableAs(3)).map((e) => toSource(3, e));

  const primaryOtherAuthor = primaries.filter((e) => e.authorMatches === false);
  const otherAuthor = [...primaryOtherAuthor, ...scholarlyOtherAuthor];
  // Spec section 8: sources that conflict on the attribution are a hard reject, even when another
  // source names the attributed author (for example a passage found both in the author's text and in
  // another author's text, where one of them is quoting).
  if ((byAuthor.length > 0 || scholarlyByAuthor.length > 0) && otherAuthor.length > 0) {
    return reject(
      'attribution-conflict',
      `a source attributes the quote to a different author: ${otherAuthor.map((e) => e.citation).join('; ')}`,
    );
  }
  if (byAuthor.length > 0) {
    return {
      status: 'verified',
      sources: [...byAuthor.map((e) => toSource(1, e)), ...scholarlyByAuthor.map((e) => toSource(2, e)), ...references],
    };
  }
  if (primaries.length > 0) {
    return reject('author-mismatch', `found only in works not by the attributed author: ${primaries.map((e) => e.citation).join('; ')}`);
  }
  if (scholarlyByAuthor.length > 0) {
    return { status: 'verified', sources: [...scholarlyByAuthor.map((e) => toSource(2, e)), ...references] };
  }
  if (scholarly.length > 0) {
    return reject('author-mismatch', `attested only for a different author: ${scholarly.map((e) => e.citation).join('; ')}`);
  }
  return reject('insufficient-evidence', references.length > 0 ? 'reference sources only' : 'no usable evidence');
}
