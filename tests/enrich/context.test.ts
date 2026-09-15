import { describe, it, expect } from 'vitest';
import { articleParagraphs, DROPPED_SECTIONS, formatParagraph, labelParagraphs, MIN_PARAGRAPH_CHARS, paragraphSource } from '../../src/enrich/context.js';
import type { WikipediaArticle } from '../../src/enrich/wikipedia.js';
import { assertSourceAllowed, SourcePolicyError } from '../../src/verify/source-policy.js';

const P = (n: number) => `Paragraph ${n} says something about the author at enough length to be worth citing.`;
const article = (title: string, qid: string, extract: string): WikipediaArticle => ({
  title,
  qid,
  revid: 1371883001,
  extract,
  url: `https://en.wikipedia.org/w/index.php?title=${title.replace(/ /g, '_')}&oldid=1371883001`,
  fetchedAt: '2026-09-15T00:00:00.000Z',
});

// The extracts API layout: one paragraph per line, "\n\n\n== Heading ==\n\n" before a section, "=== Sub ===" deeper.
const DICKENS = article(
  'Charles Dickens',
  'Q5686',
  [P(1), P(2), '', '', '== Early life ==', '', P(3), '=== Education ===', P(4), 'Short caption line.', '', '', '== References ==', '', P(5), '=== Sources ===', P(6), '', '', '== Legacy ==', '', P(7)].join('\n'),
);
const TALE = article('A Tale of Two Cities', 'Q308918', [P(8), '', '', '== Synopsis ==', '', P(9)].join('\n'));

describe('articleParagraphs', () => {
  it('keeps paragraphs with their sections, skipping reference sections and short lines', () => {
    expect(DROPPED_SECTIONS).toContain('References');
    expect('Short caption line.'.length).toBeLessThan(MIN_PARAGRAPH_CHARS);
    expect(articleParagraphs(DICKENS, 10_000).map((p) => [p.section, p.text])).toEqual([
      ['Lead', P(1)],
      ['Lead', P(2)],
      ['Early life', P(3)],
      ['Early life / Education', P(4)],
      ['Legacy', P(7)],
    ]);
  });

  it('stops before the paragraph that would pass the character budget', () => {
    expect(articleParagraphs(DICKENS, 3 * P(1).length - 1).map((p) => p.text)).toEqual([P(1), P(2)]);
  });
});

describe('labelParagraphs and formatParagraph', () => {
  it('labels paragraphs across articles in order, and shows each with its article and section', () => {
    const labelled = labelParagraphs([articleParagraphs(DICKENS, 10_000).slice(0, 2), articleParagraphs(TALE, 10_000)]);
    expect(labelled.map((p) => p.id)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(formatParagraph(labelled[3]!)).toBe(`[S4] (A Tale of Two Cities: Synopsis) ${P(9)}`);
  });
});

describe('paragraphSource', () => {
  it('stores a paragraph as a tier 3 Wikipedia source cited by article, section and revision', () => {
    const [lead, , , education] = labelParagraphs([articleParagraphs(DICKENS, 10_000)]);
    expect(paragraphSource(education!)).toEqual({
      tier: 3,
      url: 'https://en.wikipedia.org/w/index.php?title=Charles_Dickens&oldid=1371883001',
      citation: 'Wikipedia, "Charles Dickens", section "Early life / Education", revision 1371883001',
      excerpt: P(4),
    });
    expect(paragraphSource(lead!).citation).toBe('Wikipedia, "Charles Dickens", lead section, revision 1371883001');
    expect(() => assertSourceAllowed(paragraphSource(lead!))).not.toThrow();
    expect(() => assertSourceAllowed({ ...paragraphSource(lead!), tier: 2 })).toThrow(SourcePolicyError);
  });
});
