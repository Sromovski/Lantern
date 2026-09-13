import { describe, it, expect } from 'vitest';
import { bodyHash, locateQuote, normalizeText } from '../../src/verify/normalize.js';

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
