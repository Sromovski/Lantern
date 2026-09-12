import { describe, it, expect } from 'vitest';
import { runStage } from '../../src/lib/run-stage.js';
import { testDb, seedPublicationChain } from '../helpers/db.js';

type Row = { stage: string; ok: number; vertical_id: number | null; channel_id: number | null; detail_json: string };

const rows = (db: ReturnType<typeof testDb>) =>
  (db.prepare('SELECT stage, ok, vertical_id, channel_id, detail_json FROM run_log ORDER BY id').all() as Row[])
    .map((r) => ({ ...r, detail: JSON.parse(r.detail_json) }));

describe('runStage', () => {
  it('writes an entry row and an exit row around a successful stage', async () => {
    const db = testDb();
    const { verticalId } = seedPublicationChain(db);
    const result = await runStage(db, { stage: 'harvest', verticalId }, () => ({ inserted: 3 }));
    expect(result).toEqual({ inserted: 3 });
    const [start, end] = rows(db);
    expect(start).toMatchObject({ stage: 'harvest', ok: 1, vertical_id: verticalId, detail: { phase: 'start' } });
    expect(end).toMatchObject({ stage: 'harvest', ok: 1, detail: { phase: 'end', result: { inserted: 3 } } });
    expect(typeof end!.detail.ms).toBe('number');
  });

  it('records failure with ok = 0 and rethrows', async () => {
    const db = testDb();
    await expect(
      runStage(db, { stage: 'verify' }, async () => {
        throw new Error('gutendex timeout');
      }),
    ).rejects.toThrow('gutendex timeout');
    const [, end] = rows(db);
    expect(end).toMatchObject({ ok: 0, detail: { phase: 'end', error: 'gutendex timeout' } });
  });

  it('records non-Error throws in run_log', async () => {
    const db = testDb();
    await expect(
      runStage(db, { stage: 'publish' }, async () => {
        throw 'quota exhausted';
      }),
    ).rejects.toEqual('quota exhausted');
    const [, end] = rows(db);
    expect(end).toMatchObject({ ok: 0, detail: { phase: 'end', error: 'quota exhausted' } });
  });
});
