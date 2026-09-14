# Phase 2 Harvest Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the offline core of milestone 2.1, the Gutendex harvester:

- **Config:** the `harvest` section in the literature vertical config, holding the four chosen authors and the picker settings.
- **Gutenberg stripping:** remove the Project Gutenberg wrapper from a book's text.
- **Candidate extraction:** extract verbatim candidate passages.
- **Book filtering:** pick harvestable books from Gutendex results.
- **Evidence storage:** a table that stores harvested quote evidence until `lantern verify` runs.
- **Spec updates:** the user's verbatim-excerpt decision and the corrected attribution-conflict sentence.

Everything here is pure or local SQLite. There is no network, no Claude call, and no CLI command. Those come in the next plan: the Claude picker, the Wikiquote check (2.2), and `lantern harvest` / `lantern verify` (2.3).

**User decisions this plan implements (2026-09-13):**
- **Canonical quote body:** a published quote is the verbatim passage from the primary source, with whitespace tidied only.
- **First authors:** Charles Dickens, Jane Austen, Mark Twain and Oscar Wilde, prose only.
- **Picker model:** `claude-sonnet-5`, recorded in config now. The picker itself comes in the next plan.

**Architecture:** new modules under `src/harvest/`, plus one migration.
- `gutenberg-text.ts` strips the wrapper.
- `candidates.ts` cuts sentences as exact whitespace-tidied slices of the source text. The eventual picker may only choose among these, never write text.
- `gutendex.ts` validates a results page with zod and applies the filter rules.
- `migrations/005_item_evidence.sql` and `src/db/evidence.ts` persist `QuoteEvidence` between the harvest and verify stages (spec §7: state lives in SQLite between stages).

**Tech Stack:** Node 26, TypeScript 7 (strict, nodenext), vitest 5, better-sqlite3 13, zod 4, yaml. No new dependencies.

**Spec:** `claude.md`. The relevant sections are:
- §2: never publish an unverified quote; fail closed.
- §5–§6: data model.
- §7: harvest writes `raw` items; dedupe on `body_hash`.
- §8: tier 1 is the exact string located in a public-domain full text; store the work, the location, and the matched excerpt.
- §15: prompts in files; verification code gets tests first.

The parent plan is `plan.md` Part C. This plan closes these rows: **Canonical quote body** (review I2b) and **Novel-sized fixtures** (the size policy part).

**Evidence gathered before this plan (details in `.superpowers/sdd/phase-2-guardrails/progress.md`):**
- **Gutendex search:** `results[]` has `id`, `title`, `authors[{name: "Dickens, Charles", birth_year, death_year}]`, `editors`, `translators`, `subjects`, `bookshelves`, `languages`, `copyright`, `media_type`, `formats{mime: url}` and `download_count`. Results are paginated through `next`. Real edge cases:
  - fuzzy matches by other authors (Thornton Wilder for "wilde")
  - duplicate editions
  - Sound editions
  - compilations with editors
  - co-authored books
- **Gutenberg text:** `ebooks/98.txt.utf-8` redirects with a 302 to `cache/epub/98/pg98.txt`, which is 807 KB. The text uses CRLF line endings and has no BOM. It carries markers of the form `*** START OF THE PROJECT GUTENBERG EBOOK <TITLE> ***` and the matching `*** END OF ...`.
- **Offline probe on *A Tale of Two Cities*:** a paragraph-to-sentence splitter (8–40 words, no dialogue quote marks, not all caps) gave 3029 candidates.
  - `locateQuoteIn` found all 3029.
  - `normalizeText` equality held for all 3029.
  - Every candidate is an exact whitespace-tidied slice of the source.
  - The matcher's own excerpt drops leading and trailing punctuation. That is why `items.body` must be the candidate slice, not `located.excerpt`.
- **Wikidata years match Gutendex years exactly:**
  - Dickens Q5686: 1812–1870
  - Austen Q36322: 1775–1817
  - Twain Q7245: 1835–1910
  - Wilde Q30875: 1854–1900

**Deliberately NOT in this plan (next plan):**
- the Claude passage picker and the `@anthropic-ai/sdk` dependency
- the `prompts/literature/pick.md` prompt
- the Wikiquote Misattributed/Disputed parser (2.2)
- `lantern harvest` and `lantern verify` (2.3)
- fetching and caching real Gutenberg texts
- subject rows for authors

## Global Constraints

- **Language and modules:** Node.js + TypeScript, ESM, strict mode on. Relative imports use `.js` extensions.
- **Unicode:** every non-ASCII character in code and tests must be a `\u` escape.
  - Verify with `git diff | grep '^+' | grep -P '[^\x00-\x7F]'` on `.ts` files; it must print nothing.
  - Markdown and SQL comments keep ASCII.
  - Existing characters in `claude.md` and `plan.md` must not be re-encoded.
