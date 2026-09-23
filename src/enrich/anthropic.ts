import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { report, usageOf, type CallTag, type RecordUsage } from '../lib/usage.js';
import { checkSchema, draftSchema } from './draft.js';

/** Spec section 15: prompts are content and live in version-controlled files. The writer's are per vertical; the fact check is shared. */
export function enrichPromptPaths(verticalSlug: string): EnrichPrompts {
  return {
    write: `prompts/${verticalSlug}/enrich.md`,
    revise: `prompts/${verticalSlug}/revise.md`,
    check: 'prompts/shared/fact-check.md',
  };
}

export interface EnrichPrompts {
  write: string;
  revise: string;
  check: string;
}

export function loadEnrichPrompts(root: string, verticalSlug: string): EnrichPrompts {
  const paths = enrichPromptPaths(verticalSlug);
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  return { write: read(paths.write), revise: read(paths.revise), check: read(paths.check) };
}

/** A model's answer: the JSON it returned (validated by the caller), the model that wrote it, and its token use. */
export interface ModelAnswer {
  value: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** The tag says what the call is for; a builder given a RecordUsage records every response under it. */
export type ModelFn = (system: string, user: string, tag?: CallTag) => Promise<ModelAnswer>;

/** A model answered without usable output: a refusal, a truncated answer, text that is not JSON, or JSON of the wrong shape. */
export class EnrichResponseError extends Error {
  override name = 'EnrichResponseError';
}

/** The beta that lets the API answer with a substitute model when the requested model declines for policy reasons. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function parseAnswer(role: string, stopReason: string | null, text: string): unknown {
  if (stopReason !== 'end_turn') throw new EnrichResponseError(`the ${role} stopped with ${String(stopReason)} and no usable output`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EnrichResponseError(`the ${role}'s output is not JSON`);
  }
}

/**
 * The writer, backed by the Messages API with structured output built from draftSchema and server-side
 * fallback. The reported model is the one that wrote the text: the model of the last `fallback_message`
 * usage entry when a fallback served the response, else the last fallback block's model, else the
 * requested model. Errors making the request (the key, the network, rate limits after the SDK's
 * retries) propagate and stop the run; only an unusable answer becomes an EnrichResponseError.
 */
export function anthropicWriter(client: Anthropic, model: string, record?: RecordUsage): ModelFn {
  const { schema } = zodOutputFormat(draftSchema);
  return async (system, user, tag) => {
    const response = await client.beta.messages.create({
      model,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      // Thinking is on by default and shares max_tokens with the answer.
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema }, effort: 'medium' },
    });
    // A fallback block marks where a declining model's output gives way to the next model's: only what follows the last one is the answer.
    const answer = response.content.slice(response.content.findLastIndex((block) => block.type === 'fallback') + 1);
    const text = answer.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    // The SDK's signal that a fallback served the response is a `fallback_message` usage entry; a `fallback`
    // content block appears only when a declining model had already produced output.
    const servedBy = response.usage.iterations?.flatMap((entry) => (entry.type === 'fallback_message' ? [entry.model] : [])).at(-1);
    const handedTo = response.content.flatMap((block) => (block.type === 'fallback' ? [block.to.model] : [])).at(-1);
    const servedModel = servedBy ?? handedTo ?? response.model;
    // Recorded before the answer is judged: an unusable answer is billed like a usable one.
    report(record, tag, 'writer', usageOf(response.usage, model, servedModel, response.stop_reason));
    return {
      value: parseAnswer('writer', response.stop_reason, text),
      model: servedModel,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  };
}

/** The fact checker, backed by the Messages API with structured output built from checkSchema. Errors are handled as for the writer. */
export function anthropicChecker(client: Anthropic, model: string, record?: RecordUsage): ModelFn {
  const { schema } = zodOutputFormat(checkSchema);
  return async (system, user, tag) => {
    const response = await client.messages.create({
      model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema }, effort: 'medium' },
    });
    report(record, tag, 'checker', usageOf(response.usage, model, response.model, response.stop_reason));
    const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    return {
      value: parseAnswer('fact check', response.stop_reason, text),
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  };
}
