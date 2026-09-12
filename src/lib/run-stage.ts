import type { Db } from '../db/connection.js';

export interface StageContext {
  stage: string;
  verticalId?: number | null;
  channelId?: number | null;
}

export async function runStage<T>(
  db: Db,
  ctx: StageContext,
  fn: () => T | Promise<T>,
  now: () => Date = () => new Date(),
): Promise<T> {
  const insert = db.prepare(
    `INSERT INTO run_log (vertical_id, channel_id, stage, ok, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const log = (ok: boolean, detail: Record<string, unknown>) =>
    insert.run(ctx.verticalId ?? null, ctx.channelId ?? null, ctx.stage, ok ? 1 : 0, JSON.stringify(detail), now().toISOString());

  const started = Date.now();
  log(true, { phase: 'start' });
  try {
    const result = await fn();
    log(true, { phase: 'end', ms: Date.now() - started, result: result ?? null });
    return result;
  } catch (err) {
    log(false, { phase: 'end', ms: Date.now() - started, error: (err as Error).message });
    throw err;
  }
}
