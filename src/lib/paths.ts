import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Paths { root: string; db: string; logs: string; migrations: string }

export function findProjectRoot(start: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(resolve(start));
  for (;;) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate the Lantern project root (no package.json above ${start})`);
    }
    dir = parent;
  }
}

export function resolvePaths(
  env: Record<string, string | undefined> = process.env,
  defaultRoot: string = findProjectRoot(),
): Paths {
  const root = resolve(env.LANTERN_ROOT ?? defaultRoot);
  const under = (value: string) => (isAbsolute(value) ? value : resolve(root, value));
  return {
    root,
    db: under(env.LANTERN_DB ?? 'data/lantern.db'),
    logs: under(env.LANTERN_LOGS ?? 'logs'),
    migrations: resolve(root, 'migrations'),
  };
}
