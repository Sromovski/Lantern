import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { callCost, costReport, formatCostReport, loadPricing, type Pricing } from '../../src/costs/costs.js';
import { modelCallRecorder, modelCalls } from '../../src/db/model-calls.js';
import type { CallUsage } from '../../src/lib/usage.js';
import { loadConfig } from '../../src/config/load.js';
import { testDb } from '../helpers/db.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const NOW = '2026-09-23T00:00:00.000Z';

const PRICING: Pricing = {
  checked: '2026-09-23',
  models: {
    'claude-opus-5': { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
    'claude-sonnet-5': { input: 2, output: 10, cache_write: 2.5, cache_read: 0.2 },
  },
};

const usage = (model: string, inputTokens: number, outputTokens: number, extra: Partial<CallUsage> = {}): CallUsage => ({
  requestedModel: model,
  model,
  inputTokens,
  outputTokens,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  stopReason: 'end_turn',
  ...extra,
});

function seed() {
  const db = testDb();
  const id = (sql: string, ...params: unknown[]) => Number(db.prepare(sql).run(...params).lastInsertRowid);
  const verticalId = id("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'L', 'config/verticals/literature.yaml')");
  const subjectId = id("INSERT INTO subjects (vertical_id, kind, name, slug, created_at) VALUES (?, 'author', 'Charles Dickens', 'charles-dickens', ?)", verticalId, NOW);
  const item = (body: string, hash: string) =>
    id("INSERT INTO items (vertical_id, subject_id, kind, body, body_hash, status, created_at) VALUES (?, ?, 'quote', ?, ?, 'raw', ?)", verticalId, subjectId, body, hash, NOW);
  const first = item('What good had it ever done to him?', 'h1');
  const second = item('May that be truly said of us, and all of us!', 'h2');
  const postId = id("INSERT INTO posts (item_id, vertical_id, hook, body, alt_text, status, created_at) VALUES (?, ?, 'h', 'b', 'a', 'draft', ?)", first, verticalId, NOW);
  db.prepare(
    "INSERT INTO book_picks (vertical_id, gutenberg_id, prompt_sha256, model, batches, failed_batches, picked, picked_at) VALUES (?, 46, 'sha', 'claude-sonnet-5', 2, 0, 4, ?)",
  ).run(verticalId, NOW);
  return { db, verticalId, first, second, postId, record: modelCallRecorder(db, verticalId, () => new Date(NOW)) };
}

describe('model call recording', () => {
  it('writes a row per call with its tag, and charges a caption call to its post\'s quote', () => {
    const { db, verticalId, first, postId, record } = seed();
    record({ stage: 'enrich', role: 'writer', itemId: first }, usage('claude-opus-5', 10_000, 3_000));
    record({ stage: 'caption', role: 'checker', postId }, usage('claude-sonnet-5', 2_000, 500, { cacheReadInputTokens: 100 }));
    expect(modelCalls(db, verticalId)).toEqual([
      { stage: 'enrich', role: 'writer', itemId: first, postId: null, gutenbergId: null, model: 'claude-opus-5', inputTokens: 10_000, outputTokens: 3_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      { stage: 'caption', role: 'checker', itemId: first, postId, gutenbergId: null, model: 'claude-sonnet-5', inputTokens: 2_000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 100 },
    ]);
  });
});

describe('callCost', () => {
  it('prices every kind of token at its own rate, and returns null for a model with no price', () => {
    const call = { stage: 'enrich', role: 'writer', itemId: 1, postId: null, gutenbergId: null, model: 'claude-opus-5', inputTokens: 1_000_000, outputTokens: 100_000, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 };
    // 5 + 2.5 + 6.25 + 0.5
    expect(callCost(call, PRICING)).toBeCloseTo(14.25, 10);
    expect(callCost({ ...call, model: 'claude-mystery-9' }, PRICING)).toBeNull();
  });
});

describe('costReport', () => {
  it('reports each book per quote picked, each quote with its enrich and caption calls, and the averages', () => {
    const { db, verticalId, first, second, postId, record } = seed();
    // Harvest: two batches of book 46, which yielded 4 picks. $0.03 + $0.03 = $0.06, so $0.015 per quote.
    record({ stage: 'harvest', role: 'picker', gutenbergId: 46 }, usage('claude-sonnet-5', 10_000, 1_000));
    record({ stage: 'harvest', role: 'picker', gutenbergId: 46 }, usage('claude-sonnet-5', 10_000, 1_000));
    // Quote 1 reached a post after a revision: writer $0.125 + checker $0.03, reviser $0.125 + checker $0.03, caption check $0.009.
    record({ stage: 'enrich', role: 'writer', itemId: first }, usage('claude-opus-5', 15_000, 2_000));
    record({ stage: 'enrich', role: 'checker', itemId: first }, usage('claude-sonnet-5', 10_000, 1_000));
    record({ stage: 'enrich', role: 'reviser', itemId: first }, usage('claude-opus-5', 15_000, 2_000));
    record({ stage: 'enrich', role: 'checker', itemId: first }, usage('claude-sonnet-5', 10_000, 1_000));
    record({ stage: 'caption', role: 'checker', postId }, usage('claude-sonnet-5', 2_000, 500));
    // Quote 2 failed with no post: its refused writer call is still billed ($0.075) but does not enter the per-post mean.
    record({ stage: 'enrich', role: 'writer', itemId: second }, usage('claude-opus-5', 15_000, 0, { stopReason: 'refusal' }));

    const report = costReport(db, verticalId, PRICING);
    expect(report.unpriced).toEqual([]);
    expect(report.books).toEqual([{ gutenbergId: 46, picked: 4, calls: 2, inputTokens: 20_000, outputTokens: 2_000, cost: expect.closeTo(0.06, 10) }]);
    expect(report.harvestPerQuote).toBeCloseTo(0.015, 10);

    const [one, two] = report.quotes;
    expect(one).toMatchObject({ itemId: first, author: 'Charles Dickens', postStatus: 'draft', writerCalls: 2 });
    expect(one!.enrich).toEqual({ calls: 4, inputTokens: 50_000, outputTokens: 6_000, cost: expect.closeTo(0.31, 10) });
    expect(one!.caption.cost).toBeCloseTo(0.009, 10);
    expect(one!.total).toBeCloseTo(0.319, 10);
    expect(two).toMatchObject({ itemId: second, postStatus: null, writerCalls: 1, total: expect.closeTo(0.075, 10) });

    expect(report.meanPerPost).toBeCloseTo(0.319, 10);
    expect(report.total.calls).toBe(8);
    expect(report.total.cost).toBeCloseTo(0.06 + 0.319 + 0.075, 10);
    expect(report.byStageModel.map((g) => [g.stage, g.model, g.calls])).toEqual([
      ['harvest', 'claude-sonnet-5', 2],
      ['enrich', 'claude-opus-5', 3],
      ['enrich', 'claude-sonnet-5', 2],
      ['caption', 'claude-sonnet-5', 1],
    ]);
    const text = formatCostReport(report);
    expect(text).toContain('Gutenberg #46: 2 batches, $0.0600, $0.0150 per quote picked (4)');
    expect(text).toContain('All-in per post: $0.3340');
  });

  it('names a model with no price rather than counting its calls as free', () => {
    const { db, verticalId, first, record } = seed();
    record({ stage: 'enrich', role: 'writer', itemId: first }, usage('claude-mystery-9', 1_000, 1_000));
    const report = costReport(db, verticalId, PRICING);
    expect(report.unpriced).toEqual(['claude-mystery-9']);
    expect(formatCostReport(report)).toContain('WARNING: no price for claude-mystery-9');
  });

  it('says so when nothing has been recorded', () => {
    const { db, verticalId } = seed();
    expect(formatCostReport(costReport(db, verticalId, PRICING))).toContain('No model calls recorded yet.');
  });
});

describe('config/pricing.yaml', () => {
  it('prices every model the verticals are configured to call', () => {
    const pricing = loadPricing(ROOT);
    const models = loadConfig(ROOT).verticals.flatMap((v) => [v.harvest?.picker.model, v.enrich?.writer_model, v.enrich?.checker_model]);
    for (const model of models.filter((m): m is string => m !== undefined)) expect(pricing.models, model).toHaveProperty([model]);
    expect(pricing.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
