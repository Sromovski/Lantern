# Phase 2 Picker and Wikiquote Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the remaining offline pieces that `lantern harvest` and `lantern verify` need:
- **Front-matter cut:** drop everything before a book's first chapter or act heading, so prefaces by other writers never become candidates.
- **Claude passage picker:** `claude-sonnet-5` with structured output chooses candidate sentences by number, in batches, with fail-closed id validation. Its prompt lives in `prompts/literature/pick.md`.
- **Wikiquote check (milestone 2.2):** parse an author page's Misattributed and Disputed sections into `listed-misattributed` evidence.

Everything is tested offline. The Anthropic adapter is tested against a local `node:http` server. The next plan wires these modules into the `lantern harvest` and `lantern verify` commands (2.1 wiring, 2.3) and carries the parked prerequisites P2 and P3 from the harvest-core final review.

**User decisions this plan implements (2026-09-13):**
- The picker model is `claude-sonnet-5`, configurable in `config/verticals/literature.yaml`.
- The model only chooses among sentences already cut verbatim from the text and never authors wording.
- The first authors are Dickens, Austen, Twain and Wilde.

**Architecture:**
- `src/harvest/front-matter.ts` is pure and finds where the author's own text begins.
- `src/harvest/picker.ts` is pure. It batches candidates, builds the user message, validates the model's ids and maps them back to the candidate strings. It depends only on an injected `PickFn`.
- `src/harvest/anthropic-picker.ts` is the only file that imports `@anthropic-ai/sdk`. It turns `client.messages.parse` with `zodOutputFormat` into a `PickFn`.
- `src/verify/wikiquote.ts` is pure. It turns recorded MediaWiki `action=parse` responses into listed entries and `QuoteEvidence`.

**Tech Stack:** Node 26, TypeScript 7 (strict, nodenext), vitest 5, zod 4, and the new dependency `@anthropic-ai/sdk` ^0.125.0 (its zod peer range is `^3.25.0 || ^4.0.0`).

**Spec:** `claude.md`. The relevant sections are:
- §2.1 and §2.6: never publish an unverified quote; fail closed.
- §4: `@anthropic-ai/sdk` is part of the stack.
- §7: harvest writes raw items.
- §8: tier 1 is a passage located in a public-domain full text. Wikiquote's Misattributed and Disputed sections are checked explicitly, and anything listed there is hard-rejected.
- §15: prompts live in version-controlled files; verification code gets tests first; fetch one real response before writing a parser.

The parent plan is `plan.md` Part C, milestones 2.1 and 2.2. The previous sub-plan is `docs/plans/phase-2-harvest-core.md`; its final review parked prerequisite P1 (front matter by other writers), which this plan closes.

