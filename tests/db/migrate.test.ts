import { describe, it, expect } from 'vitest';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/db/connection.js';
import { expectedTriggers, migrate, migrationDrift, pendingMigrations, MIGRATIONS_DIR } from '../../src/db/migrate.js';
import { testDb, seedPublicationChain } from '../helpers/db.js';

function tempMigrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lantern-migrations-'));
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  return dir;
}

const TABLES = [
  'verticals', 'channels', 'subjects', 'items', 'sources', 'images',
  'posts', 'renditions', 'captions', 'publications', 'run_log',
];

describe('migrate', () => {
  it('applies all migrations to an empty database', () => {
    const db = openDb(':memory:');
    const result = migrate(db, MIGRATIONS_DIR);
    expect(result.applied[0]).toBe('001_initial.sql');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .pluck()
      .all() as string[];
    for (const t of TABLES) expect(names).toContain(t);
    expect(pendingMigrations(db, MIGRATIONS_DIR)).toEqual([]);
  });

  it('is idempotent', () => {
    const db = openDb(':memory:');
    migrate(db, MIGRATIONS_DIR);
    expect(migrate(db, MIGRATIONS_DIR).applied).toEqual([]);
  });

  it('enforces foreign keys', () => {
    const db = testDb();
    expect(() =>
      db.prepare(
        "INSERT INTO items (vertical_id, kind, body, body_hash, status, created_at) VALUES (999, 'quote', 'x', 'h', 'raw', 'now')",
      ).run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('throws on a badly named migration file instead of silently skipping it', () => {
    const dir = tempMigrationsDir({
      '001_ok.sql': "CREATE TABLE t (id INTEGER PRIMARY KEY);",
      '002-bad.sql': "CREATE TABLE u (id INTEGER PRIMARY KEY);",
    });
    const db = openDb(':memory:');
    expect(() => migrate(db, dir)).toThrow(/invalid migration filename: 002-bad\.sql/);
  });

  it('throws on duplicate migration numbers', () => {
    const dir = tempMigrationsDir({
      '001_a.sql': "CREATE TABLE t (id INTEGER PRIMARY KEY);",
      '001_b.sql': "CREATE TABLE u (id INTEGER PRIMARY KEY);",
    });
    const db = openDb(':memory:');
    expect(() => migrate(db, dir)).toThrow(/duplicate migration number 001/);
  });

  it('ignores non-.sql files such as a README', () => {
    const dir = tempMigrationsDir({
      '001_ok.sql': "CREATE TABLE t (id INTEGER PRIMARY KEY);",
      'notes.txt': 'not a migration',
    });
    const db = openDb(':memory:');
    const result = migrate(db, dir);
    expect(result.applied).toEqual(['001_ok.sql']);
  });

  it('makes double-posting the same post to the same channel impossible', () => {
    const db = testDb();
    const s = seedPublicationChain(db);
    const insert = db.prepare(
      `INSERT INTO publications (post_id, channel_id, rendition_id, caption_id, status, idempotency_key)
       VALUES (?, ?, ?, ?, 'scheduled', ?)`,
    );
    insert.run(s.postId, s.channelId, s.renditionId, s.captionId, 'key-1');
    expect(() =>
      insert.run(s.postId, s.channelId, s.renditionId, s.captionId, 'key-2'),
    ).toThrow(/UNIQUE constraint failed: publications\.post_id, publications\.channel_id/);
  });

  it('runs a table-rebuild migration on a populated database without breaking foreign keys', () => {
    const dir = tempMigrationsDir({
      '001_parent.sql':
        'CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));',
      '002_seed.sql': "INSERT INTO parent VALUES (1, 'a'); INSERT INTO child VALUES (1, 1);",
      '003_rebuild_parent.sql':
        'CREATE TABLE parent_new (id INTEGER PRIMARY KEY, name TEXT, extra TEXT); INSERT INTO parent_new (id, name) SELECT id, name FROM parent; DROP TABLE parent; ALTER TABLE parent_new RENAME TO parent;',
    });
    const db = openDb(':memory:');
    expect(migrate(db, dir).applied).toEqual(['001_parent.sql', '002_seed.sql', '003_rebuild_parent.sql']);
    expect(db.prepare('SELECT COUNT(*) FROM child JOIN parent ON parent.id = child.parent_id').pluck().get()).toBe(1);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => db.prepare('INSERT INTO child VALUES (2, 999)').run()).toThrow(/FOREIGN KEY/);
  });

  it('rolls back a migration that leaves a dangling foreign key and restores enforcement', () => {
    const dir = tempMigrationsDir({
      '001_parent.sql':
        'CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id)); INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1, 1);',
      '002_orphan.sql': 'DELETE FROM parent;',
    });
    const db = openDb(':memory:');
    expect(() => migrate(db, dir)).toThrow(/002_orphan\.sql leaves 1 foreign key violation/);
    expect(db.prepare('SELECT COUNT(*) FROM parent').pluck().get()).toBe(1);
    expect(pendingMigrations(db, dir)).toEqual(['002_orphan.sql']);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('restores foreign key enforcement after a migration with a syntax error', () => {
    const dir = tempMigrationsDir({ '001_broken.sql': 'CREATE TABLE broken (' });
    const db = openDb(':memory:');
    expect(() => migrate(db, dir)).toThrow();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('applies the remaining real migrations to a database populated after 001', () => {
    const only001 = tempMigrationsDir({});
    copyFileSync(join(MIGRATIONS_DIR, '001_initial.sql'), join(only001, '001_initial.sql'));
    const db = openDb(':memory:');
    migrate(db, only001);
    const seeded = seedPublicationChain(db);
    const rest = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .slice(1);
    expect(migrate(db, MIGRATIONS_DIR).applied).toEqual(rest);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare('SELECT body FROM items WHERE id = ?').pluck().get(seeded.itemId)).toBe('It was the best of times');
  });

  it('lists the triggers the applied migrations leave in place', () => {
    const db = testDb();
    const present = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").pluck().all();
    expect(expectedTriggers(db, MIGRATIONS_DIR)).toEqual(present);
    expect(present).toContain('items_verified_not_reopened');
  });

  it('replays CREATE TRIGGER and DROP TRIGGER in order', () => {
    const dir = tempMigrationsDir({
      '001_t.sql':
        'CREATE TABLE t (id INTEGER PRIMARY KEY); CREATE TRIGGER t_a BEFORE INSERT ON t BEGIN SELECT 1; END; CREATE TRIGGER t_b BEFORE DELETE ON t BEGIN SELECT 1; END;',
      '002_drop.sql': 'DROP TRIGGER t_a; CREATE TRIGGER IF NOT EXISTS t_c BEFORE UPDATE ON t BEGIN SELECT 1; END;',
    });
    const db = openDb(':memory:');
    migrate(db, dir);
    expect(expectedTriggers(db, dir)).toEqual(['t_b', 't_c']);
  });

  it('records a line-ending-independent checksum for each applied migration', () => {
    const lf = tempMigrationsDir({ '001_t.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);\nCREATE TABLE u (id INTEGER PRIMARY KEY);\n' });
    const crlf = tempMigrationsDir({
      '001_t.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);\r\nCREATE TABLE u (id INTEGER PRIMARY KEY);\r\n',
    });
    const a = openDb(':memory:');
    migrate(a, lf);
    const b = openDb(':memory:');
    migrate(b, crlf);
    const checksumOf = (db: Db) => db.prepare('SELECT checksum FROM schema_migrations').pluck().get();
    expect(checksumOf(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(checksumOf(a)).toBe(checksumOf(b));
  });

  it('backfills checksums on a database migrated before checksums existed', () => {
    const dir = tempMigrationsDir({
      '001_t.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
      '002_u.sql': 'CREATE TABLE u (id INTEGER PRIMARY KEY);',
    });
    const db = openDb(':memory:');
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL); CREATE TABLE t (id INTEGER PRIMARY KEY);');
    db.prepare("INSERT INTO schema_migrations VALUES ('001_t.sql', '2026-01-01T00:00:00.000Z')").run();
    expect(migrationDrift(db, dir).unrecorded).toEqual(['001_t.sql']);
    expect(migrate(db, dir).applied).toEqual(['002_u.sql']);
    expect(migrationDrift(db, dir)).toEqual({ edited: [], unknown: [], unrecorded: [] });
  });

  it('reports a migration file edited after it was applied', () => {
    const dir = tempMigrationsDir({ '001_t.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);' });
    const db = openDb(':memory:');
    migrate(db, dir);
    writeFileSync(join(dir, '001_t.sql'), 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);');
    expect(migrationDrift(db, dir)).toEqual({ edited: ['001_t.sql'], unknown: [], unrecorded: [] });
  });

  it('reports an applied migration that is missing from the directory', () => {
    const dir = tempMigrationsDir({
      '001_t.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);',
      '002_u.sql': 'CREATE TABLE u (id INTEGER PRIMARY KEY);',
    });
    const db = openDb(':memory:');
    migrate(db, dir);
    rmSync(join(dir, '002_u.sql'));
    expect(migrationDrift(db, dir)).toEqual({ edited: [], unknown: ['002_u.sql'], unrecorded: [] });
  });
});
