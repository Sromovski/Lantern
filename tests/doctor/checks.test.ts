import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { appendFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/connection.js';
import { MIGRATIONS_DIR } from '../../src/db/migrate.js';
import { loadConfig } from '../../src/config/load.js';
import { syncConfig } from '../../src/db/sync.js';
import { runChecks, type DoctorContext } from '../../src/doctor/checks.js';
import { exitCode, formatReport } from '../../src/doctor/report.js';
import { testDb } from '../helpers/db.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENV = {
  FB_PAGE_ID_COMMONPLACE: '1',
  PINTEREST_BOARD_ID_COMMONPLACE: '2',
  YT_CHANNEL_ID_LOOK_CLOSER: '3',
};

function healthyCtx(overrides: Partial<DoctorContext> = {}): DoctorContext {
  const db = testDb();
  syncConfig(db, loadConfig(ROOT));
  return {
    db,
    root: ROOT,
    migrationsDir: MIGRATIONS_DIR,
    env: ENV,
    now: new Date('2026-09-12T12:00:00Z'),
    freeBytes: () => 50 * 1024 ** 3,
    ...overrides,
  };
}

const byName = (ctx: DoctorContext, name: string) => runChecks(ctx).find((r) => r.name === name);

describe('runChecks', () => {
  it('reports a healthy empty system with no warnings or failures', () => {
    const results = runChecks(healthyCtx());
    expect(results.filter((r) => r.status !== 'ok')).toEqual([]);
    expect(exitCode(results)).toBe(0);
  });

  it('fails when migrations are pending', () => {
    const ctx = healthyCtx({ db: openDb(':memory:') });
    expect(byName(ctx, 'db.migrations')?.status).toBe('fail');
    expect(exitCode(runChecks(ctx))).toBe(1);
  });

  it('reports a bad migration filename as a failed check without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lantern-migrations-'));
    writeFileSync(join(dir, '002-bad.sql'), 'CREATE TABLE t (id INTEGER PRIMARY KEY);');
    const ctx = healthyCtx({ migrationsDir: dir });
    let results: ReturnType<typeof runChecks> = [];
    expect(() => {
      results = runChecks(ctx);
    }).not.toThrow();
    const migrations = results.find((r) => r.name === 'db.migrations');
    expect(migrations?.status).toBe('fail');
    expect(migrations?.detail).toContain('invalid migration filename');
    expect(results.find((r) => r.name.startsWith('channel.'))).toBeUndefined();
  });

  it('fails when config has not been synced', () => {
    expect(byName(healthyCtx({ db: testDb() }), 'config.synced')?.status).toBe('fail');
  });

  it('warns when a channel account_ref env var is missing', () => {
    const r = byName(healthyCtx({ env: {} }), 'channel.literature-facebook.account_ref');
    expect(r).toMatchObject({ status: 'warn' });
    expect(r?.detail).toContain('FB_PAGE_ID_COMMONPLACE');
  });

  it('warns about a thin buffer only once a channel is live', () => {
    const ctx = healthyCtx();
    expect(byName(ctx, 'channel.literature-facebook.buffer')?.status).toBe('ok');
    ctx.db.prepare("UPDATE channels SET auto_publish = 1 WHERE platform = 'facebook'").run();
    expect(byName(ctx, 'channel.literature-facebook.buffer')).toMatchObject({ status: 'warn' });
    expect(byName(ctx, 'channel.literature-facebook.last_publish')).toMatchObject({ status: 'warn' });
  });

  it('warns when disk space is low', () => {
    expect(byName(healthyCtx({ freeBytes: () => 10 * 1024 ** 2 }), 'disk.free')?.status).toBe('warn');
  });

  it('fails when a guard trigger is missing', () => {
    const ctx = healthyCtx();
    ctx.db.exec('DROP TRIGGER items_verified_not_reopened');
    const r = byName(ctx, 'db.triggers');
    expect(r).toMatchObject({ status: 'fail' });
    expect(r?.detail).toContain('items_verified_not_reopened');
  });

  it('fails when an applied migration file was edited afterwards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lantern-migrations-'));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const ctx = healthyCtx({ migrationsDir: dir });
    appendFileSync(join(dir, '004_item_guards.sql'), '\n-- edited after being applied\n');
    const r = byName(ctx, 'db.drift');
    expect(r).toMatchObject({ status: 'fail' });
    expect(r?.detail).toContain('004_item_guards.sql');
  });

  it('warns when applied migrations have no recorded checksum', () => {
    const ctx = healthyCtx();
    ctx.db.prepare('UPDATE schema_migrations SET checksum = NULL').run();
    expect(byName(ctx, 'db.drift')).toMatchObject({ status: 'warn' });
  });
});

describe('formatReport', () => {
  it('prints one line per check with its status', () => {
    const out = formatReport([
      { name: 'db.integrity', status: 'ok', detail: 'ok' },
      { name: 'disk.free', status: 'warn', detail: '10 MiB free' },
    ]);
    expect(out).toContain('[ ok ] db.integrity');
    expect(out).toContain('[warn] disk.free');
    expect(out).toContain('0 failed, 1 warning');
  });
});
