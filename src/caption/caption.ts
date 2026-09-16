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
import { pinterestCaption } from './pinterest.js';
import { CaptionConfigError, unapprovedSentences } from './text.js';

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

  // The checker is shown everything the gate judged, title included. Judging on title + text while
  // showing the model only the text means an invented title buys a model call that cannot see it.
  const sentences = captionSentences(built.title === null ? built.text : `${built.title}\n\n${built.text}`);
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
  // Only a draft or a post waiting for review is captioned. An approved post keeps the text a human
  // approved, and a rejected one will never be published (spec sections 5 and 7).
  if (post.status !== 'draft' && post.status !== 'needs_review') {
    throw new CaptionError(`post ${options.postId} is ${post.status}, so it is not waiting for captions`);
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
