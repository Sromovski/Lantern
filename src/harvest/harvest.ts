import { createHash } from 'node:crypto';
import type { HarvestConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { hasBookPick, insertHarvestedQuote, recordBookPick, upsertAuthorSubject } from '../db/quotes.js';
import { errorReason } from '../lib/http.js';
import type { Logger } from '../lib/log.js';
import { locateQuoteIn, prepareHaystack } from '../verify/normalize.js';
import type { QuoteEvidence } from '../verify/quote-gate.js';
import { listedEvidence, type ListedSection } from '../verify/wikiquote.js';
import { extractCandidates } from './candidates.js';
import { bookBody } from './front-matter.js';
import { GutenbergMarkerError, stripGutenbergWrapper } from './gutenberg-text.js';
import { harvestableBooks, plainTextUrl, type GutendexBook } from './gutendex.js';
import { PickerFailedError, pickPassages, type PickFailure, type PickFn } from './picker.js';
import { bookText, gutendexBooks, wikiquoteListedSections, wikiquotePageTitle, type Endpoints, type HttpGet } from './sources.js';

export interface HarvestOptions {
  db: Db;
  verticalId: number;
  harvest: HarvestConfig;
  get: HttpGet;
  endpoints: Endpoints;
  pick: PickFn;
  /** The picker's system prompt (prompts/literature/pick.md). */
  prompt: string;
  /** No new book is started once this many quotes have been inserted in the run. */
  limit: number;
  now?: () => Date;
  log?: Logger;
}

export type BookOutcome =
  | { status: 'already-picked' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  | {
      status: 'harvested';
      heading: string;
      skippedLines: number;
      candidates: number;
      batches: number;
      failures: PickFailure[];
      picked: number;
      inserted: number;
      duplicates: number;
      listed: number;
    };

export interface BookReport {
  gutenbergId: number;
  title: string;
  outcome: BookOutcome;
}

export interface AuthorReport {
  author: string;
  /** Why the author was skipped (their Wikiquote page, Gutendex results or subject row could not be used), or null. */
  error: string | null;
  listedEntries: number;
  books: BookReport[];
}

export interface HarvestReport {
  inserted: number;
  authors: AuthorReport[];
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Harvests quotes for a vertical's configured authors (spec section 7, `lantern harvest`).
 *
 * For each author, in config order:
 * 1. The author's subjects row is found or created, bound to their Wikidata id.
 * 2. Their Wikiquote page is read first. If it cannot be read, the author is skipped with an error:
 *    a quote is never inserted without the Misattributed and Disputed check (spec section 8).
 * 3. Gutendex results are filtered to the author's own public-domain prose (harvestableBooks).
 * 4. For each book not yet picked with this prompt and model: the text is fetched (only a
 *    primary-text url can be cited), the wrapper and front and end matter are cut, candidates are
 *    extracted, and the picker chooses among them. A book that cannot be used is skipped or marked
 *    failed and the run moves on; any other error (such as a rejected API key) stops the run.
 * 5. Each picked passage is inserted raw with primary-text evidence (the cited url, the matched
 *    excerpt and its character location) and listed-misattributed evidence for any Wikiquote match.
 *
 * The run stops starting new books once `limit` quotes have been inserted.
 */
export async function harvestVertical(options: HarvestOptions): Promise<HarvestReport> {
  const now = options.now ?? (() => new Date());
  const promptSha256 = sha256(options.prompt);
  const { picker } = options.harvest;
  const report: HarvestReport = { inserted: 0, authors: [] };

  for (const author of options.harvest.authors) {
    if (report.inserted >= options.limit) break;
    const authorReport: AuthorReport = { author: author.name, error: null, listedEntries: 0, books: [] };
    report.authors.push(authorReport);
    const wikiquotePage = wikiquotePageTitle(author);

    let subjectId: number;
    let sections: ListedSection[];
    let books: GutendexBook[];
    try {
      subjectId = upsertAuthorSubject(options.db, options.verticalId, author, now());
      sections = await wikiquoteListedSections(options.get, options.endpoints, wikiquotePage);
      authorReport.listedEntries = sections.reduce((count, section) => count + section.entries.length, 0);
      books = harvestableBooks(await gutendexBooks(options.get, options.endpoints, author), author);
    } catch (err) {
      authorReport.error = errorReason(err);
      options.log?.warn('harvest author skipped', { author: author.name, error: authorReport.error });
      continue;
    }

    for (const book of books) {
      if (report.inserted >= options.limit) break;
      const bookReport: BookReport = { gutenbergId: book.id, title: book.title, outcome: { status: 'already-picked' } };
      authorReport.books.push(bookReport);
      if (hasBookPick(options.db, options.verticalId, book.id, promptSha256, picker.model)) continue;

      const outcome = await harvestBook(options, { author: author.name, subjectId, wikiquotePage, sections, book, promptSha256 }, now);
      bookReport.outcome = outcome;
      if (outcome.status === 'harvested') report.inserted += outcome.inserted;
      options.log?.info('harvest book', { author: author.name, gutenbergId: book.id, title: book.title, outcome });
    }
  }
  return report;
}

interface BookContext {
  author: string;
  subjectId: number;
  wikiquotePage: string;
  sections: ListedSection[];
  book: GutendexBook;
  promptSha256: string;
}

async function harvestBook(options: HarvestOptions, context: BookContext, now: () => Date): Promise<BookOutcome> {
  const { book } = context;
  const { picker } = options.harvest;

  let text: Awaited<ReturnType<typeof bookText>>;
  try {
    text = await bookText(options.get, plainTextUrl(book)!);
  } catch (err) {
    return { status: 'failed', reason: errorReason(err) };
  }
  if (text.citedUrl === null) return { status: 'skipped', reason: 'the text url is not a primary-text url' };

  let stripped: string;
  try {
    stripped = stripGutenbergWrapper(text.text);
  } catch (err) {
    if (err instanceof GutenbergMarkerError) return { status: 'skipped', reason: err.message };
    throw err;
  }
  const body = bookBody(stripped);
  if (body === null) return { status: 'skipped', reason: 'no chapter or act heading with a body under it' };

  const candidates = extractCandidates(body.text);
  let picks: Awaited<ReturnType<typeof pickPassages>>;
  try {
    picks = await pickPassages(options.pick, options.prompt, context.author, book.title, candidates, {
      batchSize: picker.batch_size,
      maxBatches: picker.max_batches_per_work,
      picksPerBatch: picker.picks_per_batch,
    });
  } catch (err) {
    if (err instanceof PickerFailedError) return { status: 'failed', reason: err.message };
    throw err;
  }

  const haystack = prepareHaystack(body.text);
  let inserted = 0;
  let duplicates = 0;
  let listed = 0;
  for (const passage of picks.picked) {
    const located = locateQuoteIn(passage.text, haystack);
    if (located === null) continue;
    // The matcher's span stops at the last letter or digit; the verbatim excerpt keeps the closing punctuation.
    const end = located.end + /[^\p{L}\p{N}]*$/u.exec(passage.text)![0].length;
    const excerpt = body.text.slice(located.start, end);
    if (excerpt.replace(/\s+/g, ' ').trim() !== passage.text) continue;
    const listings = context.sections
      .map((section) => listedEvidence(passage.text, section))
      .filter((evidence): evidence is QuoteEvidence => evidence !== null);
    const evidence: QuoteEvidence[] = [
      {
        kind: 'primary-text',
        citation: `${context.author}, ${book.title} (Project Gutenberg #${book.id})`,
        url: text.citedUrl,
        excerpt,
        location: `characters ${body.offset + located.start}-${body.offset + end} after the Project Gutenberg header`,
        authorMatches: true,
      },
      ...listings,
    ];
    const result = insertHarvestedQuote(
      options.db,
      {
        verticalId: options.verticalId,
        subjectId: context.subjectId,
        body: passage.text,
        workTitle: book.title,
        evidence,
        wikiquotePage: context.wikiquotePage,
      },
      now(),
    );
    if (!result.inserted) duplicates++;
    else {
      inserted++;
      if (listings.length > 0) listed++;
    }
  }

  recordBookPick(
    options.db,
    {
      verticalId: options.verticalId,
      gutenbergId: book.id,
      promptSha256: context.promptSha256,
      model: picker.model,
      batches: picks.batches,
      failedBatches: picks.failedBatches,
      picked: picks.picked.length,
    },
    now(),
  );
  return {
    status: 'harvested',
    heading: body.heading,
    skippedLines: body.skippedLines,
    candidates: candidates.length,
    batches: picks.batches,
    failures: picks.failures,
    picked: picks.picked.length,
    inserted,
    duplicates,
    listed,
  };
}
