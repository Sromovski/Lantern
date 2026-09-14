import { z } from 'zod';

/** What the model returns: candidate numbers as shown in the prompt (1-based), each with a one-sentence reason. */
export const pickResultSchema = z.object({
  picks: z.array(z.object({ id: z.number().int(), reason: z.string() })),
});

/** Sends one batch (system prompt, user message) to the model and resolves to its structured output. */
export type PickFn = (system: string, user: string) => Promise<unknown>;

/** The model's output for one batch is unusable. Only that batch is skipped. */
export class PickerResponseError extends Error {
  override name = 'PickerResponseError';
}

export interface PickOptions {
  batchSize: number;
  maxBatches: number;
  picksPerBatch: number;
}

export interface PickedPassage {
  /** The candidate sentence itself, never text from the model. */
  text: string;
  reason: string;
}

export interface PickOutcome {
  picked: PickedPassage[];
  batches: number;
  failedBatches: number;
}

export function buildPickMessage(author: string, work: string, batch: readonly string[], picksPerBatch: number): string {
  const numbered = batch.map((text, i) => `[${i + 1}] ${text}`).join('\n');
  return `Author: ${author}\nWork: ${work}\nChoose at most ${picksPerBatch} sentences.\n\n${numbered}`;
}

/**
 * The model's picks for a batch of `batchLength` candidates, as 0-based indexes in the order given.
 * An id that is not a whole number in range, a repeated id, or more picks than allowed rejects the
 * whole batch: the model may only choose, so a malformed choice is never partly trusted.
 */
export function validatePicks(raw: unknown, batchLength: number, picksPerBatch: number): { index: number; reason: string }[] {
  const parsed = pickResultSchema.safeParse(raw);
  if (!parsed.success) throw new PickerResponseError(`picker output does not match the schema: ${parsed.error.message}`);
  const { picks } = parsed.data;
  if (picks.length > picksPerBatch) {
    throw new PickerResponseError(`picker chose ${picks.length} sentences; at most ${picksPerBatch} are allowed`);
  }
  const seen = new Set<number>();
  return picks.map(({ id, reason }) => {
    if (id < 1 || id > batchLength) throw new PickerResponseError(`picker chose id ${id}, outside 1-${batchLength}`);
    if (seen.has(id)) throw new PickerResponseError(`picker chose id ${id} twice`);
    seen.add(id);
    return { index: id - 1, reason };
  });
}

/**
 * Runs the picker over a work's candidates. When there are more batches than `maxBatches`, the
 * batches sent are spread evenly across the work instead of all coming from its opening. A batch
 * whose output is unusable (PickerResponseError) is counted and skipped; any other error, such as
 * authentication, network or rate limiting after the client's retries, stops the run.
 */
export async function pickPassages(
  pick: PickFn,
  system: string,
  author: string,
  work: string,
  candidates: readonly string[],
  options: PickOptions,
): Promise<PickOutcome> {
  const total = Math.ceil(candidates.length / options.batchSize);
  const count = Math.min(total, options.maxBatches);
  const picked: PickedPassage[] = [];
  let failedBatches = 0;
  for (let k = 0; k < count; k++) {
    const start = Math.floor((k * total) / count) * options.batchSize;
    const batch = candidates.slice(start, start + options.batchSize);
    try {
      const raw = await pick(system, buildPickMessage(author, work, batch, options.picksPerBatch));
      for (const { index, reason } of validatePicks(raw, batch.length, options.picksPerBatch)) {
        picked.push({ text: batch[index]!, reason });
      }
    } catch (err) {
      if (!(err instanceof PickerResponseError)) throw err;
      failedBatches++;
    }
  }
  return { picked, batches: count, failedBatches };
}
