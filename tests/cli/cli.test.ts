import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the real CLI from the project root, with logs and database redirected to a temp dir. */
function runCli(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LANTERN_LOGS: join(dir, 'logs'), LANTERN_DB: join(dir, 'lantern.db') },
    timeout: 60_000,
  });
}

function logRecords(): Record<string, unknown>[] {
  const logs = join(dir, 'logs');
  if (!existsSync(logs)) return [];
  return readdirSync(logs).flatMap((file) =>
    readFileSync(join(logs, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}

describe('lantern CLI', () => {
  it('logs a mistyped command to logs/ and exits 1', () => {
    const run = runCli('doctr');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("unknown command 'doctr'");
    expect(logRecords()).toEqual([
      expect.objectContaining({ level: 'error', msg: 'command rejected', code: 'commander.unknownCommand' }),
    ]);
  }, 60_000);

  it('exits 0 for --help without logging an error', () => {
    const run = runCli('--help');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Usage: lantern');
    expect(logRecords().filter((r) => r.level === 'error')).toEqual([]);
  }, 60_000);
});