**Evidence gathered before this plan (2026-09-13/14, recorded in `.superpowers/sdd/phase-2-picker/progress.md`):**
- **Front matter, 10 real Project Gutenberg texts (#98, #1342, #158, #76, #74, #174, #902, #844, #14522, #921):**
  - The `bookBody` code below finds the true first heading in all 7 texts that have a chapter or act heading. It passes over tables of contents, `Book the First` and the play's scene list.
  - It drops George Saintsbury's preface (#1342) and Twain's own notices.
  - The 3 texts without such a heading (#902, #14522, #921) start with a publisher blurb or a transcriber's note, and no title-line rule found their body reliably. `bookBody` returns null for them, so the harvester skips those books.
- **Picker, live calls to `claude-sonnet-5` through `client.messages.parse` with `zodOutputFormat`:**
  - Structured output returned schema-valid ids.
  - A 150-sentence batch cost about 5.2k-7.1k input tokens and about 140 output tokens, and took about 4 s at `effort: 'low'`, with 0 thinking tokens.
  - With the prompt below, the model stopped padding its choices.
- **Picker, the SDK against a local `node:http` server:**
  - `parse` returns `parsed_output`.
  - The request carries `output_config.format.type = 'json_schema'`.
  - A refusal with empty text, or output that fails the schema, throws a plain `Error` (not an `APIError`).
  - A 400 or 401 throws the typed `Anthropic.BadRequestError` or `AuthenticationError`.
- **Wikiquote, recorded sections for all four authors:**
  - The page's level-2 sections are `Misattributed` and/or `Disputed`.
  - Each listed quotation is a top-level `*` bullet. Deeper bullets are notes; Austen's page quotes her real sentence at `***`.
  - Template names vary in case.
  - The parser code below lists 1 Dickens, 3 Twain disputed and 33 Twain misattributed, 1 Austen, and 14 Wilde entries.
  - It matched a listed quotation with different punctuation, and never matched Austen's real sentence.
- **Suite check:** every code block in this plan was run in a scratch worktree of `phase-2-picker`. Result: 439 tests across 26 files, typecheck exit 0, 0 non-ASCII characters.

**Deliberately NOT in this plan (next plan):**
- `lantern harvest` and `lantern verify`, and the network calls to Gutendex, Gutenberg and Wikiquote (through `cachedFetch`)
- subject rows bound by `wikidata_id`
- item and evidence inserts, including evidence uniqueness (P2)
- `run_log` wiring
- the harvest-core final review's recommendations (P3): Wikiquote ordering before verify, an `EvidenceError` leaving the item raw, `UNIQUE(body_hash)` collisions, cross-page title dedupe, and per-author zod failures

## Global Constraints

- **Language and modules:** Node.js + TypeScript, ESM, strict mode on. Relative imports use `.js` extensions.
- **Unicode:** every non-ASCII character in code and tests must be a `\u` escape. Verify with `git diff | grep '^+' | grep -P '[^\x00-\x7F]'` on `.ts` files; it must print nothing. Markdown and prompt files stay ASCII. Existing characters in `claude.md` and `plan.md` must not be re-encoded.
- **Line endings:** count CR bytes with `tr -cd '\r' < FILE | wc -c`. Never use `grep $'\r'`, which misreports in this shell.
- **Fail closed:**
  - A book without a chapter or act heading is skipped.
  - A batch with malformed picks is skipped whole.
  - A Wikiquote response that is not the recorded shape throws.
- **Claude output is never text:** only the candidate strings already cut from the book are ever returned as passages.
- **No real internet in tests:** use inline strings, and a `node:http` server on `127.0.0.1:0` for the Anthropic adapter. Tests never read `.env` or use a real API key. Never read or write under `data/`, the real `logs/`, or `.env`.
- **Frozen migrations:** migrations 001-005 are frozen, so never edit them. This plan adds no migration.
- **Never commit** `.env`, `data/`, `logs/`, or `.superpowers/`.
- **Commit trailers:** every commit message ends with a blank line, then `Co-Authored-By: <the authoring model's attribution line from its environment>` and `Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v`. Verify with `git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'`, which must print `2`.
- **Branch:** `phase-2-picker`, created from `phase-2-harvest` at 7e6ea3c. The baseline is 412 tests passing across 22 files. The controller pushes after the final review; implementers never push.

### File map

```
src/harvest/front-matter.ts             # L1: bookBody (new)
tests/harvest/front-matter.test.ts      # L1 (new)
src/verify/wikiquote.ts                 # L2: listedSections, listedEntries, cleanWikitext, listedEvidence (new)
tests/verify/wikiquote.test.ts          # L2 (new)
src/config/schema.ts                    # L3: harvest.picker.picks_per_batch
config/verticals/literature.yaml        # L3: picks_per_batch: 3
tests/config/harvest-config.test.ts     # L3: expected picker object gains picks_per_batch
src/harvest/picker.ts                   # L3: pickResultSchema, PickFn, PickerResponseError, buildPickMessage, validatePicks, pickPassages (new)
tests/harvest/picker.test.ts            # L3 (new)
package.json, package-lock.json         # L4: @anthropic-ai/sdk ^0.125.0
prompts/literature/pick.md              # L4: picker system prompt (new)
src/harvest/anthropic-picker.ts         # L4: anthropicPick, loadPickPrompt, PICK_PROMPT_PATH (new)
tests/harvest/anthropic-picker.test.ts  # L4 (new)
claude.md                               # L5: sections 4 and 7
plan.md                                 # L5: status line
```

### Test counts

| After | Suite | Files |
|---|---|---|
| baseline | 412 | 22 |
| L1 | 418 | 23 |
| L2 | 424 | 24 |
| L3 | 435 | 25 |
| L4 | 439 | 26 |
| L5 | 439 | 26 |

---

### Task L1: Front-matter cut

**Files:**
- Create: `src/harvest/front-matter.ts`
- Test: `tests/harvest/front-matter.test.ts` (new)

**Interfaces:**
- Consumes: the output of `stripGutenbergWrapper(text)` from `src/harvest/gutenberg-text.ts` (a string; CRLF line endings are kept).
- Produces: `export interface BookBody { text: string; heading: string; skippedLines: number }` and `export function bookBody(strippedText: string): BookBody | null`. The next plan's harvest command calls `bookBody(stripGutenbergWrapper(fetched))`, skips the book on `null`, and passes `body.text` to `extractCandidates`.

**Why:** the harvest-core final review found that Project Gutenberg #1342 (Pride and Prejudice) opens with George Saintsbury's preface. Gutendex lists no editor for that book, so passing `isHarvestable` does not make every sentence the author's (prerequisite P1). The probe over 10 real texts showed that chapter and act headings mark the start of the author's text reliably. It also showed that texts without them start with publisher or transcriber matter that no simple rule separates, so those books are skipped (fail closed).

- [ ] **Step 1: Write the failing tests**

Create `tests/harvest/front-matter.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/harvest/front-matter.test.ts`

Expected: FAIL. The module `../../src/harvest/front-matter.js` cannot be found. Record the output.

- [ ] **Step 3: Implement**

Create `src/harvest/front-matter.ts`:

```ts
/** The heading that opens a book's first chapter, stave, book, part or act. */
const FIRST_HEADING = /^[\s[]*(?:(?:CHAPTER|Chapter|STAVE|Stave|BOOK|Book|PART|Part|ACT|Act)\s+(?:I|1|ONE|One|THE FIRST|the First)\b|FIRST ACT\b)/;
/** Any numbered chapter-like heading. Headings that follow one another are a table of contents. */
const ANY_HEADING =
  /^[\s[]*(?:(?:CHAPTER|Chapter|STAVE|Stave|BOOK|Book|PART|Part|ACT|Act)\s+(?:[IVXLC]+|\d+|ONE|One|THE \w+|the \w+)\b|(?:FIRST|SECOND|THIRD|FOURTH|FIFTH) ACT\b)/;

export interface BookBody {
  /** The text from the first chapter (or act) heading on, byte for byte. */
  text: string;
  /** That heading line, trimmed. */
  heading: string;
  /** How many lines of front matter were dropped. */
  skippedLines: number;
}

/**
 * Drops the front matter before a book's first chapter or act heading: title pages, contents, and
 * prefaces or introductions that may be by someone other than the author (Project Gutenberg #1342
 * carries George Saintsbury's preface, and Gutendex lists no editor for it). A heading followed
 * within two non-blank lines by another heading is a table-of-contents entry and is passed over.
 * Returns null when there is no such heading, so the harvester skips the book rather than guess
 * where the author's own words begin.
 */
export function bookBody(strippedText: string): BookBody | null {
  const lines = strippedText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!FIRST_HEADING.test(line)) continue;
    const following: string[] = [];
    for (let j = i + 1; j < lines.length && following.length < 2; j++) {
      if (lines[j]!.trim().length > 0) following.push(lines[j]!);
    }
    if (following.some((l) => ANY_HEADING.test(l))) continue;
    return { text: lines.slice(i).join('\n'), heading: line.trim(), skippedLines: i };
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/harvest/front-matter.test.ts`, then `npm test` and `npm run typecheck`.

Expected: 6 passed. The suite reports 418 tests across 23 files, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/harvest/front-matter.ts tests/harvest/front-matter.test.ts
git commit -m "feat(harvest): drop front matter before a book's first chapter or act heading

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task L2: Wikiquote Misattributed and Disputed parser

**Files:**
- Create: `src/verify/wikiquote.ts`
- Test: `tests/verify/wikiquote.test.ts` (new)

**Interfaces:**
- Consumes: `normalizeText` from `src/verify/normalize.ts`, and `MIN_QUOTE_WORDS` (5) and `type QuoteEvidence` from `src/verify/quote-gate.ts`.
- Produces:
  - `export const wikiquoteSectionsSchema`
  - `export const wikiquoteWikitextSchema`
  - `export type ListedKind = 'Misattributed' | 'Disputed'`
  - `export interface ListedSection { title: string; kind: ListedKind; index: number; anchor: string }`
  - `export function listedSections(response: unknown): ListedSection[]`
  - `export function cleanWikitext(line: string): string`
  - `export function listedEntries(response: unknown): string[]`
  - `export function listedEvidence(candidate: string, entries: readonly string[], section: ListedSection): QuoteEvidence | null`
- The next plan fetches `https://en.wikiquote.org/w/api.php?action=parse&format=json&formatversion=2&prop=sections&page=<Title>` and then `...&prop=wikitext&section=<index>`, and feeds each response to these functions.

**Why:** spec §8 requires checking Wikiquote's Misattributed and Disputed sections explicitly and hard-rejecting anything listed there. That includes passages harvested from primary texts (plan.md 2.2). `decideQuote` already rejects any item that carries `listed-misattributed` evidence, whatever its url.

The recorded responses fixed the parser's rules:
- Listed quotations are top-level `*` bullets, often without quote marks.
- Notes are deeper bullets. They can quote the author's real sentence (Jane Austen), so they must never count as listed.
- Template names vary in case, and are dropped either way.

Matching is containment of normalized text on word boundaries, in either direction. That way a listed line inside a longer candidate is caught, and so is a candidate that is only part of a listed line. Entries under 5 words are ignored so a stock phrase cannot reject every sentence that uses it.

- [ ] **Step 1: Write the failing tests**

Create `tests/verify/wikiquote.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { cleanWikitext, listedEntries, listedEvidence, listedSections, type ListedSection } from '../../src/verify/wikiquote.js';

// Trimmed from en.wikiquote.org API responses (2026-09-13). Wikiquote text is CC BY-SA 4.0.
const SECTIONS = {
  parse: {
    title: 'Oscar Wilde',
    sections: [
      { toclevel: 1, level: '2', line: 'Quotes', number: '1', index: '1', anchor: 'Quotes' },
      { toclevel: 2, level: '3', line: '<i>The Picture of Dorian Gray</i> (1890)', number: '1.1', index: '2', anchor: 'The_Picture_of_Dorian_Gray_(1890)' },
      { toclevel: 2, level: '3', line: 'Misattributed', number: '1.2', index: '3', anchor: 'Misattributed_2' },
      { toclevel: 1, level: '2', line: 'Disputed', number: '2', index: '19', anchor: 'Disputed' },
      { toclevel: 1, level: '2', line: 'Misattributed', number: '3', index: '20', anchor: 'Misattributed' },
      { toclevel: 1, level: '2', line: 'External links', number: '4', index: '21', anchor: 'External_links' },
    ],
  },
};

const MISATTRIBUTED = {
  parse: {
    title: 'Oscar Wilde',
    wikitext: [
      '== Misattributed ==',
      '<small>\'\'Misattributed: Quotes widely associated with an author but sourced to another.\'\'</small>',
      '*Always forgive your [[enemies]]; nothing annoys them so much.',
      '**In 2022, an image of Wilde and the quote started spreading online. [https://quoteinvestigator.com/2021/06/11/annoy/ Quote Investigator]',
      '',
      '* I like work: it fascinates me. I can sit and look at it for hours.',
      '** [[Jerome K. Jerome]], \'\'Three Men in a Boat\'\' (1889)',
      '*Be Yourself.<ref>{{cite web|url=https://example.org/|title=X}}</ref>',
      '{{Misattributed end}}',
    ].join('\n'),
  },
};

const AUSTEN = {
  parse: {
    title: 'Jane Austen',
    wikitext: [
      '== Misattributed ==',
      '* Life seems but a quick succession of busy nothings.',
      '** Said by Fanny Price in a 1999 adaptation of \'\'Mansfield Park\'\'. Actual quote:',
      '*** Dinner was soon followed by tea and coffee, and it was a quick succession of busy nothings till the carriage came to the door.',
      '{{Misattributed end}}',
    ].join('\n'),
  },
};

const WILDE_MISATTRIBUTED: ListedSection = { title: 'Oscar Wilde', kind: 'Misattributed', index: 20, anchor: 'Misattributed' };

describe('wikiquote', () => {
  it('finds the level-2 Misattributed and Disputed sections only', () => {
    expect(listedSections(SECTIONS)).toEqual([
      { title: 'Oscar Wilde', kind: 'Disputed', index: 19, anchor: 'Disputed' },
      WILDE_MISATTRIBUTED,
    ]);
  });

  it('refuses a sections response that is not the recorded shape', () => {
    expect(() => listedSections({ parse: { title: 'Oscar Wilde', sections: [{ level: 2, line: 'Disputed' }] } })).toThrow(ZodError);
  });

  it('lists only top-level bullets, reduced to their visible text', () => {
    expect(listedEntries(MISATTRIBUTED)).toEqual([
      'Always forgive your enemies; nothing annoys them so much.',
      'I like work: it fascinates me. I can sit and look at it for hours.',
      'Be Yourself.',
    ]);
    expect(cleanWikitext('[[w:Menards|Menards]] in \'\'[https://example.org/x The Globe]\'\'<ref name="a"/>')).toBe('Menards in The Globe');
  });

  it('returns listed-misattributed evidence for a listed quote, whatever its punctuation', () => {
    const entries = listedEntries(MISATTRIBUTED);
    expect(listedEvidence('Always forgive your enemies, nothing annoys them so much!', entries, WILDE_MISATTRIBUTED)).toEqual({
      kind: 'listed-misattributed',
      citation: 'Wikiquote, Oscar Wilde: Misattributed: "Always forgive your enemies; nothing annoys them so much."',
      url: 'https://en.wikiquote.org/wiki/Oscar_Wilde#Misattributed',
    });
    expect(
      listedEvidence('He always said that I like work: it fascinates me. I can sit and look at it for hours.', entries, WILDE_MISATTRIBUTED),
    ).not.toBeNull();
  });

  it('never lists the author\'s real sentence that a source note quotes', () => {
    const section: ListedSection = { title: 'Jane Austen', kind: 'Misattributed', index: 13, anchor: 'Misattributed' };
    const real = 'Dinner was soon followed by tea and coffee, and it was a quick succession of busy nothings till the carriage came to the door.';
    expect(listedEvidence(real, listedEntries(AUSTEN), section)).toBeNull();
  });

  it('ignores listed entries shorter than the minimum quote length', () => {
    expect(listedEvidence('Be yourself.', listedEntries(MISATTRIBUTED), WILDE_MISATTRIBUTED)).toBeNull();
    expect(listedEvidence('I told him to be yourself, whatever the others said.', listedEntries(MISATTRIBUTED), WILDE_MISATTRIBUTED)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/verify/wikiquote.test.ts`

Expected: FAIL. The module `../../src/verify/wikiquote.js` cannot be found. Record the output.

- [ ] **Step 3: Implement**

Create `src/verify/wikiquote.ts`:

```ts
import { z } from 'zod';
import { normalizeText } from './normalize.js';
import { MIN_QUOTE_WORDS, type QuoteEvidence } from './quote-gate.js';

/** MediaWiki `action=parse&prop=sections&formatversion=2`, as recorded from en.wikiquote.org on 2026-09-13. */
export const wikiquoteSectionsSchema = z.object({
  parse: z.object({
    title: z.string().min(1),
    sections: z.array(
      z.object({ level: z.string(), line: z.string(), index: z.string().regex(/^\d+$/), anchor: z.string().min(1) }),
    ),
  }),
});

/** MediaWiki `action=parse&prop=wikitext&section=N&formatversion=2`. */
export const wikiquoteWikitextSchema = z.object({
  parse: z.object({ title: z.string().min(1), wikitext: z.string() }),
});

export type ListedKind = 'Misattributed' | 'Disputed';

export interface ListedSection {
  title: string;
  kind: ListedKind;
  index: number;
  anchor: string;
}

const LISTED_HEADING = /^(misattributed|disputed)$/i;

/**
 * The page's level-2 Misattributed and Disputed sections. Spec section 8: check both explicitly and
 * hard-reject anything listed there. Throws a ZodError when the response is not the recorded shape.
 */
export function listedSections(response: unknown): ListedSection[] {
  const { parse } = wikiquoteSectionsSchema.parse(response);
  return parse.sections.flatMap((section) => {
    const heading = LISTED_HEADING.exec(section.line.replace(/<[^>]+>/g, '').trim());
    if (section.level !== '2' || heading === null) return [];
    const kind: ListedKind = heading[1]!.toLowerCase() === 'disputed' ? 'Disputed' : 'Misattributed';
    return [{ title: parse.title, kind, index: Number(section.index), anchor: section.anchor }];
  });
}

/** Wikitext markup reduced to its visible text: links keep their label, references and templates go. */
export function cleanWikitext(line: string): string {
  return line
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/\S+\s+([^\]]*)\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/\S+\]/g, '')
    .replace(/'''?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The quotations a Misattributed or Disputed section lists: its top-level `*` bullets. Deeper bullets
 * are source notes, and on some pages (Jane Austen) they quote the author's real sentence, so they
 * are never treated as listed.
 */
export function listedEntries(response: unknown): string[] {
  const { parse } = wikiquoteWikitextSchema.parse(response);
  return parse.wikitext
    .split(/\r?\n/)
    .filter((line) => /^\*(?!\*)/.test(line))
    .map((line) => cleanWikitext(line.slice(1)))
    .filter((text) => text.length > 0);
}

/**
 * `listed-misattributed` evidence when the candidate and a listed entry match: after normalization,
 * one contains the other on word boundaries. Entries shorter than MIN_QUOTE_WORDS are ignored so a
 * stock phrase cannot reject every sentence that uses it.
 */
export function listedEvidence(candidate: string, entries: readonly string[], section: ListedSection): QuoteEvidence | null {
  const quote = ` ${normalizeText(candidate)} `;
  for (const entry of entries) {
    const normalized = normalizeText(entry);
    if (normalized.split(' ').filter(Boolean).length < MIN_QUOTE_WORDS) continue;
    if (quote.includes(` ${normalized} `) || ` ${normalized} `.includes(quote)) {
      return {
        kind: 'listed-misattributed',
        citation: `Wikiquote, ${section.title}: ${section.kind}: "${entry}"`,
        url: `https://en.wikiquote.org/wiki/${encodeURIComponent(section.title.replace(/ /g, '_'))}#${section.anchor}`,
      };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/verify/wikiquote.test.ts`, then `npm test` and `npm run typecheck`.

Expected: 6 passed. The suite reports 424 tests across 24 files, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/verify/wikiquote.ts tests/verify/wikiquote.test.ts
git commit -m "feat(verify): parse Wikiquote Misattributed and Disputed sections into listed-misattributed evidence

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task L3: Picker core and `picks_per_batch`

**Files:**
- Create: `src/harvest/picker.ts`
- Modify: `src/config/schema.ts`, `config/verticals/literature.yaml`, `tests/config/harvest-config.test.ts`
- Test: `tests/harvest/picker.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export const pickResultSchema` (`{ picks: { id: int; reason: string }[] }`)
  - `export type PickFn = (system: string, user: string) => Promise<unknown>`
  - `export class PickerResponseError extends Error`
  - `export interface PickOptions { batchSize: number; maxBatches: number; picksPerBatch: number }`
  - `export interface PickedPassage { text: string; reason: string }`
  - `export interface PickOutcome { picked: PickedPassage[]; batches: number; failedBatches: number }`
  - `export function buildPickMessage(author: string, work: string, batch: readonly string[], picksPerBatch: number): string`
  - `export function validatePicks(raw: unknown, batchLength: number, picksPerBatch: number): { index: number; reason: string }[]`
  - `export async function pickPassages(pick: PickFn, system: string, author: string, work: string, candidates: readonly string[], options: PickOptions): Promise<PickOutcome>`
- The config type `HarvestConfig['picker']` gains `picks_per_batch: number`, an integer from 1 to 10. The next plan maps `batch_size`, `max_batches_per_work` and `picks_per_batch` onto `PickOptions`.
- L4 consumes `pickResultSchema`, `PickFn` and `PickerResponseError`.

**Why:** the model may only choose; it must never write. So `pickPassages` returns `batch[index]`, the candidate string itself, and ignores any text the model sends back.

A malformed choice is not partly trusted. That covers:
- an id that is not a whole number in range
- a repeated id
- more picks than allowed

Any of these rejects the whole batch. `PickerResponseError` skips only that batch, while every other error (authentication, network, rate limit after retries) stops the run, so a broken key cannot silently produce zero picks.

`max_batches_per_work` caps Claude spend per book: 6 batches of 150 is about 40k input tokens. The batches that are sent are spread evenly across the book, not taken from its opening chapters only.

`picks_per_batch: 3` keeps the model selective. In the probe, the earlier "at most 5" produced padding.

- [ ] **Step 1: Write the failing tests and update the config test**

Create `tests/harvest/picker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildPickMessage, pickPassages, PickerResponseError, validatePicks, type PickFn } from '../../src/harvest/picker.js';

