import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { cleanWikitext, listedEvidence, listedSections, WikiquotePageError, type ListedSection } from '../../src/verify/wikiquote.js';

// Trimmed from en.wikiquote.org page wikitext (2026-09-13/14). Wikiquote text is CC BY-SA 4.0.
const WILDE = {
  parse: {
    title: 'Oscar Wilde',
    wikitext: [
      '{{Wikipedia}}',
      '== Quotes ==',
      '* Experience is the name everyone gives to their mistakes.',
      '=== Misattributed ===',
      '* A level-3 heading is part of Quotes, and this line is never listed.',
      '==Disputed==',
      '* A pessimist is one who, when he has the choice of two evils, chooses both.',
      '** Similar quotes are found, unattributed, from [https://books.google.com/books?id=x as early as 1899].',
      '{{Disputed end}}',
      '',
      '== Misattributed ==',
      '<small>\'\'Misattributed: Quotes widely associated with an author but sourced to another.\'\'</small>',
      '*Always forgive your [[enemies]]; nothing annoys them so much.',
      '**In 2022, an image of Wilde and the quote started spreading online. [https://quoteinvestigator.com/2021/06/11/annoy/ Quote Investigator]',
      '',
      '* I like work: it fascinates me. I can sit and look at it for hours.',
      '** [[Jerome K. Jerome]], \'\'Three Men in a Boat\'\' (1889)',
      '*Be Yourself.<ref>{{cite web|url=https://example.org/|title=X}}</ref>',
      '{{Misattributed end}}',
      '',
      '== External links ==',
      '* A link line that is never listed.',
    ].join('\n'),
  },
};

const AUSTEN = {
  parse: {
    title: 'Jane Austen',
    wikitext: [
      '== Quotes == ',
      '* It is a truth universally acknowledged.',
      '== Misattributed ==',
      '* Life seems but a quick succession of busy nothings.',
      '** Said by Fanny Price in a 1999 adaptation of \'\'Mansfield Park\'\'. Actual quote:',
      '*** Dinner was soon followed by tea and coffee, and it was a quick succession of busy nothings till the carriage came to the door.',
      '{{Misattributed end}}',
    ].join('\n'),
  },
};

const sectionOf = (response: unknown, kind: ListedSection['kind']) => listedSections(response).find((s) => s.kind === kind)!;

describe('wikiquote', () => {
  it('reads the level-2 Disputed and Misattributed sections of a whole page with their top-level entries', () => {
    expect(listedSections(WILDE)).toEqual([
      {
        title: 'Oscar Wilde',
        kind: 'Disputed',
        anchor: 'Disputed',
        entries: ['A pessimist is one who, when he has the choice of two evils, chooses both.'],
      },
      {
        title: 'Oscar Wilde',
        kind: 'Misattributed',
        anchor: 'Misattributed',
        entries: [
          'Always forgive your enemies; nothing annoys them so much.',
          'I like work: it fascinates me. I can sit and look at it for hours.',
          'Be Yourself.',
        ],
      },
    ]);
  });

  it('returns no sections for a page without them, and refuses a response that is not the recorded shape', () => {
    expect(listedSections({ parse: { title: 'Somebody', wikitext: '== Quotes ==\n* A quote.' } })).toEqual([]);
    expect(() => listedSections({ error: { code: 'missingtitle', info: 'The page you specified does not exist.' } })).toThrow(ZodError);
  });

  it('refuses a redirect page and a listed section heading it does not recognise', () => {
    expect(() => listedSections({ parse: { title: 'Samuel Clemens', wikitext: '#REDIRECT [[Mark Twain]]' } })).toThrow(WikiquotePageError);
    expect(() =>
      listedSections({ parse: { title: 'Somebody', wikitext: '== Quotes ==\n* A quote.\n== Misattributed quotes ==\n* A listed quotation of some length.' } }),
    ).toThrow(WikiquotePageError);
  });

  it('reduces wikitext markup to its visible text', () => {
    expect(cleanWikitext('[[w:Menards|Menards]] in \'\'[https://example.org/x The Globe]\'\'<ref name="a"/>')).toBe('Menards in The Globe');
  });

  it('returns listed-misattributed evidence for a listed quote, whatever its punctuation', () => {
    const misattributed = sectionOf(WILDE, 'Misattributed');
    expect(listedEvidence('Always forgive your enemies, nothing annoys them so much!', misattributed)).toEqual({
      kind: 'listed-misattributed',
      citation: 'Wikiquote, Oscar Wilde: Misattributed: "Always forgive your enemies; nothing annoys them so much."',
      url: 'https://en.wikiquote.org/wiki/Oscar_Wilde#Misattributed',
    });
    expect(listedEvidence('He always said that I like work: it fascinates me. I can sit and look at it for hours.', misattributed)).not.toBeNull();
  });

  it('never lists the author\'s real sentence that a source note quotes', () => {
    const real = 'Dinner was soon followed by tea and coffee, and it was a quick succession of busy nothings till the carriage came to the door.';
    expect(listedEvidence(real, sectionOf(AUSTEN, 'Misattributed'))).toBeNull();
  });

  it('ignores listed entries shorter than the minimum quote length', () => {
    const misattributed = sectionOf(WILDE, 'Misattributed');
    expect(listedEvidence('I told him to be yourself, whatever the others said.', misattributed)).toBeNull();
  });

  it('does not list a scrap of a listed entry that is shorter than the minimum quote length', () => {
    const misattributed = sectionOf(WILDE, 'Misattributed');
    expect(listedEvidence('Nothing annoys them so.', misattributed)).toBeNull();
    expect(listedEvidence('Nothing annoys them so much.', misattributed)).not.toBeNull();
  });
});
