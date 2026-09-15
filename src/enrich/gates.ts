import { normalizeText } from '../verify/normalize.js';
import { unsupportedNumbers } from '../verify/numbers.js';
import type { SourceParagraph } from './context.js';
import { draftParts, splitSentences, type Check, type Draft, type DraftSentence } from './draft.js';

export interface Range {
  min: number;
  max: number;
}

/** The counts a vertical's post_shape allows: sentences in the hook and closer, paragraphs in the body. */
export interface PostShape {
  hook: Range;
  body: Range;
  closer: Range;
}

const LEADING_RANGE = /^\s*(\d+)(?:\s*[-\u2013]\s*(\d+))?(?!\d)/;

/** The count a post_shape entry starts with: "1 sentence" is 1 to 1, "2-4 short paragraphs" is 2 to 4. */
export function parseShapeRange(text: string): Range {
  const match = LEADING_RANGE.exec(text);
  if (match === null) throw new Error(`post_shape entry "${text}" does not start with a count such as "1" or "2-4"`);
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  if (min < 1 || max < min) throw new Error(`post_shape entry "${text}" is not a usable range`);
  return { min, max };
}

export function parsePostShape(shape: { hook: string; body: string; closer: string }): PostShape {
  return { hook: parseShapeRange(shape.hook), body: parseShapeRange(shape.body), closer: parseShapeRange(shape.closer) };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const allowed = (range: Range) => (range.min === range.max ? `${range.min}` : `${range.min} to ${range.max}`);
const outside = (n: number, range: Range) => n < range.min || n > range.max;

/**
 * Problems a program can see without a model: a part with the wrong number of sentences or paragraphs,
 * an empty part, a label that is not one of the source paragraphs, and the whole quotation repeated
 * (the post shows it separately).
 */
export function shapeProblems(draft: Draft, shape: PostShape, labels: ReadonlySet<string>, quotation: string): string[] {
  const problems: string[] = [];
  const hook = splitSentences(draft.hook.text).length;
  if (outside(hook, shape.hook)) problems.push(`the hook has ${plural(hook, 'sentence', 'sentences')}; the post shape allows ${allowed(shape.hook)}`);
  if (outside(draft.body.length, shape.body)) {
    problems.push(`the body has ${plural(draft.body.length, 'paragraph', 'paragraphs')}; the post shape allows ${allowed(shape.body)}`);
  }
  const closer = splitSentences(draft.closer.text).length;
  if (outside(closer, shape.closer)) {
    problems.push(`the closer has ${plural(closer, 'sentence', 'sentences')}; the post shape allows ${allowed(shape.closer)}`);
  }
  for (const { name, part } of draftParts(draft)) {
    if (part.text.trim() === '') problems.push(`the ${name} is empty`);
    for (const label of new Set(part.sources)) {
      if (!labels.has(label)) problems.push(`the ${name} cites ${label}, which is not one of the source paragraphs`);
    }
  }
  const quote = normalizeText(quotation);
  const text = normalizeText(draftParts(draft).map(({ part }) => part.text).join(' '));
  if (quote.length > 0 && text.includes(quote)) problems.push('the draft repeats the whole quotation, which the post already shows');
  return problems;
}

/** The source paragraphs the draft cites, in source order. */
export function citedParagraphs(draft: Draft, paragraphs: readonly SourceParagraph[]): SourceParagraph[] {
  const cited = new Set(draftParts(draft).flatMap(({ part }) => part.sources));
  return paragraphs.filter((paragraph) => cited.has(paragraph.id));
}

/** Numbers in the draft that are neither in the quotation nor in a cited paragraph (spec section 8, applied to every vertical). */
export function numberProblems(draft: Draft, quotation: string, cited: readonly SourceParagraph[]): string[] {
  const text = draftParts(draft)
    .map(({ part }) => part.text)
    .join('\n');
  return unsupportedNumbers(text, [quotation, ...cited.map((paragraph) => paragraph.text)]).map(
    (n) => `the number ${n} is not in the quotation or in any cited source paragraph`,
  );
}

/** Sentences the checker found unsupported, and any sentence it did not judge exactly once (fail closed). */
export function checkProblems(check: Check, sentences: readonly DraftSentence[]): string[] {
  const problems: string[] = [];
  for (const sentence of sentences) {
    const verdicts = check.sentences.filter((verdict) => verdict.id === sentence.n);
    const verdict = verdicts[0];
    if (verdict === undefined || verdicts.length > 1) {
      problems.push(`the fact check gave ${verdicts.length} verdicts for "${sentence.text}"`);
    } else if (!verdict.supported) {
      problems.push(`"${sentence.text}" is not supported by the source paragraphs: ${verdict.problem.trim() || 'the fact check gave no detail'}`);
    }
  }
  const numbers = new Set(sentences.map((sentence) => sentence.n));
  for (const id of new Set(check.sentences.map((verdict) => verdict.id))) {
    if (!numbers.has(id)) problems.push(`the fact check judged a sentence ${id}, which the draft does not have`);
  }
  return problems;
}
