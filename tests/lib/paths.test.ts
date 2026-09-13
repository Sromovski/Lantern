import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findProjectRoot, resolvePaths } from '../../src/lib/paths.js';

describe('resolvePaths', () => {
  it('defaults everything under the given default root', () => {
    const defaultRoot = resolve('/work/lantern');
    expect(resolvePaths({}, defaultRoot)).toEqual({
      root: defaultRoot,
      db: join(defaultRoot, 'data', 'lantern.db'),
      logs: join(defaultRoot, 'logs'),
      migrations: join(defaultRoot, 'migrations'),
      cache: join(defaultRoot, 'data', 'cache'),
      media: join(defaultRoot, 'data', 'media'),
    });
  });

  it('honours overrides, resolving relative ones against LANTERN_ROOT rather than the default root', () => {
    const root = resolve('/srv/lantern');
    const defaultRoot = resolve('/elsewhere');
    const abs = resolve('/tmp/test.db');
    const p = resolvePaths({ LANTERN_ROOT: root, LANTERN_DB: abs, LANTERN_LOGS: 'var/logs' }, defaultRoot);
    expect(p.db).toBe(abs);
    expect(p.logs).toBe(join(root, 'var', 'logs'));
  });

  it('resolves cache and media overrides the same way as the database and logs', () => {
    const root = resolve('/srv/lantern');
    const media = resolve('/mnt/media');
    const p = resolvePaths({ LANTERN_ROOT: root, LANTERN_CACHE: 'fixtures', LANTERN_MEDIA: media }, resolve('/elsewhere'));
    expect(p.cache).toBe(join(root, 'fixtures'));
    expect(p.media).toBe(media);
  });
});

describe('findProjectRoot', () => {
  it('returns a directory containing package.json and migrations/', () => {
    const root = findProjectRoot();
    expect(existsSync(join(root, 'package.json'))).toBe(true);
    expect(existsSync(join(root, 'migrations'))).toBe(true);
  });

  it('finds the project root from a start path nested inside it', () => {
    const here = fileURLToPath(import.meta.url);
    expect(findProjectRoot(here)).toBe(findProjectRoot());
  });

  it('throws when no package.json exists above the start path', () => {
    const outer = mkdtempSync(join(tmpdir(), 'lantern-noroot-'));
    const nested = join(outer, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(() => findProjectRoot(join(nested, 'file.ts'))).toThrow(
      /could not locate the Lantern project root/,
    );
  });
});
