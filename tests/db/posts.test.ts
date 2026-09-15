import { describe, it, expect } from 'vitest';
import { insertPost, itemsToEnrich, PostRuleError, type NewPost } from '../../src/db/posts.js';
import { insertHarvestedQuote, upsertAuthorSubject } from '../../src/db/quotes.js';
import { insertSource } from '../../src/db/sources.js';
import type { HarvestAuthor } from '../../src/harvest/gutendex.js';
import type { QuoteEvidence } from '../../src/verify/quote-gate.js';
import { verifyVertical } from '../../src/verify/run.js';
import { testDb } from '../helpers/db.js';

const NOW = () => new Date('2026-09-15T00:00:00.000Z');
const DICKENS: HarvestAuthor = { name: 'Charles Dickens', gutendex_name: 'Dickens, Charles', wikidata_id: 'Q5686', birth_year: 1812, death_year: 1870 };
const AUSTEN: HarvestAuthor = { name: 'Jane Austen', gutendex_name: 'Austen, Jane', wikidata_id: 'Q36322', birth_year: 1775, death_year: 1817 };
const URL_S1 = 'https://en.wikipedia.org/w/index.php?title=Charles_Dickens&oldid=1371883001';

function setup() {
  const db = testDb();
  const verticalId = Number(
    db.prepare("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'Literature', 'config/verticals/literature.yaml')").run()
      .lastInsertRowid,
  );
  const quote = (author: HarvestAuthor, body: string, workTitle: string, verified = true) => {
    const subjectId = upsertAuthorSubject(db, verticalId, author, NOW());
    const evidence: QuoteEvidence[] = verified
      ? [
          {
            kind: 'primary-text',
            citation: `${author.name}, ${workTitle} (Project Gutenberg)`,
            url: 'https://www.gutenberg.org/ebooks/98.txt.utf-8',
            excerpt: body,
            location: 'characters 10-140 after the Project Gutenberg header',
            authorMatches: true,
          },
        ]
      : [{ kind: 'reference', citation: `Wikiquote, ${author.name}`, url: 'https://en.wikiquote.org/wiki/Charles_Dickens' }];
    return insertHarvestedQuote(
      db,
      { verticalId, subjectId, author: author.name, body, workTitle, evidence, wikiquotePage: author.name, wikiquoteCheckedAt: NOW().toISOString() },
      NOW(),
    ).itemId;
  };
  return { db, verticalId, quote };
}

const round = (problems: string[] = []) => ({
  round: 1 as const,
  draft: { hook: { text: 'A hook.', sources: ['S1'] }, body: [], closer: { text: 'A closer.', sources: [] } },
  check: { sentences: [] },
  problems,
  writerModel: 'claude-opus-5',
  checkerModel: 'claude-sonnet-5',
});

const post = (itemId: number, verticalId: number, overrides: Partial<NewPost> = {}): NewPost => ({
  itemId,
  verticalId,
  hook: 'A hook.',
  body: 'First paragraph.\n\nSecond paragraph.',
  closer: 'A closer.',
  altText: 'Quotation from A Tale of Two Cities by Charles Dickens: "..."',
  status: 'draft',
  rounds: [round()],
  sources: [
    {
      label: 'S1',
      source: { tier: 3, url: URL_S1, citation: 'Wikipedia, "Charles Dickens", lead section, revision 1371883001', excerpt: 'Charles Dickens was an English novelist.' },
      retrievedAt: new Date('2026-09-14T00:00:00.000Z'),
    },
    {
      label: 'S7',
      source: { tier: 3, url: URL_S1, citation: 'Wikipedia, "Charles Dickens", section "Early life", revision 1371883001', excerpt: 'Dickens was born in Portsmouth.' },
      retrievedAt: new Date('2026-09-14T00:00:00.000Z'),
    },
  ],
  ...overrides,
});

describe('itemsToEnrich', () => {
  it('lists verified quotes without a post, every author taking a turn before anyone gets a second', () => {
    const { db, verticalId, quote } = setup();
    const d1 = quote(DICKENS, 'It was the best of times, it was the worst of times, it was the age of wisdom.', 'A Tale of Two Cities');
    const d2 = quote(DICKENS, 'There is a wisdom of the head, and a wisdom of the heart, and they are not the same.', 'Hard Times');
    quote(DICKENS, 'This passage has only a reference behind it and will be rejected by verify.', 'Hard Times', false);
    const a1 = quote(AUSTEN, 'It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.', 'Pride and Prejudice');
    verifyVertical(db, verticalId, { now: NOW });

    expect(itemsToEnrich(db, verticalId, 10).map((i) => i.itemId)).toEqual([d1, a1, d2]);
    expect(itemsToEnrich(db, verticalId, 2)[1]).toEqual({
      itemId: a1,
      subjectId: expect.any(Number),
      body: 'It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.',
      workTitle: 'Pride and Prejudice',
      author: 'Jane Austen',
      wikidataId: 'Q36322',
    });

    insertPost(db, post(d1, verticalId), NOW());
    expect(itemsToEnrich(db, verticalId, 10).map((i) => i.itemId)).toEqual([d2, a1]);
  });
});

