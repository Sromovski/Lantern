# Phase 2.7 Captions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `lantern caption --post <id> --platforms facebook,pinterest` writes one `captions` row per platform from the post's already-approved prose, enforcing each channel's character limits, and re-running the fact-check gate on anything that is not verbatim approved text.

**Architecture:** The stage is a formatter, not a writer (spec section 15). Both builders select and trim the post's own hook, body and closer; nothing invents a sentence. A caption whose every sentence is a literal substring of the approved text ships unchecked, because the enrichment gates already passed it; anything else is judged by the existing enrich checker, reusing `prompts/shared/fact-check.md` unmodified. The stage mirrors `composePost`: an options object, a report with per-platform outcomes, a typed-error allowlist, and unexpected errors aborting the run.

**Tech Stack:** Node 26, TypeScript (strict, nodenext, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), vitest, better-sqlite3, zod, commander, `@anthropic-ai/sdk`. No new dependencies.

**Spec:** `claude.md` (sections 5, 6, 7, 9, 10, 11, 15) and `plan.md` milestone 2.7.

## Global Constraints

- **No migration.** `captions` and its `UNIQUE(post_id, platform)` have existed since `migrations/001_initial.sql:114-125`. Do not add one.
- **No new dependencies.** `package.json` and `package-lock.json` must not change. If `npm install` adds a `hasInstallScript` line to the lockfile, revert it: it is npm noise, not part of this milestone.
- **No writer model anywhere in this stage.** The only model call is the checker, and it is reached only by a caption that is not verbatim approved text.
- **Every non-ASCII character in a `.ts` file must be a `\u` escape.** Prefer avoiding them entirely. The existing non-ASCII in `claude.md`, `plan.md`, `config/verticals/literature.yaml` and `src/config/schema.ts` must **not** be re-encoded: the documentation steps below contain an em dash and `§`, and they are to be reproduced byte for byte.
- **Relative imports carry `.js` extensions**; type-only imports use `import type`.
- **A caption with any problem writes no row.** The review queue must never show text that was not judged (spec section 2.6).
- **`char_count` is the body only.** `text_max` governs `captions.text` and `title_max` governs the title; a combined count would mean neither.
- Tests make no network requests and use no API key.
- Commit messages end with two trailers: a `Co-Authored-By:` line naming **the model that did the work** (this repo's convention; each implementer uses its own), and the `Claude-Session:` line exactly as given.

---

### Task 1: The caption text helpers

Every later task rests on these three rules: what counts as approved text, how a caption is trimmed, and what boilerplate is exempt.

**Files:**
- Create: `src/caption/text.ts`
- Test: `tests/caption/text.test.ts`

**Interfaces:**
- Produces: `BOILERPLATE`, `unapprovedSentences(caption, approved): string[]`, `fitSentences(text, max): string`, `truncateAtWord(text, max): string`, `joinParagraphs(parts): string`.

- [ ] **Step 1: Write the failing test**

Note the measured numbers in it: the fixture's first two sentences are 31 and 88 characters, and keeping the paragraph break between them costs two characters rather than one, so the pair needs 121 and does not fit in 120. That is the price of not reflowing a write-up into a single block, and it is asserted rather than assumed.

```ts
import { describe, expect, it } from 'vitest';
import { BOILERPLATE, fitSentences, joinParagraphs, truncateAtWord, unapprovedSentences } from '../../src/caption/text.js';

const APPROVED = [
  'Dickens wrote the line in 1859.',
  'He had been running a weekly magazine, and the first instalment opened its first number.',
  'Read the novel and see how early the sentence arrives.',
].join('\n\n');

describe('unapprovedSentences', () => {
  it('accepts text carried over whole from the post', () => {
    expect(unapprovedSentences('Dickens wrote the line in 1859.', APPROVED)).toEqual([]);
    expect(unapprovedSentences(APPROVED, APPROVED)).toEqual([]);
  });

  it('accepts a truncation, because a prefix is still approved text', () => {
    const shorter = fitSentences(APPROVED, 120);
    expect(shorter.length).toBeLessThan(APPROVED.length);
    expect(unapprovedSentences(shorter, APPROVED)).toEqual([]);
  });

  it('accepts the fixed boilerplate but nothing else that was never approved', () => {
    expect(unapprovedSentences(BOILERPLATE[0] ?? '', APPROVED)).toEqual([]);

    // The danger this rule exists for: every clause below is approved, but the sentence is not, and
    // it asserts something no source said.
    const stitched = 'Dickens wrote the line in 1859 while running a weekly magazine.';
    expect(unapprovedSentences(stitched, APPROVED)).toEqual([stitched]);
  });

  it('ignores differences in whitespace only', () => {
    expect(unapprovedSentences('Dickens   wrote the line\nin 1859.', APPROVED)).toEqual([]);
  });
});

describe('fitSentences', () => {
  it('keeps whole sentences and never appends an ellipsis', () => {
    // The first two sentences are 31 and 88 characters. Keeping the paragraph break between them
    // costs two characters rather than one, so the pair needs 121 and does not fit in 120 - the
    // price of not reflowing a write-up into a single block. Measured, not guessed.
    expect(fitSentences(APPROVED, 120)).toBe('Dickens wrote the line in 1859.');

    const fitted = fitSentences(APPROVED, 121);
    expect(fitted).toBe('Dickens wrote the line in 1859.\n\nHe had been running a weekly magazine, and the first instalment opened its first number.');
    // Written as a code point so this file stays ASCII, the same way template.ts writes its quotes.
    expect(fitted).not.toContain(String.fromCharCode(0x2026));
    expect(fitted).not.toContain('...');
    expect(APPROVED.includes(fitted)).toBe(true);
  });

  it('drops the sentence that does not fit rather than cutting it', () => {
    expect(fitSentences(APPROVED, 40)).toBe('Dickens wrote the line in 1859.');
  });

  it('returns everything when it already fits, paragraphs intact', () => {
    // A Facebook caption is a paragraph of writing, so the blank lines survive: reflowing the
    // write-up into one block would make it read as a wall.
    expect(fitSentences(APPROVED, 10_000)).toBe(APPROVED);
  });

  it('falls back to a word boundary when even the first sentence is too long', () => {
    const fitted = fitSentences('Dickens wrote the line in 1859.', 12);
    expect(fitted).toBe('Dickens');
    expect([...fitted].length).toBeLessThanOrEqual(12);
  });
});

describe('truncateAtWord', () => {
  it('cuts at the last whole word and adds nothing', () => {
    expect(truncateAtWord('It was the best of times', 14)).toBe('It was the');
    expect(truncateAtWord('short', 40)).toBe('short');
  });

  it('counts characters, not code units, so an em dash costs one', () => {
    const text = `a${String.fromCharCode(0x2014)}b c`;
    expect([...truncateAtWord(text, 3)].length).toBeLessThanOrEqual(3);
  });
});

describe('joinParagraphs', () => {
  it('separates parts with a blank line and drops empty ones', () => {
    expect(joinParagraphs(['hook', '', '  ', 'closer'])).toBe('hook\n\ncloser');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/caption/text.test.ts`
Expected: FAIL, cannot resolve `../../src/caption/text.js`.

- [ ] **Step 3: Write the helpers**

`fitSentences` drops whole trailing sentences and never appends an ellipsis, so a trimmed caption stays a literal substring of approved text and costs no model call. It keeps paragraph breaks: a Facebook caption is a paragraph of writing (spec section 11), and reflowing it into one block to save two characters makes it read as a wall.

```ts
import { normalizeText } from '../verify/normalize.js';
import { splitSentences } from '../enrich/draft.js';

/**
 * Text a caption may contain that is not drawn from the post.
 *
 * The rule is that a caption is only ever selected or trimmed from prose the enrichment gates
 * already approved (spec section 15: adapters select and format, they do not write). These lines are
 * the sole exception, and they are an explicit allowlist rather than a general rule: each is a fixed
 * string that makes no factual claim about the subject, so there is nothing for a fact check to judge.
 */
export const BOILERPLATE: readonly string[] = ['Illustration: AI-generated'];

/** Whitespace folded the same way the quote matcher folds it, so the two never disagree about a match. */
const folded = (text: string): string => normalizeText(text);

/**
 * The sentences of a caption that are not found in the approved post text.
 *
 * Empty means the caption is a pure truncation and may ship without a fact check. Anything else
 * re-runs the checker (user decision 2026-09-16, fail closed per spec section 6): a caption that
 * stitches two approved clauses together can imply something neither of them said.
 */
export function unapprovedSentences(caption: string, approved: string): string[] {
  const haystack = folded(approved);
  const allowed = new Set(BOILERPLATE.map(folded));
  return splitSentences(caption).filter((sentence) => {
    const needle = folded(sentence);
    return needle !== '' && !allowed.has(needle) && !haystack.includes(needle);
  });
}

/**
 * The longest run of whole sentences from the start of the text that fits.
 *
 * Whole sentences, and never an added ellipsis: both keep the result a literal substring of the
 * approved text, so trimming a caption to a channel's limit cannot by itself cost a model call. A
 * caption cut mid-sentence would also read as a mistake rather than as an ending.
 */
export function fitSentences(text: string, max: number): string {
  // Paragraphs are kept apart. A Facebook caption is a paragraph of writing under a picture (spec
  // section 11), and reflowing a three-paragraph write-up into one block to save two characters
  // makes it read as a wall rather than as prose.
  let kept = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    for (const [index, sentence] of splitSentences(paragraph).entries()) {
      // A blank line before a paragraph's first sentence, a space between sentences within one.
      // Compared by index, not by text: a paragraph may repeat a sentence, and comparing the words
      // would then put a paragraph break in the middle of it.
      const joiner = kept === '' ? '' : index === 0 ? '\n\n' : ' ';
      const candidate = `${kept}${joiner}${sentence}`;
      if ([...candidate].length > max) return kept === '' ? truncateAtWord(text, max) : kept;
      kept = candidate;
    }
  }
  // Even the first sentence is too long for this channel, so fall back to a word boundary. Still a
  // prefix of the approved text, so still verbatim.
  return kept === '' ? truncateAtWord(text, max) : kept;
}

/** The text cut at the last word boundary that fits, with nothing appended. */
export function truncateAtWord(text: string, max: number): string {
  const characters = [...text];
  if (characters.length <= max) return text;
  const clipped = characters.slice(0, max).join('');
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd();
}

/** Paragraphs joined the way a caption reads them: a blank line between each. */
export function joinParagraphs(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n\n');
}
```

- [ ] **Step 4: Run the tests**

Run: `npx tsc --noEmit && npx vitest run tests/caption/text.test.ts`
Expected: clean, 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/caption/text.ts tests/caption/text.test.ts
git commit -m "feat(caption): add the caption text helpers

A caption is approved prose selected and trimmed, never written. Trimming drops
whole sentences and adds no ellipsis, so a shortened caption is still a literal
substring of text the enrichment gates passed, and needs no fact check.

Co-Authored-By: THE MODEL YOU ARE RUNNING AS <noreply@anthropic.com>   <- replace this line with your own attribution
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task 2: Reading a post's prose, its cited sources, and writing a caption row

**Files:**
- Modify: `src/db/posts.ts`
- Create: `src/db/captions.ts`

**Interfaces:**
- Produces: `postForCaption(db, postId): PostForCaption | undefined`, `postCitedSources(db, postId): CitedSource[]`, `upsertCaption(db, caption, now?): number`, `postCaptions(db, postId): StoredCaption[]`, and the types `PostForCaption`, `CitedSource`, `NewCaption`, `StoredCaption`.

- [ ] **Step 1: Add the two readers**

`post_sources` has been written by enrichment since 2.4 and **never read back**; this is its first reader. `postForCaption` returns the post's own prose, and names the quotation `quotation` rather than `body` on purpose: `postToCompose` calls the quotation `body`, and confusing the two would put the quote where the write-up belongs.

```ts
import type { SourceInput } from '../verify/source-policy.js';
import type { Db } from './connection.js';
import { insertSource } from './sources.js';

/** After this many failed attempts a quote is no longer offered to enrich, unless a run asks to retry failed quotes. */
export const MAX_ENRICH_FAILURES = 3;

export interface ItemToEnrich {
  itemId: number;
  subjectId: number;
  body: string;
  workTitle: string;
  author: string;
  wikidataId: string;
}

export interface ItemsToEnrichOptions {
  /** Also offer quotes that have already failed MAX_ENRICH_FAILURES times. */
  retryFailed?: boolean;
}

/**
 * Verified quotes in a vertical with no post yet, at most `limit`, with their author.
 *
 * Quotes with fewer recorded failures come first, so a quote that always fails cannot hold back new
 * ones, and a quote that has failed MAX_ENRICH_FAILURES times is left out unless `retryFailed`. Within
 * that, subjects take turns: every subject's oldest waiting quote comes before any subject's second, so
 * a small limit still mixes authors. Quotes without a work title or an author Wikidata id cannot be
 * given sources and are not returned; harvest always records both.
 */
export function itemsToEnrich(db: Db, verticalId: number, limit: number, options: ItemsToEnrichOptions = {}): ItemToEnrich[] {
  return db
    .prepare(
      `SELECT itemId, subjectId, body, workTitle, author, wikidataId FROM (
         SELECT i.id AS itemId, s.id AS subjectId, i.body AS body, i.work_title AS workTitle, s.name AS author, s.wikidata_id AS wikidataId,
                (SELECT COUNT(*) FROM enrich_failures f WHERE f.item_id = i.id) AS failures,
                ROW_NUMBER() OVER (PARTITION BY i.subject_id ORDER BY i.id) AS turn
         FROM items i JOIN subjects s ON s.id = i.subject_id
         WHERE i.vertical_id = ? AND i.kind = 'quote' AND i.status = 'verified'
           AND i.work_title IS NOT NULL AND s.wikidata_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.item_id = i.id)
       )
       WHERE ? = 1 OR failures < ?
       ORDER BY failures, turn, subjectId, itemId
       LIMIT ?`,
    )
    .all(verticalId, options.retryFailed === true ? 1 : 0, MAX_ENRICH_FAILURES, limit) as ItemToEnrich[];
}

/** Records one failed attempt to write a post for a quote. */
export function recordEnrichFailure(db: Db, itemId: number, reason: string, now: Date = new Date()): void {
  db.prepare('INSERT INTO enrich_failures (item_id, reason, failed_at) VALUES (?, ?, ?)').run(itemId, reason, now.toISOString());
}

/** Verified quotes without a post that are no longer offered because they failed MAX_ENRICH_FAILURES times. */
export function countGivenUp(db: Db, verticalId: number): number {
  return db
    .prepare(
      `SELECT COUNT(*) FROM items i
       WHERE i.vertical_id = ? AND i.kind = 'quote' AND i.status = 'verified'
         AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.item_id = i.id)
         AND (SELECT COUNT(*) FROM enrich_failures f WHERE f.item_id = i.id) >= ?`,
    )
    .pluck()
    .get(verticalId, MAX_ENRICH_FAILURES) as number;
}

export interface PostForCaption {
  postId: number;
  verticalId: number;
  status: string;
  /** The post's own editorial prose, which is what a caption is built from. */
  hook: string;
  /** Body paragraphs separated by a blank line. */
  body: string;
  closer: string;
  /**
   * The quotation, exactly as the source prints it. Named `quotation` rather than `body` on purpose:
   * PostToCompose calls the quotation `body`, and confusing the two would put the quote where the
   * write-up belongs.
   */
  quotation: string;
  workTitle: string;
  workYear: number | null;
  author: string;
  /** Null when the media stage has not run; 'generated' is what obliges a caption to disclose (spec section 9). */
  imageLicense: string | null;
}

/** The one post a caption run is about: its approved prose, the quotation it is about, and its image's licence. */
export function postForCaption(db: Db, postId: number): PostForCaption | undefined {
  return db
    .prepare(
      `SELECT p.id AS postId, p.vertical_id AS verticalId, p.status, p.hook, p.body, p.closer,
              i.body AS quotation, i.work_title AS workTitle, i.work_year AS workYear,
              s.name AS author, im.license AS imageLicense
       FROM posts p
       JOIN items i ON i.id = p.item_id
       JOIN subjects s ON s.id = i.subject_id
       LEFT JOIN images im ON im.id = p.image_id
       WHERE p.id = ?`,
    )
    .get(postId) as PostForCaption | undefined;
}

export interface CitedSource {
  /** The label the post's drafts cite it by (S1, S2, ...). */
  label: string;
  tier: number;
  url: string | null;
  citation: string;
  excerpt: string | null;
}

/**
 * The sources a post's drafts cited, under the labels they used.
 *
 * Nothing has read `post_sources` back before now: enrichment writes it and never looks again. A
 * caption that is not a pure truncation is judged against exactly these, so the caption gate sees
 * the same evidence the post was written from and no more (spec section 7).
 */
export function postCitedSources(db: Db, postId: number): CitedSource[] {
  return db
    .prepare(
      `SELECT ps.label, so.tier, so.url, so.citation, so.excerpt
       FROM post_sources ps
       JOIN sources so ON so.id = ps.source_id
       WHERE ps.post_id = ?
       ORDER BY ps.label`,
    )
    .all(postId) as CitedSource[];
}

export interface PostToCompose {
  postId: number;
  verticalId: number;
  /** Null until the media stage has given the post an image; compose has nothing to compose without one. */
  imageId: number | null;
  status: string;
  /** The quotation, exactly as the source prints it (spec section 8). */
  body: string;
  workTitle: string;
  workYear: number | null;
  author: string;
}

/** The one post a compose run is about, with the quotation and the work it comes from. */
export function postToCompose(db: Db, postId: number): PostToCompose | undefined {
  return db
    .prepare(
      `SELECT p.id AS postId, p.vertical_id AS verticalId, p.image_id AS imageId, p.status,
              i.body AS body, i.work_title AS workTitle, i.work_year AS workYear, s.name AS author
       FROM posts p
       JOIN items i ON i.id = p.item_id
       JOIN subjects s ON s.id = i.subject_id
       WHERE p.id = ?`,
    )
    .get(postId) as PostToCompose | undefined;
}

/**
 * Rewrites a post's alt text once its card exists. Enrich writes a placeholder from the quote alone;
 * the composed card is what a reader actually sees, so this stage owns the description (plan 2.6).
 */
export function updateAltText(db: Db, postId: number, altText: string): boolean {
  return db.prepare('UPDATE posts SET alt_text = ? WHERE id = ?').run(altText, postId).changes === 1;
}

export interface PostRound {
  round: 1 | 2;
  draft: unknown;
  check: unknown;
  /** Every problem the gates found in this round; empty when it passed. */
  problems: string[];
  writerModel: string;
  checkerModel: string;
  /** sha256 of the round's writer system prompt, a blank line, and the checker's system prompt. */
  promptSha256: string;
}

export interface PostSource {
  /** The label the drafts cite it by (S1, S2, ...). */
  label: string;
  source: SourceInput;
  retrievedAt: Date;
}

export interface NewPost {
  itemId: number;
  verticalId: number;
  hook: string;
  /** Body paragraphs separated by a blank line. */
  body: string;
  closer: string;
  altText: string;
  status: 'draft' | 'needs_review';
  rounds: PostRound[];
  sources: PostSource[];
}

/** A post that would break the enrichment rules: nothing was written. */
export class PostRuleError extends Error {
  override name = 'PostRuleError';
}

/**
 * Inserts a post with its rounds and cited sources in one transaction. The quote must be verified
 * (spec section 2.1), the rounds must be numbered from 1 in order, and a 'draft' post's last round must
 * have no problems (spec section 2.6). Each cited paragraph becomes a source of the quote (spec section
 * 2.2: every claim traces to a stored source), reusing an identical source row the quote already has,
 * and is linked to the post under its label.
 */
export function insertPost(db: Db, post: NewPost, now: Date = new Date()): number {
  return db.transaction((): number => {
    const status = db.prepare('SELECT status FROM items WHERE id = ?').pluck().get(post.itemId) as string | undefined;
    if (status !== 'verified') throw new PostRuleError(`item ${post.itemId} is ${status ?? 'missing'}, not verified`);
    const last = post.rounds[post.rounds.length - 1];
    if (last === undefined) throw new PostRuleError('a post needs at least one round');
    if (post.rounds.some((r, i) => r.round !== i + 1)) throw new PostRuleError('rounds must be numbered from 1, in order');
    if (post.status === 'draft' && last.problems.length > 0) throw new PostRuleError('a draft post cannot have problems in its last round');

    const postId = Number(
      db
        .prepare('INSERT INTO posts (item_id, vertical_id, hook, body, closer, alt_text, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(post.itemId, post.verticalId, post.hook, post.body, post.closer, post.altText, post.status, now.toISOString()).lastInsertRowid,
    );
    const existing = db
      .prepare('SELECT id FROM sources WHERE item_id = ? AND tier = ? AND url IS ? AND citation = ? AND excerpt IS ? ORDER BY id LIMIT 1')
      .pluck();
    const link = db.prepare('INSERT INTO post_sources (post_id, source_id, label) VALUES (?, ?, ?)');
    for (const { label, source, retrievedAt } of post.sources) {
      const found = existing.get(post.itemId, source.tier, source.url ?? null, source.citation, source.excerpt ?? null) as number | undefined;
      link.run(postId, found ?? insertSource(db, post.itemId, source, retrievedAt), label);
    }
    const round = db.prepare(
      'INSERT INTO post_rounds (post_id, round, draft_json, check_json, problems_json, writer_model, checker_model, prompt_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of post.rounds) {
      round.run(
        postId,
        r.round,
        JSON.stringify(r.draft),
        JSON.stringify(r.check),
        JSON.stringify(r.problems),
        r.writerModel,
        r.checkerModel,
        r.promptSha256,
        now.toISOString(),
      );
    }
    return postId;
  })();
}
```