const CANDIDATES = Array.from({ length: 6 }, (_, i) => `Sentence number ${i + 1} is a candidate cut from the book.`);
const OPTIONS = { batchSize: 2, maxBatches: 2, picksPerBatch: 1 };

describe('picker', () => {
  it('numbers the batch from 1 under the author, the work and the pick limit', () => {
    expect(buildPickMessage('Charles Dickens', 'A Tale of Two Cities', ['First.', 'Second.'], 3)).toBe(
      'Author: Charles Dickens\nWork: A Tale of Two Cities\nChoose at most 3 sentences.\n\n[1] First.\n[2] Second.',
    );
  });

  it('turns valid picks into 0-based indexes with their reasons', () => {
    expect(validatePicks({ picks: [{ id: 3, reason: 'stands alone' }, { id: 1, reason: 'wise' }] }, 3, 2)).toEqual([
      { index: 2, reason: 'stands alone' },
      { index: 0, reason: 'wise' },
    ]);
  });

  it.each([
    ['output that is not the schema', { picks: 'none' }],
    ['a fractional id', { picks: [{ id: 1.5, reason: 'x' }] }],
    ['id 0', { picks: [{ id: 0, reason: 'x' }] }],
    ['an id past the end of the batch', { picks: [{ id: 4, reason: 'x' }] }],
    ['a repeated id', { picks: [{ id: 2, reason: 'x' }, { id: 2, reason: 'y' }] }],
    ['more picks than allowed', { picks: [{ id: 1, reason: 'x' }, { id: 2, reason: 'y' }, { id: 3, reason: 'z' }] }],
  ])('rejects the whole batch for %s', (_label, raw) => {
    expect(() => validatePicks(raw, 3, 2)).toThrow(PickerResponseError);
  });

  it('returns the candidate text itself and spreads the batches it sends across the work', async () => {
    const users: string[] = [];
    const pick: PickFn = async (_system, user) => {
      users.push(user);
      return { picks: [{ id: 1, reason: 'Rewritten by the model, which must never be used.' }] };
    };
    const outcome = await pickPassages(pick, 'system prompt', 'Charles Dickens', 'A Tale of Two Cities', CANDIDATES, OPTIONS);
    expect(outcome).toEqual({
      picked: [
        { text: CANDIDATES[0], reason: 'Rewritten by the model, which must never be used.' },
        { text: CANDIDATES[2], reason: 'Rewritten by the model, which must never be used.' },
      ],
      batches: 2,
      failedBatches: 0,
    });
    expect(users[1]).toContain(`[1] ${CANDIDATES[2]}\n[2] ${CANDIDATES[3]}`);
  });

  it('skips and counts a batch whose output is unusable', async () => {
    let call = 0;
    const pick: PickFn = async () => (call++ === 0 ? { picks: [{ id: 9, reason: 'out of range' }] } : { picks: [] });
    expect(await pickPassages(pick, 's', 'a', 'w', CANDIDATES, OPTIONS)).toEqual({ picked: [], batches: 2, failedBatches: 1 });
  });

  it('stops on any other error', async () => {
    const pick: PickFn = async () => {
      throw new Error('authentication failed');
    };
    await expect(pickPassages(pick, 's', 'a', 'w', CANDIDATES, OPTIONS)).rejects.toThrow('authentication failed');
  });
});
```

In `tests/config/harvest-config.test.ts`, the picker object literal `{ model: 'claude-sonnet-5', batch_size: 150, max_batches_per_work: 6 }` appears twice: in `valid`, and in the `toEqual` of the load test. Change both occurrences to `{ model: 'claude-sonnet-5', batch_size: 150, max_batches_per_work: 6, picks_per_batch: 3 }`. This is the only edit to an existing test in this plan.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/harvest/picker.test.ts tests/config/harvest-config.test.ts`

