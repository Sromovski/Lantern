import { isAbsolute, resolve } from 'node:path';

export interface Paths { root: string; db: string; logs: string; migrations: string }

export function resolvePaths(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): Paths {
  const root = resolve(env.LANTERN_ROOT ?? cwd);
  const under = (value: string) => (isAbsolute(value) ? value : resolve(root, value));
  return {
    root,
    db: under(env.LANTERN_DB ?? 'data/lantern.db'),
    logs: under(env.LANTERN_LOGS ?? 'logs'),
    migrations: resolve(root, 'migrations'),
  };
}
