import { describe, it, expect } from 'vitest';
import { GutenbergMarkerError, hasGutenbergEndMarker, stripGutenbergWrapper } from '../../src/harvest/gutenberg-text.js';

const wrap = (inner: string, eol = '\n') =>
  [
    'The Project Gutenberg eBook of A Tale of Two Cities',
    'This eBook is for the use of anyone anywhere in the United States.',
    '*** START OF THE PROJECT GUTENBERG EBOOK A TALE OF TWO CITIES ***',
    inner,
    '*** END OF THE PROJECT GUTENBERG EBOOK A TALE OF TWO CITIES ***',
    'Section 1. General Terms of Use and Redistributing Project Gutenberg-tm electronic works',
  ].join(eol);

describe('stripGutenbergWrapper', () => {
  it('returns only the text between the START and END markers', () => {
    const body = stripGutenbergWrapper(wrap('It was the best of times, it was the worst of times.'));
    expect(body.trim()).toBe('It was the best of times, it was the worst of times.');
    expect(body).not.toContain('Project Gutenberg');
  });

  it('handles CRLF line endings and the older "THIS PROJECT" marker wording', () => {
    const crlf = wrap('A line of the book.', '\r\n').replace(/THE PROJECT/g, 'THIS PROJECT');
    expect(stripGutenbergWrapper(crlf).trim()).toBe('A line of the book.');
  });

  it('refuses a text with no END marker, such as a truncated download', () => {
    const truncated = wrap('Half a book.').split('*** END')[0]!;
    expect(hasGutenbergEndMarker(truncated)).toBe(false);
    expect(() => stripGutenbergWrapper(truncated)).toThrow(GutenbergMarkerError);
  });

  it('refuses a text with no START marker', () => {
    expect(() => stripGutenbergWrapper('Just some text.\n*** END OF THE PROJECT GUTENBERG EBOOK X ***\n')).toThrow(
      GutenbergMarkerError,
    );
  });

  it('reports a complete text as having its END marker', () => {
    expect(hasGutenbergEndMarker(wrap('Whole book.'))).toBe(true);
  });
});
