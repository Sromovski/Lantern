import { statfsSync } from 'node:fs';
import { ConfigError, loadConfig, type LanternConfig, type LoadedChannel } from '../config/load.js';
import type { Db } from '../db/connection.js';
import { expectedTriggers, migrationDrift, pendingMigrations } from '../db/migrate.js';
import { findChannelId } from '../db/sync.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface CheckResult { name: string; status: CheckStatus; detail: string }

export interface DoctorContext {
  db: Db;
  root: string;
  migrationsDir: string;
  env: Record<string, string | undefined>;
  now: Date;
  freeBytes?: (path: string) => number;
}

const BUFFER_DAYS = 30;
const SILENCE_HOURS = 48;
const MIN_FREE_BYTES = 1024 ** 3;

const result = (name: string, status: CheckStatus, detail: string): CheckResult => ({ name, status, detail });

function defaultFreeBytes(path: string): number {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
}

function channelChecks(ctx: DoctorContext, channel: LoadedChannel, id: number): CheckResult[] {
  const { db, env, now } = ctx;
  const prefix = `channel.${channel.slug}`;
  const out: CheckResult[] = [];

  out.push(
    env[channel.account_ref]
      ? result(`${prefix}.account_ref`, 'ok', `${channel.account_ref} is set`)
      : result(`${prefix}.account_ref`, 'warn', `${channel.account_ref} is not set in the environment`),
  );

  const row = db.prepare('SELECT enabled, auto_publish FROM channels WHERE id = ?').get(id) as {
    enabled: number;
    auto_publish: number;
  };
  const live = row.enabled === 1 && row.auto_publish === 1;

  const scheduled = db
    .prepare("SELECT COUNT(*) FROM publications WHERE channel_id = ? AND status = 'scheduled' AND scheduled_for >= ?")
    .pluck()
    .get(id, now.toISOString()) as number;
  const days = scheduled / channel.cadence.posts_per_day;
  const bufferDetail = `${scheduled} scheduled ≈ ${days.toFixed(1)} days`;
  if (!live) out.push(result(`${prefix}.buffer`, 'ok', `not live (auto_publish off); ${bufferDetail}`));
  else if (days < BUFFER_DAYS) out.push(result(`${prefix}.buffer`, 'warn', `${bufferDetail}; minimum is ${BUFFER_DAYS}`));
  else out.push(result(`${prefix}.buffer`, 'ok', bufferDetail));

  const last = db
    .prepare("SELECT MAX(published_at) FROM publications WHERE channel_id = ? AND status = 'published'")
    .pluck()
    .get(id) as string | null;
  const hoursSince = last ? (now.getTime() - Date.parse(last)) / 3_600_000 : Infinity;
  const lastDetail = last ? `last published ${last}` : 'never published';
  out.push(
    live && hoursSince > SILENCE_HOURS
      ? result(`${prefix}.last_publish`, 'warn', `${lastDetail}; live channel silent > ${SILENCE_HOURS}h`)
      : result(`${prefix}.last_publish`, 'ok', lastDetail),
  );

  return out;
}

export function runChecks(ctx: DoctorContext): CheckResult[] {
  const { db } = ctx;
  const out: CheckResult[] = [];

  const integrity = db.pragma('integrity_check', { simple: true });
  out.push(result('db.integrity', integrity === 'ok' ? 'ok' : 'fail', String(integrity)));

  let pending: string[] | undefined;
  try {
    pending = pendingMigrations(db, ctx.migrationsDir);
    out.push(
      pending.length === 0
        ? result('db.migrations', 'ok', 'up to date')
        : result('db.migrations', 'fail', `pending: ${pending.join(', ')} — run \`lantern migrate\``),
    );
  } catch (err) {
    out.push(result('db.migrations', 'fail', err instanceof Error ? err.message : String(err)));
  }

  if (pending !== undefined && pending.length === 0) {
    const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").pluck().all() as string[]);
    const missing = expectedTriggers(db, ctx.migrationsDir).filter((name) => !present.has(name));
    out.push(
      missing.length === 0
        ? result('db.triggers', 'ok', `${present.size} triggers present`)
        : result('db.triggers', 'fail', `missing guard triggers: ${missing.join(', ')}; the schema was changed outside lantern migrate`),
    );
  }

  if (pending !== undefined) {
    const drift = migrationDrift(db, ctx.migrationsDir);
    if (drift.edited.length > 0 || drift.unknown.length > 0) {
      const parts = [
        ...(drift.edited.length > 0 ? [`edited after being applied: ${drift.edited.join(', ')}`] : []),
        ...(drift.unknown.length > 0 ? [`applied but not in migrations/: ${drift.unknown.join(', ')}`] : []),
      ];
      out.push(result('db.drift', 'fail', parts.join('; ')));
    } else if (drift.unrecorded.length > 0) {
      out.push(result('db.drift', 'warn', `no checksum recorded for ${drift.unrecorded.join(', ')}; run lantern migrate to record them`));
    } else {
      out.push(result('db.drift', 'ok', 'applied migrations match their files'));
    }
  }

  let config: LanternConfig | undefined;
  try {
    config = loadConfig(ctx.root);
    out.push(result('config.valid', 'ok', `${config.verticals.length} verticals, ${config.channels.length} channels`));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    out.push(result('config.valid', 'fail', err.issues.join('; ')));
  }

  if (config && pending !== undefined && pending.length === 0) {
    const ids = new Map<LoadedChannel, number>();
    const missing: string[] = [];
    for (const channel of config.channels) {
      const id = findChannelId(db, channel);
      const enabled = id !== undefined && db.prepare('SELECT enabled FROM channels WHERE id = ?').pluck().get(id) === 1;
      if (id === undefined || !enabled) missing.push(channel.slug);
      else ids.set(channel, id);
    }
    out.push(
      missing.length === 0
        ? result('config.synced', 'ok', 'all channels present in database')
        : result('config.synced', 'fail', `not in database: ${missing.join(', ')} — run \`lantern migrate\``),
    );
    for (const [channel, id] of ids) out.push(...channelChecks(ctx, channel, id));
  }

  const free = (ctx.freeBytes ?? defaultFreeBytes)(ctx.root);
  const freeDetail = `${(free / 1024 ** 2).toFixed(0)} MiB free`;
  out.push(result('disk.free', free < MIN_FREE_BYTES ? 'warn' : 'ok', freeDetail));

  return out;
}
