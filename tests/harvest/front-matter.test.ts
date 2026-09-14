import { describe, it, expect } from 'vitest';
import { bookBody } from '../../src/harvest/front-matter.js';

const crlf = (lines: string[]) => lines.join('\r\n');

/** Twenty non-blank lines of chapter text, enough for a heading to count as the start of the body. */
const PROSE = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} of the first chapter, which runs on as ordinary prose for a while.`);

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

  it('passes over a table of contents and keeps the rest of the text byte for byte, with its offset', () => {
    const front = ['CONTENTS.', '', 'CHAPTER I.', 'Civilizing Huck.', 'CHAPTER II.', 'Our Gang.', '', 'NOTICE.', ''];
    const rest = ['CHAPTER I.', '', ...PROSE, ''];
    const text = crlf([...front, ...rest]);
    const body = bookBody(text);
    expect(body?.heading).toBe('CHAPTER I.');
    expect(body?.text).toBe(crlf(rest));
    expect(body?.offset).toBe(text.indexOf(crlf(rest)));
  });

  it('passes over contents entries whose descriptions wrap across several lines', () => {
    const wrapped = crlf([
      'CONTENTS.',
      '',
      'CHAPTER I.',
      'In which our hero is born in a small village and grows up quickly amid',
      'many strange adventures involving his uncle and a mysterious trunk that',
      'nobody in the family will open, though they talk of it every winter',
      'evening, and of the letters it is said to hold, and of the man who',
      'brought it to the door one night and never came back for it.',
      'CHAPTER II.',
      'Our Gang.',
      '',
      'CHAPTER I.',
      '',
      ...PROSE,
    ]);
    expect(bookBody(wrapped)?.skippedLines).toBe(11);
    const separated = crlf(['CONTENTS', '', 'CHAPTER I.', 'A wrapped description,', 'which runs on,', 'and on.', '', 'CHAPTER II.', 'The next one.', '', 'CHAPTER I.', '', ...PROSE]);
    expect(bookBody(separated)?.skippedLines).toBe(10);
  });

  it('passes over a list of illustrations placed between contents entries', () => {
    const text = crlf(['CONTENTS', '', 'CHAPTER I.', '', 'ILLUSTRATIONS', 'Plate one', 'Plate two', 'Plate three', 'Plate four', 'Plate five', '', 'CHAPTER II.', '', 'CHAPTER I.', '', ...PROSE]);
    expect(bookBody(text)?.skippedLines).toBe(13);
  });

  it('does not take a line of an introduction that starts with "Chapter I" for the heading', () => {
    const lowercase = crlf([
      'INTRODUCTION.',
      '',
      'The novel was written quickly, and its opening was revised many times.',
      'Chapter I of the novel opens with a long description of the moors and',
      'the weather that follows the family home through the whole of that first winter.',
      '',
      'CHAPTER I.',
      '',
      ...PROSE,
    ]);
    expect(bookBody(lowercase)?.heading).toBe('CHAPTER I.');
    const capitalized = crlf([
      'INTRODUCTION.',
      '',
      'The novel was written quickly, and its opening was revised often.',
      'Chapter I. Revised many times, as her letters plainly show it.',
      ...PROSE.slice(0, 6),
      '',
      'CHAPTER I.',
      '',
      ...PROSE,
    ]);
    const body = bookBody(capitalized);
    expect(body?.heading).toBe('CHAPTER I.');
    expect(body?.text).not.toContain('Revised many times');
  });

  it('prefers the first chapter heading to a part heading inside an introduction', () => {
    const text = crlf(['INTRODUCTION', '', 'PART I', '', ...PROSE, '', 'CHAPTER I.', '', ...PROSE]);
    const body = bookBody(text);
    expect(body?.heading).toBe('CHAPTER I.');
    expect(bookBody(crlf(['PART I', '', ...PROSE]))?.heading).toBe('PART I');
  });

  it('stops the text at notes, an appendix or an index after the last chapter', () => {
    const chapter = ['CHAPTER I.', '', ...PROSE, '', 'THE END', ''];
    for (const label of ['Transcriber\'s Notes:', 'TRANSCRIBER\'S NOTE', 'FOOTNOTES:', 'APPENDIX BY THE EDITOR', 'INDEX']) {
      const text = crlf([...chapter, label, '', 'The following changes were made to the text in order to correct obvious printing errors.']);
      expect(bookBody(text)?.text).toBe(text.slice(0, text.indexOf(label)));
    }
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
      ...PROSE,
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
    expect(bookBody(crlf(['CHAPTER I.', '', ...PROSE.slice(0, 19), '', 'CHAPTER II.', '']))).toBeNull();
  });
});
