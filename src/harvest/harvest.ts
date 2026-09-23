import { createHash } from 'node:crypto';
import type { HarvestConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { hasBookPick, insertHarvestedQuote, recordBookPick, upsertAuthorSubject } from '../db/quotes.js';
import { errorReason } from '../lib/http.js';
import type { Logger } from '../lib/log.js';
import { locateQuoteIn, prepareHaystack } from '../verify/normalize.js';
import type { QuoteEvidence } from '../verify/quote-gate.js';
import { listedEvidence } from '../verify/wikiquote.js';
import { extractCandidates } from './candidates.js';
import { bookBody } from './front-matter.js';
import { GutenbergMarkerError, stripGutenbergWrapper } from './gutenberg-text.js';
import { harvestableBooks, plainTextUrl, type GutendexBook, type HarvestAuthor } from './gutendex.js';
import { PickerFailedError, pickPassages, type PickFailure, type PickFn } from './picker.js';
import {
  bookText,
  gutendexBooks,
  wikiquoteListedSections,
  wikiquotePageTitle,
  type Endpoints,
  type HttpGet,
  type WikiquoteCheck,
} from './sources.js';

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
      /** Passages this author's items already had. */
      duplicates: number;
      /** Inserted passages that a Wikiquote Misattributed or Disputed section lists. */
      listed: number;
      /** Passages another author's raw item already had: attribution-conflict evidence was added to it. */
      conflicts: number;
      /** Passages another author's already decided item has: nothing was written, and a human should look. */
      conflictsWithDecided: number;
    };

export interface BookReport {
  gutenbergId: number;
  title: string;
  outcome: BookOutcome;
}

export interface AuthorReport {
  author: string;
  /** Whether the author's subject, Wikiquote page and Gutendex books were read; false when never reached or skipped. */
  loaded: boolean;
  /** Why the author was skipped (their Wikiquote page, Gutendex results or subject row could not be used), or null. */
  error: string | null;
  listedEntries: number;
  books: BookReport[];
}

export interface HarvestReport {
  inserted: number;
  authors: AuthorReport[];
}

interface LoadedAuthor {
  subjectId: number;
  check: WikiquoteCheck;
  books: GutendexBook[];
  next: number;
}

