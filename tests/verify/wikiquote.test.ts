import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { cleanWikitext, listedEntries, listedEvidence, listedSections, type ListedSection } from '../../src/verify/wikiquote.js';

// Trimmed from en.wikiquote.org API responses (2026-09-13). Wikiquote text is CC BY-SA 4.0.
const SECTIONS = {
  parse: {
    title: 'Oscar Wilde',
    sections: [
      { toclevel: 1, level: '2', line: 'Quotes', number: '1', index: '1', anchor: 'Quotes' },
      { toclevel: 2, level: '3', line: '<i>The Picture of Dorian Gray</i> (1890)', number: '1.1', index: '2', anchor: 'The_Picture_of_Dorian_Gray_(1890)' },
      { toclevel: 2, level: '3', line: 'Misattributed', number: '1.2', index: '3', anchor: 'Misattributed_2' },
      { toclevel: 1, level: '2', line: 'Disputed', number: '2', index: '19', anchor: 'Disputed' },
      { toclevel: 1, level: '2', line: 'Misattributed', number: '3', index: '20', anchor: 'Misattributed' },
      { toclevel: 1, level: '2', line: 'External links', number: '4', index: '21', anchor: 'External_links' },
    ],
  },
};

const MISATTRIBUTED = {
  parse: {
    title: 'Oscar Wilde',
    wikitext: [
      '== Misattributed ==',
      '<small>\'\'Misattributed: Quotes widely associated with an author but sourced to another.\'\'</small>',
      '*Always forgive your [[enemies]]; nothing annoys them so much.',
      '**In 2022, an image of Wilde and the quote started spreading online. [https://quoteinvestigator.com/2021/06/11/annoy/ Quote Investigator]',
      '',
      '* I like work: it fascinates me. I can sit and look at it for hours.',
      '** [[Jerome K. Jerome]], \'\'Three Men in a Boat\'\' (1889)',
      '*Be Yourself.<ref>{{cite web|url=https://example.org/|title=X}}</ref>',
      '{{Misattributed end}}',
    ].join('\n'),
  },
};

const AUSTEN = {
  parse: {
    title: 'Jane Austen',
    wikitext: [
      '== Misattributed ==',
      '* Life seems but a quick succession of busy nothings.',
      '** Said by Fanny Price in a 1999 adaptation of \'\'Mansfield Park\'\'. Actual quote:',
      '*** Dinner was soon followed by tea and coffee, and it was a quick succession of busy nothings till the carriage came to the door.',
      '{{Misattributed end}}',
    ].join('\n'),
  },
};

const WILDE_MISATTRIBUTED: ListedSection = { title: 'Oscar Wilde', kind: 'Misattributed', index: 20, anchor: 'Misattributed' };

describe('wikiquote', () => {
  it('finds the level-2 Misattributed and Disputed sections only', () => {
    expect(listedSections(SECTIONS)).toEqual([
      { title: 'Oscar Wilde', kind: 'Disputed', index: 19, anchor: 'Disputed' },
      WILDE_MISATTRIBUTED,
    ]);
  });

  it('refuses a sections response that is not the recorded shape', () => {
    expect(() => listedSections({ parse: { title: 'Oscar Wilde', sections: [{ level: 2, line: 'Disputed' }] } })).toThrow(ZodError);
  });

  it('lists only top-level bullets, reduced to their visible text', () => {
    expect(listedEntries(MISATTRIBUTED)).toEqual([
      'Always forgive your enemies; nothing annoys them so much.',
      'I like work: it fascinates me. I can sit and look at it for hours.',
      'Be Yourself.',
    ]);
    expect(cleanWikitext('[[w:Menards|Menards]] in \'\'[https://example.org/x The Globe]\'\'<ref name="a"/>')).toBe('Menards in The Globe');
  });

  it('returns listed-misattributed evidence for a listed quote, whatever its punctuation', () => {
    const entries = listedEntries(MISATTRIBUTED);
    expect(listedEvidence('Always forgive your enemies, nothing annoys them so much!', entries, WILDE_MISATTRIBUTED)).toEqual({
      kind: 'listed-misattributed',
      citation: 'Wikiquote, Oscar Wilde: Misattributed: "Always forgive your enemies; nothing annoys them so much."',
      url: 'https://en.wikiquote.org/wiki/Oscar_Wilde#Misattributed',
    });
    expect(
      listedEvidence('He always said that I like work: it fascinates me. I can sit and look at it for hours.', entries, WILDE_MISATTRIBUTED),
    ).not.toBeNull();
  });

  it('never lists the author\'s real sentence that a source note quotes', () => {
    const section: ListedSection = { title: 'Jane Austen', kind: 'Misattributed', index: 13, anchor: 'Misattributed' };
    const real = 'Dinner was soon followed by tea and coffee, and it was a quick succession of busy nothings till the carriage came to the door.';
    expect(listedEvidence(real, listedEntries(AUSTEN), section)).toBeNull();
  });

  it('ignores listed entries shorter than the minimum quote length', () => {
    expect(listedEvidence('Be yourself.', listedEntries(MISATTRIBUTED), WILDE_MISATTRIBUTED)).toBeNull();
    expect(listedEvidence('I told him to be yourself, whatever the others said.', listedEntries(MISATTRIBUTED), WILDE_MISATTRIBUTED)).toBeNull();
  });
});
