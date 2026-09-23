import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { report, usageOf, type RecordUsage } from '../lib/usage.js';
import { PickerResponseError, pickResultSchema, type PickFn } from './picker.js';

/** Spec section 15: prompts are content and live in version-controlled files. */
export const PICK_PROMPT_PATH = 'prompts/literature/pick.md';

export function loadPickPrompt(root: string): string {
  return readFileSync(join(root, PICK_PROMPT_PATH), 'utf8');
}

/**
 * A PickFn backed by the Messages API with structured output (a JSON schema built from
 * pickResultSchema). Anything that goes wrong making the request (a missing or rejected key, the
 * network, rate limiting after the SDK's retries, an invalid parameter) propagates and stops the
 * run. Only reading the answer can fail a batch: a stop other than end_turn (a refusal, a truncated
 * answer) or text that is not JSON becomes a PickerResponseError, and validatePicks checks the rest.
 */
export function anthropicPick(client: Anthropic, model: string, record?: RecordUsage): PickFn {
  const { schema } = zodOutputFormat(pickResultSchema);
  return async (system, user, tag) => {
    const response = await client.messages.create({
      model,
      // Room for adaptive thinking as well as the answer: a max_tokens stop fails the batch.
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema }, effort: 'low' },
    });
    // Recorded before the answer is judged: an unusable batch is billed like a usable one.
    report(record, tag, 'picker', usageOf(response.usage, model, response.model, response.stop_reason));
    if (response.stop_reason !== 'end_turn') {
      throw new PickerResponseError(`picker stopped with ${String(response.stop_reason)} and no usable output`);
    }
    const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PickerResponseError('picker output is not JSON');
    }
  };
}
