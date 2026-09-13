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
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const byPrefix = new Map<string, string>();
  for (const f of files) {
    if (!MIGRATION_FILE.test(f)) {
      throw new Error(`invalid migration filename: ${f} (expected NNN_lower_snake_case.sql)`);
    }
    const prefix = f.slice(0, 3);
    const existing = byPrefix.get(prefix);
    if (existing !== undefined) {
      throw new Error(`duplicate migration number ${prefix}: ${existing}, ${f}`);
    }
    byPrefix.set(prefix, f);
  }

  return files;
}

export function pendingMigrations(db: Db, dir: string): string[] {
  ensureTable(db);
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[]);
  return migrationFiles(dir).filter((f) => !done.has(f));
}

/**
 * Each migration runs in its own transaction with foreign keys switched off around it (the pragma is a
 * no-op inside a transaction), so a table-rebuild migration can drop and recreate a referenced table.
 * `PRAGMA foreign_key_check` must come back empty before the transaction commits, and enforcement is
 * restored afterwards, even on failure. Rebuilding a table drops its triggers: a rebuild of `items` or
 * `sources` must recreate the 002-004 guard triggers, and `lantern doctor` fails if any are missing.
 */
export function migrate(db: Db, dir: string): { applied: string[]; current: string | null } {
  const pending = pendingMigrations(db, dir);
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  for (const file of pending) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(sql);
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `migration ${file} leaves ${violations.length} foreign key violation(s): ${JSON.stringify(violations.slice(0, 5))}`,
          );
        }
        record.run(file, new Date().toISOString());
      })();
    } finally {
      db.pragma(`foreign_keys = ${foreignKeys === 1 ? 'ON' : 'OFF'}`);
    }
  }
  return { applied: pending, current: migrationFiles(dir).at(-1) ?? null };
}

const CREATE_TRIGGER = /\bCREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
const DROP_TRIGGER = /\bDROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;

/** Trigger names the applied migrations should have left in place: CREATE and DROP TRIGGER replayed in order. */
export function expectedTriggers(db: Db, dir: string): string[] {
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[]);
  const names = new Set<string>();
  for (const file of migrationFiles(dir).filter((f) => applied.has(f))) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const events = [
      ...[...sql.matchAll(CREATE_TRIGGER)].map((m) => ({ at: m.index ?? 0, name: m[1] ?? '', create: true })),
      ...[...sql.matchAll(DROP_TRIGGER)].map((m) => ({ at: m.index ?? 0, name: m[1] ?? '', create: false })),
    ].sort((a, b) => a.at - b.at);
    for (const event of events) {
      if (event.create) names.add(event.name);
      else names.delete(event.name);
    }
  }
  return [...names].sort();
}