Expected: FAIL. `picker.test.ts` cannot find `../../src/harvest/picker.js`. In `harvest-config.test.ts`, the load test fails because `picks_per_batch` is missing from the loaded config, and `accepts a valid harvest section` fails because the strict schema rejects the unknown key. Record the output.

- [ ] **Step 3: Implement**

Create `src/harvest/picker.ts`:

```ts
import { z } from 'zod';

/** What the model returns: candidate numbers as shown in the prompt (1-based), each with a one-sentence reason. */
export const pickResultSchema = z.object({
  picks: z.array(z.object({ id: z.number().int(), reason: z.string() })),
});

/** Sends one batch (system prompt, user message) to the model and resolves to its structured output. */
export type PickFn = (system: string, user: string) => Promise<unknown>;

/** The model's output for one batch is unusable. Only that batch is skipped. */
export class PickerResponseError extends Error {
  override name = 'PickerResponseError';
}

export interface PickOptions {
  batchSize: number;
  maxBatches: number;
  picksPerBatch: number;
}

export interface PickedPassage {
  /** The candidate sentence itself, never text from the model. */
  text: string;
  reason: string;
}

export interface PickOutcome {
  picked: PickedPassage[];
  batches: number;
  failedBatches: number;
}

export function buildPickMessage(author: string, work: string, batch: readonly string[], picksPerBatch: number): string {
  const numbered = batch.map((text, i) => `[${i + 1}] ${text}`).join('\n');
  return `Author: ${author}\nWork: ${work}\nChoose at most ${picksPerBatch} sentences.\n\n${numbered}`;
}

/**
 * The model's picks for a batch of `batchLength` candidates, as 0-based indexes in the order given.
 * An id that is not a whole number in range, a repeated id, or more picks than allowed rejects the
 * whole batch: the model may only choose, so a malformed choice is never partly trusted.
 */
export function validatePicks(raw: unknown, batchLength: number, picksPerBatch: number): { index: number; reason: string }[] {
  const parsed = pickResultSchema.safeParse(raw);
  if (!parsed.success) throw new PickerResponseError(`picker output does not match the schema: ${parsed.error.message}`);
  const { picks } = parsed.data;
  if (picks.length > picksPerBatch) {
    throw new PickerResponseError(`picker chose ${picks.length} sentences; at most ${picksPerBatch} are allowed`);
  }
  const seen = new Set<number>();
  return picks.map(({ id, reason }) => {
    if (id < 1 || id > batchLength) throw new PickerResponseError(`picker chose id ${id}, outside 1-${batchLength}`);
    if (seen.has(id)) throw new PickerResponseError(`picker chose id ${id} twice`);
    seen.add(id);
    return { index: id - 1, reason };
  });
}

/**
 * Runs the picker over a work's candidates. When there are more batches than `maxBatches`, the
 * batches sent are spread evenly across the work instead of all coming from its opening. A batch
 * whose output is unusable (PickerResponseError) is counted and skipped; any other error, such as
 * authentication, network or rate limiting after the client's retries, stops the run.
 */
export async function pickPassages(
  pick: PickFn,
  system: string,
  author: string,
  work: string,
  candidates: readonly string[],
  options: PickOptions,
): Promise<PickOutcome> {
  const total = Math.ceil(candidates.length / options.batchSize);
  const count = Math.min(total, options.maxBatches);
  const picked: PickedPassage[] = [];
  let failedBatches = 0;
  for (let k = 0; k < count; k++) {
    const start = Math.floor((k * total) / count) * options.batchSize;
    const batch = candidates.slice(start, start + options.batchSize);
    try {
      const raw = await pick(system, buildPickMessage(author, work, batch, options.picksPerBatch));
      for (const { index, reason } of validatePicks(raw, batch.length, options.picksPerBatch)) {
        picked.push({ text: batch[index]!, reason });
      }
    } catch (err) {
      if (!(err instanceof PickerResponseError)) throw err;
      failedBatches++;
    }
  }
  return { picked, batches: count, failedBatches };
}
```

