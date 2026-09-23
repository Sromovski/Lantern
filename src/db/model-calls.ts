import type { RecordUsage } from '../lib/usage.js';
import type { Db } from './connection.js';

/** A RecordUsage that writes each call to model_calls under the given vertical. */
export function modelCallRecorder(db: Db, verticalId: number, now: () => Date = () => new Date()): RecordUsage {
  const insert = db.prepare(
    `INSERT INTO model_calls (vertical_id, stage, role, item_id, post_id, gutenberg_id, requested_model, model,
       input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, stop_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return (tag, usage) => {
    insert.run(
      verticalId,
      tag.stage,
      tag.role,
      tag.itemId ?? null,
      tag.postId ?? null,
      tag.gutenbergId ?? null,
      usage.requestedModel,
      usage.model,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheCreationInputTokens,
      usage.cacheReadInputTokens,
      usage.stopReason,
      now().toISOString(),
    );
  };
}

/** One recorded call, as the cost report reads it. */
export interface ModelCallRow {
  stage: string;
  role: string;
  itemId: number | null;
  postId: number | null;
  gutenbergId: number | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * Every recorded call in a vertical, oldest first. A caption call is recorded against its post; its
 * item id is filled in from the post, so every enrich and caption call can be charged to a quote.
 */
export function modelCalls(db: Db, verticalId: number): ModelCallRow[] {
  return db
    .prepare(
      `SELECT c.stage, c.role, COALESCE(c.item_id, p.item_id) AS itemId, c.post_id AS postId, c.gutenberg_id AS gutenbergId,
              c.model, c.input_tokens AS inputTokens, c.output_tokens AS outputTokens,
              c.cache_creation_input_tokens AS cacheCreationInputTokens, c.cache_read_input_tokens AS cacheReadInputTokens
       FROM model_calls c LEFT JOIN posts p ON p.id = c.post_id
       WHERE c.vertical_id = ?
       ORDER BY c.id`,
    )
    .all(verticalId) as ModelCallRow[];
}