- **Line endings:** count CR bytes with `tr -cd '\r' < FILE | wc -c`. Never use `grep $'\r'`, which misreports in this shell.
- **Fail closed:** when in doubt, a book is not harvestable, a candidate is dropped, and evidence is refused.
- **No real internet:** tests use inline strings or small fixtures. Never read or write under `data/`, the real `logs/`, or `.env`.
- **Frozen migrations:** migrations 001–004 are frozen; never edit them. New schema goes in `migrations/005_item_evidence.sql`.
- **Never commit** `.env`, `data/`, `logs/`, or `.superpowers/`.
- **Commit trailers:** every commit message ends with a blank line, then:
  - `Co-Authored-By: <the authoring model's attribution line from its environment>`
  - `Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v`

  Verify with `git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'`, which must print `2`.
- **Branch:** `phase-2-harvest`, created from `phase-2-guardrails` at cb6ee32. The baseline is 377 tests passing across 17 files. The controller pushes after the final review; implementers never push.

### File map

```
config/verticals/literature.yaml        # K1: harvest.authors (4), harvest.picker
src/config/schema.ts                    # K1: harvestSchema inside verticalSchema (optional key)
tests/config/harvest-config.test.ts     # K1 (new)
src/harvest/gutenberg-text.ts           # K2: stripGutenbergWrapper, hasGutenbergEndMarker
tests/harvest/gutenberg-text.test.ts    # K2 (new)
src/harvest/candidates.ts               # K3: extractCandidates (verbatim tidied sentence slices)
tests/harvest/candidates.test.ts        # K3 (new)
src/harvest/gutendex.ts                 # K4: gutendexPageSchema, harvestableBooks, plainTextUrl
tests/harvest/gutendex.test.ts          # K4 (new)
migrations/005_item_evidence.sql        # K5: item_evidence table
src/db/evidence.ts                      # K5: insertEvidence, loadEvidence
tests/db/evidence.test.ts               # K5 (new)
claude.md                               # K6: sections 6 and 8
plan.md                                 # K6: status line
.gitignore                              # K6: data/cache/gutenberg-text/
```

### Test counts

| After | Suite |
|---|---|
| baseline | 377 |
| K1 | 383 |
| K2 | 388 |
| K3 | 393 |
| K4 | 401 |
| K5 | 406 |
| K6 | 406 |

---

### Task K1: `harvest` section in the vertical config

**Files:**
- Modify: `src/config/schema.ts`, `config/verticals/literature.yaml`
- Test: `tests/config/harvest-config.test.ts` (new)

**Interfaces:**
- Produces: `export const harvestAuthorSchema`, `export const harvestSchema`, and `export type HarvestConfig = z.infer<typeof harvestSchema>`.
- `verticalSchema` gains an optional `harvest: harvestSchema`. The type is `{ authors: { name: string; gutendex_name: string; wikidata_id: string; birth_year: number; death_year: number }[]; picker: { model: string; batch_size: number; max_batches_per_work: number } }`.
- K4 consumes `gutendex_name`, `birth_year` and `death_year`.

**Why:** Plan milestone 2.1 says the author list lives in `literature.yaml` under a new `harvest.authors` key. The schemas are strict, so an unknown key is rejected today. The user chose the four authors and `claude-sonnet-5` on 2026-09-13.

The author's name and years must match Gutendex exactly. That match is how `authorMatches` gets set (the spec's §2.1 cross-check against Wikidata). The Wikidata years were verified to equal the Gutendex years for all four authors.

Picker limits cap Claude spend per book. The probe measured about 45 input tokens per candidate, so 150 candidates per batch across 6 batches is roughly 40k input tokens per work.

- [ ] **Step 1: Write the failing tests**

Create `tests/config/harvest-config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.js';
import { harvestSchema } from '../../src/config/schema.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const valid = {
  authors: [
    { name: 'Charles Dickens', gutendex_name: 'Dickens, Charles', wikidata_id: 'Q5686', birth_year: 1812, death_year: 1870 },
  ],
  picker: { model: 'claude-sonnet-5', batch_size: 150, max_batches_per_work: 6 },
};

describe('harvest config', () => {
  it('loads the four chosen literature authors and the picker settings', () => {
    const literature = loadConfig(ROOT).verticals.find((v) => v.slug === 'literature');
    expect(literature?.harvest?.authors.map((a) => a.wikidata_id)).toEqual(['Q5686', 'Q36322', 'Q7245', 'Q30875']);
    expect(literature?.harvest?.authors.map((a) => a.gutendex_name)).toEqual([
      'Dickens, Charles',
      'Austen, Jane',
      'Twain, Mark',
      'Wilde, Oscar',
    ]);
    expect(literature?.harvest?.picker).toEqual({ model: 'claude-sonnet-5', batch_size: 150, max_batches_per_work: 6 });
  });

  it('accepts a valid harvest section', () => {
    expect(harvestSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['a lowercase Wikidata id', { authors: [{ ...valid.authors[0]!, wikidata_id: 'q5686' }] }],
    ['a Gutendex name not in "Surname, Given" form', { authors: [{ ...valid.authors[0]!, gutendex_name: 'Charles Dickens' }] }],
    ['a death year before the birth year', { authors: [{ ...valid.authors[0]!, death_year: 1800 }] }],
    ['an unknown key', { extra: true }],
  ])('rejects %s', (_label, change) => {
    expect(harvestSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/config/harvest-config.test.ts`

