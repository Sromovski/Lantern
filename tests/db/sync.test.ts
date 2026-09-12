import { describe, it, expect } from 'vitest';
import type { LanternConfig, LoadedChannel, LoadedVertical } from '../../src/config/load.js';
import { syncConfig, findChannelId } from '../../src/db/sync.js';
import { testDb } from '../helpers/db.js';

const vertical = (slug: string): LoadedVertical => ({
  slug,
  name: slug.toUpperCase(),
  kid_safe: false,
  audience: {},
  voice: 'v',
  post_shape: { hook: 'h', body: 'b', closer: 'c' },
  banned_topics: [],
  image: { style: 's', generated_disclosure: true },
  configPath: `config/verticals/${slug}.yaml`,
});

const channel = (slug: string, verticalSlug: string, accountRef: string): LoadedChannel => ({
  slug,
  vertical: verticalSlug,
  platform: 'facebook',
  account_ref: accountRef,
  formats: ['square'],
  cadence: { posts_per_day: 1, times: ['09:00'] },
  caption: { text_max: 2000 },
  configPath: `config/channels/${slug}.yaml`,
});

const base = (): LanternConfig => ({
  verticals: [vertical('literature')],
  channels: [channel('literature-facebook', 'literature', 'FB_PAGE_ID_COMMONPLACE')],
});

describe('syncConfig', () => {
  it('inserts verticals and channels with auto_publish off', () => {
    const db = testDb();
    const counts = syncConfig(db, base());
    expect(counts.verticals).toEqual({ inserted: 1, updated: 0, deactivated: 0 });
    expect(counts.channels).toEqual({ inserted: 1, updated: 0, deactivated: 0 });
    expect(db.prepare('SELECT auto_publish, enabled FROM channels').get()).toEqual({ auto_publish: 0, enabled: 1 });
  });

  it('is idempotent', () => {
    const db = testDb();
    syncConfig(db, base());
    const counts = syncConfig(db, base());
    expect(counts.verticals.inserted + counts.channels.inserted).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM channels').pluck().get()).toBe(1);
  });

  it('never resets auto_publish that a human switched on', () => {
    const db = testDb();
    syncConfig(db, base());
    db.prepare('UPDATE channels SET auto_publish = 1').run();
    syncConfig(db, base());
    expect(db.prepare('SELECT auto_publish FROM channels').pluck().get()).toBe(1);
  });

  it('deactivates rather than deletes removed config', () => {
    const db = testDb();
    syncConfig(db, {
      verticals: [vertical('literature'), vertical('math')],
      channels: base().channels,
    });
    const counts = syncConfig(db, { verticals: [vertical('literature')], channels: [] });
    expect(counts.verticals.deactivated).toBe(1);
    expect(counts.channels.deactivated).toBe(1);
    expect(db.prepare("SELECT active FROM verticals WHERE slug = 'math'").pluck().get()).toBe(0);
    expect(db.prepare('SELECT enabled FROM channels').pluck().get()).toBe(0);
  });

  it('finds a synced channel id', () => {
    const db = testDb();
    const cfg = base();
    syncConfig(db, cfg);
    expect(findChannelId(db, cfg.channels[0]!)).toBeTypeOf('number');
    expect(findChannelId(db, channel('other', 'literature', 'NOPE'))).toBeUndefined();
  });
});
