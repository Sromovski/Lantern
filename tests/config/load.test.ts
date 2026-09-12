import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ConfigError } from '../../src/config/load.js';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const LITERATURE = `
slug: literature
name: The Commonplace Book
kid_safe: false
audience: {}
voice: Warm and precise.
post_shape: { hook: 1 sentence, body: 2-4 paragraphs, closer: 1 sentence }
image: { style: period portrait or title page, generated_disclosure: true }
`;

const FACEBOOK = `
vertical: literature
platform: facebook
account_ref: FB_PAGE_ID_COMMONPLACE
formats: [square]
cadence: { posts_per_day: 1, times: ["09:00"] }
caption: { text_max: 2000 }
`;

let root: string;

function write(files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
}

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error('expected ConfigError');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lantern-config-'));
});

describe('loadConfig', () => {
  it('loads a valid vertical and channel', () => {
    write({
      'config/verticals/literature.yaml': LITERATURE,
      'config/channels/literature-facebook.yaml': FACEBOOK,
    });
    const cfg = loadConfig(root);
    expect(cfg.verticals).toHaveLength(1);
    expect(cfg.verticals[0]).toMatchObject({
      slug: 'literature',
      configPath: 'config/verticals/literature.yaml',
      banned_topics: [],
    });
    expect(cfg.channels[0]).toMatchObject({
      slug: 'literature-facebook',
      platform: 'facebook',
      configPath: 'config/channels/literature-facebook.yaml',
    });
  });

  it('rejects unknown keys, including auto_publish', () => {
    write({
      'config/verticals/literature.yaml': LITERATURE,
      'config/channels/literature-facebook.yaml': FACEBOOK + 'auto_publish: true\n',
    });
    expect(issuesOf(() => loadConfig(root)).join('\n')).toMatch(/literature-facebook\.yaml.*auto_publish/);
  });

  it('rejects a channel pointing at an unknown vertical', () => {
    write({
      'config/verticals/literature.yaml': LITERATURE,
      'config/channels/literature-facebook.yaml': FACEBOOK.replace('vertical: literature', 'vertical: poetry'),
    });
    expect(issuesOf(() => loadConfig(root)).join('\n')).toMatch(/unknown vertical "poetry"/);
  });

  it('requires reading level and banned topics for kid-safe verticals', () => {
    write({ 'config/verticals/literature.yaml': LITERATURE.replace('kid_safe: false', 'kid_safe: true') });
    expect(issuesOf(() => loadConfig(root)).join('\n')).toMatch(/kid_safe verticals require/);
  });

  it('requires cadence times to match posts_per_day', () => {
    write({
      'config/verticals/literature.yaml': LITERATURE,
      'config/channels/literature-facebook.yaml': FACEBOOK.replace('posts_per_day: 1', 'posts_per_day: 2'),
    });
    expect(issuesOf(() => loadConfig(root)).join('\n')).toMatch(/cadence\.times/);
  });

  it('requires youtube channels to set made_for_kids explicitly', () => {
    write({
      'config/verticals/literature.yaml': LITERATURE,
      'config/channels/literature-youtube.yaml': FACEBOOK.replace('platform: facebook', 'platform: youtube').replace('[square]', '[short]'),
    });
    expect(issuesOf(() => loadConfig(root)).join('\n')).toMatch(/made_for_kids/);
  });

  it('requires the vertical slug to match its filename', () => {
    write({ 'config/verticals/lit.yaml': LITERATURE });
    expect(issuesOf(() => loadConfig(root)).join('\n')).toMatch(/slug "literature" does not match filename "lit"/);
  });

  it('reports every problem at once', () => {
    write({
      'config/verticals/lit.yaml': LITERATURE,
      'config/channels/x.yaml': 'platform: myspace\n',
    });
    expect(issuesOf(() => loadConfig(root)).length).toBeGreaterThan(1);
  });

  it('accepts the committed repository config', () => {
    const cfg = loadConfig(PROJECT_ROOT);
    expect(cfg.verticals.map((v) => v.slug).sort()).toEqual(['literature', 'science-curious']);
    expect(cfg.channels.map((c) => c.slug).sort()).toEqual([
      'literature-facebook', 'literature-pinterest', 'science-youtube',
    ]);
  });
});