Expected: the import of `harvestSchema` fails because it does not exist yet. With a temporary stub, the load test would fail for a different reason: `literature.yaml` has no `harvest` key. Record the failure output.

- [ ] **Step 3: Implement**

In `src/config/schema.ts`, directly above `export const verticalSchema`, add:

```ts
export const harvestAuthorSchema = z
  .strictObject({
    name: z.string().min(1),
    /** Exactly as Gutendex lists the author ("Surname, Given"); matched with the years to set authorMatches. */
    gutendex_name: z.string().regex(/^[^,]+, [^,]+$/, 'must be "Surname, Given" as Gutendex lists it'),
    wikidata_id: z.string().regex(/^Q[1-9]\d*$/, 'must be a Wikidata Q-number'),
    birth_year: z.number().int(),
    death_year: z.number().int(),
  })
  .refine((a) => a.death_year >= a.birth_year, { message: 'death_year must not be before birth_year', path: ['death_year'] });

export const harvestSchema = z.strictObject({
  authors: z.array(harvestAuthorSchema).min(1),
  picker: z.strictObject({
    model: z.string().min(1),
    batch_size: z.number().int().min(10).max(500),
    max_batches_per_work: z.number().int().min(1).max(50),
  }),
});
```

In `verticalSchema`'s `z.strictObject({ ... })`, add `harvest: harvestSchema.optional(),` directly after the `image` entry.

After the `export type ChannelConfig ...` line, add:

```ts
export type HarvestConfig = z.infer<typeof harvestSchema>;
```

In `config/verticals/literature.yaml`, append this at the end of the file:

```yaml
harvest:
  # Wikidata years equal Gutendex's author years; both must match for authorMatches (spec section 8).
  authors:
    - { name: Charles Dickens, gutendex_name: "Dickens, Charles", wikidata_id: Q5686, birth_year: 1812, death_year: 1870 }
    - { name: Jane Austen, gutendex_name: "Austen, Jane", wikidata_id: Q36322, birth_year: 1775, death_year: 1817 }
    - { name: Mark Twain, gutendex_name: "Twain, Mark", wikidata_id: Q7245, birth_year: 1835, death_year: 1910 }
    - { name: Oscar Wilde, gutendex_name: "Wilde, Oscar", wikidata_id: Q30875, birth_year: 1854, death_year: 1900 }
  picker:
    model: claude-sonnet-5        # user's choice, 2026-09-13
    batch_size: 150               # candidates per Claude call (~45 input tokens each)
    max_batches_per_work: 6       # spend cap per book
```

The YAML comment must be ASCII. Write `spec 8` instead of the section sign if your editor inserts a non-ASCII character.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/config && npm test && npm run typecheck`

Expected:
- All 6 new tests pass (4 of them come from one `it.each`).
- The existing config, doctor and CLI tests pass unchanged. The `harvest` key is optional, and the literature vertical still syncs.
- The full suite has **383** tests across 18 files.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts config/verticals/literature.yaml tests/config/harvest-config.test.ts
git commit -m "feat(config): literature harvest authors and picker settings

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task K2: Strip the Project Gutenberg wrapper

**Files:**
- Create: `src/harvest/gutenberg-text.ts`
- Test: `tests/harvest/gutenberg-text.test.ts` (new)

**Interfaces:**
- Produces: `export class GutenbergMarkerError extends Error`
- Produces: `export function hasGutenbergEndMarker(text: string): boolean`
- Produces: `export function stripGutenbergWrapper(text: string): string`. It returns the text strictly between the START and END marker lines. It throws `GutenbergMarkerError` if either marker is missing, or if END comes before START.
- K3 consumes the stripped body. The next plan uses `hasGutenbergEndMarker` as the text cache's `cacheable` hook.

**Why:**
- **The book sits inside a wrapper.** Every Gutenberg plain text wraps the book in a license header and footer. The probe on #98 found `*** START OF THE PROJECT GUTENBERG EBOOK A TALE OF TWO CITIES ***` at line 27 and the matching `*** END OF ...` at line 15933, with CRLF line endings.
- **The wrapper must never reach candidates.** Quotes must come from the book, never from license text.
- **A missing marker is an error.** It means the download was truncated or the format changed, so the stage refuses rather than guesses (fail closed).
- **The cache check reuses the END marker.** A cache that stores only complete texts (plan.md row **Novel-sized fixtures**: "use the `cacheable` hook to require the Gutenberg END marker") is the same check.

- [ ] **Step 1: Write the failing tests**

Create `tests/harvest/gutenberg-text.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/harvest/gutenberg-text.test.ts`

Expected: the tests fail because the module does not exist yet. Record the error.

- [ ] **Step 3: Implement**

Create `src/harvest/gutenberg-text.ts`:

```ts
/** Marker lines Project Gutenberg puts around every book ("THE" in current files, "THIS" in older ones). */
const START_MARKER = /^\*\*\* ?START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*[ \t]*\r?$/m;
const END_MARKER = /^\*\*\* ?END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*[ \t]*\r?$/m;

