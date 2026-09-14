import { describe, it, expect } from 'vitest';
import { bookBody } from '../../src/harvest/front-matter.js';

const crlf = (lines: string[]) => lines.join('\r\n');

describe('bookBody', () => {
  it('drops a preface by another writer before the first chapter heading', () => {
    const text = crlf([
      'PREFACE.',
      '',
      'Walt Whitman has somewhere a fine and just distinction between loving by allowance and loving with personal love.',
      '',
      'GEORGE SAINTSBURY.',
      '',
      '[Illustration:',
      'Chapter I.]',
      '',
      'It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.',
    ]);
    const body = bookBody(text);
    expect(body?.heading).toBe('Chapter I.]');
    expect(body?.skippedLines).toBe(7);
    expect(body?.text.startsWith('Chapter I.]\r\n')).toBe(true);
    expect(body?.text).not.toContain('Walt Whitman');
  });

  it('passes over a table of contents and keeps the rest of the text byte for byte', () => {
    const rest = ['CHAPTER I.', '', 'You don\'t know about me without you have read a book.', ''];
    const text = crlf(['CONTENTS.', '', 'CHAPTER I.', 'Civilizing Huck.', 'CHAPTER II.', 'Our Gang.', '', 'NOTICE.', '', ...rest]);
    const body = bookBody(text);
    expect(body?.heading).toBe('CHAPTER I.');
    expect(body?.text).toBe(crlf(rest));
  });

  it('passes over a book heading that is followed straight away by its first chapter', () => {
    const text = crlf(['Book the First--Recalled to Life', '', '', 'CHAPTER I.', 'The Period', '', 'It was the best of times.']);
    expect(bookBody(text)?.heading).toBe('CHAPTER I.');
  });

  it('starts a play at its first act, past the list of scenes', () => {
    const text = crlf([
      'THE SCENES OF THE PLAY',
      '',
      'ACT I. Algernon Moncrieff\'s Flat in Half-Moon Street, W.',
      'ACT II. The Garden at the Manor House, Woolton.',
      '',
      'FIRST ACT',
      '',
      'SCENE',
      '',
      'Morning-room in Algernon\'s flat in Half-Moon Street.',
    ]);
    expect(bookBody(text)?.heading).toBe('FIRST ACT');
  });

  it('does not mistake prose that begins with "Part of" for a contents entry', () => {
    const text = crlf(['CHAPTER I', '', 'Part of the crowd ran down to the river.', 'Part of it stayed.']);
    expect(bookBody(text)?.heading).toBe('CHAPTER I');
  });

  it('returns null when the text has no chapter or act heading', () => {
    expect(bookBody(crlf(['DE PROFUNDIS', '', 'Transcribed from the 1913 edition.', '', 'Suffering is one very long moment.']))).toBeNull();
  });
});