- [ ] **Step 2: Add the caption writer**

Keyed on the existing `UNIQUE(post_id, platform)`, exactly as `upsertRendition` is keyed on `UNIQUE(post_id, format)`, so re-running replaces one platform's row and leaves the others.

```ts
import type { Db } from './connection.js';

export interface NewCaption {
  postId: number;
  platform: string;
  /** Pinterest and YouTube carry a title; Facebook has only a caption body. */
  title: string | null;
  /** The caption body, already within the channel's text_max. */
  text: string;
  /** Space-separated. Unused by both Phase 2 channels: Pinterest copy is plain keywords (spec section 11). */
  hashtags: string | null;
  /** The archive permalink. Null until the archive site ships in Phase 8 (spec section 13, user decision 2026-09-16). */
  link: string | null;
}

export interface StoredCaption {
  id: number;
  platform: string;
  title: string | null;
  text: string;
  charCount: number;
}

/**
 * Writes one platform's caption, replacing the row that platform already has.
 *
 * The table's UNIQUE(post_id, platform) makes this the natural shape, exactly as UNIQUE(post_id,
 * format) does for renditions: re-running the stage regenerates one platform's caption and leaves
 * every other platform untouched.
 *
 * `char_count` is computed here rather than passed in, so it cannot disagree with the text it
 * counts. It counts the body only: `text_max` governs `captions.text` and `title_max` governs the
 * title, so a combined number would mean neither.
 */
export function upsertCaption(db: Db, caption: NewCaption, now: Date = new Date()): number {
  db.prepare(
    `INSERT INTO captions (post_id, platform, title, text, hashtags, link, char_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(post_id, platform) DO UPDATE SET
       title = excluded.title,
       text = excluded.text,
       hashtags = excluded.hashtags,
       link = excluded.link,
       char_count = excluded.char_count,
       created_at = excluded.created_at`,
  ).run(
    caption.postId,
    caption.platform,
    caption.title,
    caption.text,
    caption.hashtags,
    caption.link,
    [...caption.text].length,
    now.toISOString(),
  );
  return db.prepare('SELECT id FROM captions WHERE post_id = ? AND platform = ?').pluck().get(caption.postId, caption.platform) as number;
}

/** Every caption a post has, for the review UI and for deciding what the stage still owes it. */
export function postCaptions(db: Db, postId: number): StoredCaption[] {
  return db
    .prepare(
      `SELECT id, platform, title, text, char_count AS charCount
       FROM captions
       WHERE post_id = ?
       ORDER BY platform`,
    )
    .all(postId) as StoredCaption[];
}
```

- [ ] **Step 3: Type-check and run the existing suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean, and every existing test still passes.

- [ ] **Step 4: Commit**

```bash
git add src/db/posts.ts src/db/captions.ts
git commit -m "feat(caption): read a post's prose and its cited sources, and write caption rows

post_sources has been written since enrichment and never read back; the caption
gate is its first reader, so a caption is judged against exactly the evidence
the post was written from.

Co-Authored-By: THE MODEL YOU ARE RUNNING AS <noreply@anthropic.com>   <- replace this line with your own attribution
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task 3: The two platform builders

**Files:**
- Create: `src/caption/facebook.ts`, `src/caption/pinterest.ts`

**Interfaces:**
- Consumes: Task 1's helpers, Task 2's `PostForCaption`.
- Produces: `facebookCaption(post, limits): BuiltCaption`, `disclosureFor(imageLicense): string | null`, `pinterestCaption(post, limits): BuiltCaption`, `CaptionConfigError`, and the types `CaptionLimits`, `BuiltCaption`.

- [ ] **Step 1: Facebook**

The write-up itself, trimmed to the channel's limit. No model call. The disclosure is reserved out of the budget *before* the prose is fitted, so a caption cannot be trimmed to exactly the limit and then pushed over it by the line that has to be there.

```ts
import type { PostForCaption } from '../db/posts.js';
import { BOILERPLATE, fitSentences, joinParagraphs } from './text.js';

export interface CaptionLimits {
  /** The channel's cap on the caption body. */
  textMax: number;
  /** The channel's cap on a title, where the platform has one. Facebook does not. */
  titleMax?: number | undefined;
}

export interface BuiltCaption {
  title: string | null;
  text: string;
  hashtags: string | null;
  link: string | null;
}

/** An AI-generated image must say so (spec section 9). No whitelisted licence obliges a credit line; that belongs on the archive page (spec section 10). */
export function disclosureFor(imageLicense: string | null): string | null {
  return imageLicense === 'generated' ? (BOILERPLATE[0] ?? null) : null;
}

/**
 * Facebook's caption: the post's own prose, trimmed to the channel's limit.
 *
 * A Facebook post is a paragraph of writing under a picture, so the caption is the write-up itself
 * rather than anything reshaped for it. Nothing here calls a model: every sentence is approved prose
 * carried over whole, which is what keeps this a formatting step (spec sections 7 and 15).
 *
 * The disclosure is reserved out of the budget before the prose is fitted, so a caption can never be
 * trimmed to exactly the limit and then pushed over it by the line that has to be there.
 */
export function facebookCaption(post: PostForCaption, limits: CaptionLimits): BuiltCaption {
  const disclosure = disclosureFor(post.imageLicense);
  const reserved = disclosure === null ? 0 : [...disclosure].length + 2;
  const prose = fitSentences(joinParagraphs([post.hook, post.body, post.closer]), Math.max(0, limits.textMax - reserved));
  return {
    title: null,
    text: disclosure === null ? prose : `${prose}\n\n${disclosure}`,
    hashtags: null,
    link: null,
  };
}
```

- [ ] **Step 2: Pinterest**

The title is the approved hook cut at a word boundary (user decision 2026-09-16), so it is verbatim and needs no check. `hashtags` stays null because Pinterest copy is plain keywords (spec section 11), and `link` stays null until the archive site ships in Phase 8 (section 13). A pinterest channel with no `title_max` is an error, not a silent over-long title.

```ts
import type { PostForCaption } from '../db/posts.js';
import type { BuiltCaption, CaptionLimits } from './facebook.js';
import { disclosureFor } from './facebook.js';
import { fitSentences, joinParagraphs, truncateAtWord } from './text.js';

/** Pinterest without a title_max would silently publish an over-long title, so the channel must declare one. */
export class CaptionConfigError extends Error {
  override name = 'CaptionConfigError';
}

/**
 * Pinterest's pin: a title, a description, and no link yet.
 *
 * The title is the post's approved hook, cut at a word boundary to the channel's title_max (user
 * decision 2026-09-16). The hook is already written to be the compelling first line, so nothing has
 * to invent a title, and because the result is verbatim approved text it costs no fact check.
 *
 * `hashtags` stays null: Pinterest is a search surface and the spec asks for plain keywords, not
 * hashtag spam (section 11). `link` stays null until the archive site ships in Phase 8 (section 13),
 * because there is nowhere honest to point it in the meantime.
 */
export function pinterestCaption(post: PostForCaption, limits: CaptionLimits): BuiltCaption {
  if (limits.titleMax === undefined) {
    throw new CaptionConfigError('a pinterest channel must set caption.title_max, since every pin carries a title');
  }
  const disclosure = disclosureFor(post.imageLicense);
  const reserved = disclosure === null ? 0 : [...disclosure].length + 2;
  const description = fitSentences(joinParagraphs([post.body, post.closer]), Math.max(0, limits.textMax - reserved));
  return {
    title: truncateAtWord(post.hook.trim(), limits.titleMax),
    text: disclosure === null ? description : `${description}\n\n${disclosure}`,
    hashtags: null,
    link: null,
  };
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/caption/facebook.ts src/caption/pinterest.ts
git commit -m "feat(caption): build the Facebook and Pinterest captions

Facebook takes the write-up; Pinterest takes a title from the approved hook and
a description from the body and closer. Neither invents a sentence, and neither
calls a model.

Co-Authored-By: THE MODEL YOU ARE RUNNING AS <noreply@anthropic.com>   <- replace this line with your own attribution
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task 4: The caption stage

**Files:**
- Create: `src/caption/caption.ts`
- Test: `tests/caption/caption.test.ts`

**Interfaces:**
- Consumes: everything Tasks 1-3 produce, plus `checkProblems` and `splitSentences` from `src/enrich/`, and `unsupportedNumbers` from `src/verify/numbers.js`.
- Produces: `captionPost(options): Promise<CaptionReport>`, `CaptionError`, `CAPTION_PLATFORMS`, `isCaptionPlatform`, `BUILDERS`, `approvedText`, `formatSource`, `captionCheckMessage`, `captionSentences`, and the types `CaptionPlatform`, `CaptionBuilder`, `CaptionOptions`, `CaptionOutcome`, `PlatformReport`, `CaptionReport`.

- [ ] **Step 1: Write the failing test**

Two things in this file are deliberate and must not be "simplified":

The fixture inserts the post through the **real `insertPost`**, with real rounds and sources, because the caption gate reads `post_sources` and an approximation of those rows would not exercise it. It also reuses its vertical and subject when seeding a second post, since both slugs are unique and only collide on the second call.

One test asserts that the checker is **never reached** through the real builders, and another drives the refusal path through an **injected** builder. That is not a workaround: no real builder can produce a caption that is not approved text, so an injected one is the only honest way to exercise the gate. See the note in Task 4's implementation.

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { captionPost, CaptionError, approvedText, captionSentences, formatSource } from '../../src/caption/caption.js';
import type { CaptionPlatform } from '../../src/caption/caption.js';
import type { CaptionLimits } from '../../src/caption/facebook.js';
import { unapprovedSentences } from '../../src/caption/text.js';
import { upsertCaption } from '../../src/db/captions.js';
import type { Db } from '../../src/db/connection.js';
import { insertPost, type NewPost } from '../../src/db/posts.js';
import type { ModelFn, ModelAnswer } from '../../src/enrich/anthropic.js';
import { testDb } from '../helpers/db.js';

const NOW = new Date('2026-09-16T12:00:00Z');
const CHECK_PROMPT = 'the fact-check system prompt';
const LIMITS: Record<CaptionPlatform, CaptionLimits> = {
  facebook: { textMax: 2000, titleMax: undefined },
  pinterest: { textMax: 800, titleMax: 100 },
};

const HOOK = 'Dickens opened his new weekly with a sentence that refuses to settle.';
const BODY = 'The first instalment ran in April 1859.\n\nHe was steering the magazine himself, and the novel carried its first number.';
const CLOSER = 'Read it and see how early the line arrives.';

let db: Db;
let postId: number;
let asked: { system: string; user: string }[];
/** Keeps each seeded item's body_hash unique; items are unique on (vertical_id, body_hash). */
let seq: number;

/** Answers every sentence "supported", which is what a caption of approved text should get. */
const supportive: ModelFn = async (system, user) => {
  asked.push({ system, user });
  const count = (user.match(/^\(\d+\)/gm) ?? []).length;
  const value = {
    sentences: Array.from({ length: count }, (_, i) => ({ id: i + 1, kind: 'other', supported: true, sources: ['Q'], problem: '' })),
  };
  return { value, model: 'test-checker', inputTokens: 0, outputTokens: 0 } satisfies ModelAnswer;
};

const refusing: ModelFn = async (system, user) => {
  asked.push({ system, user });
  return {
    value: { sentences: [{ id: 1, kind: 'fact', supported: false, sources: [], problem: 'the sources do not say this' }] },
    model: 'test-checker',
    inputTokens: 0,
    outputTokens: 0,
  } satisfies ModelAnswer;
};

/**
 * A post with real sources, written through insertPost rather than raw SQL.
 *
 * The caption gate reads post_sources, which nothing has ever read back before, so the fixture has
 * to produce exactly the rows enrichment writes rather than an approximation of them.
 */
function seed(hook = HOOK, body = BODY, closer = CLOSER): number {
  const id = (sql: string, ...params: unknown[]) => Number(db.prepare(sql).run(...params).lastInsertRowid);
  const pick = (sql: string, ...params: unknown[]) => db.prepare(sql).pluck().get(...params) as number | undefined;

  // A test may seed more than one post. The vertical slug, the subject slug and the item body_hash
  // are each unique, and every one of them only bites on the second call.
  const verticalId =
    pick("SELECT id FROM verticals WHERE slug = 'literature'") ??
    id("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'The Commonplace Book', 'config/verticals/literature.yaml')");
  const subjectId =
    pick('SELECT id FROM subjects WHERE vertical_id = ? AND slug = ?', verticalId, 'charles-dickens') ??
    id(
      "INSERT INTO subjects (vertical_id, kind, name, slug, wikidata_id, created_at) VALUES (?, 'author', 'Charles Dickens', 'charles-dickens', 'Q5686', ?)",
      verticalId,
      NOW.toISOString(),
    );
  const itemId = id(
    `INSERT INTO items (vertical_id, subject_id, kind, body, body_hash, work_title, work_year, status, created_at)
     VALUES (?, ?, 'quote', 'It was the best of times, it was the worst of times.', ?, 'A Tale of Two Cities', 1859, 'raw', ?)`,
    verticalId,
    subjectId,
    `hash-${++seq}`,
    NOW.toISOString(),
  );
  // A post may only be written for a verified quote, and an item may only be promoted once it has a source.
  id(
    "INSERT INTO sources (item_id, tier, url, citation, excerpt, retrieved_at) VALUES (?, 1, 'https://www.gutenberg.org/ebooks/98', 'A Tale of Two Cities', 'It was the best of times', ?)",
    itemId,
    NOW.toISOString(),
  );
  db.prepare("UPDATE items SET status = 'verified' WHERE id = ?").run(itemId);

  const post: NewPost = {
    itemId,
    verticalId,
    hook,
    body,
    closer,
    altText: 'a placeholder',
    status: 'draft',
    rounds: [
      {
        round: 1,
        draft: { hook: { text: hook, sources: ['S1'] }, body: [{ text: body, sources: ['S1'] }], closer: { text: closer, sources: [] } },
        check: { sentences: [] },
        problems: [],
        writerModel: 'test-writer',
        checkerModel: 'test-checker',
        promptSha256: 'a'.repeat(64),
      },
    ],
    sources: [
      {
        label: 'S1',
        source: { tier: 3, url: 'https://en.wikipedia.org/wiki/Charles_Dickens', citation: 'Wikipedia, Charles Dickens, lead', excerpt: 'The first instalment ran in April 1859.' },
        retrievedAt: NOW,
      },
    ],
  };
  return insertPost(db, post, NOW);
}

const run = (platforms: readonly CaptionPlatform[], check: ModelFn = supportive, post = postId) =>
  captionPost({ db, postId: post, platforms, limits: LIMITS, check, checkPrompt: CHECK_PROMPT, now: () => NOW });

beforeEach(() => {
  db = testDb();
  asked = [];
  seq = 0;
  postId = seed();
});

describe('captionPost', () => {
  it('writes one caption per platform, with Pinterest alone carrying a title', async () => {
    const report = await run(['facebook', 'pinterest']);
    expect(report).toMatchObject({ postId, considered: 2, written: 2, failed: 0 });

    const rows = db.prepare('SELECT platform, title, text, char_count AS charCount, hashtags, link FROM captions ORDER BY platform').all() as {
      platform: string;
      title: string | null;
      text: string;
      charCount: number;
      hashtags: string | null;
      link: string | null;
    }[];
    expect(rows.map((row) => row.platform)).toEqual(['facebook', 'pinterest']);

    const facebook = rows[0]!;
    const pinterest = rows[1]!;
    expect(facebook.title).toBeNull();
    expect(facebook.text).toContain(HOOK);
    expect(pinterest.title).toBe(HOOK);
    // The title is the approved hook, so it never invents a phrase of its own.
    expect(HOOK.startsWith(pinterest.title ?? '')).toBe(true);

    // char_count counts the body only, and neither channel carries hashtags or a link yet.
    for (const row of rows) {
      expect(row.charCount).toBe([...row.text].length);
      expect(row.hashtags).toBeNull();
      expect(row.link).toBeNull();
    }
  });

  it('spends no fact check when every sentence is approved text', async () => {
    const report = await run(['facebook', 'pinterest']);
    expect(report.checked).toBe(0);
    expect(asked).toEqual([]);
    expect(report.items.every((item) => item.outcome.status === 'written' && !item.outcome.checked)).toBe(true);
  });

  it('respects each channel character limit', async () => {
    const long = `${BODY} ${'A sentence that goes on at length about the magazine and its readers. '.repeat(30)}`;
    const wordy = seed(HOOK, long, CLOSER);
    const report = await run(['pinterest'], supportive, wordy);

    expect(report.written).toBe(1);
    const row = db.prepare('SELECT title, text FROM captions WHERE post_id = ?').get(wordy) as { title: string; text: string };
    expect([...row.text].length).toBeLessThanOrEqual(800);
    expect([...row.title].length).toBeLessThanOrEqual(100);
  });

  it('replaces only the platform it regenerates when it runs again', async () => {
    await run(['facebook', 'pinterest']);
    const before = db.prepare('SELECT id, platform FROM captions ORDER BY platform').all() as { id: number; platform: string }[];

    await run(['facebook']);
    const after = db.prepare('SELECT id, platform FROM captions ORDER BY platform').all() as { id: number; platform: string }[];

    expect(after.map((row) => row.platform)).toEqual(['facebook', 'pinterest']);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(db.prepare('SELECT COUNT(*) FROM captions').pluck().get()).toBe(2);
  });

  it('never reaches the checker, because neither builder can produce a caption that is not approved text', async () => {
    // Worth asserting rather than assuming: as the stage stands today there is no input that makes
    // the checker fire. Both builders only select and trim the post's own prose, a truncation is
    // still a substring, and the one line that is not drawn from the post - the AI disclosure - is
    // on the allowlist. Measured across every shape the builders can emit, including a hook longer
    // than Pinterest's title_max (cut to a prefix) and a generated image (disclosure appended).
    const long = seed('Dickens opened his new weekly with a sentence that refuses to settle, and it has never stopped being quoted since.', BODY, CLOSER);
    db.prepare("UPDATE images SET license = 'generated' WHERE id = (SELECT image_id FROM posts WHERE id = ?)").run(long);

    const report = await run(['facebook', 'pinterest'], refusing, long);

    expect(report).toMatchObject({ written: 2, failed: 0, checked: 0 });
    expect(asked).toEqual([]);
    // The guard is real even so: this is what changes the day a builder reshapes text instead of
    // selecting it, which is why the checker stays wired in and tested below.
  });

  it('writes no caption when the fact check refuses one', async () => {
    // The refusal path, driven where it is reachable. No builder can currently produce a caption
    // that is not verbatim (see the test above), so the divergence is injected: a builder that adds
    // a sentence the post never approved is exactly what a future, less careful adapter would do.
    const post = seed();
    const inventing = () => ({
      title: null,
      text: 'Dickens ran the magazine in 1859 and wrote the line for its first number.',
      hashtags: null,
      link: null,
    });

    const report = await captionPost({
      db,
      postId: post,
      platforms: ['facebook'],
      limits: LIMITS,
      check: refusing,
      checkPrompt: CHECK_PROMPT,
      now: () => NOW,
      builders: { facebook: inventing, pinterest: inventing },
    });

    expect(report).toMatchObject({ written: 0, failed: 1, checked: 1 });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.system).toBe(CHECK_PROMPT);
    const outcome = report.items[0]?.outcome;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.status === 'failed' && outcome.problems.length).toBeGreaterThan(0);
    // Nothing is stored: the review queue never shows text that was not judged.
    expect(db.prepare('SELECT COUNT(*) FROM captions WHERE post_id = ?').pluck().get(post)).toBe(0);
  });

  it('checks a caption whose text is not drawn from the approved prose', () => {
    // The rule that matters, tested where it lives: `unapprovedSentences` is what decides whether a
    // caption reaches the checker at all, and it is the one place the fixture cannot confound,
    // because both sides are passed in explicitly.
    const approved = [HOOK, BODY, CLOSER].join('\n\n');
    expect(unapprovedSentences(HOOK, approved)).toEqual([]);
    expect(unapprovedSentences(CLOSER, approved)).toEqual([]);

    const invented = 'Dickens ran the magazine in 1859 and wrote the line for its first number.';
    expect(unapprovedSentences(invented, approved)).toEqual([invented]);
  });

  it('refuses a post with no cited sources, since nothing could check its caption', async () => {
    const id = (sql: string, ...params: unknown[]) => Number(db.prepare(sql).run(...params).lastInsertRowid);
    const verticalId = db.prepare("SELECT id FROM verticals WHERE slug = 'literature'").pluck().get() as number;
    const subjectId = db.prepare("SELECT id FROM subjects WHERE slug = 'charles-dickens'").pluck().get() as number;
    const itemId = id(
      `INSERT INTO items (vertical_id, subject_id, kind, body, body_hash, work_title, work_year, status, created_at)
       VALUES (?, ?, 'quote', 'Another quotation entirely.', 'hash-2', 'Bleak House', 1853, 'raw', ?)`,
      verticalId,
      subjectId,
      NOW.toISOString(),
    );
    const bare = id(
      `INSERT INTO posts (item_id, vertical_id, hook, body, closer, alt_text, status, created_at)
       VALUES (?, ?, 'A hook', 'A body', 'A closer', 'alt', 'draft', ?)`,
      itemId,
      verticalId,
      NOW.toISOString(),
    );

    await expect(run(['facebook'], supportive, bare)).rejects.toThrow('has no cited sources');
  });

  it('refuses a post that does not exist', async () => {
    await expect(run(['facebook'], supportive, 9999)).rejects.toThrow('post 9999 does not exist');
  });
});

