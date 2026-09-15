import type { VerticalConfig } from '../config/schema.js';
import { formatParagraph, type SourceParagraph } from './context.js';
import type { Draft, DraftSentence } from './draft.js';

export type VerticalVoice = Pick<VerticalConfig, 'voice' | 'post_shape' | 'banned_topics'>;

export interface QuoteContext {
  body: string;
  author: string;
  workTitle: string;
}

/**
 * A prompt file with the vertical's voice, post shape and banned topics filled in (spec section 9). An
 * unknown {{placeholder}} is refused, so a typo in a prompt never reaches the model.
 */
export function fillPrompt(template: string, vertical: VerticalVoice): string {
  const values: Record<string, string> = {
    voice: vertical.voice.trim(),
    hook: vertical.post_shape.hook,
    body: vertical.post_shape.body,
    closer: vertical.post_shape.closer,
    banned_topics: vertical.banned_topics.length === 0 ? '- none' : vertical.banned_topics.map((topic) => `- ${topic}`).join('\n'),
  };
  for (const [whole, name] of template.matchAll(/\{\{([a-z_]+)\}\}/g)) {
    if (!(name! in values)) throw new Error(`prompt has an unknown placeholder ${whole}`);
  }
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_whole, name: string) => values[name]!);
}

export function writerMessage(quote: QuoteContext, paragraphs: readonly SourceParagraph[]): string {
  return [
    `Quotation: ${quote.body}`,
    `Author: ${quote.author}`,
    `Work: ${quote.workTitle}`,
    '',
    'Source paragraphs:',
    '',
    paragraphs.map(formatParagraph).join('\n\n'),
  ].join('\n');
}

export function reviseMessage(quote: QuoteContext, paragraphs: readonly SourceParagraph[], draft: Draft, problems: readonly string[]): string {
  return [
    writerMessage(quote, paragraphs),
    '',
    'Draft:',
    JSON.stringify(draft, null, 2),
    '',
    'Problems the reviewer found:',
    problems.map((problem) => `- ${problem}`).join('\n'),
  ].join('\n');
}

/** The checker sees only the quotation, the paragraphs the draft cites, and the draft's numbered sentences (spec section 7). */
export function checkerMessage(quote: QuoteContext, cited: readonly SourceParagraph[], sentences: readonly DraftSentence[]): string {
  return [
    'Source paragraphs:',
    '',
    `[Q] (the quotation, from ${quote.workTitle} by ${quote.author}) ${quote.body}`,
    ...cited.map((paragraph) => `\n${formatParagraph(paragraph)}`),
    '',
    'Draft sentences:',
    sentences.map((sentence) => `(${sentence.n}) ${sentence.text}`).join('\n'),
  ].join('\n');
}
