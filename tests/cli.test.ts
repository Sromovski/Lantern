import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Resolved as an absolute file:// URL (not the bare "tsx" specifier) so the loader
// resolves from this repo's node_modules regardless of the child process's cwd.
const TSX_LOADER = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

interface LanternOpts {
  cwd?: string;
  root?: string | null; // null omits LANTERN_ROOT from the child env
  db?: string | null; // null omits LANTERN_DB from the child env
  logs?: string | null; // null omits LANTERN_LOGS from the child env
}

function lantern(args: string[], scratch: string, opts: LanternOpts = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    FB_PAGE_ID_COMMONPLACE: 'x',
    PINTEREST_BOARD_ID_COMMONPLACE: 'x',
    YT_CHANNEL_ID_LOOK_CLOSER: 'x',
  };

  const root = 'root' in opts ? opts.root : ROOT;
  if (root === null) delete env.LANTERN_ROOT;
  else env.LANTERN_ROOT = root;

  const db = 'db' in opts ? opts.db : join(scratch, 'lantern.db');
  if (db === null) delete env.LANTERN_DB;
  else env.LANTERN_DB = db;

  const logs = 'logs' in opts ? opts.logs : join(scratch, 'logs');
  if (logs === null) delete env.LANTERN_LOGS;
  else env.LANTERN_LOGS = logs;

  const res = spawnSync(process.execPath, ['--import', TSX_LOADER, join(ROOT, 'src', 'cli.ts'), ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    env,
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

  it('resolves the project root from its own install location, not an unrelated cwd', () => {
    const emptyCwd = mkdtempSync(join(tmpdir(), 'lantern-cli-cwd-'));
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-scratch-'));

    const migrated = lantern(['migrate'], scratch, { cwd: emptyCwd, root: null });
    expect(migrated.code).toBe(0);
    expect(migrated.out).toContain('001_initial.sql');

    const doctored = lantern(['doctor'], scratch, { cwd: emptyCwd, root: null });
    expect(doctored.code).toBe(0);

    expect(existsSync(join(emptyCwd, 'data'))).toBe(false);
    expect(existsSync(join(emptyCwd, 'logs'))).toBe(false);
  }, 30_000);

  it('honours LANTERN_DB / LANTERN_LOGS set in .env at the project root', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-env-'));
    cpSync(join(ROOT, 'config'), join(scratch, 'config'), { recursive: true });
    cpSync(join(ROOT, 'migrations'), join(scratch, 'migrations'), { recursive: true });
    writeFileSync(
      join(scratch, '.env'),
      [
        'LANTERN_DB=custom/fromdotenv.db',
        'LANTERN_LOGS=dotenvlogs',
        'FB_PAGE_ID_COMMONPLACE=x',
        'PINTEREST_BOARD_ID_COMMONPLACE=x',
        'YT_CHANNEL_ID_LOOK_CLOSER=x',
        '',
      ].join('\n'),
    );

    const migrated = lantern(['migrate'], scratch, { root: scratch, db: null, logs: null });
    expect(migrated.code).toBe(0);

    expect(existsSync(join(scratch, 'custom', 'fromdotenv.db'))).toBe(true);
    expect(existsSync(join(scratch, 'dotenvlogs'))).toBe(true);
  }, 30_000);
});
