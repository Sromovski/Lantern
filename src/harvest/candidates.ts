export interface CandidateOptions {
  minWords?: number;
  maxWords?: number;
}

/** A sentence: text up to and including its terminal punctuation and any closing quote mark. */
const SENTENCE = /[^.!?]+(?:[.!?]+["'\u201D\u2019]?)/g;
/** Double quote marks signal dialogue, which needs its speaker and context to stand alone. */
const DIALOGUE = /["\u201C\u201D]/;

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Candidate passages for the picker. Each is a sentence cut from the source with its whitespace
 * tidied and nothing else changed, so a chosen candidate is already the verbatim quote body
 * (user decision 2026-09-13; spec section 8). Paragraphs are split on blank lines, so hard-wrapped
 * lines join into one sentence.
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
    if (DIALOGUE.test(text)) continue;
    for (const match of text.matchAll(SENTENCE)) {
      const sentence = match[0].trim();
      const words = sentence.split(' ').length;
      if (words < minWords || words > maxWords) continue;
      if (sentence === sentence.toUpperCase()) continue;
      if (seen.has(sentence)) continue;
      seen.add(sentence);
      out.push(sentence);
    }
  }
  return out;
}
