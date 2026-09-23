/**
 * What a model call is for, so its tokens can be charged to the right quote. The stage and role say
 * which step made the call; the ids say what it was about. A call records its usage whether or not
 * its answer turns out to be usable, because a refused or truncated answer is billed all the same.
 */
export interface CallTag {
  stage: string;
  role?: string;
  itemId?: number;
  postId?: number;
  gutenbergId?: number;
}

/** The token counts of one response, as the API reported them, and the model that was billed. */
export interface CallUsage {
  requestedModel: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  stopReason: string | null;
}

/** Records one call's usage. The role is the builder's own (picker, writer, checker) unless the tag names one. */
export type RecordUsage = (tag: CallTag & { role: string }, usage: CallUsage) => void;

interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Reads the counts off a Messages API response. Thinking tokens are already inside output_tokens. */
export function usageOf(usage: ApiUsage, requestedModel: string, model: string, stopReason: string | null): CallUsage {
  return {
    requestedModel,
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    stopReason,
  };
}

/** Sends usage to `record` when there is one. A call made without a tag is still recorded, under stage 'untagged'. */
export function report(record: RecordUsage | undefined, tag: CallTag | undefined, role: string, usage: CallUsage): void {
  record?.({ ...(tag ?? { stage: 'untagged' }), role: tag?.role ?? role }, usage);
}
