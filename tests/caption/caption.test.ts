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