describe('the checker adapter', () => {
  it('numbers caption sentences from one and marks them as caption text', () => {
    expect(captionSentences('One thing. Then another.')).toEqual([
      { n: 1, part: 'caption', text: 'One thing.' },
      { n: 2, part: 'caption', text: 'Then another.' },
    ]);
  });

  it('shows a cited source under the label the post used', () => {
    expect(formatSource({ label: 'S1', tier: 3, url: null, citation: 'Wikipedia, Charles Dickens, lead', excerpt: 'He ran a weekly.' })).toBe(
      '[S1] (Wikipedia, Charles Dickens, lead) He ran a weekly.',
    );
  });

  it('offers the post its own prose as the approved text, and nothing else', () => {
    const post = {
      postId: 1,
      verticalId: 1,
      status: 'draft',
      hook: 'A hook.',
      body: 'A body.',
      closer: 'A closer.',
      quotation: 'The quotation itself.',
      workTitle: 'Bleak House',
      workYear: 1853,
      author: 'Charles Dickens',
      imageLicense: 'public-domain',
    };
    const approved = approvedText(post);
    expect(approved).toContain('A hook.');
    expect(approved).toContain('A closer.');
    // The quotation is shown beside the card, not inside the caption's approved prose.
    expect(approved).not.toContain('The quotation itself.');
  });
});

