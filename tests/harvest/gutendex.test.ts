import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  gutendexPageSchema,
  harvestableBooks,
  plainTextUrl,
  PLAIN_TEXT_FORMAT,
  type GutendexBook,
  type HarvestAuthor,
} from '../../src/harvest/gutendex.js';

const DICKENS: HarvestAuthor = {
  name: 'Charles Dickens',
  gutendex_name: 'Dickens, Charles',
  wikidata_id: 'Q5686',
  birth_year: 1812,
  death_year: 1870,
};
const dickens = { name: 'Dickens, Charles', birth_year: 1812, death_year: 1870 };

/** A book shaped like a real Gutendex result (probed 2026-09-13), overridable per test. */
const book = (over: Partial<GutendexBook> = {}): GutendexBook => ({
  id: 98,
  title: 'A Tale of Two Cities',
  authors: [dickens],
  editors: [],
  translators: [],
  subjects: ['Historical fiction'],
  bookshelves: ['Best Books Ever Listings'],
  languages: ['en'],
  copyright: false,
  media_type: 'Text',
  formats: { [PLAIN_TEXT_FORMAT]: 'https://www.gutenberg.org/ebooks/98.txt.utf-8' },
  download_count: 1000,
  ...over,
});
const ids = (books: GutendexBook[]) => books.map((b) => b.id);

describe('gutendex', () => {
  it("parses a page, tolerating extra fields, and keeps the author's own text edition", () => {
    const page = gutendexPageSchema.parse({ count: 1, next: null, previous: null, results: [{ ...book(), summaries: ['extra'] }] });
    expect(ids(harvestableBooks(page.results, DICKENS))).toEqual([98]);
    expect(plainTextUrl(page.results[0]!)).toBe('https://www.gutenberg.org/ebooks/98.txt.utf-8');
  });

  it('drops a fuzzy match by another author', () => {
    const wilder = book({ id: 78024, authors: [{ name: 'Wilder, Thornton', birth_year: 1897, death_year: 1975 }] });
    expect(harvestableBooks([wilder], DICKENS)).toEqual([]);
  });

  it('drops an author with the same name but different years', () => {
    expect(harvestableBooks([book({ authors: [{ ...dickens, death_year: 1871 }] })], DICKENS)).toEqual([]);
  });

  it('drops Sound editions and books without a UTF-8 plain text', () => {
    const sound = book({ media_type: 'Sound' });
    const ascii = book({ id: 99, formats: { 'text/plain; charset=us-ascii': 'https://www.gutenberg.org/files/99/99.txt' } });
    expect(harvestableBooks([sound, ascii], DICKENS)).toEqual([]);
  });

  it('drops edited, translated, co-authored and not-public-domain books', () => {
    const collins = { name: 'Collins, Wilkie', birth_year: 1824, death_year: 1889 };
    const books = [
      book({ editors: [dickens] }),
      book({ id: 100, translators: [dickens] }),
      book({ id: 101, authors: [dickens, collins] }),
      book({ id: 102, copyright: true }),
      book({ id: 103, copyright: null }),
    ];
    expect(harvestableBooks(books, DICKENS)).toEqual([]);
  });

  it('drops compilations and poetry', () => {
    const books = [
      book({ id: 31100, title: 'The Complete Project Gutenberg Works of Charles Dickens' }),
      book({ id: 3200, title: 'The Entire Project Gutenberg Works of Charles Dickens' }),
      book({ id: 58329, title: 'Index of the Project Gutenberg Works of Charles Dickens' }),
      book({ id: 1057, title: 'Poems' }),
      book({ id: 1058, subjects: ['English poetry -- 19th century'] }),
    ];
    expect(harvestableBooks(books, DICKENS)).toEqual([]);
  });

  it('drops letters, speeches and other collections that may carry editor prose', () => {
    const books = [
      book({ id: 1, title: 'The Letters of Charles Dickens' }),
      book({ id: 2, title: 'Speeches: Literary and Social' }),
      book({ id: 3, title: 'The Correspondence of a Novelist' }),
      book({ id: 4, title: 'A Memoir of the Author' }),
      book({ id: 5, title: 'Great Expectations' }),
    ];
    expect(ids(harvestableBooks(books, DICKENS))).toEqual([5]);
  });

  it('keeps the lowest id among editions with the same title', () => {
    expect(ids(harvestableBooks([book({ id: 26740, title: 'A Tale of Two Cities!' }), book({ id: 98 })], DICKENS))).toEqual([98]);
  });

  it('rejects a malformed page', () => {
    expect(() => gutendexPageSchema.parse({ count: 1, next: null, previous: null })).toThrow(ZodError);
  });
});
