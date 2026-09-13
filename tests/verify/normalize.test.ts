import { describe, it, expect } from 'vitest';
import { bodyHash, locateQuote, locateQuoteIn, normalizeText, prepareHaystack } from '../../src/verify/normalize.js';

describe('normalizeText', () => {
  it('folds smart quotes and apostrophes', () => {
    expect(normalizeText('Don\u2019t \u201Cpanic\u201D')).toBe('dont panic');
    expect(normalizeText(`Don't "panic"`)).toBe('dont panic');
  });

  it('folds dashes, ellipses, line breaks, and runs of whitespace', () => {
    expect(normalizeText('best of times\u2014it was\r\n   the worst\u2026')).toBe(
      'best of times it was the worst',
    );
    expect(normalizeText('best of times -- it was the worst...')).toBe(
      'best of times it was the worst',
    );
  });

  it('keeps diacritics but treats composed and decomposed forms alike', () => {
    expect(normalizeText('Caf\u00E9')).toBe('caf\u00E9');
    expect(normalizeText('Cafe\u0301')).toBe('caf\u00E9');
    expect(normalizeText('Caf\u00E9')).not.toBe(normalizeText('Cafe'));
  });

  it('treats Gutenberg _italic_ markers as separators', () => {
    expect(normalizeText('a _very_ fine day')).toBe('a very fine day');
  });
});

describe('bodyHash', () => {
  it('is equal for typographic variants and different for different words', () => {
    const a = bodyHash('It was the best of times, it was the worst of times.');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(bodyHash('it was the best of times \u2014 it was the worst of times')).toBe(a);
    expect(bodyHash('It was the best of times, it was the worst of crimes.')).not.toBe(a);
  });
});

describe('locateQuote', () => {
  const TALE =
    'It was the best of times,\r\nit was the worst of times, it was the age of wisdom';

  it('finds a quote across line breaks and returns the original excerpt', () => {
    expect(locateQuote('it was the best of times, it was the worst of times', TALE)).toEqual({
      start: 0,
      end: 52,
      excerpt: 'It was the best of times,\r\nit was the worst of times',
    });
  });

  it('matches straight quotes in the query against smart quotes in the text', () => {
    const text = 'said Oliver. \u201CPlease, sir, I want some more.\u201D The master';
    const hit = locateQuote('"Please, sir, I want some more"', text);
    expect(hit?.excerpt).toBe('Please, sir, I want some more');
  });

  it('only matches whole words', () => {
    expect(locateQuote('rose', 'the sun arose')).toBeNull();
    expect(locateQuote('rose', 'a rose by any other name')?.excerpt).toBe('rose');
  });

  it('skips a partial-word hit and finds a later whole-word one', () => {
    expect(locateQuote('rose', 'it arose; a rose')).toMatchObject({ excerpt: 'rose', start: 12 });
  });

  it('returns null when absent or when the quote is empty', () => {
    expect(locateQuote('call me ishmael', TALE)).toBeNull();
    expect(locateQuote(' \u2014 ', TALE)).toBeNull();
  });
});

