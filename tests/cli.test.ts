import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function lantern(args: string[], scratch: string) {
  const res = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      LANTERN_ROOT: ROOT,
      LANTERN_DB: join(scratch, 'lantern.db'),
      LANTERN_LOGS: join(scratch, 'logs'),
      FB_PAGE_ID_COMMONPLACE: 'x',
      PINTEREST_BOARD_ID_COMMONPLACE: 'x',
      YT_CHANNEL_ID_LOOK_CLOSER: 'x',
    },
  });
  return { code: res.status, out: res.stdout + res.stderr };
}

describe('lantern CLI', () => {
  it('doctor fails on a fresh database, then passes after migrate', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));

    const before = lantern(['doctor'], scratch);
    expect(before.code).toBe(1);
    expect(before.out).toContain('[FAIL] db.migrations');

    const migrated = lantern(['migrate'], scratch);
    expect(migrated.code).toBe(0);
    expect(migrated.out).toContain('001_initial.sql');

    const after = lantern(['doctor'], scratch);
    expect(after.code).toBe(0);
    expect(after.out).toContain('0 failed, 0 warnings');
  }, 30_000);

  it('doctor --json emits machine-readable results', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    lantern(['migrate'], scratch);
    const res = lantern(['doctor', '--json'], scratch);
    const parsed = JSON.parse(res.out) as Array<{ name: string; status: string }>;
    expect(parsed.find((r) => r.name === 'db.integrity')?.status).toBe('ok');
  }, 30_000);
});
