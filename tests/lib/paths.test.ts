import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { resolvePaths } from '../../src/lib/paths.js';

describe('resolvePaths', () => {
  it('defaults everything under the working directory', () => {
    const cwd = resolve('/work/lantern');
    expect(resolvePaths({}, cwd)).toEqual({
      root: cwd,
      db: join(cwd, 'data', 'lantern.db'),
      logs: join(cwd, 'logs'),
      migrations: join(cwd, 'migrations'),
    });
  });

  it('honours overrides, resolving relative ones against the root', () => {
    const root = resolve('/srv/lantern');
    const abs = resolve('/tmp/test.db');
    const p = resolvePaths({ LANTERN_ROOT: root, LANTERN_DB: abs, LANTERN_LOGS: 'var/logs' }, '/elsewhere');
    expect(p.db).toBe(abs);
    expect(p.logs).toBe(join(root, 'var', 'logs'));
  });
});