describe('normalization hardening', () => {
  it('pins the golden body hash so normalization changes are deliberate', () => {
    expect(bodyHash('It was the best of times, it was the worst of times.')).toBe(
      'af8da705bfd95621983e5cf4232ac1ca0c79b47122e3defd8a98fa9a4387d985',
    );
  });

  it('deletes soft hyphens and zero-width characters instead of splitting words', () => {
    expect(normalizeText('won\u00adderful')).toBe('wonderful');
    expect(normalizeText('won\u200bder\u200dful\u2060ly')).toBe('wonderfully');
    expect(normalizeText('\ufeffhello\u200e world')).toBe('hello world');
  });

  it('does not locate a quote that starts mid-word across a soft hyphen', () => {
    expect(locateQuote('derful thing to see today', 'a won\u00adderful thing to see today')).toBeNull();
  });

  it('locates across a soft hyphen and keeps it in the excerpt', () => {
    expect(locateQuote('wonderful thing', 'a won\u00adderful thing')).toEqual({
      start: 2,
      end: 18,
      excerpt: 'won\u00adderful thing',
    });
  });

  it('handles astral characters, ligatures and dotted capital I', () => {
    expect(normalizeText('\u{1D518}nicorn')).toBe('unicorn');
    expect(normalizeText('\ufb01ne')).toBe('fine');
    expect(normalizeText('\u0130stanbul')).toBe('i\u0307stanbul');
  });

  it('maps excerpts correctly around astral characters and ligatures', () => {
    const text = 'the \u{1D518}nicorn has a \ufb01ne horn';
    expect(locateQuote('unicorn has a fine horn', text)).toEqual({
      start: 4,
      end: text.length,
      excerpt: '\u{1D518}nicorn has a \ufb01ne horn',
    });
  });

  it('pins a second golden hash covering apostrophe, format, ligature, astral, dash and CRLF paths', () => {
    const input = 'Don\uFF07t \u2018quote\u2019 the wo\u00ADnderful \uFB01re\u2014\u{1D518}nicorn\r\nplease';
    expect(normalizeText(input)).toBe('dont quote the wonderful fire unicorn please');
    expect(bodyHash(input)).toBe('a367e9b24649d525eb0650315ba11b19822f46f7a8f306cdab78437688884731');
  });

  it('drops apostrophes that only appear after compatibility normalization', () => {
    expect(normalizeText('don\uFF07t')).toBe('dont');
    expect(normalizeText('don\uFF40t')).toBe('dont');
    expect(normalizeText('\u0149')).toBe('n');
  });

  it('locates a quote across a full-width apostrophe', () => {
    expect(locateQuoteIn('dont go', prepareHaystack('He said don\uFF07t go.'))).toEqual({
      start: 8,
      end: 16,
      excerpt: 'don\uFF07t go',
    });
  });
});

describe('prepared haystack', () => {
  const TEXT = 'It was the best of times,\r\nit was the worst of times, it was the age of wisdom';

  it('locateQuoteIn reuses one prepared haystack across many queries with exact offsets', () => {
    const hay = prepareHaystack(TEXT);
    expect(locateQuoteIn('it was the best of times, it was the worst of times', hay)).toEqual({
      start: 0,
      end: 52,
      excerpt: 'It was the best of times,\r\nit was the worst of times',
    });
    expect(locateQuoteIn('age of wisdom', hay)).toEqual({ start: 65, end: 78, excerpt: 'age of wisdom' });
    expect(locateQuoteIn('call me ishmael', hay)).toBeNull();
    expect(locateQuoteIn('wisdom', hay)).toEqual({ start: 72, end: 78, excerpt: 'wisdom' });
    expect(locateQuoteIn('age of wisdom', hay)).toEqual(locateQuote('age of wisdom', TEXT));
  });

  it('uses a compact typed offset map with one entry per normalized code unit', () => {
    const hay = prepareHaystack(TEXT);
    expect(hay.map).toBeInstanceOf(Uint32Array);
    expect(hay.map.length).toBe(hay.text.length);
  });

  it('locates many quotes in a novel-sized text within budget', () => {
    const para =
      'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness. ';
    const text =
      para.repeat(Math.ceil(2_000_000 / para.length)) + 'Call me Ishmael, said nobody in this book.';
    const started = performance.now();
    const hay = prepareHaystack(text);
    for (let i = 0; i < 20; i++) {
      expect(locateQuoteIn(`a line that is not present number ${i}`, hay)).toBeNull();
    }
    expect(locateQuoteIn('call me ishmael said nobody', hay)?.excerpt).toBe('Call me Ishmael, said nobody');
    expect(performance.now() - started).toBeLessThan(5000);
  }, 20_000);
});
