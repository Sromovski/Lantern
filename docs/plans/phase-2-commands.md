# Phase 2 Harvest and Verify Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the offline pieces into the two pipeline stages that turn public-domain books into decided quotes:

- **`lantern harvest --vertical literature [--limit 25] [--refresh]`** runs per author, in this order:
  1. Bind the author to a subject row by Wikidata id.
  2. Read their Wikiquote Misattributed and Disputed lists first.
  3. Fetch their Gutendex books.
  4. For each book not yet picked, fetch and cache the text, cut it to the author's body, extract candidates, let the picker choose, and insert raw quotes. Each quote carries its primary-text evidence, any Wikiquote listing, and a recorded Wikiquote check.
- **`lantern verify --vertical literature [--retry-insufficient]`** decides every raw quote that has a recorded check, from evidence that loads cleanly.

**User decisions this plan implements (2026-09-13):**

- The quote body is the verbatim source passage, with whitespace tidied only.
- The picker is `claude-sonnet-5`.
- The first authors are Dickens, Austen, Twain and Wilde.
- `LANTERN_CONTACT` is the repo URL.

The user migrated the real database to 005 on 2026-09-15. This plan adds 006, which the user applies with `lantern migrate` before the first harvest.

**Architecture:**

- `migrations/006_harvest_state.sql` adds `quote_checks` (one Wikiquote check per quote) and `book_picks` (a book already judged with this prompt and model).
- `src/db/quotes.ts` writes the rows:
  - The author subject is bound by Wikidata id.
  - A quote, its evidence and its check are inserted in one transaction.
  - A repeated `body_hash` inserts nothing.
- `src/harvest/sources.ts` holds the cached network reads, built on `cachedFetch` and `fetchWithRetry`: Gutendex pages, a Gutenberg text, and a whole Wikiquote page.
- `src/harvest/harvest.ts` orchestrates one run and returns a per-author, per-book report.
- `src/verify/run.ts` decides a vertical's raw quotes through `verifyQuoteItem`.
- `src/cli.ts` wires both stages through `runStage`, with explicit HTTP and Anthropic timeouts and startup checks that run before any fetch.

**Tech Stack:** Node 26, TypeScript 7 (strict, nodenext), vitest 5, better-sqlite3 13, zod 4, commander 15, `@anthropic-ai/sdk` 0.125.0. No new dependencies.

**Spec:** `claude.md`. The relevant sections are:

- §2.1, §2.6: never publish an unverified quote; fail closed.
- §4: the CLI locates its root; `.env`; logging.
- §6: data model.
- §7: `lantern harvest` and `lantern verify` are separate, idempotent stages with state in SQLite; every stage writes `run_log`.
- §8: tier 1 evidence; the Wikiquote Misattributed/Disputed hard reject.
- §15: prefer real integration over mocks; tests are fast and offline.

The parent plan is `plan.md` Part C, milestones 2.1 and 2.3. This plan carries these prerequisites from the earlier final reviews:

- **P2:** evidence uniqueness.
- **P3:** book, author and subject bound in one path; Wikiquote before verify; `EvidenceError` leaves the quote raw; per-author failures.
- **P4 (from the picker final review):**
  - explicit client timeouts
  - re-runs that spend nothing
  - locate the quote in the body and store the offset
  - per-book reports

**Evidence gathered before this plan (2026-09-15; details in `.superpowers/sdd/phase-2-commands/design-notes.md`):**

