import { describe, it, expect } from 'vitest';
import { checkSchema, draftParts, draftSchema, draftSentences, splitSentences, type Draft } from '../../src/enrich/draft.js';

const part = (text: string, sources: string[] = ['S1']) => ({ text, sources });

describe('splitSentences', () => {
  it('splits at sentence ends but not after abbreviations, initials or decimals', () => {
    expect(splitSentences('Mr. Dickens wrote it in 1859. It sold widely!')).toEqual(['Mr. Dickens wrote it in 1859.', 'It sold widely!']);
    expect(splitSentences('J. M. W. Turner painted it. St. Paul\u2019s was near.')).toEqual(['J. M. W. Turner painted it.', 'St. Paul\u2019s was near.']);
    expect(splitSentences('It weighed 3.5 tons in c. 1850. Nobody knows why.')).toEqual(['It weighed 3.5 tons in c. 1850.', 'Nobody knows why.']);
  });

  it('keeps closing quotation marks with their sentence, and returns nothing for blank text', () => {
    expect(splitSentences('He said, \u201CNo.\u201D Then he left.')).toEqual(['He said, \u201CNo.\u201D', 'Then he left.']);
    expect(splitSentences('   ')).toEqual([]);
  });
});

describe('draftParts and draftSentences', () => {
  const draft: Draft = {
    hook: part('A novel of secrets.'),
    body: [part('Dickens published it in 1859. It is set in London and Paris.'), part('The line is a reading of privacy.', [])],
    closer: part('The book keeps testing it.'),
  };

  it('names the parts in order', () => {
    expect(draftParts(draft).map((p) => p.name)).toEqual(['hook', 'body paragraph 1', 'body paragraph 2', 'closer']);
  });

  it('numbers every sentence across the parts', () => {
    expect(draftSentences(draft)).toEqual([
      { n: 1, part: 'hook', text: 'A novel of secrets.' },
      { n: 2, part: 'body paragraph 1', text: 'Dickens published it in 1859.' },
      { n: 3, part: 'body paragraph 1', text: 'It is set in London and Paris.' },
      { n: 4, part: 'body paragraph 2', text: 'The line is a reading of privacy.' },
      { n: 5, part: 'closer', text: 'The book keeps testing it.' },
    ]);
  });
});

describe('draft and check schemas', () => {
  it('accept the recorded answer shapes and refuse others', () => {
    expect(draftSchema.safeParse({ hook: part('h'), body: [part('b')], closer: part('c') }).success).toBe(true);
    expect(draftSchema.safeParse({ hook: part('h'), body: [part('b')] }).success).toBe(false);
    const verdict = { id: 1, kind: 'fact', supported: true, sources: ['S1'], problem: '' };
    expect(checkSchema.safeParse({ sentences: [verdict] }).success).toBe(true);
    expect(checkSchema.safeParse({ sentences: [{ ...verdict, kind: 'opinion' }] }).success).toBe(false);
    expect(checkSchema.safeParse({ sentences: [{ ...verdict, id: 1.5 }] }).success).toBe(false);
  });
});
