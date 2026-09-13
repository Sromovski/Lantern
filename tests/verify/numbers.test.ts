import { describe, it, expect } from 'vitest';
import { extractNumbers, unsupportedNumbers } from '../../src/verify/numbers.js';

describe('extractNumbers', () => {
  it('extracts integers, decimals, and comma-grouped thousands', () => {
    expect(extractNumbers('About 1,000 objects fall at 9.8 m/s\u00B2 — first measured before 1859.')).toEqual(['1000', '9.8', '1859']);
  });

  it('pulls the digits out of ordinals and decades', () => {
    expect(extractNumbers('the 19th century and the 1990s')).toEqual(['19', '1990']);
  });

  it('does not swallow a sentence-ending period', () => {
    expect(extractNumbers('Pi is roughly 3.14.')).toEqual(['3.14']);
  });

  it('returns nothing for text without numerals', () => {
    expect(extractNumbers('three blind mice')).toEqual([]);
  });
});

describe('unsupportedNumbers', () => {
  it('accepts numbers present in any excerpt, regardless of grouping', () => {
    expect(unsupportedNumbers('Dickens wrote it in 1859; it sold 1000 copies.', ['published 1859', 'sold 1,000 copies'])).toEqual([]);
  });

  it('flags numbers that do not appear verbatim in a source', () => {
    const draft = 'Sunlight takes 8 minutes to cross 93 million miles.';
    expect(unsupportedNumbers(draft, ['about 8 minutes', 'roughly 93,000,000 miles'])).toEqual(['93']);
  });

  it('treats a rounded number as unsupported', () => {
    expect(unsupportedNumbers('Gravity pulls at 9.8 m/s\u00B2.', ['g = 9.81 m/s\u00B2'])).toEqual(['9.8']);
  });

  it('reports each unsupported number once', () => {
    expect(unsupportedNumbers('42, then 42 again', [])).toEqual(['42']);
  });
});