- **Every code block ran first.** Each block in this plan ran in a scratch worktree of `bcc744f`: 473/473 tests across 30 files, typecheck exit 0, full suite run twice.
- **The excerpt rule was checked against real text.** It ran over all 8923 candidates of seven real Project Gutenberg texts (#98, #1342, #158, #76, #74, #174, #844).
  - The rule: the matcher's span, extended by the passage's trailing punctuation, must tidy back to the passage.
  - Every candidate was located.
  - Every excerpt that tidied back passed the quote gate as tier 1.
  - 3 picks (0.03%) would be skipped, because the first match was an earlier near-duplicate line. That fails closed.
- **Recorded response shapes:**
  - **Gutendex search pages** carry `next` links on `gutendex.com`, 32 results per page. A surname search runs to about 2-8 pages, and one request took about 90 s.
  - **The plain-text format url** is `https://www.gutenberg.org/ebooks/<id>.txt.utf-8`. It redirects to `.../cache/epub/<id>/pg<id>.txt`, and both pass the tier 1 policy.
  - **Wikiquote whole-page wikitext** (`action=parse&prop=wikitext&formatversion=2`) gives the same Misattributed/Disputed entries as the per-section responses (Mark Twain 2+33, Jane Austen 1).

**Deliberately NOT in this plan:**

- A live harvest. That is the user's first run, after `lantern migrate`.
- Enrichment (2.4), images (2.5), composition (2.6) and captions (2.7).
- Doctor checks on harvest health.
- The parked minors:
  - a level-3 sub-heading under a listed section is still treated as listed
  - a bare uppercase `NOTES` line inside a novel cuts the body
  - Wikiquote heading variants

## Global Constraints

- **Language and modules:** Node.js + TypeScript, ESM, strict mode on. Relative imports use `.js` extensions.
- **Unicode:**
  - Every non-ASCII character in code and tests must be a `\u` escape. Verify with `git diff | grep '^+' | grep -P '[^\x00-\x7F]'` on `.ts` files; it must print nothing.
  - SQL and prompt files stay ASCII.
  - Existing characters in `claude.md` and `plan.md` must not be re-encoded.
- **Line endings:** count CR bytes with `tr -cd '\r' < FILE | wc -c`. Never use `grep $'\r'`, which misreports in this shell.
- **Fail closed:**
  - A quote is never inserted without the Wikiquote check.
  - A quote without a recorded check, or with malformed evidence, stays raw.
  - A book that cannot be read, cut or cited is skipped or marked failed.
  - Any error other than those stops the run.
- **No real internet in tests:** use `node:http` servers on `127.0.0.1:0`. Tests may use a `fetchImpl` that routes a real host's url to that local server. They never use a real API key, never make a real Anthropic call, and never write under the real `data/` or `logs/`. CLI tests that reach `harvest` set `ANTHROPIC_API_KEY` to the empty string, so the command stops before any fetch.
- **Frozen migrations:** migrations 001-005 are frozen and applied to the user's real database. Never edit them. New schema goes in `migrations/006_harvest_state.sql`.
- **Never commit** `.env`, `data/`, `logs/`, or `.superpowers/`.
- **Commit trailers:** every commit message ends with a blank line, then `Co-Authored-By: <the authoring model's attribution line from its environment>` and `Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v`. Verify with `git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'`, which must print `2`.
- **Branch:** `phase-2-commands`, created from `phase-2-picker` at bcc744f. The baseline is 447 tests passing across 26 files. The controller pushes after the final review; implementers never push.

### File map

```
migrations/006_harvest_state.sql        # M1: quote_checks, book_picks (new)
src/db/quotes.ts                        # M1: upsertAuthorSubject, insertHarvestedQuote, hasWikiquoteCheck, hasBookPick, recordBookPick (new)
tests/db/quotes.test.ts                 # M1 (new)
src/harvest/sources.ts                  # M2: createHttpGet, gutendexBooks, bookText, wikiquoteListedSections (new)
tests/harvest/sources.test.ts           # M2 (new)
src/verify/run.ts                       # M3: verifyVertical (new)
tests/verify/run.test.ts                # M3 (new)
src/harvest/harvest.ts                  # M4: harvestVertical (new)
tests/harvest/harvest.test.ts           # M4 (new)
src/cli.ts                              # M5: harvest and verify commands
tests/cli.test.ts                       # M5: env override in the helper, 4 tests
claude.md                               # M6: sections 6 and 7
plan.md                                 # M6: status line
```

### Test counts

| After | Suite | Files |
|---|---|---|
| baseline | 447 | 26 |
| M1 | 453 | 27 |
| M2 | 459 | 28 |
| M3 | 463 | 29 |
| M4 | 469 | 30 |
| M5 | 473 | 30 |
| M6 | 473 | 30 |

---

### Task M1: Harvest state tables and row writers

**Files:**
- Create: `migrations/006_harvest_state.sql`, `src/db/quotes.ts`
- Test: `tests/db/quotes.test.ts` (new)

**Interfaces:**
- **Consumes:**
  - `insertEvidence` from `src/db/evidence.ts`
  - `bodyHash` from `src/verify/normalize.ts`
  - `type QuoteEvidence` from `src/verify/quote-gate.ts`
  - `type HarvestAuthor` from `src/harvest/gutendex.ts`
- **Produces:**
  - `export class SubjectConflictError extends Error`
  - `export function authorSlug(name: string): string`
  - `export function upsertAuthorSubject(db: Db, verticalId: number, author: HarvestAuthor, now?: Date): number`
  - `export interface HarvestedQuote { verticalId: number; subjectId: number; body: string; workTitle: string; evidence: QuoteEvidence[]; wikiquotePage: string }`
  - `export interface InsertedQuote { itemId: number; inserted: boolean }`
  - `export function insertHarvestedQuote(db: Db, quote: HarvestedQuote, now?: Date): InsertedQuote`
  - `export function hasWikiquoteCheck(db: Db, itemId: number): boolean`
  - `export interface BookPick { verticalId: number; gutenbergId: number; promptSha256: string; model: string; batches: number; failedBatches: number; picked: number }`
  - `export function hasBookPick(db: Db, verticalId: number, gutenbergId: number, promptSha256: string, model: string): boolean`
  - `export function recordBookPick(db: Db, pick: BookPick, now?: Date): void`
- **Used by:** M3 uses `hasWikiquoteCheck`; M4 uses the rest.

**Why:**

- **Spec §7 keeps state between stages in SQLite.** Two facts must survive between `harvest` and `verify`:
  - **The Wikiquote check.** Verify must refuse a quote that was never checked; otherwise a quote inserted by any other path would verify without the §8 hard-reject check.
  - **A book already picked.** A re-run must spend nothing on it, since picks are deterministic and cost about 42k input tokens per book.
- **Subjects bind by Wikidata id.** An existing subject with the same slug but a different `wikidata_id` is refused, so a book's quotes can never attach to another author of the same name.
- **One transaction per quote.** The quote, its evidence and its check are written together. A `body_hash` already in the vertical inserts nothing, so a re-run never duplicates evidence (prerequisite P2).
- **No trigger changes.** Migration 006 adds no triggers, so doctor's `db.triggers` stays at 13.

- [ ] **Step 1: Write the failing tests**

Create `tests/db/quotes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadEvidence } from '../../src/db/evidence.js';
import {
  authorSlug,
  hasBookPick,
  hasWikiquoteCheck,
  insertHarvestedQuote,
  recordBookPick,
  SubjectConflictError,
  upsertAuthorSubject,
  type HarvestedQuote,
} from '../../src/db/quotes.js';
import type { HarvestAuthor } from '../../src/harvest/gutendex.js';
import { seedItem, testDb } from '../helpers/db.js';

const NOW = new Date('2026-09-15T00:00:00.000Z');
const DICKENS: HarvestAuthor = {
  name: 'Charles Dickens',
  gutendex_name: 'Dickens, Charles',
  wikidata_id: 'Q5686',
  birth_year: 1812,
  death_year: 1870,
};
const BODY = 'A wonderful fact to reflect upon, that every human creature is constituted to be that profound secret and mystery to every other.';

function setup() {
  const db = testDb();
  const verticalId = Number(
    db.prepare("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'Literature', 'config/verticals/literature.yaml')").run()
      .lastInsertRowid,
  );
  const subjectId = upsertAuthorSubject(db, verticalId, DICKENS, NOW);
  const quote: HarvestedQuote = {
    verticalId,
    subjectId,
    body: BODY,
    workTitle: 'A Tale of Two Cities',
    evidence: [
      {
        kind: 'primary-text',
        citation: 'Charles Dickens, A Tale of Two Cities (Project Gutenberg #98)',
        url: 'https://www.gutenberg.org/cache/epub/98/pg98.txt',
        excerpt: BODY,
        location: 'characters 120450-120580',
        authorMatches: true,
      },
    ],
    wikiquotePage: 'Charles Dickens',
  };
  return { db, verticalId, subjectId, quote };
}

describe('harvest rows', () => {
  it('creates an author subject once, bound to its Wikidata id', () => {
    const { db, verticalId, subjectId } = setup();
    expect(upsertAuthorSubject(db, verticalId, DICKENS, NOW)).toBe(subjectId);
    expect(db.prepare('SELECT kind, name, slug, wikidata_id, meta_json FROM subjects WHERE id = ?').get(subjectId)).toEqual({
      kind: 'author',
      name: 'Charles Dickens',
      slug: 'charles-dickens',
      wikidata_id: 'Q5686',
      meta_json: '{"gutendex_name":"Dickens, Charles","birth_year":1812,"death_year":1870}',
    });
    expect(authorSlug('\u00C9mile Zola')).toBe('emile-zola');
  });

  it('refuses an existing subject of the same name with a different Wikidata id', () => {
    const { db, verticalId } = setup();
    expect(() => upsertAuthorSubject(db, verticalId, { ...DICKENS, wikidata_id: 'Q99999' }, NOW)).toThrow(SubjectConflictError);
  });

  it('inserts a raw quote with its evidence and its Wikiquote check in one step', () => {
    const { db, quote } = setup();
    const { itemId, inserted } = insertHarvestedQuote(db, quote, NOW);
    expect(inserted).toBe(true);
    expect(db.prepare('SELECT kind, body, work_title, status, subject_id FROM items WHERE id = ?').get(itemId)).toEqual({
      kind: 'quote',
      body: BODY,
      work_title: 'A Tale of Two Cities',
      status: 'raw',
      subject_id: quote.subjectId,
    });
    expect(loadEvidence(db, itemId)).toEqual(quote.evidence);
    expect(hasWikiquoteCheck(db, itemId)).toBe(true);
  });

  it('leaves an existing item alone when the same passage is harvested again', () => {
    const { db, quote } = setup();
    const first = insertHarvestedQuote(db, quote, NOW);
    const again = insertHarvestedQuote(db, { ...quote, body: BODY.toUpperCase(), workTitle: 'Another edition' }, NOW);
    expect(again).toEqual({ itemId: first.itemId, inserted: false });
    expect(db.prepare('SELECT COUNT(*) FROM item_evidence WHERE item_id = ?').pluck().get(first.itemId)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM quote_checks WHERE item_id = ?').pluck().get(first.itemId)).toBe(1);
  });

  it('reports no Wikiquote check for an item inserted another way, and refuses unknown check names', () => {
    const { db } = setup();
    const { itemId } = seedItem(db, 'Some other passage that was inserted without a check, for this test only.');
    expect(hasWikiquoteCheck(db, itemId)).toBe(false);
    expect(() =>
      db.prepare("INSERT INTO quote_checks (item_id, check_name, page, checked_at) VALUES (?, 'goodreads', 'x', ?)").run(itemId, NOW.toISOString()),
    ).toThrow(/CHECK constraint/);
  });

  it('remembers that a book was picked with a given prompt and model', () => {
    const { db, verticalId } = setup();
    const pick = { verticalId, gutenbergId: 98, promptSha256: 'a'.repeat(64), model: 'claude-sonnet-5', batches: 6, failedBatches: 1, picked: 12 };
    expect(hasBookPick(db, verticalId, 98, pick.promptSha256, pick.model)).toBe(false);
    recordBookPick(db, pick, NOW);
    recordBookPick(db, { ...pick, picked: 14 }, NOW);
    expect(hasBookPick(db, verticalId, 98, pick.promptSha256, pick.model)).toBe(true);
    expect(hasBookPick(db, verticalId, 98, pick.promptSha256, 'claude-opus-5')).toBe(false);
    expect(hasBookPick(db, verticalId, 98, 'b'.repeat(64), pick.model)).toBe(false);
    expect(db.prepare('SELECT picked FROM book_picks').pluck().all()).toEqual([14]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/quotes.test.ts`

Expected: FAIL, because the module `../../src/db/quotes.js` cannot be found. Record the output.

- [ ] **Step 3: Implement**

Create `migrations/006_harvest_state.sql` (ASCII only):

```sql
-- Harvest state that the verify stage and later harvest runs depend on
-- (spec section 7: state lives in SQLite between stages).

-- The Wikiquote Misattributed/Disputed check made for a quote item before it was inserted.
-- verify refuses a raw quote that has no such row (spec section 8).
CREATE TABLE quote_checks (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  check_name  TEXT NOT NULL CHECK (check_name IN ('wikiquote')),
  page        TEXT NOT NULL CHECK (length(trim(page)) > 0),
  checked_at  TEXT NOT NULL,
  UNIQUE(item_id, check_name)
);

-- A book whose candidates the picker has already judged with this prompt and model,
-- so a later harvest run spends nothing on it.
CREATE TABLE book_picks (
  id              INTEGER PRIMARY KEY,
  vertical_id     INTEGER NOT NULL REFERENCES verticals(id),
  gutenberg_id    INTEGER NOT NULL,
  prompt_sha256   TEXT NOT NULL,
  model           TEXT NOT NULL,
  batches         INTEGER NOT NULL,
  failed_batches  INTEGER NOT NULL,
  picked          INTEGER NOT NULL,
  picked_at       TEXT NOT NULL,
  UNIQUE(vertical_id, gutenberg_id, prompt_sha256, model)
);
```

Create `src/db/quotes.ts`:

```ts
import type { HarvestAuthor } from '../harvest/gutendex.js';
import { bodyHash } from '../verify/normalize.js';
import type { QuoteEvidence } from '../verify/quote-gate.js';
import type { Db } from './connection.js';
import { insertEvidence } from './evidence.js';

/** An existing subjects row with the author's slug names a different Wikidata entity. */
export class SubjectConflictError extends Error {
  override name = 'SubjectConflictError';
}

export function authorSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The author's subjects row, created on first use. An existing row with the same slug must carry the
 * same wikidata_id, so harvested quotes can never attach to a different author of the same name.
 */
export function upsertAuthorSubject(db: Db, verticalId: number, author: HarvestAuthor, now: Date = new Date()): number {
  const slug = authorSlug(author.name);
  const existing = db.prepare('SELECT id, wikidata_id FROM subjects WHERE vertical_id = ? AND slug = ?').get(verticalId, slug) as
    | { id: number; wikidata_id: string | null }
    | undefined;
  if (existing !== undefined) {
    if (existing.wikidata_id !== author.wikidata_id) {
      throw new SubjectConflictError(`subject ${slug} is ${existing.wikidata_id ?? 'unset'}, not ${author.wikidata_id}`);
    }
    return existing.id;
  }
  const meta = JSON.stringify({ gutendex_name: author.gutendex_name, birth_year: author.birth_year, death_year: author.death_year });
  return Number(
    db
      .prepare(
        "INSERT INTO subjects (vertical_id, kind, name, slug, wikidata_id, meta_json, created_at) VALUES (?, 'author', ?, ?, ?, ?, ?)",
      )
      .run(verticalId, author.name, slug, author.wikidata_id, meta, now.toISOString()).lastInsertRowid,
  );
}

export interface HarvestedQuote {
  verticalId: number;
  subjectId: number;
  /** The verbatim passage, whitespace tidied only (user decision 2026-09-13). */
  body: string;
  workTitle: string;
  evidence: QuoteEvidence[];
  /** The Wikiquote page whose Misattributed and Disputed sections were checked for this quote. */
  wikiquotePage: string;
}

export interface InsertedQuote {
  itemId: number;
  inserted: boolean;
}

/**
 * Inserts a raw quote, its evidence and its Wikiquote check in one transaction. A body whose
 * normalized hash already exists in the vertical (spec section 7 dedupe) is left as it is: the
 * existing item gets no further evidence or checks, so re-running harvest never duplicates rows.
 */
export function insertHarvestedQuote(db: Db, quote: HarvestedQuote, now: Date = new Date()): InsertedQuote {
  return db.transaction((): InsertedQuote => {
    const hash = bodyHash(quote.body);
    const result = db
      .prepare(
        "INSERT OR IGNORE INTO items (vertical_id, subject_id, kind, body, body_hash, work_title, status, created_at) VALUES (?, ?, 'quote', ?, ?, ?, 'raw', ?)",
      )
      .run(quote.verticalId, quote.subjectId, quote.body, hash, quote.workTitle, now.toISOString());
    if (result.changes === 0) {
      const itemId = db.prepare('SELECT id FROM items WHERE vertical_id = ? AND body_hash = ?').pluck().get(quote.verticalId, hash) as number;
      return { itemId, inserted: false };
    }
    const itemId = Number(result.lastInsertRowid);
    for (const evidence of quote.evidence) insertEvidence(db, itemId, evidence, now);
    db.prepare("INSERT INTO quote_checks (item_id, check_name, page, checked_at) VALUES (?, 'wikiquote', ?, ?)").run(
      itemId,
      quote.wikiquotePage,
      now.toISOString(),
    );
    return { itemId, inserted: true };
  })();
}

export function hasWikiquoteCheck(db: Db, itemId: number): boolean {
  return db.prepare("SELECT 1 FROM quote_checks WHERE item_id = ? AND check_name = 'wikiquote'").get(itemId) !== undefined;
}

export interface BookPick {
  verticalId: number;
  gutenbergId: number;
  promptSha256: string;
  model: string;
  batches: number;
  failedBatches: number;
  picked: number;
}

export function hasBookPick(db: Db, verticalId: number, gutenbergId: number, promptSha256: string, model: string): boolean {
  return (
    db
      .prepare('SELECT 1 FROM book_picks WHERE vertical_id = ? AND gutenberg_id = ? AND prompt_sha256 = ? AND model = ?')
      .get(verticalId, gutenbergId, promptSha256, model) !== undefined
  );
}

/** Records that the picker judged a book with this prompt and model. A repeat updates the counts. */
export function recordBookPick(db: Db, pick: BookPick, now: Date = new Date()): void {
  db.prepare(
    `INSERT INTO book_picks (vertical_id, gutenberg_id, prompt_sha256, model, batches, failed_batches, picked, picked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vertical_id, gutenberg_id, prompt_sha256, model)
     DO UPDATE SET batches = excluded.batches, failed_batches = excluded.failed_batches, picked = excluded.picked, picked_at = excluded.picked_at`,
  ).run(pick.verticalId, pick.gutenbergId, pick.promptSha256, pick.model, pick.batches, pick.failedBatches, pick.picked, now.toISOString());
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/db tests/doctor`, then `npm test` and `npm run typecheck`.

Expected:
- `quotes.test.ts` shows 6 passed.
- The doctor tests still report a healthy system: 13 triggers, no drift.
- The suite reports 453 tests across 27 files.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add migrations/006_harvest_state.sql src/db/quotes.ts tests/db/quotes.test.ts
git commit -m "feat(db): harvest state tables and row writers for quotes, Wikiquote checks and book picks

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task M2: Cached harvest sources

**Files:**
- Create: `src/harvest/sources.ts`
- Test: `tests/harvest/sources.test.ts` (new)

**Interfaces:**
- **Consumes:**
  - `cachedFetch` and `type CachedResult` from `src/lib/cache.ts`
  - `fetchWithRetry`, `type HttpOptions` and `type HttpResult` from `src/lib/http.ts`
  - `assertSourceAllowed` and `SourcePolicyError` from `src/verify/source-policy.ts`
  - `listedSections` and `type ListedSection` from `src/verify/wikiquote.ts`
  - `stripGutenbergWrapper` from `src/harvest/gutenberg-text.ts`
  - `gutendexPageSchema`, `type GutendexBook` and `type HarvestAuthor` from `src/harvest/gutendex.ts`
- **Produces:**
  - `export type HttpGet = (url: string, source: string, cacheable?: (result: HttpResult) => boolean) => Promise<CachedResult>`
  - `export interface HttpGetOptions { cacheDir: string; http: HttpOptions; refresh?: boolean; now?: () => Date; secretValues?: readonly string[] }`
  - `export function createHttpGet(options: HttpGetOptions): HttpGet`
  - `export class SourceStatusError extends Error`
  - `export interface Endpoints { gutendex: string; wikiquote: string }`
  - `export const DEFAULT_ENDPOINTS: Endpoints`
  - `export const MAX_GUTENDEX_PAGES = 10`
  - `export function gutendexSearchUrl(endpoints: Endpoints, author: HarvestAuthor): string`
  - `export async function gutendexBooks(get: HttpGet, endpoints: Endpoints, author: HarvestAuthor): Promise<GutendexBook[]>`
  - `export function isCompleteGutenbergText(result: HttpResult): boolean`
  - `export interface BookText { text: string; citedUrl: string | null; fromCache: boolean }`
  - `export async function bookText(get: HttpGet, url: string): Promise<BookText>`
  - `export function wikiquotePageTitle(author: HarvestAuthor): string`
  - `export function wikiquotePageUrl(endpoints: Endpoints, title: string): string`
  - `export async function wikiquoteListedSections(get: HttpGet, endpoints: Endpoints, title: string): Promise<ListedSection[]>`
- **Used by:** M4 and M5.

**Why:**

- **Every read is cached.** Each read goes through the existing cached, retrying client, so a re-run or a test is served from disk. The cache source names are:
  - `gutendex` and `wikiquote` (small JSON)
  - `gutenberg-text` (full novels, a directory git already ignores)
- **Only complete texts are cached.** A text is cached only when both its START and END markers are present, so a truncated download is fetched again next time (plan.md's `cacheable` hook).
- **Tier 1 evidence needs policy-approved urls.** Evidence may cite a text only when both the requested url and the url after redirects pass the tier 1 policy, and it cites the url after redirects (plan.md 2.1). Otherwise the book yields no tier 1 evidence.
- **Gutendex paging is bounded.** A `next` link must stay on the Gutendex origin, and paging stops after 10 pages.
- **Wikiquote is one request.** The whole page is read in one request, so a list can never be read against a shifted section index. That was finding I2 in the picker branch's final review.
- **Tests use a real server.** A real `node:http` server serves the responses. One test routes a `gutenberg.org` url to it through `fetchImpl`, so the citation rule is exercised the way the real host answers.

- [ ] **Step 1: Write the failing tests**

Create `tests/harvest/sources.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import type { HarvestAuthor } from '../../src/harvest/gutendex.js';
import {
  bookText,
  createHttpGet,
  gutendexBooks,
  SourceStatusError,
  wikiquoteListedSections,
  type Endpoints,
} from '../../src/harvest/sources.js';

const UA = 'Lantern/test (test@example.invalid)';
const DICKENS: HarvestAuthor = { name: 'Charles Dickens', gutendex_name: 'Dickens, Charles', wikidata_id: 'Q5686', birth_year: 1812, death_year: 1870 };
const TEXT = [
  '*** START OF THE PROJECT GUTENBERG EBOOK A TALE OF TWO CITIES ***',
  '',
  'CHAPTER I.',
  '',
  'It was the best of times, it was the worst of times.',
  '',
  '*** END OF THE PROJECT GUTENBERG EBOOK A TALE OF TWO CITIES ***',
].join('\r\n');

interface Route {
  status?: number;
  type?: string;
  body: string | ((origin: string) => string);
}

const servers: Server[] = [];
let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'lantern-sources-'));
});

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A real HTTP server on 127.0.0.1:0 answering by path and query. Records every request url. */
async function site(routes: Record<string, Route>) {
  const hits: string[] = [];
  let origin = '';
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const route = routes[req.url ?? ''];
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(route.status ?? 200, { 'content-type': route.type ?? 'application/json; charset=utf-8' });
    res.end(typeof route.body === 'function' ? route.body(origin) : route.body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, hits };
}

/** Sends every request to the local site while the client still sees the url it asked for, as a real host would answer it. */
function routedTo(origin: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const response = await fetch(`${origin}${url.pathname}${url.search}`, init);
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
}

const book = (id: number, textUrl: string) => ({
  id,
  title: `Book ${id}`,
  authors: [{ name: 'Dickens, Charles', birth_year: 1812, death_year: 1870 }],
  editors: [],
  translators: [],
  subjects: [],
  bookshelves: [],
  languages: ['en'],
  copyright: false,
  media_type: 'Text',
  formats: { 'text/plain; charset=utf-8': textUrl },
  download_count: 1,
});

describe('harvest sources', () => {
  it('follows Gutendex next links from a surname search, serving repeats from the cache', async () => {
    const { origin, hits } = await site({
      '/books/?languages=en&search=dickens': {
        body: (o) => JSON.stringify({ count: 2, next: `${o}/books/?languages=en&page=2&search=dickens`, previous: null, results: [book(98, 'x')] }),
      },
      '/books/?languages=en&page=2&search=dickens': { body: JSON.stringify({ count: 2, next: null, previous: null, results: [book(1400, 'y')] }) },
    });
    const get = createHttpGet({ cacheDir, http: { userAgent: UA }, secretValues: [] });
    const endpoints: Endpoints = { gutendex: origin, wikiquote: origin };
    expect((await gutendexBooks(get, endpoints, DICKENS)).map((b) => b.id)).toEqual([98, 1400]);
    expect((await gutendexBooks(get, endpoints, DICKENS)).map((b) => b.id)).toEqual([98, 1400]);
    expect(hits).toEqual(['/books/?languages=en&search=dickens', '/books/?languages=en&page=2&search=dickens']);
  });

  it('refuses a Gutendex page that is not the recorded shape, or a next link to another origin', async () => {
    const { origin } = await site({
      '/books/?languages=en&search=dickens': { body: JSON.stringify({ count: 1, next: 'https://elsewhere.example/books/?page=2', previous: null, results: [] }) },
      '/books/?languages=en&search=twain': { body: JSON.stringify({ results: 'none' }) },
    });
    const get = createHttpGet({ cacheDir, http: { userAgent: UA }, secretValues: [] });
    const endpoints: Endpoints = { gutendex: origin, wikiquote: origin };
    await expect(gutendexBooks(get, endpoints, DICKENS)).rejects.toThrow('leaves');
    await expect(gutendexBooks(get, endpoints, { ...DICKENS, gutendex_name: 'Twain, Mark' })).rejects.toThrow(ZodError);
  });

  it('caches only a complete book text and cites a text that is not on a primary-text host as nothing', async () => {
    const { origin, hits } = await site({
      '/complete.txt': { type: 'text/plain; charset=utf-8', body: TEXT },
      '/truncated.txt': { type: 'text/plain; charset=utf-8', body: TEXT.slice(0, 120) },
    });
    const get = createHttpGet({ cacheDir, http: { userAgent: UA }, secretValues: [] });
    const first = await bookText(get, `${origin}/complete.txt`);
    expect(first).toMatchObject({ text: TEXT, citedUrl: null, fromCache: false });
    expect(await bookText(get, `${origin}/complete.txt`)).toMatchObject({ fromCache: true });
    await bookText(get, `${origin}/truncated.txt`);
    expect(await bookText(get, `${origin}/truncated.txt`)).toMatchObject({ fromCache: false });
    expect(hits.filter((h) => h === '/truncated.txt')).toHaveLength(2);
  });

  it('cites the Project Gutenberg url of a text fetched from gutenberg.org', async () => {
    const { origin } = await site({ '/cache/epub/98/pg98.txt': { type: 'text/plain; charset=utf-8', body: TEXT } });
    const get = createHttpGet({ cacheDir, http: { userAgent: UA, fetchImpl: routedTo(origin) }, secretValues: [] });
    expect(await bookText(get, 'https://www.gutenberg.org/cache/epub/98/pg98.txt')).toMatchObject({
      citedUrl: 'https://www.gutenberg.org/cache/epub/98/pg98.txt',
    });
  });

  it('reads the listed sections of the author page from one Wikiquote request', async () => {
    const page = { parse: { title: 'Charles Dickens', wikitext: '== Quotes ==\n* A quote.\n==Misattributed==\n* Every one for himself, and Providence for us all.' } };
    const { origin, hits } = await site({
      '/w/api.php?action=parse&format=json&formatversion=2&prop=wikitext&page=Charles_Dickens': { body: JSON.stringify(page) },
    });
    const get = createHttpGet({ cacheDir, http: { userAgent: UA }, secretValues: [] });
    const sections = await wikiquoteListedSections(get, { gutendex: origin, wikiquote: origin }, 'Charles Dickens');
    expect(sections).toEqual([
      { title: 'Charles Dickens', kind: 'Misattributed', anchor: 'Misattributed', entries: ['Every one for himself, and Providence for us all.'] },
    ]);
    expect(hits).toHaveLength(1);
  });

  it('fails on a source that does not answer 200', async () => {
    const { origin } = await site({});
    const get = createHttpGet({ cacheDir, http: { userAgent: UA }, secretValues: [] });
    await expect(wikiquoteListedSections(get, { gutendex: origin, wikiquote: origin }, 'Nobody')).rejects.toThrow(SourceStatusError);
    await expect(bookText(get, `${origin}/missing.txt`)).rejects.toThrow(SourceStatusError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/harvest/sources.test.ts`

Expected: FAIL, because the module `../../src/harvest/sources.js` cannot be found. Record the output.

- [ ] **Step 3: Implement**

Create `src/harvest/sources.ts`:

```ts
import { cachedFetch, type CachedResult } from '../lib/cache.js';
import { fetchWithRetry, type HttpOptions, type HttpResult } from '../lib/http.js';
import { assertSourceAllowed, SourcePolicyError } from '../verify/source-policy.js';
import { listedSections, type ListedSection } from '../verify/wikiquote.js';
import { stripGutenbergWrapper } from './gutenberg-text.js';
import { gutendexPageSchema, type GutendexBook, type HarvestAuthor } from './gutendex.js';

/** A cached GET. `source` names the cache subdirectory; `cacheable` can veto storing a response. */
export type HttpGet = (url: string, source: string, cacheable?: (result: HttpResult) => boolean) => Promise<CachedResult>;

export interface HttpGetOptions {
  cacheDir: string;
  http: HttpOptions;
  refresh?: boolean;
  now?: () => Date;
  secretValues?: readonly string[];
}

export function createHttpGet(options: HttpGetOptions): HttpGet {
  return (url, source, cacheable) =>
    cachedFetch(
      { url },
      { cacheDir: options.cacheDir, source, refresh: options.refresh, now: options.now, cacheable, secretValues: options.secretValues },
      (req) => fetchWithRetry(req, options.http),
    );
}

/** A source answered with something other than 200. */
export class SourceStatusError extends Error {
  override name = 'SourceStatusError';

  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`HTTP ${status} from ${url}`);
  }
}

function expectOk(result: CachedResult): CachedResult {
  if (result.status !== 200) throw new SourceStatusError(result.url, result.status);
  return result;
}

export interface Endpoints {
  gutendex: string;
  wikiquote: string;
}

export const DEFAULT_ENDPOINTS: Endpoints = { gutendex: 'https://gutendex.com', wikiquote: 'https://en.wikiquote.org' };

/** Gutendex is slow and a surname search can run to many pages; this caps the requests per author. */
export const MAX_GUTENDEX_PAGES = 10;

export function gutendexSearchUrl(endpoints: Endpoints, author: HarvestAuthor): string {
  const surname = author.gutendex_name.split(', ')[0]!.toLowerCase();
  return `${endpoints.gutendex}/books/?languages=en&search=${encodeURIComponent(surname)}`;
}

/**
 * Every English Gutendex result for the author's surname, following `next` links for at most
 * MAX_GUTENDEX_PAGES pages. A page that is not the recorded shape throws, and so does a `next` link to
 * another origin. The caller still filters with harvestableBooks.
 */
export async function gutendexBooks(get: HttpGet, endpoints: Endpoints, author: HarvestAuthor): Promise<GutendexBook[]> {
  const origin = new URL(endpoints.gutendex).origin;
  const books: GutendexBook[] = [];
  let url: string | null = gutendexSearchUrl(endpoints, author);
  for (let page = 0; url !== null && page < MAX_GUTENDEX_PAGES; page++) {
    const parsed = gutendexPageSchema.parse(JSON.parse(expectOk(await get(url, 'gutendex')).body));
    books.push(...parsed.results);
    if (parsed.next !== null && new URL(parsed.next).origin !== origin) {
      throw new Error(`Gutendex next link leaves ${origin}: ${parsed.next}`);
    }
    url = parsed.next;
  }
  return books;
}

/** Whether a response is a complete Project Gutenberg text: both its START and END markers are present. */
export function isCompleteGutenbergText(result: HttpResult): boolean {
  if (result.status !== 200) return false;
  try {
    stripGutenbergWrapper(result.body);
    return true;
  } catch {
    return false;
  }
}

function isPrimaryTextUrl(url: string): boolean {
  try {
    assertSourceAllowed({ tier: 1, url, citation: 'Project Gutenberg text', excerpt: null });
    return true;
  } catch (err) {
    if (err instanceof SourcePolicyError) return false;
    throw err;
  }
}

export interface BookText {
  /** The whole downloaded text, wrapper included. */
  text: string;
  /**
   * The url to cite as tier 1 evidence: the url after redirects, when both it and the requested url
   * are primary-text urls (spec section 8). Null otherwise, so the book yields no tier 1 evidence.
   */
  citedUrl: string | null;
  fromCache: boolean;
}

/** A book's plain text. Only a complete text (START and END markers) is cached. */
export async function bookText(get: HttpGet, url: string): Promise<BookText> {
  const result = expectOk(await get(url, 'gutenberg-text', isCompleteGutenbergText));
  const finalUrl = result.finalUrl ?? url;
  return { text: result.body, citedUrl: isPrimaryTextUrl(url) && isPrimaryTextUrl(finalUrl) ? finalUrl : null, fromCache: result.fromCache };
}

/** The Wikiquote page checked for an author: the page named after them, as for the four configured authors. */
export function wikiquotePageTitle(author: HarvestAuthor): string {
  return author.name;
}

export function wikiquotePageUrl(endpoints: Endpoints, title: string): string {
  const page = encodeURIComponent(title.replace(/ /g, '_'));
  return `${endpoints.wikiquote}/w/api.php?action=parse&format=json&formatversion=2&prop=wikitext&page=${page}`;
}

/** The Misattributed and Disputed sections of the author's Wikiquote page, from one request. */
export async function wikiquoteListedSections(get: HttpGet, endpoints: Endpoints, title: string): Promise<ListedSection[]> {
  return listedSections(JSON.parse(expectOk(await get(wikiquotePageUrl(endpoints, title), 'wikiquote')).body));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/harvest/sources.test.ts`, then `npm test` and `npm run typecheck`.

Expected:
- `sources.test.ts` shows 6 passed.
- The suite reports 459 tests across 28 files.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/harvest/sources.ts tests/harvest/sources.test.ts
git commit -m "feat(harvest): cached Gutendex, Gutenberg text and Wikiquote page reads

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task M3: Verify a vertical

**Files:**
- Create: `src/verify/run.ts`
- Test: `tests/verify/run.test.ts` (new)

**Interfaces:**
- **Consumes:**
  - `EvidenceError` and `loadEvidence` from `src/db/evidence.ts`
  - `hasWikiquoteCheck` from `src/db/quotes.ts` (M1)
  - `parseRejectReason`, `reopenInsufficientEvidence` and `verifyQuoteItem` from `src/verify/apply.ts`
- **Produces:**
  - `export interface VerifyOptions { retryInsufficient?: boolean; now?: () => Date; log?: Logger }`
  - `export interface VerifyReport { considered: number; verified: number; rejected: Record<string, number>; unchecked: number; malformed: number; reopened: number }`
  - `export function verifyVertical(db: Db, verticalId: number, options?: VerifyOptions): VerifyReport`
- **Used by:** M4's end-to-end test and M5's `verify` command.

**Why:**

- **What verify decides.** Spec §7 `lantern verify` decides raw quotes with the §8 gates. `verifyQuoteItem` already makes the only decision path, deciding from the stored body inside the write transaction.
- **What verify refuses.** This task adds refusals to decide on partial information. Such a quote stays raw and is counted, never decided:
  - A quote without a recorded Wikiquote check.
  - A quote whose evidence rows do not load (`EvidenceError`), which is prerequisite P3. Skipping a malformed `attribution-conflict` row would weaken negative evidence.
- **Retrying.** `--retry-insufficient` reopens only insufficient-evidence rejections (§7), then decides them again.

- [ ] **Step 1: Write the failing tests**

Create `tests/verify/run.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { insertHarvestedQuote, upsertAuthorSubject } from '../../src/db/quotes.js';
import type { QuoteEvidence } from '../../src/verify/quote-gate.js';
import { verifyVertical } from '../../src/verify/run.js';
import { seedItem, testDb } from '../helpers/db.js';

const NOW = () => new Date('2026-09-15T00:00:00.000Z');
const BODY = 'A wonderful fact to reflect upon, that every human creature is constituted to be that profound secret and mystery to every other.';
const OTHER = 'Nothing in this second passage has any primary text behind it, so it cannot be verified yet.';

const primary: QuoteEvidence = {
  kind: 'primary-text',
  citation: 'Charles Dickens, A Tale of Two Cities (Project Gutenberg #98)',
  url: 'https://www.gutenberg.org/ebooks/98.txt.utf-8',
  excerpt: BODY,
  location: 'characters 10-140 after the Project Gutenberg header',
  authorMatches: true,
};

function setup() {
  const db = testDb();
  const verticalId = Number(
    db.prepare("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'Literature', 'config/verticals/literature.yaml')").run()
      .lastInsertRowid,
  );
  const subjectId = upsertAuthorSubject(
    db,
    verticalId,
    { name: 'Charles Dickens', gutendex_name: 'Dickens, Charles', wikidata_id: 'Q5686', birth_year: 1812, death_year: 1870 },
    NOW(),
  );
  const quote = (body: string, evidence: QuoteEvidence[]) =>
    insertHarvestedQuote(db, { verticalId, subjectId, body, workTitle: 'A Tale of Two Cities', evidence, wikiquotePage: 'Charles Dickens' }, NOW()).itemId;
  return { db, verticalId, quote };
}

const status = (db: ReturnType<typeof testDb>, id: number) => db.prepare('SELECT status FROM items WHERE id = ?').pluck().get(id);

describe('verifyVertical', () => {
  it('decides every checked raw quote with the quote gate', () => {
    const { db, verticalId, quote } = setup();
    const verified = quote(BODY, [primary]);
    const insufficient = quote(OTHER, [{ kind: 'reference', citation: 'Wikiquote, Charles Dickens', url: 'https://en.wikiquote.org/wiki/Charles_Dickens' }]);
    expect(verifyVertical(db, verticalId, { now: NOW })).toEqual({
      considered: 2,
      verified: 1,
      rejected: { 'insufficient-evidence': 1 },
      unchecked: 0,
      malformed: 0,
      reopened: 0,
    });
    expect([status(db, verified), status(db, insufficient)]).toEqual(['verified', 'rejected']);
    expect(db.prepare('SELECT tier, url FROM sources WHERE item_id = ?').all(verified)).toEqual([{ tier: 1, url: primary.url }]);
  });

  it('leaves a raw quote without a recorded Wikiquote check raw', () => {
    const { db, verticalId } = setup();
    const { itemId } = seedItem(db, BODY);
    db.prepare("INSERT INTO item_evidence (item_id, kind, citation, url, excerpt, author_matches, recorded_at) VALUES (?, 'primary-text', 'x', ?, ?, 1, ?)").run(
      itemId,
      primary.url,
      BODY,
      NOW().toISOString(),
    );
    expect(verifyVertical(db, verticalId, { now: NOW })).toMatchObject({ considered: 1, verified: 0, unchecked: 1 });
    expect(status(db, itemId)).toBe('raw');
  });

  it('leaves a quote with malformed evidence raw instead of deciding on the rest', () => {
    const { db, verticalId, quote } = setup();
    const itemId = quote(BODY, [primary]);
    db.prepare("INSERT INTO item_evidence (item_id, kind, citation, recorded_at) VALUES (?, 'attribution-conflict', 'Some anthology', ?)").run(
      itemId,
      NOW().toISOString(),
    );
    expect(verifyVertical(db, verticalId, { now: NOW })).toMatchObject({ considered: 1, verified: 0, malformed: 1 });
    expect(status(db, itemId)).toBe('raw');
  });

  it('reopens only insufficient-evidence rejections when asked, and decides them again', () => {
    const { db, verticalId, quote } = setup();
    const insufficient = quote(OTHER, []);
    const listed = quote(BODY, [primary, { kind: 'listed-misattributed', citation: 'Wikiquote, Charles Dickens: Misattributed' }]);
    verifyVertical(db, verticalId, { now: NOW });
    expect([status(db, insufficient), status(db, listed)]).toEqual(['rejected', 'rejected']);
    expect(verifyVertical(db, verticalId, { retryInsufficient: true, now: NOW })).toEqual({
      considered: 1,
      verified: 0,
      rejected: { 'insufficient-evidence': 1 },
      unchecked: 0,
      malformed: 0,
      reopened: 1,
    });
    expect(db.prepare('SELECT reject_reason FROM items WHERE id = ?').pluck().get(listed)).toMatch(/^misattributed: /);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/verify/run.test.ts`

Expected: FAIL, because the module `../../src/verify/run.js` cannot be found. Record the output.

- [ ] **Step 3: Implement**

Create `src/verify/run.ts`:

```ts
import type { Db } from '../db/connection.js';
import { EvidenceError, loadEvidence } from '../db/evidence.js';
import { hasWikiquoteCheck } from '../db/quotes.js';
import type { Logger } from '../lib/log.js';
import { parseRejectReason, reopenInsufficientEvidence, verifyQuoteItem } from './apply.js';

export interface VerifyOptions {
  /** First reopen quotes rejected only for insufficient evidence, so they are decided again. */
  retryInsufficient?: boolean;
  now?: () => Date;
  log?: Logger;
}

export interface VerifyReport {
  /** Raw quotes found for the vertical. */
  considered: number;
  verified: number;
  /** Rejections by reason. */
  rejected: Record<string, number>;
  /** Raw quotes left raw because no Wikiquote check was recorded for them. */
  unchecked: number;
  /** Raw quotes left raw because a stored evidence row is malformed. */
  malformed: number;
  reopened: number;
}

/**
 * Decides every raw quote in a vertical (spec section 7, `lantern verify`). A quote is decided only
 * when its Wikiquote Misattributed and Disputed check was recorded, and only from evidence that loads
 * cleanly: otherwise it stays raw and is counted, never decided on partial evidence. Each decision
 * goes through verifyQuoteItem, which runs the quote gate against the stored body.
 */
export function verifyVertical(db: Db, verticalId: number, options: VerifyOptions = {}): VerifyReport {
  const now = options.now ?? (() => new Date());
  let reopened = 0;
  if (options.retryInsufficient === true) {
    const rejected = db
      .prepare("SELECT id, reject_reason FROM items WHERE vertical_id = ? AND kind = 'quote' AND status = 'rejected' ORDER BY id")
      .all(verticalId) as { id: number; reject_reason: string | null }[];
    for (const item of rejected) {
      if (parseRejectReason(item.reject_reason ?? '').reason !== 'insufficient-evidence') continue;
      reopenInsufficientEvidence(db, item.id);
      reopened++;
    }
  }

  const raw = db
    .prepare("SELECT id FROM items WHERE vertical_id = ? AND kind = 'quote' AND status = 'raw' ORDER BY id")
    .pluck()
    .all(verticalId) as number[];
  const report: VerifyReport = { considered: raw.length, verified: 0, rejected: {}, unchecked: 0, malformed: 0, reopened };

  for (const itemId of raw) {
    if (!hasWikiquoteCheck(db, itemId)) {
      report.unchecked++;
      continue;
    }
    let evidence: ReturnType<typeof loadEvidence>;
    try {
      evidence = loadEvidence(db, itemId);
    } catch (err) {
      if (!(err instanceof EvidenceError)) throw err;
      report.malformed++;
      options.log?.warn('verify left a quote raw: malformed evidence', { itemId, error: err.message });
      continue;
    }
    const decision = verifyQuoteItem(db, itemId, evidence, now());
    if (decision.status === 'verified') report.verified++;
    else report.rejected[decision.reason] = (report.rejected[decision.reason] ?? 0) + 1;
  }
  return report;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/verify/run.test.ts`, then `npm test` and `npm run typecheck`.

Expected:
- `run.test.ts` shows 4 passed.
- The suite reports 463 tests across 29 files.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/verify/run.ts tests/verify/run.test.ts
git commit -m "feat(verify): decide a vertical's checked raw quotes and keep the rest raw

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task M4: Harvest a vertical

**Files:**
- Create: `src/harvest/harvest.ts`
- Test: `tests/harvest/harvest.test.ts` (new)

**Interfaces:**
- **Consumes:**
  - M1: `hasBookPick`, `insertHarvestedQuote`, `recordBookPick` and `upsertAuthorSubject`.
  - M2: `bookText`, `gutendexBooks`, `wikiquoteListedSections`, `wikiquotePageTitle`, `type Endpoints` and `type HttpGet`.
  - M3: `verifyVertical`, used in the test only.
  - Existing modules:
    - `locateQuoteIn` and `prepareHaystack`
    - `listedEvidence` and `type ListedSection`
    - `extractCandidates`
    - `bookBody`
    - `GutenbergMarkerError` and `stripGutenbergWrapper`
    - `harvestableBooks`, `plainTextUrl` and `type GutendexBook`
    - `PickerFailedError`, `pickPassages`, `type PickFailure` and `type PickFn`
    - `errorReason` from `src/lib/http.ts`
- **Produces:**
  - `export interface HarvestOptions { db: Db; verticalId: number; harvest: HarvestConfig; get: HttpGet; endpoints: Endpoints; pick: PickFn; prompt: string; limit: number; now?: () => Date; log?: Logger }`
  - `export type BookOutcome = { status: 'already-picked' } | { status: 'skipped'; reason: string } | { status: 'failed'; reason: string } | { status: 'harvested'; heading: string; skippedLines: number; candidates: number; batches: number; failures: PickFailure[]; picked: number; inserted: number; duplicates: number; listed: number }`
  - `export interface BookReport { gutenbergId: number; title: string; outcome: BookOutcome }`
  - `export interface AuthorReport { author: string; error: string | null; listedEntries: number; books: BookReport[] }`
  - `export interface HarvestReport { inserted: number; authors: AuthorReport[] }`
  - `export async function harvestVertical(options: HarvestOptions): Promise<HarvestReport>`
- **Used by:** M5 calls it with the real cached client, the Anthropic picker and the prompt file.

**Why:**

- **Order of work.** The function runs the §7 harvest stage in an order where every failure fails closed:
  - **Wikiquote first.** An author's Wikiquote page is read before anything else. If it cannot be read, the author is skipped with an error: no quote goes in without the §8 check.
  - **Books.** Gutendex results are filtered to the author's own public-domain prose. A book already picked with this prompt and model is passed over.
  - **Per book, from text to picks.** Each remaining book goes through these steps:
    1. Fetch the text. A text whose url cannot be cited is skipped.
    2. Strip the Gutenberg wrapper.
    3. Cut the front and end matter.
    4. Extract candidates.
    5. Run the picker.
  - **Two ways a book fails.** A book whose text cannot be fetched is marked failed, and so is a book whose picker output is unusable in every batch. The run moves on in both cases.
  - **Anything else stops the run.** One example is a rejected API key.
- **Evidence for each pick.** Each picked passage is inserted raw. Its primary-text evidence has these fields:
  - `authorMatches: true`, because `harvestableBooks` matched the exact author name and years.
  - The cited url.
  - A verbatim excerpt: the matcher's span in the body, extended by the passage's trailing punctuation, which must tidy back to the passage.
  - The character location in the text after the Gutenberg header.
  - A `listed-misattributed` entry for any Wikiquote match.
- **Why the excerpt is located in the body.** It is located in `body.text`, never in the whole text, so a preface that quotes the same line cannot supply it (P4).
- **Limit.** `--limit` is checked between books, so a book's picks are never half-inserted and then marked picked.
- **Recording picks.** The book pick is recorded after its passages are inserted.
- **Report.** Returns a per-author, per-book report for `run_log` and the terminal.

- [ ] **Step 1: Write the failing tests**

Create `tests/harvest/harvest.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarvestConfig } from '../../src/config/schema.js';
import { loadEvidence } from '../../src/db/evidence.js';
import { harvestVertical, type HarvestOptions } from '../../src/harvest/harvest.js';
import type { PickFn } from '../../src/harvest/picker.js';
import { createHttpGet, type Endpoints } from '../../src/harvest/sources.js';
import { verifyVertical } from '../../src/verify/run.js';
import { testDb } from '../helpers/db.js';

const UA = 'Lantern/test (test@example.invalid)';
const NOW = () => new Date('2026-09-15T00:00:00.000Z');
const LISTED = 'Well, every one for himself, and Providence for us all, as the elephant said when he danced among the chickens.';
const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one'];
const PROSE = WORDS.map((w) => `Sentence ${w} tells of the river and the town and the people who lived beside it.`);

const HARVEST: HarvestConfig = {
  authors: [{ name: 'Charles Dickens', gutendex_name: 'Dickens, Charles', wikidata_id: 'Q5686', birth_year: 1812, death_year: 1870 }],
  picker: { model: 'claude-sonnet-5', batch_size: 150, max_batches_per_work: 6, picks_per_batch: 3 },
};

const gutenberg = (title: string, lines: string[]) =>
  [
    `*** START OF THE PROJECT GUTENBERG EBOOK ${title.toUpperCase()} ***`,
    '',
    'PREFACE BY THE EDITOR',
    '',
    'This edition follows the text of the first edition, and the editor has corrected obvious misprints silently.',
    '',
    ...lines,
    '',
    `*** END OF THE PROJECT GUTENBERG EBOOK ${title.toUpperCase()} ***`,
  ].join('\r\n');

const NOVEL = gutenberg('A Tale of Two Cities', [
  'CHAPTER I.',
  '',
  ...PROSE,
  LISTED,
  '',
  'TRANSCRIBER\'S NOTES',
  '',
  'Obvious printing errors in this edition have been corrected by the transcriber without comment.',
]);

const book = (id: number, title: string, textUrl: string, authors = HARVEST.authors.map((a) => ({ name: a.gutendex_name, birth_year: a.birth_year, death_year: a.death_year }))) => ({
  id,
  title,
  authors,
  editors: [],
  translators: [],
  subjects: [],
  bookshelves: [],
  languages: ['en'],
  copyright: false,
  media_type: 'Text',
  formats: { 'text/plain; charset=utf-8': textUrl },
  download_count: 1,
});

const WIKIQUOTE_PAGE = {
  parse: {
    title: 'Charles Dickens',
    wikitext: `== Quotes ==\n* It was the best of times.\n==Misattributed==\n* "Well, every one for himself, and Providence for us all--as the elephant said when he danced among the chickens."\n** [[Charles Reade]], ''A Simpleton'' (1873)\n{{Misattributed end}}`,
  },
};

const WIKIQUOTE_PATH = '/w/api.php?action=parse&format=json&formatversion=2&prop=wikitext&page=Charles_Dickens';
const SEARCH_PATH = '/books/?languages=en&search=dickens';

const servers: Server[] = [];
let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'lantern-harvest-'));
});

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A real HTTP server on 127.0.0.1:0 answering by path and query; `hits` records each request. */
async function site(routes: Record<string, { type?: string; body: string }>) {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const route = routes[req.url ?? ''];
    res.writeHead(route === undefined ? 404 : 200, { 'content-type': route?.type ?? 'application/json; charset=utf-8' });
    res.end(route?.body ?? '{}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

/** Sends every request to the local site while the client sees the url it asked for, as the real host would answer it. */
function routedTo(origin: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const response = await fetch(`${origin}${url.pathname}${url.search}`, init);
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
}

/** A picker that chooses, by number, the candidates whose text passes `choose`. */
const pickWhere =
  (choose: (text: string) => boolean): PickFn =>
  async (_system, user) => ({
    picks: user
      .split('\n')
      .map((line) => /^\[(\d+)\] (.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null && choose(match[2]!))
      .slice(0, 3)
      .map((match) => ({ id: Number(match[1]), reason: 'stands alone' })),
  });

async function setup(routes: Record<string, { type?: string; body: string }>, pick: PickFn, overrides: Partial<HarvestOptions> = {}) {
  const { origin, hits } = await site(routes);
  const db = testDb();
  const verticalId = Number(
    db.prepare("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'Literature', 'config/verticals/literature.yaml')").run()
      .lastInsertRowid,
  );
  const endpoints: Endpoints = { gutendex: 'https://gutendex.com', wikiquote: 'https://en.wikiquote.org' };
  const options: HarvestOptions = {
    db,
    verticalId,
    harvest: HARVEST,
    get: createHttpGet({ cacheDir, http: { userAgent: UA, fetchImpl: routedTo(origin) }, secretValues: [] }),
    endpoints,
    pick,
    prompt: 'You can only choose by number.',
    limit: 25,
    now: NOW,
    ...overrides,
  };
  return { db, verticalId, hits, options };
}

const standardRoutes = {
  [WIKIQUOTE_PATH]: { body: JSON.stringify(WIKIQUOTE_PAGE) },
  [SEARCH_PATH]: {
    body: JSON.stringify({
      count: 2,
      next: null,
      previous: null,
      results: [
        book(98, 'A Tale of Two Cities', 'https://www.gutenberg.org/ebooks/98.txt.utf-8'),
        book(3178, 'The Gilded Age', 'https://www.gutenberg.org/ebooks/3178.txt.utf-8', [
          { name: 'Dickens, Charles', birth_year: 1812, death_year: 1870 },
          { name: 'Warner, Charles Dudley', birth_year: 1829, death_year: 1900 },
        ]),
      ],
    }),
  },
  '/ebooks/98.txt.utf-8': { type: 'text/plain; charset=utf-8', body: NOVEL },
};

describe('harvestVertical', () => {
  it('harvests picked passages with their evidence, and verify then decides them', async () => {
    const { db, verticalId, hits, options } = await setup(standardRoutes, pickWhere((t) => t.startsWith('Sentence one ') || t === LISTED));
    const report = await harvestVertical(options);

    expect(report.inserted).toBe(2);
    expect(report.authors).toEqual([
      {
        author: 'Charles Dickens',
        error: null,
        listedEntries: 1,
        books: [
          {
            gutenbergId: 98,
            title: 'A Tale of Two Cities',
            outcome: expect.objectContaining({ status: 'harvested', heading: 'CHAPTER I.', picked: 2, inserted: 2, duplicates: 0, listed: 1 }),
          },
        ],
      },
    ]);
    expect(hits).not.toContain('/ebooks/3178.txt.utf-8');

    const items = db.prepare('SELECT id, body, work_title FROM items ORDER BY id').all() as { id: number; body: string; work_title: string }[];
    expect(items.map((i) => i.body)).toEqual([PROSE[0], LISTED]);
    const [primary] = loadEvidence(db, items[0]!.id);
    expect(primary).toMatchObject({
      kind: 'primary-text',
      citation: 'Charles Dickens, A Tale of Two Cities (Project Gutenberg #98)',
      url: 'https://www.gutenberg.org/ebooks/98.txt.utf-8',
      excerpt: PROSE[0],
      authorMatches: true,
    });
    expect(primary).toHaveProperty('location', expect.stringMatching(/^characters \d+-\d+ after the Project Gutenberg header$/));
    expect(loadEvidence(db, items[1]!.id).map((e) => e.kind)).toEqual(['primary-text', 'listed-misattributed']);
    expect(JSON.stringify(db.prepare('SELECT body FROM items').pluck().all())).not.toContain('editor');

    expect(verifyVertical(db, verticalId, { now: NOW })).toEqual({
      considered: 2,
      verified: 1,
      rejected: { misattributed: 1 },
      unchecked: 0,
      malformed: 0,
      reopened: 0,
    });
  });

  it('spends nothing on a book already picked with the same prompt and model', async () => {
    const { db, options } = await setup(standardRoutes, pickWhere((t) => t.startsWith('Sentence one ')));
    await harvestVertical(options);
    const again = await harvestVertical({
      ...options,
      pick: async () => {
        throw new Error('the picker must not be called again');
      },
    });
    expect(again.inserted).toBe(0);
    expect(again.authors[0]!.books).toEqual([{ gutenbergId: 98, title: 'A Tale of Two Cities', outcome: { status: 'already-picked' } }]);
    expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(1);
  });

  it('skips an author whose Wikiquote page cannot be read, before any book is fetched', async () => {
    const { db, hits, options } = await setup({ [SEARCH_PATH]: standardRoutes[SEARCH_PATH] }, pickWhere(() => true));
    const report = await harvestVertical(options);
    expect(report.authors[0]).toMatchObject({ author: 'Charles Dickens', error: expect.stringContaining('HTTP 404'), books: [] });
    expect(hits.some((h) => h.startsWith('/books/'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) FROM items').pluck().get()).toBe(0);
  });

  it('starts no new book once the limit is reached', async () => {
    const routes = {
      ...standardRoutes,
      [SEARCH_PATH]: {
        body: JSON.stringify({
          count: 2,
          next: null,
          previous: null,
          results: [
            book(98, 'A Tale of Two Cities', 'https://www.gutenberg.org/ebooks/98.txt.utf-8'),
            book(1400, 'Great Expectations', 'https://www.gutenberg.org/ebooks/1400.txt.utf-8'),
          ],
        }),
      },
    };
    const { hits, options } = await setup(routes, pickWhere((t) => t.startsWith('Sentence one ')), { limit: 1 });
    const report = await harvestVertical(options);
    expect(report.inserted).toBe(1);
    expect(report.authors[0]!.books.map((b) => b.gutenbergId)).toEqual([98]);
    expect(hits).not.toContain('/ebooks/1400.txt.utf-8');
  });

  it('skips a book without a usable body or primary-text url, marks a book failed when the picker output is unusable, and moves on', async () => {
    const routes = {
      [WIKIQUOTE_PATH]: standardRoutes[WIKIQUOTE_PATH],
      [SEARCH_PATH]: {
        body: JSON.stringify({
          count: 3,
          next: null,
          previous: null,
          results: [
            book(902, 'The Happy Prince', 'https://www.gutenberg.org/ebooks/902.txt.utf-8'),
            book(903, 'A Mirror Copy', 'https://mirror.example/ebooks/903.txt'),
            book(98, 'A Tale of Two Cities', 'https://www.gutenberg.org/ebooks/98.txt.utf-8'),
          ],
        }),
      },
      '/ebooks/902.txt.utf-8': { type: 'text/plain; charset=utf-8', body: gutenberg('The Happy Prince', PROSE) },
      '/ebooks/903.txt': { type: 'text/plain; charset=utf-8', body: NOVEL },
      '/ebooks/98.txt.utf-8': standardRoutes['/ebooks/98.txt.utf-8'],
    };
    let calls = 0;
    const { db, options } = await setup(routes, async () => {
      calls++;
      return { picks: 'none' };
    });
    const report = await harvestVertical(options);
    // harvestableBooks returns books in id order.
    expect(report.authors[0]!.books.map((b) => [b.gutenbergId, b.outcome.status])).toEqual([
      [98, 'failed'],
      [902, 'skipped'],
      [903, 'skipped'],
    ]);
    expect(calls).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM book_picks').pluck().get()).toBe(0);
  });

  it('stops the run when the picker fails for another reason, such as a rejected key', async () => {
    const { options } = await setup(standardRoutes, async () => {
      throw new Error('invalid x-api-key');
    });
    await expect(harvestVertical(options)).rejects.toThrow('invalid x-api-key');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/harvest/harvest.test.ts`

Expected: FAIL, because the module `../../src/harvest/harvest.js` cannot be found. Record the output.

- [ ] **Step 3: Implement**

Create `src/harvest/harvest.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/harvest/harvest.test.ts`, then `npm test` and `npm run typecheck`.

Expected:
- `harvest.test.ts` shows 6 passed.
- The suite reports 469 tests across 30 files.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/harvest/harvest.ts tests/harvest/harvest.test.ts
git commit -m "feat(harvest): harvest a vertical's authors into checked raw quotes with verbatim evidence

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task M5: `lantern harvest` and `lantern verify`

**Files:**
- Modify: `src/cli.ts` (replace the whole file), `tests/cli.test.ts`

**Interfaces:**
- **Consumes:**
  - `harvestVertical` and `type AuthorReport` (M4)
  - `createHttpGet` and `DEFAULT_ENDPOINTS` (M2)
  - `verifyVertical` (M3)
  - `anthropicPick` and `loadPickPrompt`
  - `pendingMigrations`
  - `buildUserAgent`
  - `redactUrl`
  - `runStage`
- **Produces:** the CLI commands `harvest --vertical <slug> [--limit <n>] [--refresh]` and `verify --vertical <slug> [--retry-insufficient]`.

**Why:**

- **Each command is a separate stage.** §7 makes each stage a separate, idempotent CLI command wrapped in `run_log` via `runStage`.
- **Startup checks run before anything is fetched.** They run in this order:
  1. Pending migrations: run `lantern migrate`. The user's database is at 005 and needs 006.
  2. Unknown vertical, or a vertical without a harvest section.
  3. No `ANTHROPIC_API_KEY`. A missing key must never look like "nothing quotable" (P4).
- **Explicit timeouts protect cron runs:**
  - The HTTP timeout is 180 s, because Gutendex can take over a minute.
  - The Anthropic client has a 120 s timeout and 3 retries, because a pick only reads, so retrying it is safe.
- **Exit codes.** A skipped author or a failed book exits 1, so a scheduled run alerts. Verify exits 1 on malformed evidence.
- **User-Agent.** It carries `LANTERN_CONTACT`, which is the repo URL; the email is never sent.
- **CLI tests stop early.** They cover the refusals and an empty `verify`. None of them gets past the checks to a fetch.

- [ ] **Step 1: Update the CLI tests**

In `tests/cli.test.ts`, make three edits:

1. In `interface LanternOpts`, directly after the line `  logs?: string | null; // null omits LANTERN_LOGS from the child env`, add:

```ts
  env?: Record<string, string>; // extra child env, applied last
```

2. In `function lantern`, directly before the line `  const res = spawnSync(process.execPath, ['--import', TSX_LOADER, join(ROOT, 'src', 'cli.ts'), ...args], {`, add:

```ts
  Object.assign(env, opts.env ?? {});

```

3. Directly before the file's final `});` (the end of `describe('lantern CLI', ...)`), add these tests:

```ts
  it('harvest refuses a database with pending migrations before anything else', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const res = lantern(['harvest', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(res.code).toBe(1);
    expect(res.out).toContain('run lantern migrate');
  }, 30_000);

  it('harvest refuses a vertical without a harvest section, and a missing API key, without fetching anything', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    expect(lantern(['migrate'], scratch).code).toBe(0);
    const science = lantern(['harvest', '--vertical', 'science-curious'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(science.code).toBe(1);
    expect(science.out).toContain('vertical science-curious has no harvest section');
    const noKey = lantern(['harvest', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(noKey.code).toBe(1);
    expect(noKey.out).toContain('ANTHROPIC_API_KEY is not set');
    expect(existsSync(join(scratch, 'cache'))).toBe(false);
  }, 30_000);

  it('harvest and verify refuse an unknown vertical', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    expect(lantern(['migrate'], scratch).code).toBe(0);
    for (const command of ['harvest', 'verify']) {
      const res = lantern([command, '--vertical', 'poetry'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
      expect(res.code).toBe(1);
      expect(res.out).toContain('unknown vertical: poetry');
    }
  }, 30_000);

  it('verify decides nothing on an empty database and records the stage', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    expect(lantern(['migrate'], scratch).code).toBe(0);
    const res = lantern(['verify', '--vertical', 'literature'], scratch);
    expect(res.code).toBe(0);
    expect(res.out).toContain('verified: 0');
    expect(res.out).toContain('left raw: 0 without a Wikiquote check, 0 with malformed evidence');
  }, 30_000);
```

Run: `npx vitest run tests/cli.test.ts`

Expected: FAIL. The 4 new tests fail (unknown command `harvest` or `verify`), and the existing CLI tests still pass. Record the output.

- [ ] **Step 2: Implement**

Replace the whole of `src/cli.ts` with:

```ts
#!/usr/bin/env node
import Anthropic from '@anthropic-ai/sdk';
import { Command, CommanderError } from 'commander';
import { config as loadDotenv } from 'dotenv';
import { join, resolve } from 'node:path';
import { loadConfig } from './config/load.js';
import { openDb, type Db } from './db/connection.js';
import { migrate, pendingMigrations } from './db/migrate.js';
import { syncConfig } from './db/sync.js';
import { runChecks } from './doctor/checks.js';
import { exitCode, formatReport } from './doctor/report.js';
import { anthropicPick, loadPickPrompt } from './harvest/anthropic-picker.js';
import { harvestVertical, type AuthorReport } from './harvest/harvest.js';
import { createHttpGet, DEFAULT_ENDPOINTS } from './harvest/sources.js';
import { redactUrl } from './lib/cache.js';
import { buildUserAgent } from './lib/http.js';
import { createLogger } from './lib/log.js';
import { findProjectRoot, resolvePaths } from './lib/paths.js';
import { runStage } from './lib/run-stage.js';
import { verifyVertical } from './verify/run.js';

const USER_AGENT_VERSION = '0.1';

const root = resolve(process.env.LANTERN_ROOT ?? findProjectRoot());
loadDotenv({ path: join(root, '.env'), quiet: true });
const paths = resolvePaths(process.env, root);
const log = createLogger({ dir: paths.logs });

const program = new Command()
  .name('lantern')
  .description('Automated educational social content engine')
  .exitOverride();

/** Opens the database for a pipeline stage, refusing one with pending migrations. */
function openMigratedDb(): Db {
  const db = openDb(paths.db);
  const pending = pendingMigrations(db, paths.migrations);
  if (pending.length > 0) throw new Error(`the database has pending migrations (${pending.join(', ')}); run lantern migrate`);
  return db;
}

function findVertical(db: Db, slug: string) {
  const vertical = loadConfig(paths.root).verticals.find((v) => v.slug === slug);
  if (vertical === undefined) throw new Error(`unknown vertical: ${slug}`);
  const verticalId = db.prepare('SELECT id FROM verticals WHERE slug = ?').pluck().get(slug) as number | undefined;
  if (verticalId === undefined) throw new Error(`vertical ${slug} is not in the database; run lantern migrate`);
  return { vertical, verticalId };
}

function describeAuthor(author: AuthorReport): string {
  if (author.error !== null) return `${author.author}: skipped (${author.error})`;
  const count = (status: string) => author.books.filter((b) => b.outcome.status === status).length;
  const inserted = author.books.reduce((n, b) => n + (b.outcome.status === 'harvested' ? b.outcome.inserted : 0), 0);
  return `${author.author}: ${author.listedEntries} listed on Wikiquote; books harvested ${count('harvested')}, already picked ${count('already-picked')}, skipped ${count('skipped')}, failed ${count('failed')}; quotes inserted ${inserted}`;
}

program
  .command('migrate')
  .description('Apply pending migrations and sync config/ into the database')
  .action(async () => {
    const db = openDb(paths.db);
    const { applied } = migrate(db, paths.migrations);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'migrations: up to date');
    const counts = await runStage(db, { stage: 'migrate' }, () => syncConfig(db, loadConfig(paths.root)));
    console.log(`verticals: ${JSON.stringify(counts.verticals)}`);
    console.log(`channels:  ${JSON.stringify(counts.channels)}`);
    log.info('migrate complete', { applied, counts });
  });

program
  .command('harvest')
  .description('Pull raw quotes from public-domain texts for a vertical; exits 1 if an author was skipped or a book failed')
  .requiredOption('--vertical <slug>', 'the vertical to harvest')
  .option('--limit <n>', 'start no new book once this many quotes have been inserted', '25')
  .option('--refresh', 'ignore cached responses and fetch again')
  .action(async (opts: { vertical: string; limit: string; refresh?: boolean }) => {
    const limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer, got ${opts.limit}`);
    const db = openMigratedDb();
    const { vertical, verticalId } = findVertical(db, opts.vertical);
    const harvest = vertical.harvest;
    if (harvest === undefined) throw new Error(`vertical ${vertical.slug} has no harvest section`);
    if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('ANTHROPIC_API_KEY is not set; the passage picker needs it');

    const get = createHttpGet({
      cacheDir: paths.cache,
      refresh: opts.refresh === true,
      http: {
        userAgent: buildUserAgent(process.env.LANTERN_CONTACT, USER_AGENT_VERSION),
        // Gutendex can take more than a minute to answer a search.
        timeoutMs: 180_000,
        onRetry: (event) => log.warn('http retry', { ...event, url: redactUrl(event.url) }),
      },
    });
    // A pick only reads, so retrying it is safe; the timeout keeps one stuck batch from stalling a cron run.
    const client = new Anthropic({ timeout: 120_000, maxRetries: 3 });
    const report = await runStage(db, { stage: 'harvest', verticalId }, () =>
      harvestVertical({
        db,
        verticalId,
        harvest,
        get,
        endpoints: DEFAULT_ENDPOINTS,
        pick: anthropicPick(client, harvest.picker.model),
        prompt: loadPickPrompt(paths.root),
        limit,
        log,
      }),
    );
    for (const author of report.authors) console.log(describeAuthor(author));
    console.log(`inserted: ${report.inserted}`);
    const trouble = report.authors.some((a) => a.error !== null || a.books.some((b) => b.outcome.status === 'failed'));
    if (trouble) process.exitCode = 1;
  });

