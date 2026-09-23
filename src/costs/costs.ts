import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Db } from '../db/connection.js';
import { modelCalls, type ModelCallRow } from '../db/model-calls.js';

const rateSchema = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_write: z.number().nonnegative(),
  cache_read: z.number().nonnegative(),
});

/** config/pricing.yaml: US dollars per million tokens, per model. */
export const pricingSchema = z.strictObject({
  checked: z.union([z.string(), z.date()]).transform((value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value)),
  models: z.record(z.string(), rateSchema),
});

export type Pricing = z.infer<typeof pricingSchema>;

export const PRICING_PATH = 'config/pricing.yaml';

export function loadPricing(root: string): Pricing {
  return pricingSchema.parse(parse(readFileSync(join(root, PRICING_PATH), 'utf8')));
}

/** A call's price in dollars, or null when its model has no price: an unpriced call is reported, never counted as free. */
export function callCost(call: ModelCallRow, pricing: Pricing): number | null {
  const rate = pricing.models[call.model];
  if (rate === undefined) return null;
  return (
    (call.inputTokens * rate.input +
      call.outputTokens * rate.output +
      call.cacheCreationInputTokens * rate.cache_write +
      call.cacheReadInputTokens * rate.cache_read) /
    1_000_000
  );
}

export interface Tally {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Dollars for the priced calls. */
  cost: number;
}

function tally(): Tally {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
}

function add(into: Tally, call: ModelCallRow, cost: number | null): void {
  into.calls += 1;
  into.inputTokens += call.inputTokens + call.cacheCreationInputTokens + call.cacheReadInputTokens;
  into.outputTokens += call.outputTokens;
  into.cost += cost ?? 0;
}

export interface QuoteCost {
  itemId: number;
  author: string;
  excerpt: string;
  postStatus: string | null;
  enrich: Tally;
  caption: Tally;
  /** enrich + caption, in dollars. Harvest is reported per book, since one read of a book yields several quotes. */
  total: number;
  /** Writer calls: 1 for a draft accepted first time, 2 when it was revised, more when earlier attempts failed. */
  writerCalls: number;
}

export interface BookCost extends Tally {
  gutenbergId: number;
  /** Quotes the picker chose from the book, from book_picks; null when the book was never finished. */
  picked: number | null;
}

export interface CostReport {
  pricingChecked: string;
  byStageModel: (Tally & { stage: string; model: string })[];
  books: BookCost[];
  quotes: QuoteCost[];
  /** Models with recorded calls but no price in config/pricing.yaml. Their calls are counted as $0 in every total. */
  unpriced: string[];
  total: Tally;
  /** Harvest dollars per quote picked, over the books whose picks were recorded; null when there are none. */
  harvestPerQuote: number | null;
  /** Mean enrich + caption dollars over quotes that reached a post; null when there are none. */
  meanPerPost: number | null;
}

