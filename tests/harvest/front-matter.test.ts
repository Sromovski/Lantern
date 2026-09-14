import { describe, it, expect } from 'vitest';
import { bookBody } from '../../src/harvest/front-matter.js';

const crlf = (lines: string[]) => lines.join('\r\n');

/** Five non-blank lines of chapter text, enough for a heading to count as the start of the body. */
const PROSE = [
  'It is a truth universally acknowledged, that a single man in possession',
  'of a good fortune must be in want of a wife.',
  '',
  'However little known the feelings or views of such a man may be on his',
  'first entering a neighbourhood, this truth is so well fixed in the minds',
  'of the surrounding families.',
];

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
      ...PROSE,
    ]);
    const body = bookBody(text);
    expect(body?.heading).toBe('Chapter I.]');
    expect(body?.skippedLines).toBe(7);
    expect(body?.text.startsWith('Chapter I.]\r\n')).toBe(true);
    expect(body?.text).not.toContain('Walt Whitman');
  });

  it('passes over a table of contents and keeps the rest of the text byte for byte', () => {
    const rest = ['CHAPTER I.', '', ...PROSE, ''];
    const text = crlf(['CONTENTS.', '', 'CHAPTER I.', 'Civilizing Huck.', 'CHAPTER II.', 'Our Gang.', '', 'NOTICE.', '', ...rest]);
    const body = bookBody(text);
    expect(body?.heading).toBe('CHAPTER I.');
    expect(body?.text).toBe(crlf(rest));
  });

  it('passes over a contents entry that wraps across several lines', () => {
    const text = crlf([
      'CONTENTS.',
      '',
      'CHAPTER I.',
      'In which our hero is born in a small village and grows up quickly amid',
      'many strange adventures involving his uncle and a mysterious trunk that',
      'nobody in the family will open.',
      'CHAPTER II.',
      'Our Gang.',
      '',
      'CHAPTER I.',
      '',
      ...PROSE,
    ]);
    expect(bookBody(text)?.skippedLines).toBe(9);
  });

  it('does not take a line of an introduction that starts with "Chapter I" for the heading', () => {
    const text = crlf([
      'INTRODUCTION.',
      '',
      'The novel was written quickly, and its opening was revised many times.',
      'Chapter I of the novel opens with a long description of the moors and',
      'the weather that follows the family home through the whole of that first',
      'winter, which the author had watched from her own window for many years,',
      'and which she describes again in the last pages of the book.',
      '',
      'CHAPTER I.',
      '',
      ...PROSE,
    ]);
    const body = bookBody(text);
    expect(body?.heading).toBe('CHAPTER I.');
    expect(body?.text).not.toContain('moors');
  });

  it('passes over a book heading that is followed straight away by its first chapter', () => {
    const text = crlf(['Book the First--Recalled to Life', '', '', 'CHAPTER I.', 'The Period', '', ...PROSE]);
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
      'The room is luxuriously and artistically furnished.',
      'The sound of a piano is heard in the adjoining room.',
      'Lane is arranging afternoon tea on the table.',
    ]);
    expect(bookBody(text)?.heading).toBe('FIRST ACT');
  });

  it('accepts stave and numbered chapter headings, and prose that begins with "Part of"', () => {
    expect(bookBody(crlf(['STAVE I: MARLEY\'S GHOST', '', ...PROSE]))?.heading).toBe('STAVE I: MARLEY\'S GHOST');
    expect(bookBody(crlf(['CHAPTER 1', '', ...PROSE]))?.heading).toBe('CHAPTER 1');
    expect(bookBody(crlf(['CHAPTER I', '', 'Part of the crowd ran down to the river.', ...PROSE]))?.heading).toBe('CHAPTER I');
  });

  it('returns null when no chapter or act heading has a body under it', () => {
    expect(bookBody(crlf(['DE PROFUNDIS', '', 'Transcribed from the 1913 edition.', '', ...PROSE]))).toBeNull();
    expect(bookBody(crlf(['CONTENTS', '', 'CHAPTER I.', 'The Period', 'CHAPTER II.', 'The Mail']))).toBeNull();
  });
});
