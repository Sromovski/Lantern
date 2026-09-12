import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/connection.js';
import { migrate, pendingMigrations, MIGRATIONS_DIR } from '../../src/db/migrate.js';
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
});
