import { describe, it, expect } from 'vitest';
import { extractNumbers, unsupportedNumbers } from '../../src/verify/numbers.js';

describe('extractNumbers', () => {
  it('extracts integers, decimals, and comma-grouped thousands', () => {
    expect(extractNumbers('About 1,000 objects fall at 9.8 m/s\u00B2 — first measured before 1859.')).toEqual(['1000', '9.8', '1859']);
  });

  it('pulls the digits out of ordinals and marks decades', () => {
    expect(extractNumbers('the 19th century and the 1990s')).toEqual(['19', '1990s']);
  });

  it('does not swallow a sentence-ending period', () => {
    expect(extractNumbers('Pi is roughly 3.14.')).toEqual(['3.14']);
  });

  it('returns nothing for text without numerals', () => {
    expect(extractNumbers('three blind mice')).toEqual([]);
  });

  it('preserves negative signs', () => {
    expect(extractNumbers('dropped to -5 degrees, then \u22123')).toEqual(['-5', '-3']);
  });

  it('does not extract range or label numbers', () => {
    expect(extractNumbers('pages 10-20 of the COVID-19 report')).toEqual(['10', '20', '19']);
  });

  it('normalizes leading decimals and negated decimals', () => {
    expect(extractNumbers('grew by .5 percent, then fell by -.25')).toEqual(['0.5%', '-0.25']);
  });
});

describe('unsupportedNumbers', () => {
  it('accepts numbers present in any excerpt, regardless of grouping', () => {
    expect(unsupportedNumbers('Dickens wrote it in 1859; it sold 1000 copies.', ['published 1859', 'sold 1,000 copies'])).toEqual([]);
  });

  it('flags numbers that do not appear verbatim in a source', () => {
    const draft = 'Sunlight takes 8 minutes to cross 93 million miles.';
    expect(unsupportedNumbers(draft, ['about 8 minutes', 'roughly 93,000,000 miles'])).toEqual(['93 million']);
  });

  it('treats a rounded number as unsupported', () => {
    expect(unsupportedNumbers('Gravity pulls at 9.8 m/s\u00B2.', ['g = 9.81 m/s\u00B2'])).toEqual(['9.8']);
  });

  it('reports each unsupported number once', () => {
    expect(unsupportedNumbers('42, then 42 again', [])).toEqual(['42']);
  });

  it('preserves negative sign in unsupported check', () => {
    expect(unsupportedNumbers('the temperature dropped to -5 degrees', ['recorded at 5 degrees above zero'])).toEqual(['-5']);
  });

  it('flags leading decimal as unsupported when source lacks it', () => {
    expect(unsupportedNumbers('grew by .5 percent', ['grew by roughly 5 percent'])).toEqual(['0.5%']);
  });

  it('accepts leading decimal when source has normalized form', () => {
    expect(unsupportedNumbers('grew by .5 percent', ['grew by 0.5 percent'])).toEqual([]);
  });
});

describe('stricter numeric tokens (review I6)', () => {
  it.each([
    ['about 93 billion stars', ['about 93 million stars'], ['93 billion']],
    ['a factor of 10\u00B3', ['a factor of 10\u00B2'], ['10^3']],
    ['in the 1850s', ['in 1850'], ['1850s']],
    ['70% of readers', ['70 countries'], ['70%']],
    ['it reached 40 degrees', ['it fell to \u201340 degrees'], ['40']],
  ])('flags %j as unsupported by %j', (draft, excerpts, expected) => {
    expect(unsupportedNumbers(draft, excerpts)).toEqual(expected);
  });

  it.each([
    ['70 percent of readers', ['70% of readers']],
    ['70 per cent of readers', ['70% of readers']],
    ['3 thousands', ['3 thousand']],
    ['93 Million', ['93 million']],
  ])('treats %j as supported by %j', (draft, excerpts) => {
    expect(unsupportedNumbers(draft, excerpts)).toEqual([]);
  });

  it.each([
    ['pages 10\u201320', ['10', '20']],
    ['10\u207B\u00B3 m', ['10^-3']],
    ['the 19th', ['19']],
    ['wait 5s', ['5']],
    ['the 1990s, then', ['1990s']],
    ['93 millionaires', ['93']],
    ['a 5 percentage point rise', ['5']],
    ['see page\u201340', ['40']],
    ['it fell to \u201340 degrees', ['-40']],
  ])('extracts %j as %j', (text, expected) => {
    expect(extractNumbers(text)).toEqual(expected);
  });
});