interface AuthorState {
  author: HarvestAuthor;
  report: AuthorReport;
  done: boolean;
  loaded: LoadedAuthor | null;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Harvests quotes for a vertical's configured authors (spec section 7, `lantern harvest`).
 *
 * Authors take turns: each round gives every author still in play their next unpicked book, so the
 * backlog mixes subjects (spec section 12) instead of draining one author first. An author is read on
 * their first turn:
 * 1. Their subjects row is found or created, bound to their Wikidata id.
 * 2. Their Wikiquote page is read before anything else. If it cannot be read, the author is skipped
 *    with an error: a quote is never inserted without the Misattributed and Disputed check (spec
 *    section 8).
 * 3. Gutendex results are filtered to the author's own public-domain prose (harvestableBooks).
 *
 * For each book not yet picked with this prompt and model, the text is fetched (only a primary-text
 * url can be cited), the wrapper and front and end matter are cut, candidates are extracted, and the
 * picker chooses among them. A book that cannot be used is skipped or marked failed and the run moves
 * on; any other error (such as a rejected API key) stops the run. Each picked passage is inserted raw
 * with primary-text evidence (the cited url, the verbatim excerpt and its character location) and
 * listed-misattributed evidence for any Wikiquote match. A passage another author's item already has
 * is recorded as an attribution conflict instead.
 *
 * No new book is started once `limit` quotes have been inserted, so a run can exceed the limit by up
 * to one book's picks.
 */
export async function harvestVertical(options: HarvestOptions): Promise<HarvestReport> {
  const now = options.now ?? (() => new Date());
  const promptSha256 = sha256(options.prompt);
  const states: AuthorState[] = options.harvest.authors.map((author) => ({
    author,
    report: { author: author.name, loaded: false, error: null, listedEntries: 0, books: [] },
    done: false,
    loaded: null,
  }));
  const report: HarvestReport = { inserted: 0, authors: states.map((state) => state.report) };

  while (report.inserted < options.limit && states.some((state) => !state.done)) {
    for (const state of states) {
      if (report.inserted >= options.limit) break;
      if (state.done) continue;
      const loaded = state.loaded ?? (await loadAuthor(options, state, now));
      if (loaded === null) {
        state.done = true;
        continue;
      }
      const book = nextUnpickedBook(options, state, loaded, promptSha256);
      if (book === undefined) {
        state.done = true;
        continue;
      }
      const outcome = await harvestBook(options, { state, loaded, book, promptSha256 }, now);
      state.report.books.push({ gutenbergId: book.id, title: book.title, outcome });
      if (outcome.status === 'harvested') report.inserted += outcome.inserted;
      options.log?.info('harvest book', { author: state.author.name, gutenbergId: book.id, title: book.title, outcome });
    }
  }
  return report;
}

async function loadAuthor(options: HarvestOptions, state: AuthorState, now: () => Date): Promise<LoadedAuthor | null> {
  try {
    const subjectId = upsertAuthorSubject(options.db, options.verticalId, state.author, now());
    const check = await wikiquoteListedSections(options.get, options.endpoints, wikiquotePageTitle(state.author));
    const books = harvestableBooks(await gutendexBooks(options.get, options.endpoints, state.author), state.author);
    state.loaded = { subjectId, check, books, next: 0 };
    state.report.loaded = true;
    state.report.listedEntries = check.sections.reduce((count, section) => count + section.entries.length, 0);
    return state.loaded;
  } catch (err) {
    state.report.error = errorReason(err);
    options.log?.warn('harvest author skipped', { author: state.author.name, error: state.report.error });
    return null;
  }
}

/** The author's next book not yet picked with this prompt and model; books passed over are reported. */
function nextUnpickedBook(options: HarvestOptions, state: AuthorState, loaded: LoadedAuthor, promptSha256: string): GutendexBook | undefined {
  while (loaded.next < loaded.books.length) {
    const book = loaded.books[loaded.next++]!;
    if (!hasBookPick(options.db, options.verticalId, book.id, promptSha256, options.harvest.picker.model)) return book;
    state.report.books.push({ gutenbergId: book.id, title: book.title, outcome: { status: 'already-picked' } });
  }
  return undefined;
}

interface BookContext {
  state: AuthorState;
  loaded: LoadedAuthor;
  book: GutendexBook;
  promptSha256: string;
}

async function harvestBook(options: HarvestOptions, context: BookContext, now: () => Date): Promise<BookOutcome> {
  const { book, loaded } = context;
  const author = context.state.author.name;
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
    // Every batch for this book is tagged with it, so what the book cost to read can be reported.
    const pick: PickFn = (system, user) => options.pick(system, user, { stage: 'harvest', gutenbergId: book.id });
    picks = await pickPassages(pick, options.prompt, author, book.title, candidates, {
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
  let conflicts = 0;
  let conflictsWithDecided = 0;
  for (const passage of picks.picked) {
    const located = locateQuoteIn(passage.text, haystack);
    if (located === null) continue;
    // The matcher's span stops at the last letter or digit; the verbatim excerpt keeps the closing punctuation.
    const end = located.end + /[^\p{L}\p{N}]*$/u.exec(passage.text)![0].length;
    const excerpt = body.text.slice(located.start, end);
    if (excerpt.replace(/\s+/g, ' ').trim() !== passage.text) continue;
    const listings = loaded.check.sections
      .map((section) => listedEvidence(passage.text, section))
      .filter((evidence): evidence is QuoteEvidence => evidence !== null);
    const evidence: QuoteEvidence[] = [
      {
        kind: 'primary-text',
        citation: `${author}, ${book.title} (Project Gutenberg #${book.id})`,
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
        subjectId: loaded.subjectId,
        author,
        body: passage.text,
        workTitle: book.title,
        evidence,
        wikiquotePage: wikiquotePageTitle(context.state.author),
        wikiquoteCheckedAt: loaded.check.fetchedAt,
      },
      now(),
    );
    if (result.inserted) {
      inserted++;
      if (listings.length > 0) listed++;
    } else if (result.conflict === 'recorded') conflicts++;
    else if (result.conflict === 'decided') conflictsWithDecided++;
    else duplicates++;
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
    conflicts,
    conflictsWithDecided,
  };
}
