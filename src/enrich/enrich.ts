import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { EnrichConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import { countGivenUp, insertPost, itemsToEnrich, recordEnrichFailure, type ItemToEnrich, type PostRound } from '../db/posts.js';
import { SourceStatusError, type HttpGet } from '../harvest/sources.js';
import type { Logger } from '../lib/log.js';
import { EnrichResponseError, type EnrichPrompts, type ModelAnswer, type ModelFn } from './anthropic.js';
import { articleParagraphs, labelParagraphs, paragraphSource, type SourceParagraph } from './context.js';
import { checkSchema, draftSchema, draftSentences, type Check, type Draft } from './draft.js';
import { checkProblems, citedParagraphs, numberProblems, parsePostShape, shapeProblems, type PostShape } from './gates.js';
import { checkerMessage, fillPrompt, reviseMessage, writerMessage, type QuoteContext, type VerticalVoice } from './messages.js';
import { authorArticleTitle, fetchArticle, WikiLookupError, workArticle, type WikiEndpoints, type WikipediaArticle } from './wikipedia.js';

export interface EnrichOptions {
  db: Db;
  verticalId: number;
  vertical: VerticalVoice;
  enrich: EnrichConfig;
  get: HttpGet;
  endpoints: WikiEndpoints;
  write: ModelFn;
  check: ModelFn;
  /** The prompt files as loaded; the vertical's voice, post shape and banned topics are filled in here. */
  prompts: EnrichPrompts;
  /** The most verified quotes to write posts for in one run. */
  limit: number;
  /** Also offer quotes that have already failed MAX_ENRICH_FAILURES times. */
  retryFailed?: boolean;
  now?: () => Date;
  log?: Logger;
}

export type ItemOutcome =
  | {
      status: 'draft' | 'needs_review';
      postId: number;
      /** 2 when the first draft had problems and was revised. */
      rounds: number;
      /** The problems left in the last round; empty for a draft. */
      problems: string[];
      /** The work's Wikipedia article, or null when only the author's article was used. */
      workArticle: string | null;
    }
  | { status: 'failed'; reason: string };

export interface ItemReport {
  itemId: number;
  author: string;
  workTitle: string;
  outcome: ItemOutcome;
}

export interface EnrichReport {
  /** Verified quotes without a post that this run took up. */
  considered: number;
  drafted: number;
  needsReview: number;
  failed: number;
  /** Verified quotes without a post that are no longer offered because they failed too often (0 with retryFailed). */
  givenUp: number;
  items: ItemReport[];
}

interface Round extends PostRound {
  draft: Draft;
  check: Check;
}

interface Run {
  options: EnrichOptions;
  now: () => Date;
  shape: PostShape;
  prompts: EnrichPrompts;
  articles: Map<string, WikipediaArticle>;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Writes posts for a vertical's verified quotes (spec section 7, `lantern enrich`).
 *
 * For each verified quote without a post (fewest failed attempts first, then authors taking turns, at
 * most `limit`):
 * 1. The author's Wikipedia article is found through their Wikidata id, and the work's through a
 *    Wikidata search for its title. Their paragraphs, labelled S1, S2, ..., are the only facts offered.
 *    A collection, an ambiguous title, or a work article that does not load leaves the author's
 *    article alone.
 * 2. The writer returns a hook, body paragraphs and a closer, each with the labels it relies on.
 * 3. The gates judge the draft: its shape and labels, every number against the quotation and the cited
 *    paragraphs, and a separate fact check of every sentence that sees only the quotation (with its work
 *    and author) and the cited paragraphs.
 * 4. A draft with any problem gets one revision with the problems listed, judged the same way
 *    (user decision 2026-09-15).
 * 5. The post is stored as 'draft' when its last round has no problems and as 'needs_review' otherwise,
 *    with every round, and with the cited paragraphs as tier 3 sources of the quote.
 *
 * A quote whose author article cannot be read, or whose first draft or its fact check is refused or
 * unreadable, is reported as failed, gets no post, and has the failure recorded, so a later run tries it
 * again until it has failed MAX_ENRICH_FAILURES times. A revision that fails leaves the first round as a
 * post to review. Any other error (a rejected API key, the network) stops the run.
 */
export async function enrichVertical(options: EnrichOptions): Promise<EnrichReport> {
  const run: Run = {
    options,
    now: options.now ?? (() => new Date()),
    shape: parsePostShape(options.vertical.post_shape),
    prompts: {
      write: fillPrompt(options.prompts.write, options.vertical),
      revise: fillPrompt(options.prompts.revise, options.vertical),
      check: fillPrompt(options.prompts.check, options.vertical),
    },
    articles: new Map(),
  };
  const retryFailed = options.retryFailed === true;
  const items = itemsToEnrich(options.db, options.verticalId, options.limit, { retryFailed });
  const report: EnrichReport = { considered: items.length, drafted: 0, needsReview: 0, failed: 0, givenUp: 0, items: [] };
  for (const item of items) {
    let outcome: ItemOutcome;
    try {
      outcome = await enrichItem(run, item);
    } catch (err) {
      if (!(err instanceof WikiLookupError || err instanceof SourceStatusError || err instanceof EnrichResponseError)) throw err;
      outcome = { status: 'failed', reason: err.message };
      recordEnrichFailure(options.db, item.itemId, err.message, run.now());
    }
    if (outcome.status === 'draft') report.drafted++;
    else if (outcome.status === 'needs_review') report.needsReview++;
    else report.failed++;
    report.items.push({ itemId: item.itemId, author: item.author, workTitle: item.workTitle, outcome });
    options.log?.info('enrich item', { itemId: item.itemId, outcome });
  }
  report.givenUp = retryFailed ? 0 : countGivenUp(options.db, options.verticalId);
  return report;
}

/** Deterministic alt text until the media stage chooses an image: it says nothing the quote row does not. */
export function altText(quote: QuoteContext): string {
  return `Quotation from ${quote.workTitle} by ${quote.author}: "${quote.body}"`;
}

async function article(run: Run, qid: string, title: () => Promise<string>): Promise<WikipediaArticle> {
  const known = run.articles.get(qid);
  if (known !== undefined) return known;
  const fetched = await fetchArticle(run.options.get, run.options.endpoints, await title(), qid);
  run.articles.set(qid, fetched);
  return fetched;
}

async function sourceParagraphs(run: Run, item: ItemToEnrich): Promise<{ paragraphs: SourceParagraph[]; work: WikipediaArticle | null }> {
  const { get, endpoints, enrich } = run.options;
  const author = await article(run, item.wikidataId, () => authorArticleTitle(get, endpoints, item.wikidataId));
  const found = await workArticle(get, endpoints, item.wikidataId, item.workTitle);
  let work: WikipediaArticle | null = null;
  if (found !== null && found.qid !== item.wikidataId) {
    try {
      work = await article(run, found.qid, async () => found.title);
    } catch (err) {
      if (!(err instanceof WikiLookupError || err instanceof SourceStatusError)) throw err;
      // The work's sitelink led to a missing page or to another item's article: the author's article still stands.
      run.options.log?.warn('enrich used the author article alone: the work article did not load', {
        itemId: item.itemId,
        work: found.title,
        error: err.message,
      });
    }
  }
  const paragraphs = labelParagraphs([
    articleParagraphs(author, enrich.author_article_chars),
    work === null ? [] : articleParagraphs(work, enrich.work_article_chars),
  ]);
  if (paragraphs.length === 0) throw new WikiLookupError(`no usable paragraphs in the Wikipedia article ${author.title}`);
  return { paragraphs, work };
}

async function call(run: Run, itemId: number, role: string, fn: ModelFn, system: string, message: string): Promise<ModelAnswer> {
  const answer = await fn(system, message, { stage: 'enrich', role, itemId });
  run.options.log?.info('enrich call', { itemId, role, model: answer.model, inputTokens: answer.inputTokens, outputTokens: answer.outputTokens });
  return answer;
}

function parsed<T>(schema: z.ZodType<T>, answer: ModelAnswer, what: string): T {
  const result = schema.safeParse(answer.value);
  if (!result.success) throw new EnrichResponseError(`${what} is not the expected shape`);
  return result.data;
}

async function judgedRound(run: Run, item: ItemToEnrich, n: 1 | 2, system: string, message: string, paragraphs: readonly SourceParagraph[]): Promise<Round> {
  const quote: QuoteContext = { body: item.body, author: item.author, workTitle: item.workTitle };
  const written = await call(run, item.itemId, n === 1 ? 'writer' : 'reviser', run.options.write, system, message);
  const draft = parsed(draftSchema, written, n === 1 ? 'the draft' : 'the revised draft');
  const cited = citedParagraphs(draft, paragraphs);
  const sentences = draftSentences(draft);
  const checked = await call(run, item.itemId, 'checker', run.options.check, run.prompts.check, checkerMessage(quote, cited, sentences));
  const check = parsed(checkSchema, checked, 'the fact check');
  const problems = [
    ...shapeProblems(draft, run.shape, new Set(paragraphs.map((paragraph) => paragraph.id)), item.body),
    ...numberProblems(draft, item.body, cited),
    ...checkProblems(check, sentences, new Set(cited.map((paragraph) => paragraph.id))),
  ];
  return {
    round: n,
    draft,
    check,
    problems,
    writerModel: written.model,
    checkerModel: checked.model,
    promptSha256: sha256(`${system}\n\n${run.prompts.check}`),
  };
}

async function enrichItem(run: Run, item: ItemToEnrich): Promise<ItemOutcome> {
  const { paragraphs, work } = await sourceParagraphs(run, item);
  const quote: QuoteContext = { body: item.body, author: item.author, workTitle: item.workTitle };
  const first = await judgedRound(run, item, 1, run.prompts.write, writerMessage(quote, paragraphs), paragraphs);
  const rounds: Round[] = [first];
  if (first.problems.length > 0) {
    try {
      rounds.push(await judgedRound(run, item, 2, run.prompts.revise, reviseMessage(quote, paragraphs, first.draft, first.problems), paragraphs));
    } catch (err) {
      if (!(err instanceof EnrichResponseError)) throw err;
      first.problems.push(`the revision failed: ${err.message}`);
    }
  }
  const last = rounds[rounds.length - 1]!;
  const status = last.problems.length === 0 ? 'draft' : 'needs_review';
  const cited = new Set(rounds.flatMap((round) => citedParagraphs(round.draft, paragraphs).map((paragraph) => paragraph.id)));
  const postId = insertPost(
    run.options.db,
    {
      itemId: item.itemId,
      verticalId: run.options.verticalId,
      hook: last.draft.hook.text.trim(),
      body: last.draft.body.map((part) => part.text.trim()).join('\n\n'),
      closer: last.draft.closer.text.trim(),
      altText: altText(quote),
      status,
      rounds,
      sources: paragraphs
        .filter((paragraph) => cited.has(paragraph.id))
        .map((paragraph) => ({ label: paragraph.id, source: paragraphSource(paragraph), retrievedAt: new Date(paragraph.article.fetchedAt) })),
    },
    run.now(),
  );
  return { status, postId, rounds: rounds.length, problems: last.problems, workArticle: work?.title ?? null };
}
