import { z } from 'zod';
import type { HarvestConfig } from '../config/schema.js';

const personSchema = z.object({
  name: z.string(),
  birth_year: z.number().int().nullable(),
  death_year: z.number().int().nullable(),
});

export const gutendexBookSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  authors: z.array(personSchema),
  editors: z.array(personSchema),
  translators: z.array(personSchema),
  subjects: z.array(z.string()),
  bookshelves: z.array(z.string()),
  languages: z.array(z.string()),
  copyright: z.boolean().nullable(),
  media_type: z.string(),
  formats: z.record(z.string(), z.string()),
  download_count: z.number().int().nonnegative(),
});

/** One page of `GET https://gutendex.com/books/?search=...`; `next` is the following page's url. */
export const gutendexPageSchema = z.object({
  count: z.number().int().nonnegative(),
  next: z.string().nullable(),
  previous: z.string().nullable(),
  results: z.array(gutendexBookSchema),
});

export type GutendexBook = z.infer<typeof gutendexBookSchema>;
export type HarvestAuthor = HarvestConfig['authors'][number];

export const PLAIN_TEXT_FORMAT = 'text/plain; charset=utf-8';

const COMPILATION = /\b(?:complete|collected|entire)\b.*\bworks\b|\bworks of\b|\bindex of\b/i;
const POETRY = /\bpoe(?:try|ms)\b/i;
const titleKey = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function plainTextUrl(book: GutendexBook): string | null {
  return book.formats[PLAIN_TEXT_FORMAT] ?? null;
}

/**
 * A book is harvestable only when it is plainly the configured author's own public-domain prose.
 * Every condition below must hold:
 * - exactly one author, whose Gutendex name and birth and death years all match the config
 *   (the spec section 2.1 author cross-check that sets authorMatches)
 * - a Text edition with a UTF-8 plain text
 * - no editors or translators
 * - not under copyright
 * - in English
 * - not a compilation
 * - not poetry, which needs a line-based picker
 */
export function isHarvestable(book: GutendexBook, author: HarvestAuthor): boolean {
  const [only] = book.authors;
  return (
    book.authors.length === 1 &&
    only !== undefined &&
    only.name === author.gutendex_name &&
    only.birth_year === author.birth_year &&
    only.death_year === author.death_year &&
    book.media_type === 'Text' &&
    book.editors.length === 0 &&
    book.translators.length === 0 &&
    book.copyright === false &&
    book.languages.includes('en') &&
    plainTextUrl(book) !== null &&
    !COMPILATION.test(book.title) &&
    !POETRY.test(book.title) &&
    ![...book.subjects, ...book.bookshelves].some((s) => POETRY.test(s))
  );
}

/** Harvestable books in id order, keeping the lowest id when editions share a title. */
export function harvestableBooks(books: readonly GutendexBook[], author: HarvestAuthor): GutendexBook[] {
  const seen = new Set<string>();
  const out: GutendexBook[] = [];
  for (const book of [...books].sort((a, b) => a.id - b.id)) {
    if (!isHarvestable(book, author)) continue;
    const key = titleKey(book.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(book);
  }
  return out;
}
