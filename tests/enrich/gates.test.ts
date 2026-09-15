import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.js';
import { labelParagraphs, type SourceParagraph } from '../../src/enrich/context.js';
import { draftSentences, type Check, type Draft } from '../../src/enrich/draft.js';
import { checkProblems, citedParagraphs, numberProblems, parsePostShape, parseShapeRange, shapeProblems } from '../../src/enrich/gates.js';
import type { WikipediaArticle } from '../../src/enrich/wikipedia.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const QUOTE = 'A wonderful fact to reflect upon, that every human creature is constituted to be that profound secret and mystery to every other.';
const SHAPE = parsePostShape({ hook: '1 sentence', body: '2-4 short paragraphs', closer: '1 sentence pointing back to the work itself' });

const ARTICLE: WikipediaArticle = {
  title: 'A Tale of Two Cities',
  qid: 'Q308918',
  revid: 1374830091,
  extract: '',
  url: 'https://en.wikipedia.org/w/index.php?title=A_Tale_of_Two_Cities&oldid=1374830091',
  fetchedAt: '2026-09-15T00:00:00.000Z',
};
const PARAGRAPHS: SourceParagraph[] = labelParagraphs([
  [
    { article: ARTICLE, section: 'Lead', text: 'A Tale of Two Cities is an 1859 historical novel by Charles Dickens, set in London and Paris.' },
    { article: ARTICLE, section: 'Synopsis', text: 'Doctor Manette was imprisoned in the Bastille for 18 years.' },
    { article: ARTICLE, section: 'Background', text: 'Dickens published the novel in weekly instalments in All the Year Round.' },
  ],
]);
const LABELS = new Set(PARAGRAPHS.map((p) => p.id));

const part = (text: string, sources: string[]) => ({ text, sources });
const CLEAN: Draft = {
  hook: part('Dickens set this reflection in a novel full of secrets.', ['S1']),
  body: [part('Dickens published the novel in 1859. It is set in London and Paris.', ['S1', 'S3']), part('The line reads privacy as a condition.', [])],
  closer: part('Doctor Manette spends 18 years in the Bastille.', ['S2']),
};

describe('parseShapeRange and parsePostShape', () => {
  it('reads the count a post_shape entry starts with', () => {
    expect(parseShapeRange('1 sentence')).toEqual({ min: 1, max: 1 });
    expect(parseShapeRange('2-4 short paragraphs')).toEqual({ min: 2, max: 4 });
    expect(parseShapeRange('3\u20135 short paragraphs')).toEqual({ min: 3, max: 5 });
    expect(parseShapeRange('1 question')).toEqual({ min: 1, max: 1 });
  });

  it.each(['one sentence', '4-2 paragraphs', '0 sentences'])('refuses "%s"', (entry) => {
    expect(() => parseShapeRange(entry)).toThrow('post_shape entry');
  });

  it('reads the post shape of every configured vertical', () => {
    for (const vertical of loadConfig(ROOT).verticals) expect(() => parsePostShape(vertical.post_shape)).not.toThrow();
  });
});

describe('shapeProblems', () => {
  it('finds nothing wrong with a draft of the right shape', () => {
    expect(shapeProblems(CLEAN, SHAPE, LABELS, QUOTE)).toEqual([]);
  });

  it('reports wrong counts, empty parts, unknown labels and a repeated quotation', () => {
    const draft: Draft = {
      hook: part('It is a novel. It has secrets.', ['S1', 'S9', 'S9']),
      body: [part(`As he wrote: "${QUOTE.toUpperCase()}"`, ['S1'])],
      closer: part('  ', []),
    };
    expect(shapeProblems(draft, SHAPE, LABELS, QUOTE)).toEqual([
      'the hook has 2 sentences; the post shape allows 1',
      'the body has 1 paragraph; the post shape allows 2 to 4',
      'the closer has 0 sentences; the post shape allows 1',
      'the hook cites S9, which is not one of the source paragraphs',
      'the closer is empty',
      'the draft repeats the whole quotation, which the post already shows',
    ]);
  });
});

describe('citedParagraphs and numberProblems', () => {
  it('returns the cited paragraphs once each, in source order', () => {
    expect(citedParagraphs(CLEAN, PARAGRAPHS).map((p) => p.id)).toEqual(['S1', 'S2', 'S3']);
  });

  it('accepts numbers in the quotation or a cited paragraph and reports the rest', () => {
    expect(numberProblems(CLEAN, QUOTE, citedParagraphs(CLEAN, PARAGRAPHS))).toEqual([]);
    const draft: Draft = { ...CLEAN, closer: part('Manette spends 18 years in the Bastille, across 45 chapters.', ['S2']) };
    expect(numberProblems(draft, QUOTE, citedParagraphs(draft, PARAGRAPHS))).toEqual([
      'the number 45 is not in the quotation or in any cited source paragraph',
    ]);
    expect(numberProblems(draft, QUOTE, PARAGRAPHS.slice(0, 1))).toEqual([
      'the number 18 is not in the quotation or in any cited source paragraph',
      'the number 45 is not in the quotation or in any cited source paragraph',
    ]);
  });
});

describe('checkProblems', () => {
  const sentences = draftSentences(CLEAN);
  const verdict = (id: number, supported = true, problem = '') => ({ id, kind: 'fact' as const, supported, sources: supported ? ['S1'] : [], problem });
  const CITED = new Set(['S1', 'S2', 'S3']);

  it('finds nothing when every sentence is supported', () => {
    expect(checkProblems({ sentences: sentences.map((s) => verdict(s.n)) }, sentences, CITED)).toEqual([]);
  });

  it('reports a fact judged supported without naming the quotation or a cited paragraph', () => {
    const check: Check = { sentences: sentences.map((s) => verdict(s.n)) };
    check.sentences[0] = { ...check.sentences[0]!, sources: [] };
    check.sentences[1] = { ...check.sentences[1]!, sources: ['S9'] };
    check.sentences[2] = { ...check.sentences[2]!, kind: 'interpretation', sources: [] };
    check.sentences[3] = { ...check.sentences[3]!, sources: ['Q'] };
    expect(checkProblems(check, sentences, CITED)).toEqual([
      '"Dickens set this reflection in a novel full of secrets." was judged a supported fact without naming the quotation or a cited paragraph that supports it',
      '"Dickens published the novel in 1859." was judged a supported fact without naming the quotation or a cited paragraph that supports it',
    ]);
  });

  it('reports unsupported sentences with the detail, and any sentence not judged exactly once', () => {
    const check: Check = {
      sentences: [verdict(1), verdict(2, false, 'the year is not in the cited paragraph'), verdict(3, false, ' '), verdict(4), verdict(4), verdict(9)],
    };
    expect(checkProblems(check, sentences, CITED)).toEqual([
      '"Dickens published the novel in 1859." is not supported by the source paragraphs: the year is not in the cited paragraph',
      '"It is set in London and Paris." is not supported by the source paragraphs: the fact check gave no detail',
      'the fact check gave 2 verdicts for "The line reads privacy as a condition."',
      'the fact check gave 0 verdicts for "Doctor Manette spends 18 years in the Bastille."',
      'the fact check judged a sentence 9, which the draft does not have',
    ]);
  });
});
