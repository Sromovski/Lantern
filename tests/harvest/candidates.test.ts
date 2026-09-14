import { describe, it, expect } from 'vitest';
import { extractCandidates } from '../../src/harvest/candidates.js';
import { locateQuote, normalizeText } from '../../src/verify/normalize.js';

const BODY = [
  'CHAPTER I',
  'The Period',
  '',
  'There were a king with a large jaw and a queen with a plain face, on the',
  'throne of England; there were a king with a large jaw and a queen with a',
  'fair face, on the throne of France. It was cold.',
  '',
  '\u201CWhat is the matter?\u201D asked the gentleman, looking out of the coach window for a while.',
  '',
  'In both countries it was clearer than crystal to the lords of the State',
  'preserves of loaves and fishes, that things in general were settled for ever.',
].join('\r\n');

describe('extractCandidates', () => {
  it('cuts sentences of 8 to 40 words as whitespace-tidied slices of the source, across hard line wraps', () => {
    expect(extractCandidates(BODY)).toEqual([
      'There were a king with a large jaw and a queen with a plain face, on the throne of England; there were a king with a large jaw and a queen with a fair face, on the throne of France.',
      'In both countries it was clearer than crystal to the lords of the State preserves of loaves and fishes, that things in general were settled for ever.',
    ]);
  });

  it('keeps every candidate verbatim: the source punctuation is kept, and the matcher locates it', () => {
    const tidiedSource = BODY.replace(/\s+/g, ' ');
    for (const candidate of extractCandidates(BODY)) {
      expect(tidiedSource).toContain(candidate);
      const located = locateQuote(candidate, BODY);
      expect(located).not.toBeNull();
      expect(normalizeText(located!.excerpt)).toBe(normalizeText(candidate));
    }
  });

  it('skips dialogue, headings and sentences outside the word bounds', () => {
    const candidates = extractCandidates(BODY);
    expect(candidates.some((c) => c.includes('What is the matter'))).toBe(false);
    expect(candidates).not.toContain('CHAPTER I');
    expect(candidates).not.toContain('It was cold.');
  });

  it('honours custom word bounds', () => {
    expect(extractCandidates(BODY, { minWords: 1, maxWords: 3 })).toEqual(['It was cold.']);
  });

  it('returns each repeated sentence once', () => {
    const twice = `${'A quiet sentence that the author happened to repeat word for word.'}\n\n${'A quiet sentence that the author happened to repeat word for word.'}`;
    expect(extractCandidates(twice)).toEqual(['A quiet sentence that the author happened to repeat word for word.']);
  });
});