export class GutenbergMarkerError extends Error {
  override name = 'GutenbergMarkerError';
}

/** True when the text carries the END marker, i.e. it was downloaded completely. */
export function hasGutenbergEndMarker(text: string): boolean {
  return END_MARKER.test(text);
}

/**
 * The book itself: everything strictly between the START and END marker lines. A missing or
 * out-of-order marker means a truncated download or an unknown format, so this refuses rather than
 * guessing, and license text can never become a quote.
 */
export function stripGutenbergWrapper(text: string): string {
  const start = START_MARKER.exec(text);
  const end = END_MARKER.exec(text);
  if (start === null) throw new GutenbergMarkerError('Project Gutenberg START marker not found');
  if (end === null) throw new GutenbergMarkerError('Project Gutenberg END marker not found (truncated text?)');
  const from = start.index + start[0].length;
  if (end.index < from) throw new GutenbergMarkerError('Project Gutenberg END marker precedes the START marker');
  return text.slice(from, end.index);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/harvest/gutenberg-text.test.ts && npm test && npm run typecheck`

Expected:
- 5/5 tests pass.
- The full suite has **388** tests across 19 files.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/harvest/gutenberg-text.ts tests/harvest/gutenberg-text.test.ts
git commit -m "feat(harvest): strip the Project Gutenberg wrapper, refusing truncated texts

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task K3: Verbatim candidate passages

**Files:**
- Create: `src/harvest/candidates.ts`
- Test: `tests/harvest/candidates.test.ts` (new)

**Interfaces:**
- Consumes: the stripped body from K2 (any string).
- Produces:
  - `export interface CandidateOptions { minWords?: number; maxWords?: number }`
  - `export function extractCandidates(body: string, options?: CandidateOptions): string[]`

  Candidates come back in document order, deduplicated. Each one is the source sentence with its whitespace runs collapsed to single spaces and the ends trimmed. Punctuation, capitalization and typography stay exactly as the source has them. The next plan's picker receives these numbered and may only return their numbers.

**Why:** The user decided a published quote is the verbatim source passage, with only its whitespace tidied. The probe on *A Tale of Two Cities* confirmed that cutting candidates directly from the text satisfies this.
- It produced 3029 candidates, and every one is an exact whitespace-tidied slice of the source.
- `locateQuoteIn` finds all of them.
- The matcher's own `excerpt` drops leading and trailing punctuation, so `items.body` must be this candidate, not the located excerpt.

The filters keep the picker's input to lines that stand alone:
- 8 to 40 words
- not in a paragraph that contains a double-quote mark, straight or curly. A sentence split off a dialogue line loses its speaker and context. A controller probe showed a sentence-level check would keep "asked the gentleman, looking out of the coach window..." after the quoted line, so whole paragraphs are skipped.
- not all capitals (headings)

- [ ] **Step 1: Write the failing tests**

Create `tests/harvest/candidates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractCandidates } from '../../src/harvest/candidates.js';
import { locateQuote, normalizeText } from '../../src/verify/normalize.js';

const BODY = [
  'CHAPTER I',
  'The Period',
  '',
  'There were a king with a large jaw and a queen with a plain face, on the',
  'throne of England; there were a king with a large jaw and a queen with a',
  'fair face, on the throne of France. It was cold.',
  '',
  '\u201CWhat is the matter?\u201D asked the gentleman, looking out of the coach window for a while.',
  '',
  'In both countries it was clearer than crystal to the lords of the State',
  'preserves of loaves and fishes, that things in general were settled for ever.',
].join('\r\n');