program
  .command('verify')
  .description('Decide raw quotes for a vertical with the attribution gates; exits 1 if a quote has malformed evidence')
  .requiredOption('--vertical <slug>', 'the vertical to verify')
  .option('--retry-insufficient', 'first reopen quotes rejected only for insufficient evidence')
  .action(async (opts: { vertical: string; retryInsufficient?: boolean }) => {
    const db = openMigratedDb();
    const { verticalId } = findVertical(db, opts.vertical);
    const report = await runStage(db, { stage: 'verify', verticalId }, () =>
      verifyVertical(db, verticalId, { retryInsufficient: opts.retryInsufficient === true, log }),
    );
    if (report.reopened > 0) console.log(`reopened: ${report.reopened}`);
    console.log(`verified: ${report.verified}`);
    console.log(`rejected: ${JSON.stringify(report.rejected)}`);
    console.log(`left raw: ${report.unchecked} without a Wikiquote check, ${report.malformed} with malformed evidence`);
    if (report.malformed > 0) process.exitCode = 1;
  });

program
  .command('doctor')
  .description('Report system health; exits 1 if any check fails')
  .option('--json', 'emit JSON instead of a table')
  .action((opts: { json?: boolean }) => {
    const db = openDb(paths.db);
    const results = runChecks({
      db,
      root: paths.root,
      migrationsDir: paths.migrations,
      env: process.env,
      now: new Date(),
    });
    console.log(opts.json ? JSON.stringify(results, null, 2) : formatReport(results));
    log.info('doctor complete', { results });
    process.exitCode = exitCode(results);
  });

