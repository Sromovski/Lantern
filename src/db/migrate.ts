import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './connection.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;

function ensureTable(db: Db): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
}

function migrationFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => MIGRATION_FILE.test(f)).sort();
}

export function pendingMigrations(db: Db, dir: string): string[] {
  ensureTable(db);
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[]);
  return migrationFiles(dir).filter((f) => !done.has(f));
}

export function migrate(db: Db, dir: string): { applied: string[]; current: string | null } {
  const pending = pendingMigrations(db, dir);
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  for (const file of pending) {
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    })();
  }
  return { applied: pending, current: migrationFiles(dir).at(-1) ?? null };
}