describe('extractCandidates', () => {
  it('cuts sentences of 8 to 40 words as whitespace-tidied slices of the source, across hard line wraps', () => {
    expect(extractCandidates(BODY)).toEqual([
      'There were a king with a large jaw and a queen with a plain face, on the throne of England; there were a king with a large jaw and a queen with a fair face, on the throne of France.',
      'In both countries it was clearer than crystal to the lords of the State preserves of loaves and fishes, that things in general were settled for ever.',
    ]);
  });

  it('keeps every candidate verbatim: the source punctuation is kept, and the matcher locates it', () => {
    const tidiedSource = BODY.replace(/\s+/g, ' ');
    for (const candidate of extractCandidates(BODY)) {
      expect(tidiedSource).toContain(candidate);
      const located = locateQuote(candidate, BODY);
      expect(located).not.toBeNull();
      expect(normalizeText(located!.excerpt)).toBe(normalizeText(candidate));
    }
  });

  it('skips dialogue, headings and sentences outside the word bounds', () => {
    const candidates = extractCandidates(BODY);
    expect(candidates.some((c) => c.includes('What is the matter'))).toBe(false);
    expect(candidates).not.toContain('CHAPTER I');
    expect(candidates).not.toContain('It was cold.');
  });

  it('honours custom word bounds', () => {
    expect(extractCandidates(BODY, { minWords: 1, maxWords: 3 })).toEqual(['It was cold.']);
  });

  it('returns each repeated sentence once', () => {
    const twice = `${'A quiet sentence that the author happened to repeat word for word.'}\n\n${'A quiet sentence that the author happened to repeat word for word.'}`;
    expect(extractCandidates(twice)).toEqual(['A quiet sentence that the author happened to repeat word for word.']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/harvest/candidates.test.ts`

Expected: failure, because the module does not exist yet. Record the error.

- [ ] **Step 3: Implement**

Create `src/harvest/candidates.ts`:

```ts
export interface CandidateOptions {
  minWords?: number;
  maxWords?: number;
}

/** A sentence: text up to and including its terminal punctuation and any closing quote mark. */
const SENTENCE = /[^.!?]+(?:[.!?]+["'\u201D\u2019]?)/g;
/** Double quote marks signal dialogue, which needs its speaker and context to stand alone. */
const DIALOGUE = /["\u201C\u201D]/;

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Candidate passages for the picker. Each is a sentence cut from the source with its whitespace
 * tidied and nothing else changed, so a chosen candidate is already the verbatim quote body
 * (user decision 2026-09-13; spec section 8). Paragraphs are split on blank lines, so hard-wrapped
 * lines join into one sentence.
 */
export function extractCandidates(body: string, options: CandidateOptions = {}): string[] {
  const minWords = options.minWords ?? 8;
  const maxWords = options.maxWords ?? 40;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const paragraph of body.split(/\r?\n[ \t]*\r?\n/)) {
    const text = tidy(paragraph);
    if (text.length === 0) continue;
    // A sentence split off a dialogue line loses its speaker and context, so skip the whole paragraph.
    if (DIALOGUE.test(text)) continue;
    for (const match of text.matchAll(SENTENCE)) {
      const sentence = match[0].trim();
      const words = sentence.split(' ').length;
      if (words < minWords || words > maxWords) continue;
      if (sentence === sentence.toUpperCase()) continue;
      if (seen.has(sentence)) continue;
      seen.add(sentence);
      out.push(sentence);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/harvest/candidates.test.ts && npm test && npm run typecheck`

Expected:
- 5/5 tests pass.
- The full suite has **393** tests across 20 files.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/harvest/candidates.ts tests/harvest/candidates.test.ts
git commit -m "feat(harvest): verbatim candidate sentences cut from the source text

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task K4: Harvestable books from a Gutendex page

**Files:**
- Create: `src/harvest/gutendex.ts`
- Test: `tests/harvest/gutendex.test.ts` (new)

**Interfaces:**
- Consumes (from K1): `HarvestConfig` from `../config/schema.js`.
- Produces:
  - `export const gutendexPageSchema` and `export const gutendexBookSchema` (zod objects; unknown fields such as `summaries` are allowed)
  - `export type GutendexBook`
  - `export type HarvestAuthor = HarvestConfig['authors'][number]`
  - `export const PLAIN_TEXT_FORMAT = 'text/plain; charset=utf-8'`
  - `export function plainTextUrl(book: GutendexBook): string | null`
  - `export function isHarvestable(book: GutendexBook, author: HarvestAuthor): boolean`
  - `export function harvestableBooks(books: readonly GutendexBook[], author: HarvestAuthor): GutendexBook[]`, sorted by id, keeping the lowest id per normalized title

**Why:** Real Gutendex searches return far more than the author's own books, in these five ways:
- **Fuzzy matches by other authors:** "wilde" also returns Thornton Wilder, and Guy Thorne's biography titled "Oscar Wilde".
- **Duplicate editions:** Pride and Prejudice appears as #1342, #42671 with an editor, and #26301 as Sound.
- **Compilations:** "The Complete Project Gutenberg Works of Jane Austen" and "Index of the Project Gutenberg Works of Oscar Wilde".
- **Co-authored books:** The Gilded Age, by Twain and Warner.
- **Poetry:** "Poems, with The Ballad of Reading Gaol".

Spec §2.1 cross-checks the Gutendex author against the subject. An exact name plus birth and death years check is how `authorMatches` stays truthful, and it fails closed.

A controller probe of exactly this code against the saved real first pages kept 1 book for Dickens, 9 for Austen, 22 for Twain and 14 for Wilde. It dropped every observed edge case, and all 8 tests below pass.

- [ ] **Step 1: Write the failing tests**

Create `tests/harvest/gutendex.test.ts`:

```ts
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

  it('keeps the lowest id among editions with the same title', () => {
    expect(ids(harvestableBooks([book({ id: 26740, title: 'A Tale of Two Cities!' }), book({ id: 98 })], DICKENS))).toEqual([98]);
  });

  it('rejects a malformed page', () => {
    expect(() => gutendexPageSchema.parse({ count: 1, next: null, previous: null })).toThrow(ZodError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/harvest/gutendex.test.ts`

Expected: they fail because the module does not exist yet. Record the error.

- [ ] **Step 3: Implement**

Create `src/harvest/gutendex.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/harvest/gutendex.test.ts && npm test && npm run typecheck`

Expected:
- 8/8 tests pass.
- The full suite has **401** tests across 21 files.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/harvest/gutendex.ts tests/harvest/gutendex.test.ts
git commit -m "feat(harvest): select an author's own public-domain prose from Gutendex results

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task K5: Store harvested evidence until verify runs

**Files:**
- Create: `migrations/005_item_evidence.sql`, `src/db/evidence.ts`
- Test: `tests/db/evidence.test.ts` (new)

**Interfaces:**
- Consumes: `QuoteEvidence` from `../verify/quote-gate.js`, and `Db` from `./connection.js`.
- Produces:
  - `export class EvidenceError extends Error`
  - `export function insertEvidence(db: Db, itemId: number, evidence: QuoteEvidence, now?: Date): number`, which returns the new row id
  - `export function loadEvidence(db: Db, itemId: number): QuoteEvidence[]`, which returns evidence in insertion order and throws `EvidenceError` for a row that is malformed for its kind
- The next plan uses them in two places: `lantern harvest` writes one `primary-text` row per new item, and `lantern verify` calls `loadEvidence`, then `verifyQuoteItem`.

**Why:**
- **Spec §7** makes harvest and verify separate, idempotent stages, with state kept in SQLite between them.
- **Spec §8** says to store the work, the location and the matched excerpt.
- **What harvest learns has nowhere to live yet.** At harvest time the stage knows the Gutenberg URL, the excerpt and the author cross-check, but `items` has no column for any of them. Re-deriving them at verify time from `work_title` would be fragile.
- **One row per piece of evidence** mirrors the `QuoteEvidence` union exactly, so verify can pass the rows straight to the gate.
- **CHECK constraints** reject an unknown kind, an `author_matches` value other than 0 or 1, and a blank citation. A foreign key ties each row to its item.
- **Loading fails closed.** A row written by raw SQL that lacks a field its kind requires is refused, not guessed.
- **The migration was checked against the real migration runner.** It was applied after migrations 001–004. Doctor's trigger count stays at 13, and drift reports clean.

- [ ] **Step 1: Write the failing tests**

Create `tests/db/evidence.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { EvidenceError, insertEvidence, loadEvidence } from '../../src/db/evidence.js';
import { decideQuote, type QuoteEvidence } from '../../src/verify/quote-gate.js';
import { seedItem, testDb } from '../helpers/db.js';

const QUOTE = 'It was the best of times, it was the worst of times';

const ALL: QuoteEvidence[] = [
  {
    kind: 'primary-text',
    citation: 'Charles Dickens, A Tale of Two Cities (1859)',
    url: 'https://www.gutenberg.org/cache/epub/98/pg98.txt',
    excerpt: QUOTE,
    authorMatches: true,
  },
  { kind: 'scholarly', citation: 'Oxford World\'s Classics edition, p. 5', authorMatches: true },
  { kind: 'reference', citation: 'Wikiquote: Charles Dickens', url: 'https://en.wikiquote.org/wiki/Charles_Dickens' },
  { kind: 'listed-misattributed', citation: 'Wikiquote: Misattributed' },
  { kind: 'attribution-conflict', citation: 'Some anthology', otherAuthor: 'Thomas Carlyle' },
];

describe('item evidence', () => {
  it('round-trips every evidence kind exactly, in insertion order', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    for (const evidence of ALL) insertEvidence(db, itemId, evidence);
    expect(loadEvidence(db, itemId)).toEqual(ALL);
  });

  it('feeds the quote gate unchanged', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    insertEvidence(db, itemId, ALL[0]!);
    expect(decideQuote(QUOTE, loadEvidence(db, itemId))).toMatchObject({ status: 'verified' });
  });

  it('loads an empty list for an item with no evidence', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    expect(loadEvidence(db, itemId)).toEqual([]);
  });

  it('refuses evidence for an item that does not exist', () => {
    const db = testDb();
    expect(() => insertEvidence(db, 9999, ALL[1]!)).toThrow(/FOREIGN KEY/);
  });

  it('refuses to load a row that is malformed for its kind', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    db.prepare(
      "INSERT INTO item_evidence (item_id, kind, citation, recorded_at) VALUES (?, 'primary-text', 'written by raw SQL', '2026-09-13T00:00:00.000Z')",
    ).run(itemId);
    expect(() => loadEvidence(db, itemId)).toThrow(EvidenceError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/db/evidence.test.ts`

Expected: the tests fail because `src/db/evidence.ts` does not exist yet. Record the error.

- [ ] **Step 3: Implement**

Create `migrations/005_item_evidence.sql`:

```sql
-- Evidence the harvest stage gathers for a quote item, read back by the verify stage
-- (spec section 7: state lives in SQLite between stages). One row per QuoteEvidence value.
CREATE TABLE item_evidence (
  id             INTEGER PRIMARY KEY,
  item_id        INTEGER NOT NULL REFERENCES items(id),
  kind           TEXT NOT NULL CHECK (kind IN ('primary-text', 'scholarly', 'reference', 'listed-misattributed', 'attribution-conflict')),
  citation       TEXT NOT NULL CHECK (length(trim(citation)) > 0),
  url            TEXT,
  excerpt        TEXT,
  author_matches INTEGER CHECK (author_matches IN (0, 1)),
  other_author   TEXT,
  recorded_at    TEXT NOT NULL
);

CREATE INDEX idx_item_evidence_item ON item_evidence(item_id);
```

Create `src/db/evidence.ts`:

```ts
import type { QuoteEvidence } from '../verify/quote-gate.js';
import type { Db } from './connection.js';

export class EvidenceError extends Error {
  override name = 'EvidenceError';
}

interface EvidenceRow {
  kind: string;
  citation: string;
  url: string | null;
  excerpt: string | null;
  author_matches: number | null;
  other_author: string | null;
}

/** Stores one piece of evidence for a quote item; returns the new row id. */
export function insertEvidence(db: Db, itemId: number, evidence: QuoteEvidence, now: Date = new Date()): number {
  const authorMatches =
    evidence.kind === 'primary-text' || evidence.kind === 'scholarly' ? (evidence.authorMatches ? 1 : 0) : null;
  const excerpt =
    evidence.kind === 'primary-text' || evidence.kind === 'scholarly' || evidence.kind === 'reference'
      ? (evidence.excerpt ?? null)
      : null;
  const otherAuthor = evidence.kind === 'attribution-conflict' ? evidence.otherAuthor : null;
  return Number(
    db
      .prepare(
        `INSERT INTO item_evidence (item_id, kind, citation, url, excerpt, author_matches, other_author, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(itemId, evidence.kind, evidence.citation, evidence.url ?? null, excerpt, authorMatches, otherAuthor, now.toISOString())
      .lastInsertRowid,
  );
}

/**
 * The stored evidence for an item, in insertion order, rebuilt as QuoteEvidence for the gate. A row
 * missing a field its kind requires (for example one written by hand in SQL) throws instead of
 * being guessed at.
 */
export function loadEvidence(db: Db, itemId: number): QuoteEvidence[] {
  const rows = db
    .prepare(
      'SELECT kind, citation, url, excerpt, author_matches, other_author FROM item_evidence WHERE item_id = ? ORDER BY id',
    )
    .all(itemId) as EvidenceRow[];
  return rows.map((row): QuoteEvidence => {
    const url = row.url === null ? {} : { url: row.url };
    const excerpt = row.excerpt === null ? {} : { excerpt: row.excerpt };
    switch (row.kind) {
      case 'primary-text':
        if (row.excerpt === null || row.author_matches === null) {
          throw new EvidenceError(`primary-text evidence for item ${itemId} lacks an excerpt or author_matches`);
        }
        return { kind: 'primary-text', citation: row.citation, ...url, excerpt: row.excerpt, authorMatches: row.author_matches === 1 };
      case 'scholarly':
        if (row.author_matches === null) throw new EvidenceError(`scholarly evidence for item ${itemId} lacks author_matches`);
        return { kind: 'scholarly', citation: row.citation, ...url, ...excerpt, authorMatches: row.author_matches === 1 };
      case 'reference':
        return { kind: 'reference', citation: row.citation, ...url, ...excerpt };
      case 'listed-misattributed':
        return { kind: 'listed-misattributed', citation: row.citation, ...url };
      case 'attribution-conflict':
        if (row.other_author === null) {
          throw new EvidenceError(`attribution-conflict evidence for item ${itemId} lacks other_author`);
        }
        return { kind: 'attribution-conflict', citation: row.citation, ...url, otherAuthor: row.other_author };
      default:
        throw new EvidenceError(`unknown evidence kind ${row.kind} for item ${itemId}`);
    }
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/db && npx vitest run tests/doctor && npm test && npm run typecheck`

Expected:
- 5/5 new tests pass.
- The migrate and doctor tests still pass. Migration 005 adds no triggers, and the healthy-system doctor check still reports 0 warnings.
- The populated-001 migrate test's expected list of later migrations now includes `005_item_evidence.sql`. It derives that list from the directory, so no test edit is needed.
- The full suite has **406** tests across 22 files.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add migrations/005_item_evidence.sql src/db/evidence.ts tests/db/evidence.test.ts
git commit -m "feat(db): item_evidence table holds harvested quote evidence until verify runs

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task K6: Spec, plan status and cache policy

**Files:**
- Modify: `claude.md`, `plan.md`, `.gitignore`

**Interfaces:** none.

**Why:** Spec §15 says to change the spec in the same branch as the code it describes. This task makes four spec and repo changes:
- **Verbatim quote body (§8 tier 1):** the user decided that the item body is the verbatim source passage, and §8 must say so.
- **Conflict wording (§8):** the sentence added by the guardrails fix over-generalizes. A lone source naming a different author rejects as `author-mismatch`. `attribution-conflict` needs an author-matching source alongside it.
- **Schema (§6):** the new `item_evidence` table from K5 must appear in the schema listing.
- **Cache policy:** the size policy from the **Novel-sized fixtures** row needs a `.gitignore` rule. Full Gutenberg texts are about 800 KB each and must never enter git history.

`claude.md` and `plan.md` are Markdown that already contain non-ASCII characters. Do not re-encode anything. Change only what is listed below.

- [ ] **Step 1: Edit `claude.md`**

1. **§6, after the `sources` table.** Find the table that ends with these lines:

   ```
     excerpt       TEXT,                   -- the matched passage, if applicable
     retrieved_at  TEXT NOT NULL
   );
   ```

   Directly after that closing `);` line, insert a blank line and then this block:

   ```sql
   -- Evidence gathered by harvest and read back by verify. One row per piece of evidence.
   CREATE TABLE item_evidence (
     id             INTEGER PRIMARY KEY,
     item_id        INTEGER NOT NULL REFERENCES items(id),
     kind           TEXT NOT NULL,         -- 'primary-text'|'scholarly'|'reference'|'listed-misattributed'|'attribution-conflict'
     citation       TEXT NOT NULL,
     url            TEXT,
     excerpt        TEXT,
     author_matches INTEGER,               -- primary-text and scholarly evidence only
     other_author   TEXT,                  -- attribution-conflict evidence only
     recorded_at    TEXT NOT NULL
   );
   ```

2. **§8, the Tier 1 bullet.** Find the sentence `Store the work, the location, and the matched excerpt.` (it currently wraps across two lines). Directly after it, add this sentence: `The item body is that passage exactly as the source prints it, with only whitespace tidied; punctuation, typography and spelling are never normalized for publication.` Then re-wrap only that bullet to about 80 columns. Keep its two-space continuation indent.

3. **§8, the enforcement paragraph.** Find the sentence that currently wraps as `If any usable source` / `names a different author, the quote is rejected as an attribution conflict.` Replace it with: `If a usable source names a different author, the quote is rejected: as an attribution conflict when another usable source names the attributed author, and as an author mismatch otherwise.` Then re-wrap only that paragraph to about 80 columns.

- [ ] **Step 2: Edit `.gitignore`**

Append these two lines at the end:

```
# Full Project Gutenberg texts (~800 KB each) are cached locally but never committed.
data/cache/gutenberg-text/
```

- [ ] **Step 3: Edit `plan.md`**

Under `### Prerequisites carried from the Part B final review`, find the status line that begins `> **Status:** the **Tier 1/2 host allowlists** row is done`. Directly after it, insert a blank line and then this line:

```markdown
> **Status:** the **Canonical quote body** row is decided by the user (2026-09-13: the item body is the verbatim source passage, whitespace tidied only; spec section 8), and the size-policy part of **Novel-sized fixtures** is done (full Gutenberg texts cache under `data/cache/gutenberg-text/`, which git ignores; tests use small inline texts), on branch `phase-2-harvest` (docs/plans/phase-2-harvest-core.md, Tasks K1-K6). `hasGutenbergEndMarker` exists for the END-marker `cacheable` hook, which the next plan wires into the text fetch.
```

- [ ] **Step 4: Verify**

Before editing, record `grep -cP '[^\x00-\x7F]' claude.md plan.md`. Then, after editing, run:

```bash
grep -c 'CREATE TABLE item_evidence' claude.md
grep -c 'exactly as the source prints it' claude.md
grep -c 'as an author mismatch otherwise' claude.md
grep -c 'names a different author, the quote is rejected as an attribution conflict' claude.md
grep -c 'data/cache/gutenberg-text/' .gitignore
grep -c 'phase-2-harvest' plan.md
grep -cP '[^\x00-\x7F]' claude.md plan.md
tr -cd '\r' < claude.md | wc -c
tr -cd '\r' < plan.md | wc -c
git diff --stat
```

Expected:
- `1` for the first three checks, `0` for the old conflict sentence, `1` for `.gitignore`, and `1` for `plan.md`.
- The two phrase checks may read `0` if the phrase wraps across a line. If so, quote the diff hunk in the report instead.
- The non-ASCII line counts are unchanged, because the new text is ASCII.
- `0` CR bytes in both files.
- The diff touches only `claude.md`, `plan.md` and `.gitignore`.

- [ ] **Step 5: Commit**

```bash
git add claude.md plan.md .gitignore
git commit -m "docs: verbatim quote body, item_evidence schema, precise conflict wording; ignore cached Gutenberg texts

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

## Done when

- Tasks K1-K6 are committed on `phase-2-harvest`.
- The full suite passes with **406** tests across 22 files.
- `npm run typecheck` exits 0.
- No new non-ASCII characters appear in `.ts` files.
- Migrations 001-004 are unchanged, and `migrations/005_item_evidence.sql` is the only new migration.
- Nothing under `data/` is committed.
- The next plan can add the Claude picker, the Wikiquote check and `lantern harvest` / `lantern verify` on top of these modules.

