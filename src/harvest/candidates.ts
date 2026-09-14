export interface CandidateOptions {
  minWords?: number;
  maxWords?: number;
}

/** A sentence: text up to and including its terminal punctuation and any closing quote mark. */
const SENTENCE = /[^.!?]+(?:[.!?]+["'\u201D\u2019]?)/g;
/** Double quote marks signal dialogue, which needs its speaker and context to stand alone. */
const DIALOGUE = /["\u201C\u201D]/;
/** An opening single quote signals dialogue in texts that quote with single marks. */
const SINGLE_QUOTE_DIALOGUE = /\u2018|(?:^|\s)'(?=[A-Za-z])/;
/** A line starting with whitespace marks an indented block: quoted verse, a letter or an epigraph, often not the author's words. */
const INDENTED_LINE = /^[ \t]+\S/m;
/** Transcriber credits and bracketed notes (illustrations, footnotes) are editorial, not the author's text. */
const EDITORIAL = /^(?:\[|produced by|transcriber['\u2019]?s? notes?|e-?text prepared by)/i;
/** Gutenberg transcription markup (_italics_, [notes], {braces}, *asterisks*) is not printed text. */
const MARKUP = /[_[\]{}*]/;
/** A dash followed by a space is usually a hard wrap that tidying turned into a space the page never had. */
const DASH_THEN_SPACE = /[-\u2013\u2014] /;
/** A title abbreviation or an initial ends a sentence match without ending the sentence. */
const ABBREVIATION_END = /(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|St|Messrs|Mme|Mlle|Col|Capt|Gen|Rev|Hon|Esq|Jr|Sr|Mt|No|Vol|Ch|[A-Z])\.$/;

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Candidate passages for the picker. Each is a sentence cut from the source with its whitespace
 * tidied and nothing else changed, so a chosen candidate is already the verbatim quote body
 * (user decision 2026-09-13; spec section 8). Paragraphs are split on blank lines, so hard-wrapped
 * lines join into one sentence. Anything that may not be the author's own printed words, or that
 * cannot stand alone, is skipped rather than cleaned: failing closed only costs candidates.
 */
export function extractCandidates(body: string, options: CandidateOptions = {}): string[] {
  const minWords = options.minWords ?? 8;
  const maxWords = options.maxWords ?? 40;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const paragraph of body.split(/\r?\n[ \t]*\r?\n/)) {
    const text = tidy(paragraph);
    if (text.length === 0) continue;
    // A sentence split off a dialogue line loses its speaker and context, so skip the whole paragraph.
    if (DIALOGUE.test(text) || SINGLE_QUOTE_DIALOGUE.test(text)) continue;
    if (INDENTED_LINE.test(paragraph) || EDITORIAL.test(text)) continue;
    let start = 0;
    for (const match of text.matchAll(SENTENCE)) {
      const end = (match.index ?? 0) + match[0].length;
      // "Mr." or an initial ends no sentence: keep reading, so the sentence is cut from its true start.
      if (ABBREVIATION_END.test(match[0].trimEnd())) continue;
      const sentence = text.slice(start, end).trim();
      start = end;
      const words = sentence.split(' ').length;
      if (words < minWords || words > maxWords) continue;
      if (!/^[A-Z]/.test(sentence)) continue;
      if (sentence === sentence.toUpperCase()) continue;
      if (MARKUP.test(sentence) || DASH_THEN_SPACE.test(sentence)) continue;
      if (seen.has(sentence)) continue;
      seen.add(sentence);
      out.push(sentence);
    }
  }
  return out;
}