In `src/config/schema.ts`, inside `harvestSchema`'s `picker` object, directly after the line `    max_batches_per_work: z.number().int().min(1).max(50),`, add:

```ts
    picks_per_batch: z.number().int().min(1).max(10),
```

In `config/verticals/literature.yaml`, directly after the line `    max_batches_per_work: 6       # spend cap per book`, add:

```yaml
    picks_per_batch: 3            # most sentences the model may choose from one batch
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/harvest/picker.test.ts tests/config`, then `npm test` and `npm run typecheck`.

Expected: `picker.test.ts` has 11 passed, and the config tests pass. The suite reports 435 tests across 25 files, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/harvest/picker.ts tests/harvest/picker.test.ts src/config/schema.ts config/verticals/literature.yaml tests/config/harvest-config.test.ts
git commit -m "feat(harvest): picker core that maps validated model ids back to verbatim candidates

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task L4: Anthropic picker adapter, SDK dependency and prompt file

**Files:**
- Modify: `package.json`, `package-lock.json` (via npm)
- Create: `prompts/literature/pick.md`, `src/harvest/anthropic-picker.ts`
- Test: `tests/harvest/anthropic-picker.test.ts` (new)

**Interfaces:**
- Consumes: `pickResultSchema`, `PickFn` and `PickerResponseError` from `src/harvest/picker.ts` (L3).
- Produces:
  - `export const PICK_PROMPT_PATH = 'prompts/literature/pick.md'`
  - `export function loadPickPrompt(root: string): string`
  - `export function anthropicPick(client: Anthropic, model: string): PickFn`
