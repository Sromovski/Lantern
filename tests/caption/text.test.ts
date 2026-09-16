import { describe, expect, it } from 'vitest';
import { BOILERPLATE, CaptionConfigError, fitSentences, joinParagraphs, truncateAtWord, unapprovedSentences } from '../../src/caption/text.js';
import { facebookCaption } from '../../src/caption/facebook.js';
import { pinterestCaption } from '../../src/caption/pinterest.js';

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

  it('ignores differences in spacing within a sentence', () => {
    expect(unapprovedSentences('Dickens   wrote   the line in 1859.', APPROVED)).toEqual([]);
  });

  it('accepts a sentence cut short, since a truncation adds no claim', () => {
    // Pinterest's title is a word-boundary cut of the hook, so prefixes must pass or every pin
    // would cost a fact check for text that is plainly approved.
    expect(unapprovedSentences('Dickens wrote the line', APPROVED)).toEqual([]);
    expect(unapprovedSentences('Dickens wrote', APPROVED)).toEqual([]);
  });

  it('catches a sentence stitched across two approved sentences', () => {
    // normalizeText strips end punctuation, so the approved text folds into one run and a naive
    // substring test finds this inside it. It asserts something neither approved sentence says.
    const two = 'He ran a weekly magazine. In 1859 he wrote the line.';
    expect(unapprovedSentences('He ran a weekly magazine in 1859.', two)).toEqual(['He ran a weekly magazine in 1859.']);

    // Either sentence on its own is still fine, and case and punctuation still do not matter.
    expect(unapprovedSentences('He ran a weekly magazine.', two)).toEqual([]);
    expect(unapprovedSentences('HE RAN A WEEKLY MAGAZINE', two)).toEqual([]);
    expect(unapprovedSentences('In 1859 he wrote the line.', two)).toEqual([]);
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

describe('a channel whose limit cannot hold the disclosure', () => {
  const post = {
    postId: 1,
    verticalId: 1,
    status: 'draft',
    hook: 'Dickens opened his new weekly with a sentence that refuses to settle.',
    body: 'The first instalment ran in April 1859.',
    closer: 'Read it and see.',
    quotation: 'q',
    workTitle: 'W',
    workYear: 1859,
    author: 'Charles Dickens',
    imageLicense: 'generated',
  };

  it('refuses rather than emitting a caption longer than the limit', () => {
    // Measured before this guard existed: textMax 10 produced 28 characters, being the two-newline
    // join plus the disclosure, with no prose at all. Over the limit and meaningless.
    expect(() => facebookCaption(post, { textMax: 10, titleMax: undefined })).toThrow(CaptionConfigError);
    expect(() => pinterestCaption(post, { textMax: 10, titleMax: 100 })).toThrow(CaptionConfigError);
  });

  it('still builds when the limit has room for the disclosure', () => {
    const built = facebookCaption(post, { textMax: 2000, titleMax: undefined });
    expect([...built.text].length).toBeLessThanOrEqual(2000);
    expect(built.text).toContain('Illustration: AI-generated');
  });

  it('is not triggered when the post has no generated image', () => {
    const plain = { ...post, imageLicense: 'public-domain' };
    expect([...facebookCaption(plain, { textMax: 10, titleMax: undefined }).text].length).toBeLessThanOrEqual(10);
  });
});
