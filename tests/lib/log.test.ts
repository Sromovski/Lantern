import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../src/lib/log.js';

let dir: string;
const now = () => new Date('2026-03-04T05:06:07.000Z');
const lines = () =>
  readFileSync(join(dir, 'lantern-2026-03-04.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lantern-log-'));
});

describe('createLogger', () => {
  it('appends one JSON object per line to a dated file', () => {
    const log = createLogger({ dir, now });
    log.info('harvest started', { vertical: 'literature' });
    log.warn('slow response', { ms: 5200 });
    expect(lines()).toEqual([
      { ts: '2026-03-04T05:06:07.000Z', level: 'info', msg: 'harvest started', vertical: 'literature' },
      { ts: '2026-03-04T05:06:07.000Z', level: 'warn', msg: 'slow response', ms: 5200 },
    ]);
  });

  it('merges child fields', () => {
    createLogger({ dir, now }).child({ stage: 'verify' }).error('boom', { itemId: 7 });
    expect(lines()[0]).toMatchObject({ level: 'error', stage: 'verify', itemId: 7 });
  });

  it('serializes Error values', () => {
    createLogger({ dir, now }).error('failed', { err: new TypeError('bad input') });
    expect(lines()[0].err).toMatchObject({ name: 'TypeError', message: 'bad input' });
  });

  it('echoes lines when asked', () => {
    const seen: string[] = [];
    createLogger({ dir, now, echo: (l) => seen.push(l) }).info('hi');
    expect(JSON.parse(seen[0]!)).toMatchObject({ msg: 'hi' });
  });
});