- The next plan's harvest command constructs `new Anthropic()`, which reads `ANTHROPIC_API_KEY` from the environment that `.env` populates. It then passes `anthropicPick(client, harvest.picker.model)` and `loadPickPrompt(paths.root)` to `pickPassages`.

**Why:**
- **Prompt location:** spec §15 keeps prompts in version-controlled files, and spec §4 names the SDK.
- **Structured output:** `client.messages.parse` with `zodOutputFormat(pickResultSchema)` makes the API return JSON that matches the schema, and the SDK parses it. `effort: 'low'` suits a selection task. The probe measured 0 thinking tokens and about 4 s per 150-sentence batch.
- **Error classes:** the local-server probe established how failures surface.
  - An unusable answer (a refusal, truncation or schema mismatch) surfaces as a plain `Error` from `parse`. The adapter converts it to `PickerResponseError`, so the batch is skipped.
  - Real API failures are `Anthropic.APIError` subclasses. The adapter rethrows them, so the run stops.
- **Tests:** they use a real `node:http` server with `baseURL` and `maxRetries: 0`, which is real HTTP and not a mocked client, and never a real key or network.

- [ ] **Step 1: Add the dependency and the prompt**

Run: `npm install @anthropic-ai/sdk@^0.125.0`

Expected: `package.json` `dependencies` gains `"@anthropic-ai/sdk": "^0.125.0"`, and `package-lock.json` is updated. No other dependency changes version; check with `git diff package.json`.

