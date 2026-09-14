import { describe, it, expect } from 'vitest';
import { buildPickMessage, pickPassages, PickerResponseError, validatePicks, type PickFn } from '../../src/harvest/picker.js';

const CANDIDATES = Array.from({ length: 6 }, (_, i) => `Sentence number ${i + 1} is a candidate cut from the book.`);
const OPTIONS = { batchSize: 2, maxBatches: 2, picksPerBatch: 1 };

describe('picker', () => {
  it('numbers the batch from 1 under the author, the work and the pick limit', () => {
    expect(buildPickMessage('Charles Dickens', 'A Tale of Two Cities', ['First.', 'Second.'], 3)).toBe(
      'Author: Charles Dickens\nWork: A Tale of Two Cities\nChoose at most 3 sentences.\n\n[1] First.\n[2] Second.',
    );
  });

  it('turns valid picks into 0-based indexes with their reasons', () => {
    expect(validatePicks({ picks: [{ id: 3, reason: 'stands alone' }, { id: 1, reason: 'wise' }] }, 3, 2)).toEqual([
      { index: 2, reason: 'stands alone' },
      { index: 0, reason: 'wise' },
    ]);
  });

  it.each([
    ['output that is not the schema', { picks: 'none' }],
    ['a fractional id', { picks: [{ id: 1.5, reason: 'x' }] }],
    ['id 0', { picks: [{ id: 0, reason: 'x' }] }],
    ['an id past the end of the batch', { picks: [{ id: 4, reason: 'x' }] }],
    ['a repeated id', { picks: [{ id: 2, reason: 'x' }, { id: 2, reason: 'y' }] }],
    ['more picks than allowed', { picks: [{ id: 1, reason: 'x' }, { id: 2, reason: 'y' }, { id: 3, reason: 'z' }] }],
  ])('rejects the whole batch for %s', (_label, raw) => {
    expect(() => validatePicks(raw, 3, 2)).toThrow(PickerResponseError);
  });

  it('returns the candidate text itself and spreads the batches it sends across the work', async () => {
    const users: string[] = [];
    const pick: PickFn = async (_system, user) => {
      users.push(user);
      return { picks: [{ id: 1, reason: 'Rewritten by the model, which must never be used.' }] };
    };
    const outcome = await pickPassages(pick, 'system prompt', 'Charles Dickens', 'A Tale of Two Cities', CANDIDATES, OPTIONS);
    expect(outcome).toEqual({
      picked: [
        { text: CANDIDATES[0], reason: 'Rewritten by the model, which must never be used.' },
        { text: CANDIDATES[2], reason: 'Rewritten by the model, which must never be used.' },
      ],
      batches: 2,
      failedBatches: 0,
    });
    expect(users[1]).toContain(`[1] ${CANDIDATES[2]}\n[2] ${CANDIDATES[3]}`);
  });

  it('skips and counts a batch whose output is unusable', async () => {
    let call = 0;
    const pick: PickFn = async () => (call++ === 0 ? { picks: [{ id: 9, reason: 'out of range' }] } : { picks: [] });
    expect(await pickPassages(pick, 's', 'a', 'w', CANDIDATES, OPTIONS)).toEqual({ picked: [], batches: 2, failedBatches: 1 });
  });

  it('stops on any other error', async () => {
    const pick: PickFn = async () => {
      throw new Error('authentication failed');
    };
    await expect(pickPassages(pick, 's', 'a', 'w', CANDIDATES, OPTIONS)).rejects.toThrow('authentication failed');
  });
});
