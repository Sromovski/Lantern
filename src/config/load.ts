import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import type { z } from 'zod';
import { channelSchema, verticalSchema, type ChannelConfig, type VerticalConfig } from './schema.js';

export interface LoadedVertical extends VerticalConfig { configPath: string }
export interface LoadedChannel extends ChannelConfig { slug: string; configPath: string }
export interface LanternConfig { verticals: LoadedVertical[]; channels: LoadedChannel[] }

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid config:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

interface Parsed<T> { value: T; configPath: string; name: string }

function readDir<S extends z.ZodType>(
  root: string,
  subdir: string,
  schema: S,
  issues: string[],
): Parsed<z.infer<S>>[] {
  const dir = join(root, 'config', subdir);
  if (!existsSync(dir)) {
    issues.push(`config/${subdir}: directory missing`);
    return [];
  }
  const out: Parsed<z.infer<S>>[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    const full = join(dir, file);
    const configPath = relative(root, full).split(sep).join('/');
    let raw: unknown;
    try {
      raw = parse(readFileSync(full, 'utf8'));
    } catch (err) {
      issues.push(`${configPath}: YAML parse error: ${(err as Error).message}`);
      continue;
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push(`${configPath}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      continue;
    }
    out.push({ value: result.data, configPath, name: basename(file, '.yaml') });
  }
  return out;
}

export function loadConfig(root: string): LanternConfig {
  const issues: string[] = [];
  const verticals = readDir(root, 'verticals', verticalSchema, issues);
  const channels = readDir(root, 'channels', channelSchema, issues);

  for (const v of verticals) {
    if (v.value.slug !== v.name) {
      issues.push(`${v.configPath}: slug "${v.value.slug}" does not match filename "${v.name}"`);
    }
  }

  const verticalSlugs = new Set(verticals.map((v) => v.value.slug));
  const destinations = new Set<string>();
  for (const c of channels) {
    if (!verticalSlugs.has(c.value.vertical)) {
      issues.push(`${c.configPath}: unknown vertical "${c.value.vertical}"`);
    }
    const key = `${c.value.vertical}/${c.value.platform}/${c.value.account_ref}`;
    if (destinations.has(key)) issues.push(`${c.configPath}: duplicate destination ${key}`);
    destinations.add(key);
  }

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    verticals: verticals.map((v) => ({ ...v.value, configPath: v.configPath })),
    channels: channels.map((c) => ({ ...c.value, slug: c.name, configPath: c.configPath })),
  };
}