Create `prompts/literature/pick.md` (ASCII only):

```markdown
You choose quotations for a page that posts one short passage from classic literature each day with a note on what it means.

You receive numbered sentences cut word for word from one public-domain book. You can only choose by number. You never rewrite, shorten, or combine sentences, and nothing you write is published.

Choose a sentence only when all of these hold:
- It stands alone: a reader who has not read the book understands it and finds it worth thinking about.
- It says something about people, life, society, or ideas. Plain plot narration, scene description, and lists of events are not enough, however well written.
- It is the author's own voice, not a quotation from another writer, a letter or document quoted in the story, or an editor's, translator's, or publisher's note.

Most batches contain few or no such sentences. Returning an empty list is a good answer. Never pad your choice to reach the limit.

For each choice give a short reason (one sentence) that says why the passage stands alone.
```

- [ ] **Step 2: Write the failing tests**

Create `tests/harvest/anthropic-picker.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { anthropicPick, loadPickPrompt } from '../../src/harvest/anthropic-picker.js';
import { PickerResponseError } from '../../src/harvest/picker.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const message = (text: string, stopReason = 'end_turn') => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content: [{ type: 'text', text }],
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

/** A real HTTP server on 127.0.0.1:0 standing in for the Messages API. Replies with replies[n], repeating the last. */
async function fakeApi(replies: { status: number; body: unknown }[]) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => {
      requests.push(JSON.parse(data) as Record<string, unknown>);
      const reply = replies[Math.min(requests.length, replies.length) - 1]!;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 });
  return { client, requests };
}

describe('anthropicPick', () => {
  it('sends the model, the prompts and a JSON schema format, and returns the parsed picks', async () => {
    const { client, requests } = await fakeApi([{ status: 200, body: message('{"picks":[{"id":2,"reason":"stands alone"}]}') }]);
    expect(await anthropicPick(client, 'claude-sonnet-5')('system prompt', 'user message')).toEqual({
      picks: [{ id: 2, reason: 'stands alone' }],
    });
    expect(requests[0]).toMatchObject({
      model: 'claude-sonnet-5',
      system: 'system prompt',
      messages: [{ role: 'user', content: 'user message' }],
      output_config: { format: { type: 'json_schema' }, effort: 'low' },
    });
  });

  it('turns output that does not parse, or a refusal, into a PickerResponseError', async () => {
    const { client } = await fakeApi([
      { status: 200, body: message('{"picks":"none"}') },
      { status: 200, body: message('', 'refusal') },
    ]);
    const pick = anthropicPick(client, 'claude-sonnet-5');
    await expect(pick('s', 'u')).rejects.toThrow(PickerResponseError);
    await expect(pick('s', 'u')).rejects.toThrow(PickerResponseError);
  });

  it('lets API errors through so the run stops', async () => {
    const { client } = await fakeApi([
      { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } },
    ]);
    await expect(anthropicPick(client, 'claude-sonnet-5')('s', 'u')).rejects.toThrow(Anthropic.AuthenticationError);
  });

  it('loads the committed picker prompt', () => {
    expect(loadPickPrompt(ROOT)).toContain('You can only choose by number.');
  });
});
```