describe('insertPost', () => {
  it('stores the post, its rounds and its cited paragraphs as tier 3 sources linked by label', () => {
    const { db, verticalId, quote } = setup();
    const itemId = quote(DICKENS, 'It was the best of times, it was the worst of times, it was the age of wisdom.', 'A Tale of Two Cities');
    verifyVertical(db, verticalId, { now: NOW });
    const existing = insertSource(db, itemId, post(itemId, verticalId).sources[0]!.source, NOW());

    const postId = insertPost(db, post(itemId, verticalId, { status: 'needs_review', rounds: [round(['a problem']), { ...round(), round: 2 }] }), NOW());

    expect(db.prepare('SELECT item_id, hook, body, closer, status, created_at FROM posts WHERE id = ?').get(postId)).toEqual({
      item_id: itemId,
      hook: 'A hook.',
      body: 'First paragraph.\n\nSecond paragraph.',
      closer: 'A closer.',
      status: 'needs_review',
      created_at: '2026-09-15T00:00:00.000Z',
    });
    const linked = db.prepare('SELECT label, source_id FROM post_sources WHERE post_id = ? ORDER BY label').all(postId) as { label: string; source_id: number }[];
    expect(linked.map((l) => l.label)).toEqual(['S1', 'S7']);
    expect(linked[0]!.source_id).toBe(existing);
    expect(db.prepare('SELECT tier, retrieved_at FROM sources WHERE id = ?').get(linked[1]!.source_id)).toEqual({ tier: 3, retrieved_at: '2026-09-14T00:00:00.000Z' });
    expect(db.prepare('SELECT COUNT(*) FROM sources WHERE item_id = ?').pluck().get(itemId)).toBe(3);
    const rounds = db.prepare('SELECT round, draft_json, check_json, problems_json, writer_model, checker_model FROM post_rounds WHERE post_id = ? ORDER BY round').all(postId) as {
      round: number;
      draft_json: string;
      check_json: string;
      problems_json: string;
      writer_model: string;
      checker_model: string;
    }[];
    expect(rounds.map((r) => [r.round, JSON.parse(r.problems_json), r.writer_model, r.checker_model])).toEqual([
      [1, ['a problem'], 'claude-opus-5', 'claude-sonnet-5'],
      [2, [], 'claude-opus-5', 'claude-sonnet-5'],
    ]);
    expect(JSON.parse(rounds[0]!.draft_json)).toEqual(round().draft);
    expect(JSON.parse(rounds[0]!.check_json)).toEqual({ sentences: [] });
  });

  it('refuses a post for a quote that is not verified, a draft whose last round has problems, and a second post', () => {
    const { db, verticalId, quote } = setup();
    const raw = quote(DICKENS, 'This raw passage has never been decided by verify, so it cannot have a post.', 'Hard Times');
    expect(() => insertPost(db, post(raw, verticalId), NOW())).toThrow(PostRuleError);

    const itemId = quote(DICKENS, 'It was the best of times, it was the worst of times, it was the age of wisdom.', 'A Tale of Two Cities');
    verifyVertical(db, verticalId, { now: NOW });
    expect(() => insertPost(db, post(itemId, verticalId, { rounds: [round(['still unsupported'])] }), NOW())).toThrow(
      'a draft post cannot have problems in its last round',
    );
    expect(() => insertPost(db, post(itemId, verticalId, { rounds: [] }), NOW())).toThrow('a post needs at least one round');
    expect(db.prepare('SELECT COUNT(*) FROM posts').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM sources WHERE tier = 3').pluck().get()).toBe(0);

    insertPost(db, post(itemId, verticalId), NOW());
    expect(() => insertPost(db, post(itemId, verticalId), NOW())).toThrow(/UNIQUE/);
    expect(db.prepare('SELECT COUNT(*) FROM post_sources').pluck().get()).toBe(2);
  });
});
