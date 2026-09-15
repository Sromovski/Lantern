import { z } from 'zod';
import { normalizeText } from './normalize.js';
import { MIN_QUOTE_WORDS, type QuoteEvidence } from './quote-gate.js';

/**
 * MediaWiki `action=parse&prop=wikitext&formatversion=2` for a whole author page, as recorded from
 * en.wikiquote.org on 2026-09-14. One request gives every section at once, so a Misattributed or
 * Disputed list can never be read against a stale or shifted section index.
 */
export const wikiquotePageSchema = z.object({
  parse: z.object({ title: z.string().min(1), wikitext: z.string() }),
});

export type ListedKind = 'Misattributed' | 'Disputed';

/** The page cannot be trusted to show what is listed: a redirect, or a listed section under a heading this check does not recognise. */
export class WikiquotePageError extends Error {
  override name = 'WikiquotePageError';
}

export interface ListedSection {
  title: string;
  kind: ListedKind;
  /** The section's anchor on the page, for the evidence url. */
  anchor: string;
  /** The quotations the section lists: its top-level `*` bullets, reduced to visible text. */
  entries: string[];
}

/** A level-2 heading line (`== Name ==`); level-3 and deeper headings do not match. */
const LEVEL_TWO_HEADING = /^==(?!=)\s*(.*?)\s*==\s*$/;

/** Wikitext markup reduced to its visible text: links keep their label, references and templates go. */
export function cleanWikitext(line: string): string {
  return line
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/\S+\s+([^\]]*)\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/\S+\]/g, '')
    .replace(/'''?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The page's level-2 Misattributed and Disputed sections with the quotations they list. Spec
 * section 8: check both explicitly and hard-reject anything listed there. Only top-level `*`
 * bullets are listed quotations; deeper bullets are source notes, and on some pages (Jane Austen)
 * they quote the author's real sentence. Throws a ZodError when the response is not the recorded
 * shape (a MediaWiki error response included), and a WikiquotePageError for a redirect page or for a
 * level-2 heading that mentions misattribution or dispute without being exactly one of the two.
 */
export function listedSections(response: unknown): ListedSection[] {
  const { parse } = wikiquotePageSchema.parse(response);
  if (/^\s*#REDIRECT/i.test(parse.wikitext)) throw new WikiquotePageError(`the Wikiquote page ${parse.title} is a redirect`);
  const sections: ListedSection[] = [];
  let current: ListedSection | null = null;
  for (const line of parse.wikitext.split(/\r?\n/)) {
    const heading = LEVEL_TWO_HEADING.exec(line);
    if (heading !== null) {
      const name = cleanWikitext(heading[1]!);
      const kind: ListedKind | null = /^misattributed$/i.test(name) ? 'Misattributed' : /^disputed$/i.test(name) ? 'Disputed' : null;
      if (kind === null && /misattribut|disput/i.test(name)) {
        throw new WikiquotePageError(`the Wikiquote page ${parse.title} has a section heading this check does not recognise: ${name}`);
      }
      current = kind === null ? null : { title: parse.title, kind, anchor: name.replace(/ /g, '_'), entries: [] };
      if (current !== null) sections.push(current);
      continue;
    }
    if (current !== null && /^\*(?!\*)/.test(line)) {
      const text = cleanWikitext(line.slice(1));
      if (text.length > 0) current.entries.push(text);
    }
  }
  return sections;
}

const wordCount = (normalized: string) => normalized.split(' ').filter(Boolean).length;

/**
 * `listed-misattributed` evidence when the candidate and one of the section's entries match: after
 * normalization, one contains the other on word boundaries. Both sides must have at least
 * MIN_QUOTE_WORDS words, so neither a stock phrase in a listed entry nor a scrap of one can reject a
 * sentence.
 */
export function listedEvidence(candidate: string, section: ListedSection): QuoteEvidence | null {
  const normalizedCandidate = normalizeText(candidate);
  if (wordCount(normalizedCandidate) < MIN_QUOTE_WORDS) return null;
  const quote = ` ${normalizedCandidate} `;
  for (const entry of section.entries) {
    const normalized = normalizeText(entry);
    if (wordCount(normalized) < MIN_QUOTE_WORDS) continue;
    if (quote.includes(` ${normalized} `) || ` ${normalized} `.includes(quote)) {
      return {
        kind: 'listed-misattributed',
        citation: `Wikiquote, ${section.title}: ${section.kind}: "${entry}"`,
        url: `https://en.wikiquote.org/wiki/${encodeURIComponent(section.title.replace(/ /g, '_'))}#${section.anchor}`,
      };
    }
  }
  return null;
}
