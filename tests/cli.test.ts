import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  env?: Record<string, string>; // extra child env, applied last
}

function lantern(args: string[], scratch: string, opts: LanternOpts = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    FB_PAGE_ID_COMMONPLACE: 'x',
    PINTEREST_BOARD_ID_COMMONPLACE: 'x',
    YT_CHANNEL_ID_LOOK_CLOSER: 'x',
    LANTERN_CONTACT: 'test@example.invalid',
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

  Object.assign(env, opts.env ?? {});

  const res = spawnSync(process.execPath, ['--import', TSX_LOADER, join(ROOT, 'src', 'cli.ts'), ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    env,
  });
  return { code: res.status, out: res.stdout + res.stderr };
}

function logRecords(logs: string): Record<string, unknown>[] {
  if (!existsSync(logs)) return [];
  return readdirSync(logs).flatMap((file) =>
    readFileSync(join(logs, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
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

  it('logs a mistyped command to logs/ and exits 1', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const res = lantern(['doctr'], scratch);
    expect(res.code).toBe(1);
    expect(res.out).toContain("unknown command 'doctr'");
    expect(logRecords(join(scratch, 'logs'))).toEqual([
      expect.objectContaining({ level: 'error', msg: 'command rejected', code: 'commander.unknownCommand' }),
    ]);
  }, 30_000);

  it('exits 0 for --help without logging an error', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const res = lantern(['--help'], scratch);
    expect(res.code).toBe(0);
    expect(res.out).toContain('Usage: lantern');
    expect(logRecords(join(scratch, 'logs')).filter((r) => r.level === 'error')).toEqual([]);
  }, 30_000);

  it('harvest refuses a database with pending migrations before anything else', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const res = lantern(['harvest', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(res.code).toBe(1);
    expect(res.out).toContain('run lantern migrate');
  }, 30_000);

  it('harvest refuses a vertical without a harvest section, and a missing API key, without fetching anything', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    expect(lantern(['migrate'], scratch).code).toBe(0);
    const science = lantern(['harvest', '--vertical', 'science-curious'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(science.code).toBe(1);
    expect(science.out).toContain('vertical science-curious has no harvest section');
    const cache = join(scratch, 'cache');
    const noKey = lantern(['harvest', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: '', LANTERN_CACHE: cache } });
    expect(noKey.code).toBe(1);
    expect(noKey.out).toContain('ANTHROPIC_API_KEY is not set');
    expect(existsSync(cache)).toBe(false);
  }, 30_000);

  it('harvest and verify refuse an unknown vertical', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    expect(lantern(['migrate'], scratch).code).toBe(0);
    for (const command of ['harvest', 'verify']) {
      const res = lantern([command, '--vertical', 'poetry'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
      expect(res.code).toBe(1);
      expect(res.out).toContain('unknown vertical: poetry');
    }
  }, 30_000);

  it('verify decides nothing on an empty database and records the stage', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    expect(lantern(['migrate'], scratch).code).toBe(0);
    const res = lantern(['verify', '--vertical', 'literature'], scratch);
    expect(res.code).toBe(0);
    expect(res.out).toContain('verified: 0');
    expect(res.out).toContain('left raw: 0 without a Wikiquote check, 0 with malformed evidence');
  }, 30_000);

  it('enrich refuses a bad limit, pending migrations, a vertical without an enrich section, and a missing API key, without fetching anything', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const badLimit = lantern(['enrich', '--vertical', 'literature', '--limit', '0'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(badLimit.code).toBe(1);
    expect(badLimit.out).toContain('--limit must be a positive integer, got 0');
    const pending = lantern(['enrich', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(pending.code).toBe(1);
    expect(pending.out).toContain('run lantern migrate');
    expect(lantern(['migrate'], scratch).code).toBe(0);
    const science = lantern(['enrich', '--vertical', 'science-curious'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(science.code).toBe(1);
    expect(science.out).toContain('vertical science-curious has no enrich section');
    const cache = join(scratch, 'cache');
    const noKey = lantern(['enrich', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: '', LANTERN_CACHE: cache } });
    expect(noKey.code).toBe(1);
    expect(noKey.out).toContain('ANTHROPIC_API_KEY is not set');
    expect(existsSync(cache)).toBe(false);
  }, 60_000);

  it('enrich writes nothing when no verified quote is waiting for a post', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    expect(lantern(['migrate'], scratch).code).toBe(0);
    const cache = join(scratch, 'cache');
    const res = lantern(['enrich', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: 'test-key-never-sent', LANTERN_CACHE: cache } });
    expect(res.code).toBe(0);
    expect(res.out).toContain('posts: 0 draft, 0 needs review; failed: 0');
    expect(existsSync(cache)).toBe(false);
  }, 30_000);
});