export function costReport(db: Db, verticalId: number, pricing: Pricing): CostReport {
  const calls = modelCalls(db, verticalId);
  const unpriced = new Set<string>();
  const byStageModel = new Map<string, Tally & { stage: string; model: string }>();
  const books = new Map<number, BookCost>();
  const quotes = new Map<number, QuoteCost>();
  const total = tally();

  const quoteInfo = db.prepare(
    `SELECT s.name AS author, i.body AS body, p.status AS postStatus
     FROM items i LEFT JOIN subjects s ON s.id = i.subject_id LEFT JOIN posts p ON p.item_id = i.id
     WHERE i.id = ?`,
  );
  const picked = db.prepare('SELECT SUM(picked) FROM book_picks WHERE vertical_id = ? AND gutenberg_id = ?').pluck();

  for (const call of calls) {
    const cost = callCost(call, pricing);
    if (cost === null) unpriced.add(call.model);
    add(total, call, cost);

    const key = `${call.stage}\u0000${call.model}`;
    const group = byStageModel.get(key) ?? { ...tally(), stage: call.stage, model: call.model };
    add(group, call, cost);
    byStageModel.set(key, group);

    if (call.stage === 'harvest' && call.gutenbergId !== null) {
      const book = books.get(call.gutenbergId) ?? {
        ...tally(),
        gutenbergId: call.gutenbergId,
        picked: (picked.get(verticalId, call.gutenbergId) as number | null) ?? null,
      };
      add(book, call, cost);
      books.set(call.gutenbergId, book);
    }

    if ((call.stage === 'enrich' || call.stage === 'caption') && call.itemId !== null) {
      let quote = quotes.get(call.itemId);
      if (quote === undefined) {
        const info = quoteInfo.get(call.itemId) as { author: string | null; body: string; postStatus: string | null } | undefined;
        quote = {
          itemId: call.itemId,
          author: info?.author ?? '?',
          excerpt: info?.body ?? '',
          postStatus: info?.postStatus ?? null,
          enrich: tally(),
          caption: tally(),
          total: 0,
          writerCalls: 0,
        };
        quotes.set(call.itemId, quote);
      }
      add(call.stage === 'enrich' ? quote.enrich : quote.caption, call, cost);
      if (call.role === 'writer' || call.role === 'reviser') quote.writerCalls += 1;
      quote.total = quote.enrich.cost + quote.caption.cost;
    }
  }

  const finished = [...books.values()].filter((book) => book.picked !== null && book.picked > 0);
  const pickedQuotes = finished.reduce((sum, book) => sum + (book.picked ?? 0), 0);
  const withPost = [...quotes.values()].filter((quote) => quote.postStatus !== null);
  return {
    pricingChecked: pricing.checked,
    byStageModel: [...byStageModel.values()],
    books: [...books.values()],
    quotes: [...quotes.values()],
    unpriced: [...unpriced].sort(),
    total,
    harvestPerQuote: pickedQuotes === 0 ? null : finished.reduce((sum, book) => sum + book.cost, 0) / pickedQuotes,
    meanPerPost: withPost.length === 0 ? null : withPost.reduce((sum, quote) => sum + quote.total, 0) / withPost.length,
  };
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const tokens = (t: Tally) => `${t.inputTokens.toLocaleString('en-US')} in / ${t.outputTokens.toLocaleString('en-US')} out`;

/** The report as a human reads it in a terminal. */
export function formatCostReport(report: CostReport): string {
  const lines: string[] = [`Claude API spend (prices from config/pricing.yaml, checked ${report.pricingChecked})`, ''];
  if (report.total.calls === 0) return [...lines, 'No model calls recorded yet.'].join('\n');

  lines.push('By stage and model:');
  for (const g of report.byStageModel) lines.push(`  ${g.stage.padEnd(8)} ${g.model.padEnd(18)} ${String(g.calls).padStart(4)} calls  ${tokens(g).padEnd(30)} ${usd(g.cost)}`);

  if (report.books.length > 0) {
    lines.push('', 'Harvest, per book:');
    for (const b of report.books) {
      const per = b.picked !== null && b.picked > 0 ? `, ${usd(b.cost / b.picked)} per quote picked (${b.picked})` : ', no picks recorded';
      lines.push(`  Gutenberg #${b.gutenbergId}: ${b.calls} batches, ${usd(b.cost)}${per}`);
    }
  }

  if (report.quotes.length > 0) {
    lines.push('', 'Per quote (enrich + caption):');
    for (const q of report.quotes) {
      const excerpt = q.excerpt.length > 48 ? `${q.excerpt.slice(0, 47)}…` : q.excerpt;
      const revised = q.writerCalls > 1 ? ` (${q.writerCalls} writer calls)` : '';
      lines.push(`  #${String(q.itemId).padEnd(4)} ${usd(q.total).padStart(8)}  ${(q.postStatus ?? 'no post').padEnd(12)} ${q.author}: "${excerpt}"${revised}`);
    }
  }

  lines.push('', `Total: ${report.total.calls} calls, ${tokens(report.total)}, ${usd(report.total.cost)}`);
  if (report.harvestPerQuote !== null) lines.push(`Harvest per quote picked: ${usd(report.harvestPerQuote)}`);
  if (report.meanPerPost !== null) {
    lines.push(`Enrich + caption per post: ${usd(report.meanPerPost)}`);
    lines.push(`All-in per post: ${usd(report.meanPerPost + (report.harvestPerQuote ?? 0))}${report.harvestPerQuote === null ? ' (no harvest calls recorded yet)' : ''}`);
  }
  if (report.unpriced.length > 0) lines.push('', `WARNING: no price for ${report.unpriced.join(', ')}; those calls count as $0 above. Add them to config/pricing.yaml.`);
  return lines.join('\n');
}