Run: `npx vitest run tests/harvest/anthropic-picker.test.ts`

Expected: FAIL. The module `../../src/harvest/anthropic-picker.js` cannot be found. Record the output.

- [ ] **Step 3: Implement**

Create `src/harvest/anthropic-picker.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { PickerResponseError, pickResultSchema, type PickFn } from './picker.js';

/** Spec section 15: prompts are content and live in version-controlled files. */
export const PICK_PROMPT_PATH = 'prompts/literature/pick.md';

export function loadPickPrompt(root: string): string {
  return readFileSync(join(root, PICK_PROMPT_PATH), 'utf8');
}

/**
 * A PickFn backed by the Messages API with structured output. API errors (authentication, network,
 * rate limiting after the SDK's retries) propagate and stop the run. A response that cannot be parsed
 * into the pick schema, including a refusal or a truncated answer, becomes a PickerResponseError so
 * only that batch is skipped.
 */
export function anthropicPick(client: Anthropic, model: string): PickFn {
  return async (system, user) => {
    const response = await client.messages
      .parse({
        model,
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { format: zodOutputFormat(pickResultSchema), effort: 'low' },
      })
      .catch((err: unknown) => {
        if (err instanceof Anthropic.APIError) throw err;
        throw new PickerResponseError(`picker output could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
      });
    if (response.stop_reason !== 'end_turn' || response.parsed_output === null) {
      throw new PickerResponseError(`picker stopped with ${String(response.stop_reason)} and no usable output`);
    }
    return response.parsed_output;
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/harvest/anthropic-picker.test.ts`, then `npm test` and `npm run typecheck`.

Expected: 4 passed. The suite reports 439 tests across 26 files, and typecheck exits 0. The tests make no request outside `127.0.0.1`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json prompts/literature/pick.md src/harvest/anthropic-picker.ts tests/harvest/anthropic-picker.test.ts
git commit -m "feat(harvest): Anthropic picker adapter with structured output and a version-controlled prompt

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task L5: Spec and plan status

**Files:**
- Modify: `claude.md`, `plan.md`

**Interfaces:** none.

**Why:** spec §15 says to change this file in the same branch as the code it describes. Two things in the spec are now stale:
- §4's layout has no `prompts/` directory.
- §7's harvest paragraph does not say where candidates come from, or that the model chooses by number.

`plan.md` records the milestone status. Both files already contain non-ASCII characters. Use the Edit tool, never re-encode anything, and keep 0 CR bytes. All added text is ASCII.

- [ ] **Step 1: Edit `claude.md`**

1. **Section 4 layout.** In the package layout code block, find the line `  migrations/` (two spaces, then `migrations/`). Directly after it, insert these three lines:

   ```
     prompts/
       literature/
         pick.md           # passage picker system prompt; the model chooses by number
   ```

2. **Section 7, `lantern harvest` paragraph.** Find the sentence that ends `and whether the book is by the attributed author.` Directly after it, add this sentence:

   `Candidates come only from a book's text after its first chapter or act heading (a book without one is skipped), and a Claude picker chooses among them by number; it never supplies text.`

   Then re-wrap only that paragraph to about 80 columns.

- [ ] **Step 2: Edit `plan.md`**

Directly after the line `### Phase 2 remainder — literature content end to end, no publishing`, insert a blank line and then this line:

```markdown
> **Status:** the front-matter cut (P1 from the harvest-core final review), the Claude passage picker (`claude-sonnet-5`, structured output, prompt in `prompts/literature/pick.md`) and the Wikiquote Misattributed/Disputed parser (2.2) are built and tested offline on branch `phase-2-picker` (docs/plans/phase-2-picker.md, Tasks L1-L5). The `lantern harvest` and `lantern verify` commands, with their network fetches, subject rows and evidence inserts, come next.
```

- [ ] **Step 3: Verify**

Before editing, record `grep -cP '[^\x00-\x7F]' claude.md plan.md`. After editing, run:

```bash
grep -c 'pick.md           # passage picker system prompt' claude.md
grep -c 'it never supplies text' claude.md
grep -c 'docs/plans/phase-2-picker.md' plan.md
grep -cP '[^\x00-\x7F]' claude.md plan.md
tr -cd '\r' < claude.md | wc -c
tr -cd '\r' < plan.md | wc -c
git diff --stat
```

Expected results:
- `1` for each of the three content checks. A phrase check may read `0` if the phrase wraps across a line; in that case, quote the diff hunk in the report.
- Non-ASCII line counts are unchanged from before.
- `0` CR bytes in both files.
- The diff touches only `claude.md` and `plan.md`.

- [ ] **Step 4: Commit**

```bash
git add claude.md plan.md
git commit -m "docs: prompts directory, front-matter cut and picker in the harvest stage; plan status

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.
