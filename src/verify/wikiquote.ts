import { z } from 'zod';
import { normalizeText } from './normalize.js';
import { MIN_QUOTE_WORDS, type QuoteEvidence } from './quote-gate.js';

/** MediaWiki `action=parse&prop=sections&formatversion=2`, as recorded from en.wikiquote.org on 2026-09-13. */
export const wikiquoteSectionsSchema = z.object({
  parse: z.object({
    title: z.string().min(1),
    sections: z.array(
      z.object({ level: z.string(), line: z.string(), index: z.string().regex(/^\d+$/), anchor: z.string().min(1) }),
    ),
  }),
});

/** MediaWiki `action=parse&prop=wikitext&section=N&formatversion=2`. */
export const wikiquoteWikitextSchema = z.object({
  parse: z.object({ title: z.string().min(1), wikitext: z.string() }),
});

export type ListedKind = 'Misattributed' | 'Disputed';

export interface ListedSection {
  title: string;
  kind: ListedKind;
  index: number;
  anchor: string;
}

const LISTED_HEADING = /^(misattributed|disputed)$/i;

/**
 * The page's level-2 Misattributed and Disputed sections. Spec section 8: check both explicitly and
 * hard-reject anything listed there. Throws a ZodError when the response is not the recorded shape.
 */
export function listedSections(response: unknown): ListedSection[] {
  const { parse } = wikiquoteSectionsSchema.parse(response);
  return parse.sections.flatMap((section) => {
    const heading = LISTED_HEADING.exec(section.line.replace(/<[^>]+>/g, '').trim());
    if (section.level !== '2' || heading === null) return [];
    const kind: ListedKind = heading[1]!.toLowerCase() === 'disputed' ? 'Disputed' : 'Misattributed';
    return [{ title: parse.title, kind, index: Number(section.index), anchor: section.anchor }];
  });
}

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
 * The quotations a Misattributed or Disputed section lists: its top-level `*` bullets. Deeper bullets
 * are source notes, and on some pages (Jane Austen) they quote the author's real sentence, so they
 * are never treated as listed.
 */
export function listedEntries(response: unknown): string[] {
  const { parse } = wikiquoteWikitextSchema.parse(response);
  return parse.wikitext
    .split(/\r?\n/)
    .filter((line) => /^\*(?!\*)/.test(line))
    .map((line) => cleanWikitext(line.slice(1)))
    .filter((text) => text.length > 0);
}

/**
 * `listed-misattributed` evidence when the candidate and a listed entry match: after normalization,
 * one contains the other on word boundaries. Entries shorter than MIN_QUOTE_WORDS are ignored so a
 * stock phrase cannot reject every sentence that uses it.
 */
export function listedEvidence(candidate: string, entries: readonly string[], section: ListedSection): QuoteEvidence | null {
  const quote = ` ${normalizeText(candidate)} `;
  for (const entry of entries) {
    const normalized = normalizeText(entry);
    if (normalized.split(' ').filter(Boolean).length < MIN_QUOTE_WORDS) continue;
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
