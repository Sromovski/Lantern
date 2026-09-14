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
