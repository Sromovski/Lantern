import { describe, expect, it } from 'vitest';
import { BOILERPLATE, fitSentences, joinParagraphs, truncateAtWord, unapprovedSentences } from '../../src/caption/text.js';

const APPROVED = [
  'Dickens wrote the line in 1859.',
  'He had been running a weekly magazine, and the first instalment opened its first number.',
  'Read the novel and see how early the sentence arrives.',
].join('\n\n');

describe('unapprovedSentences', () => {
  it('accepts text carried over whole from the post', () => {
    expect(unapprovedSentences('Dickens wrote the line in 1859.', APPROVED)).toEqual([]);
    expect(unapprovedSentences(APPROVED, APPROVED)).toEqual([]);
  });

  it('accepts a truncation, because a prefix is still approved text', () => {
    const shorter = fitSentences(APPROVED, 120);
    expect(shorter.length).toBeLessThan(APPROVED.length);
    expect(unapprovedSentences(shorter, APPROVED)).toEqual([]);
  });

  it('accepts the fixed boilerplate but nothing else that was never approved', () => {
    expect(unapprovedSentences(BOILERPLATE[0] ?? '', APPROVED)).toEqual([]);

    // The danger this rule exists for: every clause below is approved, but the sentence is not, and
    // it asserts something no source said.
    const stitched = 'Dickens wrote the line in 1859 while running a weekly magazine.';
    expect(unapprovedSentences(stitched, APPROVED)).toEqual([stitched]);
  });

  it('ignores differences in whitespace only', () => {
    expect(unapprovedSentences('Dickens   wrote the line\nin 1859.', APPROVED)).toEqual([]);
  });
});

describe('fitSentences', () => {
  it('keeps whole sentences and never appends an ellipsis', () => {
    // The first two sentences are 31 and 88 characters. Keeping the paragraph break between them
    // costs two characters rather than one, so the pair needs 121 and does not fit in 120 - the
    // price of not reflowing a write-up into a single block. Measured, not guessed.
    expect(fitSentences(APPROVED, 120)).toBe('Dickens wrote the line in 1859.');

    const fitted = fitSentences(APPROVED, 121);
    expect(fitted).toBe('Dickens wrote the line in 1859.\n\nHe had been running a weekly magazine, and the first instalment opened its first number.');
    // Written as a code point so this file stays ASCII, the same way template.ts writes its quotes.
    expect(fitted).not.toContain(String.fromCharCode(0x2026));
    expect(fitted).not.toContain('...');
    expect(APPROVED.includes(fitted)).toBe(true);
  });

  it('drops the sentence that does not fit rather than cutting it', () => {
    expect(fitSentences(APPROVED, 40)).toBe('Dickens wrote the line in 1859.');
  });

  it('returns everything when it already fits, paragraphs intact', () => {
    // A Facebook caption is a paragraph of writing, so the blank lines survive: reflowing the
    // write-up into one block would make it read as a wall.
    expect(fitSentences(APPROVED, 10_000)).toBe(APPROVED);
  });

  it('falls back to a word boundary when even the first sentence is too long', () => {
    const fitted = fitSentences('Dickens wrote the line in 1859.', 12);
    expect(fitted).toBe('Dickens');
    expect([...fitted].length).toBeLessThanOrEqual(12);
  });
});

describe('truncateAtWord', () => {
  it('cuts at the last whole word and adds nothing', () => {
    expect(truncateAtWord('It was the best of times', 14)).toBe('It was the');
    expect(truncateAtWord('short', 40)).toBe('short');
  });

  it('counts characters, not code units, so an em dash costs one', () => {
    const text = `a${String.fromCharCode(0x2014)}b c`;
    expect([...truncateAtWord(text, 3)].length).toBeLessThanOrEqual(3);
  });
});

describe('joinParagraphs', () => {
  it('separates parts with a blank line and drops empty ones', () => {
    expect(joinParagraphs(['hook', '', '  ', 'closer'])).toBe('hook\n\ncloser');
  });
});