program.parseAsync().catch((err: unknown) => {
  if (err instanceof CommanderError) {
    // Commander has already printed its message (unknown command, bad option, help) to the terminal.
    if (err.exitCode !== 0) log.error('command rejected', { code: err.code, message: err.message });
    process.exitCode = err.exitCode;
    return;
  }
  log.error('command failed', { err });
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npx vitest run tests/cli.test.ts`, then `npm test` and `npm run typecheck`.

Expected:
- `cli.test.ts` passes: the existing tests plus the 4 new ones.
- The suite reports 473 tests across 30 files.
- Typecheck exits 0.

These tests spawn the CLI. Under full-suite load, the existing quote-gate property test once exceeded its 5 s timeout in the scratch run; it passed on the reruns. If a timeout appears, rerun once and report it. Do not change that test.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat(cli): lantern harvest and lantern verify with startup checks and explicit timeouts

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task M6: Spec and plan status

**Files:**
- Modify: `claude.md`, `plan.md`

**Interfaces:** none.

**Why:** Spec §15 says a stale CLAUDE.md is worse than none.
- §6 lacks the two new tables.
- §7 does not yet say what the commands do on failure, re-run, `--limit`, `--refresh` or `--retry-insufficient`.

Both files already contain non-ASCII characters. Use the Edit tool, never re-encode, and keep 0 CR bytes.

- [ ] **Step 1: `claude.md`, section 6: new tables**

Replace exactly:

```
-- Source imagery, before composition.
```

with:

```
-- The Wikiquote Misattributed/Disputed check made for a quote before it was inserted.
CREATE TABLE quote_checks (
  id             INTEGER PRIMARY KEY,
  item_id        INTEGER NOT NULL REFERENCES items(id),
  check_name     TEXT NOT NULL,         -- 'wikiquote'
  page           TEXT NOT NULL,         -- the page whose sections were checked
  checked_at     TEXT NOT NULL,
  UNIQUE(item_id, check_name)
);

-- A book whose candidates the picker has judged with this prompt and model; re-runs skip it.
CREATE TABLE book_picks (
  id             INTEGER PRIMARY KEY,
  vertical_id    INTEGER NOT NULL REFERENCES verticals(id),
  gutenberg_id   INTEGER NOT NULL,
  prompt_sha256  TEXT NOT NULL,
  model          TEXT NOT NULL,
  batches        INTEGER NOT NULL,
  failed_batches INTEGER NOT NULL,
  picked         INTEGER NOT NULL,
  picked_at      TEXT NOT NULL,
  UNIQUE(vertical_id, gutenberg_id, prompt_sha256, model)
);

-- Source imagery, before composition.
```

- [ ] **Step 2: `claude.md`, section 7: harvest paragraph**

Replace exactly:

```
book without such a heading is skipped. A Claude picker chooses among them by
number; it never supplies text.
```

with:

```
book without such a heading is skipped. A Claude picker chooses among them by
number; it never supplies text. Each author's Wikiquote page is read first; if
it cannot be read, that author is skipped, so no quote is inserted without the
Misattributed and Disputed check, which is recorded in `quote_checks`. A book
already picked with the same prompt and model is skipped (`book_picks`), so a
re-run spends nothing on it. `--limit` stops the run starting new books once
that many quotes are in, and `--refresh` ignores cached responses. The command
exits 1 when an author is skipped or a book fails.
```

- [ ] **Step 3: `claude.md`, section 7: verify paragraph**

Replace exactly:

```
Runs the attribution gates (§8) on each raw item's stored `item_evidence`.
Promotes to `verified` with `sources` rows, or marks `rejected` with a reason.
```

with:

```
Runs the attribution gates (§8) on each raw item's stored `item_evidence`.
A raw quote without a recorded Wikiquote check, or with a malformed evidence
row, is left raw and counted, and a malformed row makes the command exit 1.
Promotes to `verified` with `sources` rows, or marks `rejected` with a reason.
```

- [ ] **Step 4: `claude.md`, section 7: retry flag**

Replace exactly:

```
reopened to `raw` and verified again once better evidence exists. Every other
rejection is final.
```

with:

```
reopened to `raw` and verified again once better evidence exists (with
`--retry-insufficient`). Every other rejection is final.
```

- [ ] **Step 5: `plan.md`, status line**

Replace exactly:

```
The `lantern harvest` and `lantern verify` commands, with their network fetches, subject rows and evidence inserts, come next.
```

with:

```
The `lantern harvest` and `lantern verify` commands, with their network fetches, subject rows and evidence inserts, come next.

> **Status:** the `lantern harvest` and `lantern verify` commands (2.1 wiring, 2.3) are built on branch `phase-2-commands` (docs/plans/phase-2-commands.md, Tasks M1-M6): author subjects bound by Wikidata id, the Wikiquote check before any insert (`quote_checks`), per-book picks remembered (`book_picks`), cached Gutendex, Gutenberg and Wikiquote fetches, and `verify` deciding only checked quotes, with `--retry-insufficient`. Everything is tested against local servers; the first live harvest is the user's to run.
```

- [ ] **Verify**

Before editing, record `grep -cP '[^\x00-\x7F]' claude.md plan.md`. After editing, run:

```bash
grep -c 'CREATE TABLE quote_checks' claude.md
grep -c 'CREATE TABLE book_picks' claude.md
grep -c 'exits 1 when an author is skipped or a book fails.' claude.md
grep -c 'docs/plans/phase-2-commands.md' plan.md
grep -cP '[^\x00-\x7F]' claude.md plan.md
tr -cd '\r' < claude.md | wc -c
tr -cd '\r' < plan.md | wc -c
git diff --stat
```

Expected:
- `1` for each of the four content checks.
- Non-ASCII line counts unchanged.
- `0` CR bytes in both files.
- The diff touches only `claude.md` and `plan.md`.

- [ ] **Commit**

```bash
git add claude.md plan.md
git commit -m "docs: harvest state tables and the harvest and verify commands' behaviour; plan status

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.
