import { normalizeText } from '../verify/normalize.js';
import { splitSentences } from '../enrich/draft.js';

/** A channel whose limits cannot produce a valid caption. Fail closed rather than publish a broken one. */
export class CaptionConfigError extends Error {
  override name = 'CaptionConfigError';
}

/**
 * Text a caption may contain that is not drawn from the post.
 *
 * The rule is that a caption is only ever selected or trimmed from prose the enrichment gates
 * already approved (spec section 15: adapters select and format, they do not write). These lines are
 * the sole exception, and they are an explicit allowlist rather than a general rule: each is a fixed
 * string that makes no factual claim about the subject, so there is nothing for a fact check to judge.
 */
export const BOILERPLATE: readonly string[] = ['Illustration: AI-generated'];

/** Whitespace folded the same way the quote matcher folds it, so the two never disagree about a match. */
const folded = (text: string): string => normalizeText(text);

/**
 * The sentences of a caption that are not found in the approved post text.
 *
 * Empty means the caption is a pure truncation and may ship without a fact check. Anything else
 * re-runs the checker (user decision 2026-09-16, fail closed per spec section 6): a caption that
 * stitches two approved clauses together can imply something neither of them said.
 */
export function unapprovedSentences(caption: string, approved: string): string[] {
  // A caption sentence must be a whole approved sentence. Trimming to a limit drops whole trailing
  // sentences, so it still costs nothing. A prefix is deliberately NOT accepted: a cut inside a
  // sentence can reverse it - "The story that he burned the manuscript is a myth." becomes an
  // assertion that he burned it - so a shortened title is judged rather than trusted. Comparing
  // against the joined approved text would be worse still: normalizeText strips end punctuation, so
  // a caption fusing the end of one approved sentence to the start of the next would match it.
  const approvedSentences = new Set([...BOILERPLATE, ...splitSentences(approved)].map(folded).filter((text) => text !== ''));
  return splitSentences(caption).filter((sentence) => {
    const needle = folded(sentence);
    return needle !== '' && !approvedSentences.has(needle);
  });
}

/**
 * The longest run of whole sentences from the start of the text that fits.
 *
 * Whole sentences, and never an added ellipsis: both keep the result a literal substring of the
 * approved text, so trimming a caption to a channel's limit cannot by itself cost a model call. A
 * caption cut mid-sentence would also read as a mistake rather than as an ending.
 */
export function fitSentences(text: string, max: number): string {
  // Paragraphs are kept apart. A Facebook caption is a paragraph of writing under a picture (spec
  // section 11), and reflowing a three-paragraph write-up into one block to save two characters
  // makes it read as a wall rather than as prose.
  let kept = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    for (const [index, sentence] of splitSentences(paragraph).entries()) {
      // A blank line before a paragraph's first sentence, a space between sentences within one.
      // Compared by index, not by text: a paragraph may repeat a sentence, and comparing the words
      // would then put a paragraph break in the middle of it.
      const joiner = kept === '' ? '' : index === 0 ? '\n\n' : ' ';
      const candidate = `${kept}${joiner}${sentence}`;
      if ([...candidate].length > max) return kept === '' ? truncateAtWord(text, max) : kept;
      kept = candidate;
    }
  }
  // Even the first sentence is too long for this channel, so fall back to a word boundary. Still a
  // prefix of the approved text, so still verbatim.
  return kept === '' ? truncateAtWord(text, max) : kept;
}

/** The text cut at the last word boundary that fits, with nothing appended. */
export function truncateAtWord(text: string, max: number): string {
  const characters = [...text];
  if (characters.length <= max) return text;
  const clipped = characters.slice(0, max).join('');
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd();
}

/** Paragraphs joined the way a caption reads them: a blank line between each. */
export function joinParagraphs(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n\n');
}
