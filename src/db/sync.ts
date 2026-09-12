import type { LanternConfig, LoadedChannel } from '../config/load.js';
import type { Db } from './connection.js';

export interface SyncCounts { inserted: number; updated: number; deactivated: number }

export function findChannelId(db: Db, channel: LoadedChannel): number | undefined {
  return db
    .prepare(
      `SELECT c.id FROM channels c JOIN verticals v ON v.id = c.vertical_id
       WHERE v.slug = ? AND c.platform = ? AND c.account_ref = ?`,
    )
    .pluck()
    .get(channel.vertical, channel.platform, channel.account_ref) as number | undefined;
}

export function syncConfig(db: Db, config: LanternConfig): { verticals: SyncCounts; channels: SyncCounts } {
  return db.transaction(() => {
    const verticals: SyncCounts = { inserted: 0, updated: 0, deactivated: 0 };
    const channels: SyncCounts = { inserted: 0, updated: 0, deactivated: 0 };

    const verticalId = db.prepare('SELECT id FROM verticals WHERE slug = ?').pluck();
    const upsertVertical = db.prepare(
      `INSERT INTO verticals (slug, name, config_path, active) VALUES (?, ?, ?, 1)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name, config_path = excluded.config_path, active = 1`,
    );
    for (const v of config.verticals) {
      const existed = verticalId.get(v.slug) !== undefined;
      upsertVertical.run(v.slug, v.name, v.configPath);
      existed ? verticals.updated++ : verticals.inserted++;
    }
    verticals.deactivated = db
      .prepare('UPDATE verticals SET active = 0 WHERE active = 1 AND slug NOT IN (SELECT value FROM json_each(?))')
      .run(JSON.stringify(config.verticals.map((v) => v.slug))).changes;

    // auto_publish is deliberately absent from both the INSERT and the UPDATE.
    const upsertChannel = db.prepare(
      `INSERT INTO channels (vertical_id, platform, handle, account_ref, config_path, enabled)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(vertical_id, platform, account_ref)
       DO UPDATE SET handle = excluded.handle, config_path = excluded.config_path, enabled = 1`,
    );
    const keptIds: number[] = [];
    for (const c of config.channels) {
      const existing = findChannelId(db, c);
      upsertChannel.run(verticalId.get(c.vertical), c.platform, c.handle ?? null, c.account_ref, c.configPath);
      existing === undefined ? channels.inserted++ : channels.updated++;
      keptIds.push(findChannelId(db, c)!);
    }
    channels.deactivated = db
      .prepare('UPDATE channels SET enabled = 0 WHERE enabled = 1 AND id NOT IN (SELECT value FROM json_each(?))')
      .run(JSON.stringify(keptIds)).changes;

    return { verticals, channels };
  })();
}
