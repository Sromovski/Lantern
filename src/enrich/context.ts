import type { SourceInput } from '../verify/source-policy.js';
import type { WikipediaArticle } from './wikipedia.js';

/** Sections that list references, links or adaptations instead of saying anything about the author or the work. */
export const DROPPED_SECTIONS = [
  'See also',
  'Notes',
  'References',
  'Sources',
  'Further reading',
  'External links',
  'Works cited',
  'Bibliography',
  'Adaptations',
  'Citations',
  'Footnotes',
] as const;

/** Shorter lines are captions, list entries or stray headings, not paragraphs worth citing. */
export const MIN_PARAGRAPH_CHARS = 40;

export interface SourceParagraph {
  /** The label the writer and the checker cite: S1, S2, ... */
  id: string;
  article: WikipediaArticle;
  /** The section heading ("Lead" before the first one), with any subsection after " / ". */
  section: string;
  text: string;
}

const HEADING = /^(={2,})\s*(.*?)\s*\1$/;

/**
 * An article's paragraphs in order, with their sections, until the next paragraph would take the total
 * past `maxChars`. The extracts API puts one paragraph on a line and headings as "== Name ==" (deeper
 * levels with more "="). Dropped sections and their subsections are skipped, and so are short lines and
 * a repeat of an earlier paragraph (two labels must never mean the same stored source).
 */
export function articleParagraphs(article: WikipediaArticle, maxChars: number): Omit<SourceParagraph, 'id'>[] {
  const dropped = new Set<string>(DROPPED_SECTIONS.map((name) => name.toLowerCase()));
  const seen = new Set<string>();
  const paragraphs: Omit<SourceParagraph, 'id'>[] = [];
  let top = 'Lead';
  let section = 'Lead';
  let dropping = false;
  let used = 0;
  for (const raw of article.extract.split('\n')) {
    const line = raw.trim();
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const name = heading[2] ?? '';
      if ((heading[1] ?? '').length === 2) {
        top = name;
        section = name;
        dropping = dropped.has(name.toLowerCase());
      } else {
        section = `${top} / ${name}`;
      }
      continue;
    }
    if (dropping || line.length < MIN_PARAGRAPH_CHARS || seen.has(line)) continue;
    if (used + line.length > maxChars) break;
    seen.add(line);
    used += line.length;
    paragraphs.push({ article, section, text: line });
  }
  return paragraphs;
}

/** Labels the paragraphs of every article S1, S2, ... in order. */
export function labelParagraphs(groups: readonly Omit<SourceParagraph, 'id'>[][]): SourceParagraph[] {
  return groups.flat().map((paragraph, i) => ({ id: `S${i + 1}`, ...paragraph }));
}

/** How a paragraph is shown to the writer and the checker. */
export function formatParagraph(paragraph: SourceParagraph): string {
  return `[${paragraph.id}] (${paragraph.article.title}: ${paragraph.section}) ${paragraph.text}`;
}

/** A paragraph as a stored source: tier 3 reference (spec section 8), the revision's permanent link, the paragraph as the excerpt. */
export function paragraphSource(paragraph: SourceParagraph): SourceInput {
  const where = paragraph.section === 'Lead' ? 'lead section' : `section "${paragraph.section}"`;
  return {
    tier: 3,
    url: paragraph.article.url,
    citation: `Wikipedia, "${paragraph.article.title}", ${where}, revision ${paragraph.article.revid}`,
    excerpt: paragraph.text,
  };
}