describe('upsertCaption', () => {
  it('counts the body only, not the title', () => {
    const post = seed();
    const id = upsertCaption(db, { postId: post, platform: 'pinterest', title: 'a title', text: 'a body', hashtags: null, link: null }, NOW);
    expect(db.prepare('SELECT char_count FROM captions WHERE id = ?').pluck().get(id)).toBe('a body'.length);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/caption/caption.test.ts`
Expected: FAIL, cannot resolve `../../src/caption/caption.js`.

- [ ] **Step 3: Write the stage**

`shapeProblems` has no caption analogue and is not used; numbers are checked for every caption, verbatim or not, because a truncation can carry a number away from the sentence that supported it.

```ts
import type { PLATFORMS } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { upsertCaption } from '../db/captions.js';
import type { CitedSource, PostForCaption } from '../db/posts.js';
import { postCitedSources, postForCaption } from '../db/posts.js';
import { checkSchema, splitSentences, type DraftSentence } from '../enrich/draft.js';
import { checkProblems } from '../enrich/gates.js';
import type { ModelFn } from '../enrich/anthropic.js';
import type { Logger } from '../lib/log.js';
import { unsupportedNumbers } from '../verify/numbers.js';
import type { BuiltCaption, CaptionLimits } from './facebook.js';
import { facebookCaption } from './facebook.js';
import { CaptionConfigError, pinterestCaption } from './pinterest.js';
import { unapprovedSentences } from './text.js';

/** A caption this post cannot have: the run says why rather than writing one that was never judged. */
export class CaptionError extends Error {
  override name = 'CaptionError';
}

export type CaptionPlatform = 'facebook' | 'pinterest';
export const CAPTION_PLATFORMS = ['facebook', 'pinterest'] as const satisfies readonly (typeof PLATFORMS)[number][];

export function isCaptionPlatform(value: string): value is CaptionPlatform {
  return (CAPTION_PLATFORMS as readonly string[]).includes(value);
}

export type CaptionBuilder = (post: PostForCaption, limits: CaptionLimits) => BuiltCaption;

export const BUILDERS: Readonly<Record<CaptionPlatform, CaptionBuilder>> = {
  facebook: facebookCaption,
  pinterest: pinterestCaption,
};

export interface CaptionOptions {
  db: Db;
  postId: number;
  platforms: readonly CaptionPlatform[];
  /** The caption limits of the one channel serving each platform for this post's vertical. */
  limits: Readonly<Record<CaptionPlatform, CaptionLimits>>;
  /**
   * The fact checker, used only when a caption is not verbatim approved text.
   *
   * As the two shipped builders stand, that never happens: they only select and trim approved
   * prose, so no caption reaches this. It is still wired in and tested, because the day a builder
   * reshapes text rather than selecting it, this is the gate that catches it.
   */
  check: ModelFn;
  /**
   * How each platform's caption is built. Defaults to the real builders.
   *
   * Injectable so the refusal path can be tested at all: no real builder can produce a caption that
   * is not approved text, so the only honest way to exercise the gate is a builder that invents a
   * sentence - which is exactly what a future, less careful adapter would do.
   */
  builders?: Readonly<Record<CaptionPlatform, CaptionBuilder>>;
  /** The system prompt for the checker: the contents of prompts/shared/fact-check.md. */
  checkPrompt: string;
  now?: () => Date;
  log?: Logger;
}

export type CaptionOutcome =
  | { status: 'written'; captionId: number; chars: number; checked: boolean }
  | { status: 'failed'; reason: string; problems: string[] };

export interface PlatformReport {
  platform: CaptionPlatform;
  outcome: CaptionOutcome;
}

export interface CaptionReport {
  postId: number;
  considered: number;
  written: number;
  failed: number;
  /** How many captions needed a fact check, which is how many model calls the run spent. */
  checked: number;
  items: PlatformReport[];
}

/** The approved prose a caption may draw on: the post's own write-up, nothing else. */
export function approvedText(post: PostForCaption): string {
  return [post.hook, post.body, post.closer].join('\n\n');
}

/** A cited source as the checker reads it, standing in for enrich's formatParagraph now the article and section are gone. */
export function formatSource(source: CitedSource): string {
  return `[${source.label}] (${source.citation}) ${source.excerpt ?? ''}`.trimEnd();
}

/**
 * The checker's user message for a caption.
 *
 * Deliberately the same shape enrich's checkerMessage builds, so the prompt in
 * prompts/shared/fact-check.md judges a caption exactly as it judges a draft: the quotation marked
 * [Q], the cited paragraphs, then numbered sentences.
 */
export function captionCheckMessage(post: PostForCaption, cited: readonly CitedSource[], sentences: readonly DraftSentence[]): string {
  return [
    'Source paragraphs:',
    '',
    `[Q] (the quotation, from ${post.workTitle} by ${post.author}) ${post.quotation}`,
    ...cited.map((source) => `\n${formatSource(source)}`),
    '',
    'Draft sentences:',
    sentences.map((sentence) => `(${sentence.n}) ${sentence.text}`).join('\n'),
  ].join('\n');
}

/** The caption's sentences, numbered as the checker sees them. No synthetic Draft: checkProblems needs only these. */
export function captionSentences(text: string): DraftSentence[] {
  return splitSentences(text).map((sentence, index) => ({ n: index + 1, part: 'caption', text: sentence }));
}

/**
 * Judges one caption, and reports every problem it finds.
 *
 * A caption that is a pure truncation of approved text skips the model entirely: every sentence is
 * prose the enrichment gates already passed, so there is nothing new to check (user decision
 * 2026-09-16). Anything else is checked, because a caption that stitches two approved clauses
 * together can imply something neither of them said.
 *
 * `shapeProblems` has no caption analogue - a caption has no hook, body and closer to count - but
 * numbers are checked for every caption, verbatim or not, since a truncation can still carry a
 * number away from the sentence that supported it.
 */
async function judge(
  options: CaptionOptions,
  post: PostForCaption,
  cited: readonly CitedSource[],
  built: BuiltCaption,
): Promise<{ problems: string[]; checked: boolean }> {
  const excerpts = [post.quotation, ...cited.map((source) => source.excerpt ?? '')];
  const problems = unsupportedNumbers(`${built.title ?? ''}\n${built.text}`, excerpts).map(
    (n) => `the number ${n} is not in the quotation or in any cited source`,
  );

  const unapproved = unapprovedSentences(`${built.title ?? ''}\n${built.text}`, approvedText(post));
  if (unapproved.length === 0) return { problems, checked: false };

  const sentences = captionSentences(built.text);
  const answer = await options.check(options.checkPrompt, captionCheckMessage(post, cited, sentences));
  const parsed = checkSchema.safeParse(answer.value);
  if (!parsed.success) throw new CaptionError(`the fact check for the caption was not the expected shape: ${parsed.error.message}`);
  problems.push(...checkProblems(parsed.data, sentences, new Set(cited.map((source) => source.label))));
  return { problems, checked: true };
}

/**
 * Writes a post's captions, one per requested platform.
 *
 * Safe to re-run: regenerating a platform replaces that platform's row and nothing else. A caption
 * with problems writes no row at all - a stored caption is one that passed its gate, and the review
 * queue must never show text that was never judged (spec section 6, fail closed).
 */
export async function captionPost(options: CaptionOptions): Promise<CaptionReport> {
  const now = options.now ?? (() => new Date());
  const post = postForCaption(options.db, options.postId);
  if (post === undefined) {
    const exists = options.db.prepare('SELECT 1 FROM posts WHERE id = ?').pluck().get(options.postId) !== undefined;
    throw new CaptionError(exists ? `post ${options.postId} has no subject, so its caption has no author` : `post ${options.postId} does not exist`);
  }
  const cited = postCitedSources(options.db, options.postId);
  if (cited.length === 0) throw new CaptionError(`post ${options.postId} has no cited sources, so no caption could be checked against them`);

  const builders = options.builders ?? BUILDERS;
  const report: CaptionReport = { postId: post.postId, considered: options.platforms.length, written: 0, failed: 0, checked: 0, items: [] };
  for (const platform of options.platforms) {
    let outcome: CaptionOutcome;
    try {
      const built = builders[platform](post, options.limits[platform]);
      const { problems, checked } = await judge(options, post, cited, built);
      if (checked) report.checked++;
      if (problems.length > 0) {
        outcome = { status: 'failed', reason: `${platform}: the caption did not pass its fact check`, problems };
      } else {
        const captionId = upsertCaption(
          options.db,
          { postId: post.postId, platform, title: built.title, text: built.text, hashtags: built.hashtags, link: built.link },
          now(),
        );
        outcome = { status: 'written', captionId, chars: [...built.text].length, checked };
      }
    } catch (err) {
      if (!(err instanceof CaptionError) && !(err instanceof CaptionConfigError)) throw err;
      outcome = { status: 'failed', reason: `${platform}: ${err.message}`, problems: [] };
    }
    if (outcome.status === 'written') report.written++;
    else report.failed++;
    report.items.push({ platform, outcome });
    options.log?.info('caption platform', { postId: post.postId, platform, outcome });
  }
  return report;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx tsc --noEmit && npx vitest run tests/caption/caption.test.ts`
Expected: clean, 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/caption/caption.ts tests/caption/caption.test.ts
git commit -m "feat(caption): write a post's captions, checking anything not verbatim

A caption of approved prose ships unchecked, because the enrichment gates
already passed every sentence in it. Anything else is judged against the post's
cited sources, and a caption with any problem writes no row at all.

Co-Authored-By: THE MODEL YOU ARE RUNNING AS <noreply@anthropic.com>   <- replace this line with your own attribution
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task 5: The `lantern caption` command and the documentation

**Files:**
- Modify: `src/cli.ts`, `tests/cli.test.ts`, `claude.md`, `plan.md`

- [ ] **Step 1: Add the command**

Two things here are deliberate. The post id and the platform list are judged **before** the database is opened, so a typo does not need a migrated database and an existing post before it is reported as a typo. And the checker is built **on first use**, not up front: a caption assembled from approved prose is verbatim and needs no check, which today is every caption, so demanding a key would refuse the command to anyone without one for a call that would never be made.

`findCaptionChannel` requires **exactly one** channel per (vertical, platform). The schema allows several, distinguished only by `account_ref`, and quietly taking the first would set a caption to one Page's limits and publish it to another's.

```ts
#!/usr/bin/env node
import Anthropic from '@anthropic-ai/sdk';
import { Command, CommanderError } from 'commander';
import { config as loadDotenv } from 'dotenv';
import { join, resolve } from 'node:path';
import { captionPost, CAPTION_PLATFORMS, isCaptionPlatform, type CaptionPlatform, type PlatformReport } from './caption/caption.js';
import type { CaptionLimits } from './caption/facebook.js';
import { composePost, type FormatReport } from './compose/compose.js';
import { IMAGE_FORMAT_NAMES, isImageFormat, type ImageFormat } from './compose/formats.js';
import { loadConfig } from './config/load.js';
import { openDb, type Db } from './db/connection.js';
import { migrate, pendingMigrations } from './db/migrate.js';
import { MAX_ENRICH_FAILURES } from './db/posts.js';
import { syncConfig } from './db/sync.js';
import { runChecks } from './doctor/checks.js';
import { exitCode, formatReport } from './doctor/report.js';
import { anthropicChecker, anthropicWriter, loadEnrichPrompts, type ModelFn } from './enrich/anthropic.js';
import { enrichVertical, type ItemReport } from './enrich/enrich.js';
import { DEFAULT_WIKI_ENDPOINTS } from './enrich/wikipedia.js';
import { anthropicPick, loadPickPrompt } from './harvest/anthropic-picker.js';
import { harvestVertical, type AuthorReport } from './harvest/harvest.js';
import { createHttpGet, DEFAULT_ENDPOINTS } from './harvest/sources.js';
import { redactUrl } from './lib/cache.js';
import { downloadWithRetry } from './lib/download.js';
import { buildUserAgent } from './lib/http.js';
import { createLogger } from './lib/log.js';
import { findProjectRoot, resolvePaths } from './lib/paths.js';
import { runStage } from './lib/run-stage.js';
import { DEFAULT_MEDIA_ENDPOINTS, MAX_IMAGE_BYTES } from './media/commons.js';
import { mediaVertical, type PostImageReport } from './media/media.js';
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

/** Cached GETs for a stage, with a log line for every retry so an unattended run can be read back. */
function cachedGet(refresh: boolean) {
  return createHttpGet({
    cacheDir: paths.cache,
    refresh,
    http: {
      userAgent: buildUserAgent(process.env.LANTERN_CONTACT, USER_AGENT_VERSION),
      // Gutendex can take more than a minute to answer a search; Wikidata and Wikipedia answer far sooner.
      timeoutMs: 180_000,
      onRetry: (event) => log.warn('http retry', { ...event, url: redactUrl(event.url) }),
    },
  });
}

function describeAuthor(author: AuthorReport): string {
  if (author.error !== null) return `${author.author}: skipped (${author.error})`;
  if (!author.loaded) return `${author.author}: not reached before the limit`;
  const count = (status: string) => author.books.filter((b) => b.outcome.status === status).length;
  const sum = (key: 'inserted' | 'conflicts' | 'conflictsWithDecided') =>
    author.books.reduce((n, b) => n + (b.outcome.status === 'harvested' ? b.outcome[key] : 0), 0);
  return `${author.author}: ${author.listedEntries} listed on Wikiquote; books harvested ${count('harvested')}, already picked ${count('already-picked')}, skipped ${count('skipped')}, failed ${count('failed')}; quotes inserted ${sum('inserted')}; attribution conflicts ${sum('conflicts')} recorded, ${sum('conflictsWithDecided')} with decided quotes`;
}

function describeItem(item: ItemReport): string {
  const head = `quote ${item.itemId} (${item.author}, ${item.workTitle})`;
  const outcome = item.outcome;
  if (outcome.status === 'failed') return `${head}: failed (${outcome.reason})`;
  const revised = outcome.rounds > 1 ? ', after one revision' : '';
  if (outcome.status === 'draft') return `${head}: post ${outcome.postId} drafted${revised}`;
  return `${head}: post ${outcome.postId} needs review${revised}: ${outcome.problems.join('; ')}`;
}

function describeImage(item: PostImageReport): string {
  const head = `post ${item.postId} (${item.author})`;
  const outcome = item.outcome;
  if (outcome.status === 'failed') return `${head}: failed (${outcome.reason})`;
  if (outcome.status === 'reused') return `${head}: image ${outcome.imageId} reused`;
  return `${head}: image ${outcome.imageId} from ${outcome.title} (${outcome.from}; ${outcome.refused.length} refused)`;
}

function describeCard(item: FormatReport): string {
  const outcome = item.outcome;
  if (outcome.status === 'failed') return `${item.format}: failed (${outcome.reason})`;
  const size = Math.round(outcome.bytes / 1024);
  return `${item.format}: rendition ${outcome.renditionId} at ${outcome.localPath} (${size} KB, quote ${outcome.quoteSize}px over ${outcome.lines} lines)`;
}

function describeCaption(item: PlatformReport): string {
  const outcome = item.outcome;
  if (outcome.status === 'failed') {
    const detail = outcome.problems.length > 0 ? `: ${outcome.problems.join('; ')}` : '';
    return `${item.platform}: failed (${outcome.reason})${detail}`;
  }
  return `${item.platform}: caption ${outcome.captionId}, ${outcome.chars} characters${outcome.checked ? ', fact-checked' : ', verbatim so unchecked'}`;
}

/**
 * The caption limits of the one channel serving a platform for this vertical.
 *
 * Exactly one, or the run stops. The schema allows several channels for the same vertical and
 * platform, distinguished only by account_ref, and quietly taking the first would set a caption to
 * one Page's limits and publish it to another's.
 */
function findCaptionChannel(verticalSlug: string, platform: CaptionPlatform): CaptionLimits {
  const channels = loadConfig(paths.root).channels.filter((c) => c.vertical === verticalSlug && c.platform === platform);
  const only = channels[0];
  if (only === undefined || channels.length > 1) {
    const found = channels.length === 0 ? 'none' : channels.map((c) => c.slug).join(', ');
    throw new Error(`expected exactly one ${platform} channel for vertical ${verticalSlug}, found ${found}`);
  }
  return { textMax: only.caption.text_max, titleMax: only.caption.title_max };
}

/** The vertical a post belongs to, since compose selects a post rather than a vertical. */
function findVerticalById(db: Db, verticalId: number) {
  const slug = db.prepare('SELECT slug FROM verticals WHERE id = ?').pluck().get(verticalId) as string | undefined;
  if (slug === undefined) throw new Error(`vertical ${verticalId} is not in the database; run lantern migrate`);
  return findVertical(db, slug);
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
  .description('Pull raw quotes from public-domain texts for a vertical; exits 1 if an author was skipped, a book failed, or a passage clashes with a decided quote')
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

    const get = cachedGet(opts.refresh === true);
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
    const trouble = report.authors.some(
      (a) =>
        a.error !== null ||
        a.books.some((b) => b.outcome.status === 'failed' || (b.outcome.status === 'harvested' && b.outcome.conflictsWithDecided > 0)),
    );
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
  .command('enrich')
  .description('Write posts for verified quotes from Wikipedia paragraphs, fact-check every sentence and allow one revision; exits 1 if a quote could not be written')
  .requiredOption('--vertical <slug>', 'the vertical to enrich')
  .option('--limit <n>', 'write posts for at most this many verified quotes', '5')
  .option('--refresh', 'ignore cached Wikidata and Wikipedia responses and fetch again')
  .option('--retry-failed', `also try quotes that have already failed ${MAX_ENRICH_FAILURES} times`)
  .action(async (opts: { vertical: string; limit: string; refresh?: boolean; retryFailed?: boolean }) => {
    const limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer, got ${opts.limit}`);
    const db = openMigratedDb();
    const { vertical, verticalId } = findVertical(db, opts.vertical);
    const enrich = vertical.enrich;
    if (enrich === undefined) throw new Error(`vertical ${vertical.slug} has no enrich section`);
    if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('ANTHROPIC_API_KEY is not set; the writer and the fact check need it');
    const prompts = loadEnrichPrompts(paths.root, vertical.slug);

    // A writer call can think for minutes before it answers (the SDK estimates up to 450 s for 16000 tokens).
    // A call only reads, so retrying it is safe.
    const client = new Anthropic({ timeout: 600_000, maxRetries: 2 });
    const report = await runStage(db, { stage: 'enrich', verticalId }, () =>
      enrichVertical({
        db,
        verticalId,
        vertical,
        enrich,
        get: cachedGet(opts.refresh === true),
        endpoints: DEFAULT_WIKI_ENDPOINTS,
        write: anthropicWriter(client, enrich.writer_model),
        check: anthropicChecker(client, enrich.checker_model),
        prompts,
        limit,
        retryFailed: opts.retryFailed === true,
        log,
      }),
    );
    for (const item of report.items) console.log(describeItem(item));
    console.log(`posts: ${report.drafted} draft, ${report.needsReview} needs review; failed: ${report.failed}`);
    if (report.givenUp > 0) {
      console.log(`given up after ${MAX_ENRICH_FAILURES} failed attempts: ${report.givenUp} (run with --retry-failed to try them again)`);
    }
    if (report.failed > 0) process.exitCode = 1;
  });

program
  .command('media')
  .description('Give each post a public-domain source image from Wikimedia Commons; exits 1 if a post could not be given one')
  .requiredOption('--vertical <slug>', 'the vertical to give images')
  .option('--limit <n>', 'give an image to at most this many posts', '25')
  .option('--refresh', 'ignore cached Wikidata and Commons responses and fetch again')
  .action(async (opts: { vertical: string; limit: string; refresh?: boolean }) => {
    const limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer, got ${opts.limit}`);
    const db = openMigratedDb();
    const { verticalId } = findVertical(db, opts.vertical);
    const userAgent = buildUserAgent(process.env.LANTERN_CONTACT, USER_AGENT_VERSION);
    const report = await runStage(db, { stage: 'media', verticalId }, () =>
      mediaVertical({
        db,
        verticalId,
        get: cachedGet(opts.refresh === true),
        endpoints: DEFAULT_MEDIA_ENDPOINTS,
        // Originals are streamed under data/media/source/, never into the response cache.
        download: async (url, destPath) =>
          downloadWithRetry(url, destPath, {
            userAgent,
            maxBytes: MAX_IMAGE_BYTES,
            onRetry: (event) => log.warn('download retry', { ...event, url: redactUrl(event.url) }),
          }),
        mediaDir: paths.media,
        limit,
        log,
      }),
    );
    for (const item of report.items) console.log(describeImage(item));
    console.log(`images: ${report.attached} downloaded, ${report.reused} reused; failed: ${report.failed}`);
    if (report.noWikidataId > 0) console.log(`waiting on a subject Wikidata id: ${report.noWikidataId}`);
    if (report.failed > 0) process.exitCode = 1;
  });

program
  .command('compose')
  .description('Render the cards for a post from its source image and its text; exits 1 if a format could not be rendered')
  .requiredOption('--post <id>', 'the post to compose')
  .option('--formats <list>', `comma-separated formats to render (${IMAGE_FORMAT_NAMES.join(', ')}); defaults to the vertical's compose.formats`)
  .action(async (opts: { post: string; formats?: string }) => {
    // Everything that can be judged from the arguments alone is judged first: a typo should not need
    // a migrated database and an existing post before it is reported as a typo.
    const postId = Number(opts.post);
    if (!Number.isInteger(postId) || postId < 1) throw new Error(`--post must be a positive integer, got ${opts.post}`);
    const named = opts.formats?.split(',').map((format) => format.trim()).filter((format) => format !== '');
    if (named !== undefined && named.length === 0) throw new Error('--formats must name at least one format');
    for (const format of named ?? []) {
      if (!isImageFormat(format)) throw new Error(`unknown format: ${format}; expected ${IMAGE_FORMAT_NAMES.join(', ')}`);
    }

    const db = openMigratedDb();
    // Only the vertical is needed here. composePost owns every other judgement about the post,
    // including telling a post with no subject apart from one that does not exist.
    const postVerticalId = db.prepare('SELECT vertical_id FROM posts WHERE id = ?').pluck().get(postId) as number | undefined;
    if (postVerticalId === undefined) throw new Error(`post ${postId} does not exist`);
    const { vertical, verticalId } = findVerticalById(db, postVerticalId);
    const compose = vertical.compose;
    if (compose === undefined) throw new Error(`vertical ${vertical.slug} has no compose section`);
    const formats: readonly ImageFormat[] = named === undefined ? compose.formats : (named as ImageFormat[]);

    const report = await runStage(db, { stage: 'compose', verticalId }, () =>
      composePost({
        db,
        postId,
        formats,
        config: compose,
        fontsDir: join(paths.root, 'assets', 'fonts'),
        mediaDir: paths.media,
        log,
      }),
    );
    for (const item of report.items) console.log(describeCard(item));
    console.log(`post ${report.postId}: ${report.written} rendered, ${report.failed} failed`);
    if (report.failed > 0) process.exitCode = 1;
  });

program
  .command('caption')
  .description("Write a post's per-platform captions from its approved text; exits 1 if a platform's caption could not be written")
  .requiredOption('--post <id>', 'the post to caption')
  .option('--platforms <list>', `comma-separated platforms (${CAPTION_PLATFORMS.join(', ')}); defaults to every channel the vertical has`)
  .action(async (opts: { post: string; platforms?: string }) => {
    // Judged from the arguments alone first, so a typo is reported without a database or a post.
    const postId = Number(opts.post);
    if (!Number.isInteger(postId) || postId < 1) throw new Error(`--post must be a positive integer, got ${opts.post}`);
    const named = opts.platforms?.split(',').map((platform) => platform.trim()).filter((platform) => platform !== '');
    if (named !== undefined && named.length === 0) throw new Error('--platforms must name at least one platform');
    for (const platform of named ?? []) {
      if (!isCaptionPlatform(platform)) throw new Error(`unknown platform: ${platform}; expected ${CAPTION_PLATFORMS.join(', ')}`);
    }

    const db = openMigratedDb();
    const postVerticalId = db.prepare('SELECT vertical_id FROM posts WHERE id = ?').pluck().get(postId) as number | undefined;
    if (postVerticalId === undefined) throw new Error(`post ${postId} does not exist`);
    const { vertical, verticalId } = findVerticalById(db, postVerticalId);
    const enrich = vertical.enrich;
    if (enrich === undefined) throw new Error(`vertical ${vertical.slug} has no enrich section, which names the model that checks a caption`);

    const platforms: readonly CaptionPlatform[] = named === undefined ? [...CAPTION_PLATFORMS] : (named as CaptionPlatform[]);
    const limits = Object.fromEntries(platforms.map((platform) => [platform, findCaptionChannel(vertical.slug, platform)])) as Record<
      CaptionPlatform,
      CaptionLimits
    >;

    // The checker is built on first use, not up front. A caption assembled from approved prose is
    // verbatim and needs no check, which today is every caption, so demanding a key here would
    // refuse the command to anyone without one for a call that would never be made.
    let checker: ModelFn | undefined;
    const check: ModelFn = (system, user) => {
      if (checker === undefined) {
        if (!process.env.ANTHROPIC_API_KEY?.trim()) {
          throw new Error('a caption is not verbatim approved text and must be fact-checked, but ANTHROPIC_API_KEY is not set');
        }
        checker = anthropicChecker(new Anthropic({ timeout: 600_000, maxRetries: 2 }), enrich.checker_model);
      }
      return checker(system, user);
    };

    const report = await runStage(db, { stage: 'caption', verticalId }, () =>
      captionPost({
        db,
        postId,
        platforms,
        limits,
        check,
        checkPrompt: loadEnrichPrompts(paths.root, vertical.slug).check,
        log,
      }),
    );
    for (const item of report.items) console.log(describeCaption(item));
    console.log(`post ${report.postId}: ${report.written} written, ${report.failed} failed; fact checks run: ${report.checked}`);
    if (report.failed > 0) process.exitCode = 1;
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

- [ ] **Step 2: Add the command's tests**

```ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Resolved as an absolute file:// URL (not the bare "tsx" specifier) so the loader
// resolves from this repo's node_modules regardless of the child process's cwd.
const TSX_LOADER = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

interface LanternOpts {
  cwd?: string;
  root?: string | null; // null omits LANTERN_ROOT from the child env
  db?: string | null; // null omits LANTERN_DB from the child env
  logs?: string | null; // null omits LANTERN_LOGS from the child env
  env?: Record<string, string>; // extra child env, applied last
}

function lantern(args: string[], scratch: string, opts: LanternOpts = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    FB_PAGE_ID_COMMONPLACE: 'x',
    PINTEREST_BOARD_ID_COMMONPLACE: 'x',
    YT_CHANNEL_ID_LOOK_CLOSER: 'x',
    LANTERN_CONTACT: 'test@example.invalid',
  };

  const root = 'root' in opts ? opts.root : ROOT;
  if (root === null) delete env.LANTERN_ROOT;
  else env.LANTERN_ROOT = root;

  const db = 'db' in opts ? opts.db : join(scratch, 'lantern.db');
  if (db === null) delete env.LANTERN_DB;
  else env.LANTERN_DB = db;

  const logs = 'logs' in opts ? opts.logs : join(scratch, 'logs');
  if (logs === null) delete env.LANTERN_LOGS;
  else env.LANTERN_LOGS = logs;

  Object.assign(env, opts.env ?? {});

  const res = spawnSync(process.execPath, ['--import', TSX_LOADER, join(ROOT, 'src', 'cli.ts'), ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    env,
  });
  return { code: res.status, out: res.stdout + res.stderr };
}

function logRecords(logs: string): Record<string, unknown>[] {
  if (!existsSync(logs)) return [];
  return readdirSync(logs).flatMap((file) =>
    readFileSync(join(logs, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}

describe('lantern CLI', () => {
  it('doctor fails on a fresh database, then passes after migrate', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));

    const before = lantern(['doctor'], scratch);
    expect(before.code).toBe(1);
    expect(before.out).toContain('[FAIL] db.migrations');

    const migrated = lantern(['migrate'], scratch);
    expect(migrated.code).toBe(0);
    expect(migrated.out).toContain('001_initial.sql');

    const after = lantern(['doctor'], scratch);
    expect(after.code).toBe(0);
    expect(after.out).toContain('0 failed, 0 warnings');
  }, 30_000);

  it('doctor --json emits machine-readable results', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    lantern(['migrate'], scratch);
    const res = lantern(['doctor', '--json'], scratch);
    const parsed = JSON.parse(res.out) as Array<{ name: string; status: string }>;
    expect(parsed.find((r) => r.name === 'db.integrity')?.status).toBe('ok');
  }, 30_000);

  it('resolves the project root from its own install location, not an unrelated cwd', () => {
    const emptyCwd = mkdtempSync(join(tmpdir(), 'lantern-cli-cwd-'));
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-scratch-'));

    const migrated = lantern(['migrate'], scratch, { cwd: emptyCwd, root: null });
    expect(migrated.code).toBe(0);
    expect(migrated.out).toContain('001_initial.sql');

    const doctored = lantern(['doctor'], scratch, { cwd: emptyCwd, root: null });
    expect(doctored.code).toBe(0);

    expect(existsSync(join(emptyCwd, 'data'))).toBe(false);
    expect(existsSync(join(emptyCwd, 'logs'))).toBe(false);
  }, 30_000);

  it('honours LANTERN_DB / LANTERN_LOGS set in .env at the project root', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-env-'));
    cpSync(join(ROOT, 'config'), join(scratch, 'config'), { recursive: true });
    cpSync(join(ROOT, 'migrations'), join(scratch, 'migrations'), { recursive: true });
    writeFileSync(
      join(scratch, '.env'),
      [
        'LANTERN_DB=custom/fromdotenv.db',
        'LANTERN_LOGS=dotenvlogs',
        'FB_PAGE_ID_COMMONPLACE=x',
        'PINTEREST_BOARD_ID_COMMONPLACE=x',
        'YT_CHANNEL_ID_LOOK_CLOSER=x',
        '',
      ].join('\n'),
    );

    const migrated = lantern(['migrate'], scratch, { root: scratch, db: null, logs: null });
    expect(migrated.code).toBe(0);

    expect(existsSync(join(scratch, 'custom', 'fromdotenv.db'))).toBe(true);
    expect(existsSync(join(scratch, 'dotenvlogs'))).toBe(true);
  }, 30_000);

  it('logs a mistyped command to logs/ and exits 1', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const res = lantern(['doctr'], scratch);
    expect(res.code).toBe(1);
    expect(res.out).toContain("unknown command 'doctr'");
    expect(logRecords(join(scratch, 'logs'))).toEqual([
      expect.objectContaining({ level: 'error', msg: 'command rejected', code: 'commander.unknownCommand' }),
    ]);
  }, 30_000);

  it('exits 0 for --help without logging an error', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const res = lantern(['--help'], scratch);
    expect(res.code).toBe(0);
    expect(res.out).toContain('Usage: lantern');
    expect(logRecords(join(scratch, 'logs')).filter((r) => r.level === 'error')).toEqual([]);
  }, 30_000);

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
    const cache = join(scratch, 'cache');
    const noKey = lantern(['harvest', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: '', LANTERN_CACHE: cache } });
    expect(noKey.code).toBe(1);
    expect(noKey.out).toContain('ANTHROPIC_API_KEY is not set');
    expect(existsSync(cache)).toBe(false);
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

  it('enrich refuses a bad limit, pending migrations, a vertical without an enrich section, and a missing API key, without fetching anything', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const badLimit = lantern(['enrich', '--vertical', 'literature', '--limit', '0'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(badLimit.code).toBe(1);
    expect(badLimit.out).toContain('--limit must be a positive integer, got 0');
    const pending = lantern(['enrich', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(pending.code).toBe(1);
    expect(pending.out).toContain('run lantern migrate');
    expect(lantern(['migrate'], scratch).code).toBe(0);
    const science = lantern(['enrich', '--vertical', 'science-curious'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(science.code).toBe(1);
    expect(science.out).toContain('vertical science-curious has no enrich section');
    const cache = join(scratch, 'cache');
    const noKey = lantern(['enrich', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: '', LANTERN_CACHE: cache } });
    expect(noKey.code).toBe(1);
    expect(noKey.out).toContain('ANTHROPIC_API_KEY is not set');
    expect(existsSync(cache)).toBe(false);
  }, 60_000);

  it('enrich writes nothing when no verified quote is waiting for a post', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    expect(lantern(['migrate'], scratch).code).toBe(0);
    const cache = join(scratch, 'cache');
    const res = lantern(['enrich', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: 'test-key-never-sent', LANTERN_CACHE: cache } });
    expect(res.code).toBe(0);
    expect(res.out).toContain('posts: 0 draft, 0 needs review; failed: 0');
    expect(existsSync(cache)).toBe(false);
  }, 30_000);

  it('media refuses a bad limit, pending migrations and an unknown vertical, and writes nothing when no post needs an image', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const badLimit = lantern(['media', '--vertical', 'literature', '--limit', '0'], scratch);
    expect(badLimit.code).toBe(1);
    expect(badLimit.out).toContain('--limit must be a positive integer, got 0');

    const pending = lantern(['media', '--vertical', 'literature'], scratch);
    expect(pending.code).toBe(1);
    expect(pending.out).toContain('run lantern migrate');

    expect(lantern(['migrate'], scratch).code).toBe(0);
    const unknown = lantern(['media', '--vertical', 'poetry'], scratch);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain('unknown vertical: poetry');

    const media = join(scratch, 'media');
    const res = lantern(['media', '--vertical', 'literature'], scratch, { env: { LANTERN_MEDIA: media, LANTERN_CACHE: join(scratch, 'cache') } });
    expect(res.code).toBe(0);
    expect(res.out).toContain('images: 0 downloaded, 0 reused; failed: 0');
    expect(existsSync(media)).toBe(false);
  }, 60_000);

  it('caption refuses a bad post id, an unknown platform, pending migrations and a post that does not exist, without needing an API key', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const noKey = { ANTHROPIC_API_KEY: '' };

    const badPost = lantern(['caption', '--post', '0'], scratch, { env: noKey });
    expect(badPost.code).toBe(1);
    expect(badPost.out).toContain('--post must be a positive integer, got 0');

    // The platform list is judged before the database is opened, so a typo costs nothing.
    const unknown = lantern(['caption', '--post', '1', '--platforms', 'facebook,myspace'], scratch, { env: noKey });
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain('unknown platform: myspace; expected facebook, pinterest');

    const empty = lantern(['caption', '--post', '1', '--platforms', ' , '], scratch, { env: noKey });
    expect(empty.code).toBe(1);
    expect(empty.out).toContain('--platforms must name at least one platform');

    const pending = lantern(['caption', '--post', '1'], scratch, { env: noKey });
    expect(pending.code).toBe(1);
    expect(pending.out).toContain('run lantern migrate');

    expect(lantern(['migrate'], scratch).code).toBe(0);

    const missing = lantern(['caption', '--post', '1'], scratch, { env: noKey });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('post 1 does not exist');
    // The key is never demanded up front: a caption built from approved text is verbatim and needs
    // no fact check, so requiring a key would refuse a command that never calls Anthropic.
    expect(missing.out).not.toContain('ANTHROPIC_API_KEY is not set');
  }, 60_000);

  it('compose refuses a bad post id, an unknown format, pending migrations and a post that does not exist', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const badPost = lantern(['compose', '--post', '0'], scratch);
    expect(badPost.code).toBe(1);
    expect(badPost.out).toContain('--post must be a positive integer, got 0');

    const notANumber = lantern(['compose', '--post', 'seven'], scratch);
    expect(notANumber.code).toBe(1);
    expect(notANumber.out).toContain('--post must be a positive integer, got seven');

    const pending = lantern(['compose', '--post', '1'], scratch);
    expect(pending.code).toBe(1);
    expect(pending.out).toContain('run lantern migrate');

    // The format list is checked before any post is read, so a typo costs nothing.
    const unknownFormat = lantern(['compose', '--post', '1', '--formats', 'square,poster'], scratch);
    expect(unknownFormat.code).toBe(1);
    expect(unknownFormat.out).toContain('unknown format: poster; expected square, pin');

    const empty = lantern(['compose', '--post', '1', '--formats', ' , '], scratch);
    expect(empty.code).toBe(1);
    expect(empty.out).toContain('--formats must name at least one format');

    expect(lantern(['migrate'], scratch).code).toBe(0);

    const missing = lantern(['compose', '--post', '1'], scratch, { env: { LANTERN_MEDIA: join(scratch, 'media') } });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('post 1 does not exist');
  }, 60_000);
});
```

- [ ] **Step 3: `claude.md`, the caption stage description**

Replace exactly:

```
**`lantern caption --post 123 --platforms facebook,pinterest`**
Generate per-platform text from the post. Enforces each platform's limits and
conventions (§11). Writes `captions` rows. This is a formatting step over
already-verified content — it may not introduce new claims, and the fact-check
gate re-runs against any caption that isn't a pure truncation.
```

with:

```
**`lantern caption --post 123 --platforms facebook,pinterest`**
Generate per-platform text from the post. Enforces each platform's limits and
conventions (§11). Writes `captions` rows, one per platform; re-running replaces
that platform's row only. This is a formatting step over already-verified
content — it may not introduce new claims, and the fact-check gate re-runs
against any caption that isn't a pure truncation.

No model ever writes a caption. The stage selects and trims the post's own
approved prose, which is what keeps it a formatter (§15), so the only model call
is the checker. A caption skips even that when every one of its sentences is a
literal substring of the approved text: trimming to a platform's limit drops
whole sentences and never appends an ellipsis, so a shortened caption stays
verbatim and costs nothing. Anything else is checked against the post's cited
sources, because a caption that stitches two approved clauses together can
imply something neither of them said. A caption with any problem writes no row:
the review queue never shows text that was not judged (§2.6).

Facebook takes the write-up itself. Pinterest takes a title derived from the
approved hook, cut at a word boundary, and a description from the body and
closer. Neither carries hashtags (§11), and Pinterest's `link` stays empty until
the archive site exists (§13).
```

- [ ] **Step 4: `plan.md`, milestone 2.7**

Replace exactly:

```
**2.7 Captions** — `src/caption/facebook.ts`, `src/caption/pinterest.ts`
- Enforce `caption.text_max` / `title_max` from the channel config. Pinterest copy is written for search: plain keywords, no hashtag spam.
- Always append the AI disclosure for `generated` images, and the attribution when the license requires it.
- Re-run the fact-check gate on any caption that isn't a pure truncation of approved text.
```

with:

```
**2.7 Captions** — `src/caption/facebook.ts`, `src/caption/pinterest.ts`
- Enforce `caption.text_max` / `title_max` from the channel config. Pinterest copy is written for search: plain keywords, no hashtag spam. No migration: `captions` and its `UNIQUE(post_id, platform)` have existed since `001_initial.sql`.
- **No writer model anywhere in this stage.** Adapters select and format, they do not write (spec §15), so a caption is only ever the post's approved prose selected, trimmed or rearranged. The only model call is the checker.
- **A caption is a pure truncation when every sentence is a literal substring of the approved post text**, after folding whitespace (user decision 2026-09-16). Trimming to a limit drops whole sentences and never appends an ellipsis, so a shortened caption stays verbatim and spends nothing. Everything else is checked against the post's cited sources, and a caption with any problem writes no row at all.
- Always append the AI disclosure for `generated` images. **The attribution line is a dead path and is not implemented**: §10 permits only `public-domain` and `cc0`, and neither obliges a caption credit — the credit belongs on the archive page. The disclosure is kept and tested because §9 mandates it and the science vertical will generate images.
- Reading a post's cited sources means reading `post_sources`, which enrichment has written and nothing has ever read back. This milestone adds that reader, and a reader for the post's own hook, body and closer.
- Pinterest's title comes from the approved hook (so it is verbatim and needs no check); `hashtags` stays null for both channels and `link` stays null until the archive site ships in Phase 8.
- Exactly one channel may serve a (vertical, platform) pair, or the run stops: the schema allows several, and silently taking the first would set a caption to one Page's limits and publish it to another's.
- YouTube captions are deliberately out of scope; Phase 2's bar is Facebook and Pinterest.
```

- [ ] **Step 5: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean, 47 files and 630 tests pass (605 before this milestone).

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/cli.test.ts claude.md plan.md
git commit -m "feat(caption): add the lantern caption command and document the stage

Records what the stage may and may not do: it selects and trims approved prose
and never writes, so today no caption reaches the checker at all. The spec's
attribution bullet is corrected - no whitelisted licence obliges a caption
credit, so that branch is documented as dead rather than implemented.

Co-Authored-By: THE MODEL YOU ARE RUNNING AS <noreply@anthropic.com>   <- replace this line with your own attribution
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```
