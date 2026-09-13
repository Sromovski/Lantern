# Lantern Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Lantern — a pipeline that harvests, verifies, enriches, renders, and publishes short educational posts to social channels on a schedule, failing closed at every uncertain step.

**Architecture:** A Node/TypeScript CLI where every pipeline stage is an idempotent subcommand and all state lives in a single SQLite file between stages. A verified *item* is the unit of truth; posts, renditions, captions, and publications fan out from it (spec §5). Swappable content verticals on the front (YAML config + harvester), platform adapters behind one `Publisher` interface on the back.

**Tech Stack:** Node.js (ESM) + TypeScript (strict), `better-sqlite3`, plain numbered SQL migrations, `commander`, `zod` + `yaml` for config, `dotenv`, `vitest`, later `@anthropic-ai/sdk`, `sharp`, Remotion.

**Spec:** `claude.md` (project root). Read it before any task. When a decision in this plan turns out wrong once real data flows, update `claude.md` **and** this file in the same commit as the code (spec §15).

## How this plan is organized

The spec describes ten phases spanning several independent subsystems and five external platforms. Writing step-level code for all of them now would mean guessing at API response shapes, which the spec explicitly forbids ("fetch one real response and look at it before writing the parser", §15). So this plan has three levels of detail:

| Part | Scope | Detail level |
|---|---|---|
| **Part A** | Phase 1 — the spine | Full bite-sized TDD tasks with code. Execute directly. |
| **Part B** | Phase 2 — verification core (pure logic) | Full bite-sized TDD tasks with code. Execute directly. Spec §15: "Verification code gets tests first." |
| **Part C** | Phase 2 remainder + Phases 3–10 | Milestones: scope, files, acceptance criteria, prerequisites. Each milestone gets its own detailed plan (`docs/plans/phase-N-*.md`) written **after** real API responses have been fetched and cached into `data/cache/`. |

Do not start a Part C milestone without writing its detailed plan first.

## Global Constraints

Copied from the spec; every task implicitly includes these.

- Node.js + TypeScript, **ESM**, **strict mode on**. Relative imports use `.js` extensions.
- SQLite via `better-sqlite3`, single file at `data/lantern.db`. No ORM. Migrations are plain numbered `.sql` files in `migrations/`.
- Secrets in `.env` only. **Never commit** `.env`, `data/lantern.db`, or anything under `data/media/`.
- Config: `config/verticals/*.yaml` for verticals, `config/channels/*.yaml` for destinations.
- Logging: structured JSON lines to `logs/`. Every stage writes a `run_log` row on entry and exit. Every publish writes an audit row.
- Tests with `vitest`. Verification logic gets tests **first**. Source-API tests use real cached responses from `data/cache/`, not hand-written mocks.
- **Fail closed:** any uncertainty → `needs_review` (posts) or `rejected` (items), never the platform.
- **Never publish an unverified quote. No invented facts. Images legally clear** (`public-domain` | `cc0` | `cc-by` | `generated`), license + source URL stored per image.
- Quote aggregator sites (BrainyQuote, Goodreads quotes, AZQuotes and friends) **may not appear in `sources` at all**.
- **Never AI-generate a portrait of a real person.** Always disclose AI-generated images in the caption.
- **Platform adapters never generate content.** They select and format only.
- `auto_publish` is per **channel**, defaults to `0`, and is only switched on after ~20 posts on that channel have been eyeballed.
- `UNIQUE(post_id, channel_id)` on `publications` is never removed or weakened.
- Claude prompts live in version-controlled files, never as string literals in TypeScript.
- Prefer system cron (on this Windows machine: **Task Scheduler** calling the CLI) over an in-process daemon.

## Environment notes (checked 2026-09-12)

- Local toolchain: Node v26.0.0, npm 11.12.1, git 2.54.0. The project directory is **not yet a git repository** — Task A1 initializes it.
- Latest published versions at planning time: `typescript` 7.0.2, `tsx` 4.23.13, `vitest` 5.0.0, `better-sqlite3` 13.0.3, `@types/better-sqlite3` 9.6.0, `commander` 15.0.0, `zod` 4.6.2, `yaml` 2.9.1, `dotenv` 17.4.2, `sharp` 0.35.4, `@anthropic-ai/sdk` 0.125.0.
- **Risk:** `better-sqlite3` is a native module. If `npm install` fails to find a prebuilt binary for Node 26 on Windows, install Node 24 LTS via nvm-windows rather than fighting a local C++ toolchain. Record the Node version that works in `package.json` `engines`.
- **Risk:** TypeScript 7 is the native-compiler line. If `npx tsc --noEmit` misbehaves with any dependency's types, pin `typescript@~5.9` and note it in `claude.md` §4.

---

## Part A — Phase 1: The Spine

*Done when (spec §14):* migrations run clean and `lantern doctor` reports a healthy empty system.

### File map for Part A

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, .env.example
migrations/001_initial.sql         # full schema + indexes from spec §6
src/cli.ts                          # commander entry: migrate, doctor
src/lib/paths.ts                    # project root, db path, logs dir
src/lib/log.ts                      # JSON-lines logger
src/lib/run-stage.ts                # run_log entry/exit wrapper
src/db/connection.ts                # openDb() with pragmas
src/db/migrate.ts                   # migration runner
src/db/sync.ts                      # upsert verticals/channels from config
src/config/schema.ts                # zod schemas for vertical + channel YAML
src/config/load.ts                  # read + validate config/ tree
src/doctor/checks.ts                # individual health checks
src/doctor/report.ts                # format + exit code
config/verticals/literature.yaml
config/verticals/science-curious.yaml
config/channels/literature-facebook.yaml
config/channels/literature-pinterest.yaml
config/channels/science-youtube.yaml
tests/helpers/db.ts                 # in-memory migrated DB + seed helpers
tests/db/migrate.test.ts
tests/db/sync.test.ts
tests/config/load.test.ts
tests/lib/log.test.ts
tests/lib/run-stage.test.ts
tests/doctor/checks.test.ts
```

`src/doctor/` is not in the spec's §4 layout; add it to the layout in `claude.md` in Task A6's commit.

### Task A1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Test: `tests/smoke.test.ts` (deleted at the end of the task)

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test`, `npm run typecheck`, `npm run lantern -- <cmd>` scripts used by every later task.

- [ ] **Step 1: Initialize git and npm**

```bash
cd /c/Projects/Lantern
git init
npm init -y
npm install better-sqlite3 commander zod yaml dotenv
npm install -D typescript tsx vitest @types/node @types/better-sqlite3
```

Expected: install succeeds. If `better-sqlite3` fails to build, see "Environment notes" above.

- [ ] **Step 2: Write `package.json` fields** (keep the dependency versions npm wrote)

```json
{
  "name": "lantern",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "bin": { "lantern": "./dist/src/cli.js" },
  "scripts": {
    "lantern": "tsx src/cli.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "build": "tsc"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "sourceMap": true
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 5: Write `.gitignore` and `.env.example`**

`.gitignore`:
```
node_modules/
dist/
.env
data/lantern.db
data/lantern.db-*
data/media/
logs/
```

`data/cache/` is intentionally **not** ignored: cached real API responses are test fixtures (spec §15). Revisit if it grows past a few MB.

`.env.example`:
```
# Copy to .env. Values are secrets; names are referenced by channels.account_ref.
LANTERN_DB=data/lantern.db
ANTHROPIC_API_KEY=
FB_PAGE_ID_COMMONPLACE=
PINTEREST_BOARD_ID_COMMONPLACE=
YT_CHANNEL_ID_LOOK_CLOSER=
```

- [ ] **Step 6: Write a smoke test and run the toolchain**

`tests/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

describe('toolchain', () => {
  it('loads better-sqlite3 natively', () => {
    const db = new Database(':memory:');
    expect(db.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
  });
});
```

Run: `npm test && npm run typecheck`
Expected: 1 test passes, typecheck exits 0.

- [ ] **Step 7: Delete the smoke test and commit**

```bash
rm tests/smoke.test.ts
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example claude.md plan.md
git commit -m "chore: scaffold TypeScript ESM project with vitest and better-sqlite3"
```

---

### Task A2: Database connection, schema migration, migration runner

**Files:**
- Create: `src/db/connection.ts`, `src/db/migrate.ts`, `migrations/001_initial.sql`, `tests/helpers/db.ts`
- Test: `tests/db/migrate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Db = Database.Database`
  - `openDb(path: string): Db` — enables `foreign_keys`; creates the parent dir for file paths.
  - `migrate(db: Db, dir: string): { applied: string[]; current: string | null }`
  - `pendingMigrations(db: Db, dir: string): string[]`
  - `MIGRATIONS_DIR: string` (absolute path, exported from `src/db/migrate.ts`)
  - Test helpers: `testDb(): Db`, `seedPublicationChain(db: Db): { verticalId; channelId; itemId; postId; renditionId; captionId }` (all `number`)

Journal mode stays SQLite's default rollback journal, **not WAL**: the spec's backup story is "copy the file", and WAL splits state across `-wal`/`-shm` files. A single cron-driven writer does not need WAL's concurrency.

- [ ] **Step 1: Write `migrations/001_initial.sql`**

Copy the full `CREATE TABLE` block from spec §6 verbatim (verticals, channels, subjects, items, sources, images, posts, renditions, captions, publications, run_log), then append:

```sql
CREATE INDEX idx_items_status_vertical      ON items(status, vertical_id);
CREATE INDEX idx_items_body_hash            ON items(body_hash);
CREATE INDEX idx_posts_status_vertical      ON posts(status, vertical_id);
CREATE INDEX idx_renditions_post_status     ON renditions(post_id, status);
CREATE INDEX idx_publications_status_sched  ON publications(status, scheduled_for);
CREATE INDEX idx_publications_channel_pub   ON publications(channel_id, published_at);
CREATE INDEX idx_run_log_stage_created      ON run_log(stage, created_at);
```

The last index is not in the spec (`doctor` queries `run_log` by stage and time) — add it to `claude.md` §6 in this commit.

- [ ] **Step 2: Write `src/db/connection.ts`**

```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  return db;
}
```

- [ ] **Step 3: Write `tests/helpers/db.ts`**

```ts
import { openDb, type Db } from '../../src/db/connection.js';
import { migrate, MIGRATIONS_DIR } from '../../src/db/migrate.js';

export function testDb(): Db {
  const db = openDb(':memory:');
  migrate(db, MIGRATIONS_DIR);
  return db;
}

const NOW = '2026-01-01T00:00:00.000Z';

export function seedPublicationChain(db: Db) {
  const id = (sql: string, ...params: unknown[]) =>
    Number(db.prepare(sql).run(...params).lastInsertRowid);

  const verticalId = id(
    "INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'The Commonplace Book', 'config/verticals/literature.yaml')",
  );
  const channelId = id(
    "INSERT INTO channels (vertical_id, platform, account_ref, config_path) VALUES (?, 'facebook', 'FB_PAGE_ID_COMMONPLACE', 'config/channels/literature-facebook.yaml')",
    verticalId,
  );
  const itemId = id(
    "INSERT INTO items (vertical_id, kind, body, body_hash, status, created_at) VALUES (?, 'quote', 'It was the best of times', 'hash-1', 'raw', ?)",
    verticalId, NOW,
  );
  const postId = id(
    "INSERT INTO posts (item_id, vertical_id, hook, body, alt_text, status, created_at) VALUES (?, ?, 'hook', 'body', 'alt', 'draft', ?)",
    itemId, verticalId, NOW,
  );
  const renditionId = id(
    "INSERT INTO renditions (post_id, format, media_type, aspect, width, height, local_path, status, created_at) VALUES (?, 'square', 'image', '1:1', 1200, 1200, 'x.png', 'ready', ?)",
    postId, NOW,
  );
  const captionId = id(
    "INSERT INTO captions (post_id, platform, text, char_count, created_at) VALUES (?, 'facebook', 'caption', 7, ?)",
    postId, NOW,
  );
  return { verticalId, channelId, itemId, postId, renditionId, captionId };
}
```

- [ ] **Step 4: Write the failing tests** — `tests/db/migrate.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/connection.js';
import { migrate, pendingMigrations, MIGRATIONS_DIR } from '../../src/db/migrate.js';
import { testDb, seedPublicationChain } from '../helpers/db.js';

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
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run tests/db/migrate.test.ts`
Expected: FAIL — cannot resolve `../../src/db/migrate.js`.

- [ ] **Step 6: Write `src/db/migrate.ts`**

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './connection.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;

function ensureTable(db: Db): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
}

function migrationFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => MIGRATION_FILE.test(f)).sort();
}

export function pendingMigrations(db: Db, dir: string): string[] {
  ensureTable(db);
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all() as string[]);
  return migrationFiles(dir).filter((f) => !done.has(f));
}

export function migrate(db: Db, dir: string): { applied: string[]; current: string | null } {
  const pending = pendingMigrations(db, dir);
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  for (const file of pending) {
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    })();
  }
  return { applied: pending, current: migrationFiles(dir).at(-1) ?? null };
}
```

Note: `MIGRATIONS_DIR` resolves relative to `src/db/` under `tsx`. When running compiled output from `dist/src/db/`, `../../migrations` points at `dist/migrations` — Task A6 handles this by resolving from the project root in `src/lib/paths.ts` and passing the dir explicitly from the CLI.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/db/migrate.test.ts && npm run typecheck`
Expected: 4 tests PASS, typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add migrations/ src/db/ tests/db/ tests/helpers/ claude.md
git commit -m "feat(db): initial schema migration and runner"
```

---

### Task A3: Config schemas, loader, and the initial YAML files

**Files:**
- Create: `src/config/schema.ts`, `src/config/load.ts`
- Create: `config/verticals/literature.yaml`, `config/verticals/science-curious.yaml`, `config/channels/literature-facebook.yaml`, `config/channels/literature-pinterest.yaml`, `config/channels/science-youtube.yaml`
- Test: `tests/config/load.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PLATFORMS`, `RENDITION_FORMATS` (readonly tuples), `type Platform`, `type RenditionFormat`
  - `verticalSchema`, `channelSchema` (zod), `type VerticalConfig`, `type ChannelConfig`
  - `interface LoadedVertical extends VerticalConfig { configPath: string }`
  - `interface LoadedChannel extends ChannelConfig { slug: string; configPath: string }`
  - `interface LanternConfig { verticals: LoadedVertical[]; channels: LoadedChannel[] }`
  - `class ConfigError extends Error { issues: string[] }`
  - `loadConfig(root: string): LanternConfig` — throws `ConfigError` listing **every** problem, not just the first.

Design decisions baked in here:
- Schemas are **strict**: an unknown key is an error, not silently ignored. A typo in a safety setting must fail loudly (fail closed).
- `auto_publish` is **not** a YAML key. The DB column is the source of truth, it defaults to 0, and it is flipped on only by an explicit CLI command in Phase 5 after the ~20-post review. Putting it in YAML would let a config edit bypass the per-channel human gate.
- `kid_safe: true` verticals must declare `audience.reading_level` and at least one `banned_topics` entry.
- `image.generated_disclosure` must be literally `true` (spec §9).
- YouTube channels must set `made_for_kids` explicitly — spec §11 says make that call consciously.
- A channel's `cadence.times` must have exactly `posts_per_day` entries, and `posts_per_day` is 1 or 2 (spec §12).

- [ ] **Step 1: Write the failing tests** — `tests/config/load.test.ts`

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config/load.test.ts`
Expected: FAIL — cannot resolve `../../src/config/load.js`.

- [ ] **Step 3: Write `src/config/schema.ts`**

```ts
import { z } from 'zod';

export const PLATFORMS = ['facebook', 'pinterest', 'youtube', 'instagram', 'tiktok'] as const;
export const RENDITION_FORMATS = ['square', 'portrait', 'pin', 'short', 'landscape'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type RenditionFormat = (typeof RENDITION_FORMATS)[number];

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24h)');

export const verticalSchema = z
  .strictObject({
    slug,
    name: z.string().min(1),
    kid_safe: z.boolean(),
    audience: z.strictObject({
      reading_level: z.string().regex(/^grade-\d{1,2}$/).optional(),
      age_range: z.tuple([z.number().int(), z.number().int()]).optional(),
    }),
    voice: z.string().min(1),
    post_shape: z.strictObject({ hook: z.string(), body: z.string(), closer: z.string() }),
    banned_topics: z.array(z.string().min(1)).default([]),
    image: z.strictObject({
      style: z.string().min(1),
      generated_disclosure: z.literal(true),
    }),
  })
  .superRefine((v, ctx) => {
    if (v.kid_safe && (!v.audience.reading_level || v.banned_topics.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['kid_safe'],
        message: 'kid_safe verticals require audience.reading_level and at least one banned_topics entry',
      });
    }
  });

export const channelSchema = z
  .strictObject({
    vertical: slug,
    platform: z.enum(PLATFORMS),
    handle: z.string().min(1).optional(),
    account_ref: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an env var NAME, not a value'),
    formats: z.array(z.enum(RENDITION_FORMATS)).min(1),
    cadence: z.strictObject({
      posts_per_day: z.number().int().min(1).max(2),
      times: z.array(hhmm).min(1),
    }),
    made_for_kids: z.boolean().optional(),
    caption: z.strictObject({
      title_max: z.number().int().positive().optional(),
      text_max: z.number().int().positive(),
    }),
  })
  .superRefine((c, ctx) => {
    if (c.cadence.times.length !== c.cadence.posts_per_day) {
      ctx.addIssue({
        code: 'custom',
        path: ['cadence', 'times'],
        message: `must list exactly posts_per_day (${c.cadence.posts_per_day}) times`,
      });
    }
    if (c.platform === 'youtube' && c.made_for_kids === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['made_for_kids'],
        message: 'youtube channels must set made_for_kids explicitly (spec §11)',
      });
    }
  });

export type VerticalConfig = z.infer<typeof verticalSchema>;
export type ChannelConfig = z.infer<typeof channelSchema>;
```

- [ ] **Step 4: Write `src/config/load.ts`**

```ts
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
```

- [ ] **Step 5: Write the committed YAML files**

`config/verticals/literature.yaml`:
```yaml
slug: literature
name: The Commonplace Book          # working name — see spec §3 / §16
kid_safe: false
audience: {}
voice: |
  Warm, precise, quietly enthusiastic — a well-read friend, not a lecturer.
  Say who wrote it, what was happening in their life and the world when they
  did, and what the line actually means. Every claim traces to a stored source.
  Never: inspirational-poster tone, invented anecdotes, "timeless wisdom" filler.
post_shape:
  hook: 1 sentence
  body: 2-4 short paragraphs
  closer: 1 sentence pointing back to the work itself
banned_topics: []
image:
  style: public-domain author portrait, title page, manuscript page, or period image of the setting
  generated_disclosure: true
```

`config/verticals/science-curious.yaml` — the spec §9 example, plus `kid_safe`:
```yaml
slug: science-curious
name: Look Closer                    # working name — see spec §3 / §16
kid_safe: true
audience:
  reading_level: grade-5
  age_range: [8, 13]
voice: |
  Curious, plain, never condescending. Short sentences. One idea per post.
  Explain the mechanism, not just the name of the thing. End with a question
  that makes a kid want to go look at something in the real world.
  Never: "Did you know?!", exclamation stacks, emoji walls, clickbait.
post_shape:
  hook: 1 sentence
  body: 3-5 short paragraphs
  closer: 1 question
banned_topics:
  - graphic injury or death
  - weapons and explosives beyond textbook chemistry
  - anything requiring a safety warning to try at home
  - politics, religion, current events
image:
  style: bright, clear, single-subject, no text in the generated image
  generated_disclosure: true
```

`config/channels/literature-facebook.yaml`:
```yaml
vertical: literature
platform: facebook
account_ref: FB_PAGE_ID_COMMONPLACE
formats: [square]
cadence:
  posts_per_day: 1
  times: ["09:00"]            # local time; tune once real engagement data exists
caption:
  text_max: 2000              # editorial cap, well under Facebook's hard limit — confirm at build time
```

`config/channels/literature-pinterest.yaml`:
```yaml
vertical: literature
platform: pinterest
account_ref: PINTEREST_BOARD_ID_COMMONPLACE
formats: [pin]
cadence:
  posts_per_day: 1
  times: ["20:00"]
caption:
  title_max: 100              # confirm against Pinterest API v5 docs at build time (Phase 6)
  text_max: 800
```

`config/channels/science-youtube.yaml` — the spec §9 example verbatim:
```yaml
vertical: science-curious
platform: youtube
account_ref: YT_CHANNEL_ID_LOOK_CLOSER
formats: [short]
cadence:
  posts_per_day: 1
  times: ["16:30"]            # after school, local time
made_for_kids: false          # family-friendly, not COPPA-designated — see §3
caption:
  title_max: 100
  text_max: 5000
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/config/load.test.ts && npm run typecheck`
Expected: 9 tests PASS, typecheck exits 0.

- [ ] **Step 7: Update the spec and commit**

In `claude.md` §9, add `kid_safe: true` to the vertical YAML example and a one-line note that `auto_publish` lives only in the DB, never in channel YAML.

```bash
git add src/config/ config/ tests/config/ claude.md
git commit -m "feat(config): strict vertical/channel schemas and loader"
```

---

### Task A4: JSON-lines logger and `run_log` stage wrapper

**Files:**
- Create: `src/lib/log.ts`, `src/lib/run-stage.ts`
- Test: `tests/lib/log.test.ts`, `tests/lib/run-stage.test.ts`

**Interfaces:**
- Consumes: `Db` from `src/db/connection.ts`; `testDb()` from `tests/helpers/db.ts`.
- Produces:
  - `type LogLevel = 'debug' | 'info' | 'warn' | 'error'`
  - `interface Logger { debug; info; warn; error: (msg: string, fields?: Record<string, unknown>) => void; child(fields: Record<string, unknown>): Logger }`
  - `createLogger(opts: { dir: string; now?: () => Date; echo?: (line: string) => void }): Logger` — appends to `<dir>/lantern-YYYY-MM-DD.jsonl` (UTC date).
  - `interface StageContext { stage: string; verticalId?: number | null; channelId?: number | null }`
  - `runStage<T>(db: Db, ctx: StageContext, fn: () => T | Promise<T>, now?: () => Date): Promise<T>` — writes a `run_log` row on entry and on exit (spec §7); on throw writes `ok = 0` with the message and rethrows.

- [ ] **Step 1: Write the failing logger tests** — `tests/lib/log.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../src/lib/log.js';

let dir: string;
const now = () => new Date('2026-03-04T05:06:07.000Z');
const lines = () =>
  readFileSync(join(dir, 'lantern-2026-03-04.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lantern-log-'));
});

describe('createLogger', () => {
  it('appends one JSON object per line to a dated file', () => {
    const log = createLogger({ dir, now });
    log.info('harvest started', { vertical: 'literature' });
    log.warn('slow response', { ms: 5200 });
    expect(lines()).toEqual([
      { ts: '2026-03-04T05:06:07.000Z', level: 'info', msg: 'harvest started', vertical: 'literature' },
      { ts: '2026-03-04T05:06:07.000Z', level: 'warn', msg: 'slow response', ms: 5200 },
    ]);
  });

  it('merges child fields', () => {
    createLogger({ dir, now }).child({ stage: 'verify' }).error('boom', { itemId: 7 });
    expect(lines()[0]).toMatchObject({ level: 'error', stage: 'verify', itemId: 7 });
  });

  it('serializes Error values', () => {
    createLogger({ dir, now }).error('failed', { err: new TypeError('bad input') });
    expect(lines()[0].err).toMatchObject({ name: 'TypeError', message: 'bad input' });
  });

  it('echoes lines when asked', () => {
    const seen: string[] = [];
    createLogger({ dir, now, echo: (l) => seen.push(l) }).info('hi');
    expect(JSON.parse(seen[0]!)).toMatchObject({ msg: 'hi' });
  });
});
```

- [ ] **Step 2: Write the failing stage tests** — `tests/lib/run-stage.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { runStage } from '../../src/lib/run-stage.js';
import { testDb, seedPublicationChain } from '../helpers/db.js';

type Row = { stage: string; ok: number; vertical_id: number | null; channel_id: number | null; detail_json: string };

const rows = (db: ReturnType<typeof testDb>) =>
  (db.prepare('SELECT stage, ok, vertical_id, channel_id, detail_json FROM run_log ORDER BY id').all() as Row[])
    .map((r) => ({ ...r, detail: JSON.parse(r.detail_json) }));

describe('runStage', () => {
  it('writes an entry row and an exit row around a successful stage', async () => {
    const db = testDb();
    const { verticalId } = seedPublicationChain(db);
    const result = await runStage(db, { stage: 'harvest', verticalId }, () => ({ inserted: 3 }));
    expect(result).toEqual({ inserted: 3 });
    const [start, end] = rows(db);
    expect(start).toMatchObject({ stage: 'harvest', ok: 1, vertical_id: verticalId, detail: { phase: 'start' } });
    expect(end).toMatchObject({ stage: 'harvest', ok: 1, detail: { phase: 'end', result: { inserted: 3 } } });
    expect(typeof end!.detail.ms).toBe('number');
  });

  it('records failure with ok = 0 and rethrows', async () => {
    const db = testDb();
    await expect(
      runStage(db, { stage: 'verify' }, async () => {
        throw new Error('gutendex timeout');
      }),
    ).rejects.toThrow('gutendex timeout');
    const [, end] = rows(db);
    expect(end).toMatchObject({ ok: 0, detail: { phase: 'end', error: 'gutendex timeout' } });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/lib`
Expected: FAIL — cannot resolve `../../src/lib/log.js` and `../../src/lib/run-stage.js`.

- [ ] **Step 4: Write `src/lib/log.ts`**

```ts
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

export interface LoggerOptions {
  dir: string;
  now?: () => Date;
  echo?: (line: string) => void;
}

function serialize(value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
}

export function createLogger(opts: LoggerOptions, base: Fields = {}): Logger {
  const now = opts.now ?? (() => new Date());
  mkdirSync(opts.dir, { recursive: true });

  const write = (level: LogLevel, msg: string, fields: Fields = {}) => {
    const ts = now();
    const record: Fields = { ts: ts.toISOString(), level, msg };
    for (const [k, v] of Object.entries({ ...base, ...fields })) record[k] = serialize(v);
    const line = JSON.stringify(record);
    appendFileSync(join(opts.dir, `lantern-${ts.toISOString().slice(0, 10)}.jsonl`), line + '\n');
    opts.echo?.(line);
  };

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => createLogger(opts, { ...base, ...fields }),
  };
}
```

- [ ] **Step 5: Write `src/lib/run-stage.ts`**

```ts
import type { Db } from '../db/connection.js';

export interface StageContext {
  stage: string;
  verticalId?: number | null;
  channelId?: number | null;
}

export async function runStage<T>(
  db: Db,
  ctx: StageContext,
  fn: () => T | Promise<T>,
  now: () => Date = () => new Date(),
): Promise<T> {
  const insert = db.prepare(
    `INSERT INTO run_log (vertical_id, channel_id, stage, ok, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const log = (ok: boolean, detail: Record<string, unknown>) =>
    insert.run(ctx.verticalId ?? null, ctx.channelId ?? null, ctx.stage, ok ? 1 : 0, JSON.stringify(detail), now().toISOString());

  const started = Date.now();
  log(true, { phase: 'start' });
  try {
    const result = await fn();
    log(true, { phase: 'end', ms: Date.now() - started, result: result ?? null });
    return result;
  } catch (err) {
    log(false, { phase: 'end', ms: Date.now() - started, error: (err as Error).message });
    throw err;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/lib && npm run typecheck`
Expected: 6 tests PASS, typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/log.ts src/lib/run-stage.ts tests/lib/
git commit -m "feat(lib): JSON-lines logger and run_log stage wrapper"
```

---

### Task A5: Sync config into the `verticals` and `channels` tables

**Files:**
- Create: `src/db/sync.ts`
- Test: `tests/db/sync.test.ts`

**Interfaces:**
- Consumes: `Db`; `LanternConfig`, `LoadedVertical`, `LoadedChannel` from `src/config/load.ts`; `testDb()`.
- Produces:
  - `interface SyncCounts { inserted: number; updated: number; deactivated: number }`
  - `syncConfig(db: Db, config: LanternConfig): { verticals: SyncCounts; channels: SyncCounts }` — one transaction.
  - `findChannelId(db: Db, channel: LoadedChannel): number | undefined`

Rules:
- Verticals are keyed by `slug`; channels by `(vertical_id, platform, account_ref)` — the spec's UNIQUE constraint.
- A vertical/channel removed from config is **deactivated** (`active = 0` / `enabled = 0`), never deleted — its history (items, publications) references it.
- `auto_publish` is never written by sync. New channels get the column default `0`; an existing `1` is left alone.

- [ ] **Step 1: Write the failing tests** — `tests/db/sync.test.ts`

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/db/sync.test.ts`
Expected: FAIL — cannot resolve `../../src/db/sync.js`.

- [ ] **Step 3: Write `src/db/sync.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/db/sync.test.ts && npm run typecheck`
Expected: 5 tests PASS, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/db/sync.ts tests/db/sync.test.ts
git commit -m "feat(db): sync verticals and channels from config without touching auto_publish"
```

---

### Task A6: Doctor health checks

**Files:**
- Create: `src/doctor/checks.ts`, `src/doctor/report.ts`
- Modify: `claude.md` §4 package layout — add `src/doctor/`
- Test: `tests/doctor/checks.test.ts`

**Interfaces:**
- Consumes: `Db`, `openDb`, `migrate`, `pendingMigrations`, `MIGRATIONS_DIR`, `loadConfig`, `ConfigError`, `LoadedChannel`, `syncConfig`, `findChannelId`, `testDb()`.
- Produces:
  - `type CheckStatus = 'ok' | 'warn' | 'fail'`
  - `interface CheckResult { name: string; status: CheckStatus; detail: string }`
  - `interface DoctorContext { db: Db; root: string; migrationsDir: string; env: Record<string, string | undefined>; now: Date; freeBytes?: (path: string) => number }`
  - `runChecks(ctx: DoctorContext): CheckResult[]`
  - `formatReport(results: CheckResult[]): string`, `exitCode(results: CheckResult[]): 0 | 1`

Phase 1 checks (Phase 4+ adds token validity, days-to-expiry, and quota per adapter):

| Check | ok | warn | fail |
|---|---|---|---|
| `db.integrity` | `PRAGMA integrity_check` = `ok` | — | anything else |
| `db.migrations` | none pending | — | pending migrations |
| `config.valid` | loads | — | `ConfigError` (issues in detail) |
| `config.synced` | every config channel has an enabled DB row | — | missing → "run `lantern migrate`" |
| `channel.<slug>.account_ref` | env var set | env var unset | — |
| `channel.<slug>.buffer` | not live, or ≥ 30 days scheduled | live and < 30 days (spec §12) | — |
| `channel.<slug>.last_publish` | not live, or published in last 48h | live and silent > 48h | — |
| `disk.free` | ≥ 1 GiB free | < 1 GiB | — |

"Live" means `enabled = 1 AND auto_publish = 1`. Buffer and silence warnings on channels that are not live yet would make an empty system look unhealthy, which contradicts the Phase 1 done criterion.

- [ ] **Step 1: Write the failing tests** — `tests/doctor/checks.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../src/db/connection.js';
import { MIGRATIONS_DIR } from '../../src/db/migrate.js';
import { loadConfig } from '../../src/config/load.js';
import { syncConfig } from '../../src/db/sync.js';
import { runChecks, type DoctorContext } from '../../src/doctor/checks.js';
import { exitCode, formatReport } from '../../src/doctor/report.js';
import { testDb } from '../helpers/db.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENV = {
  FB_PAGE_ID_COMMONPLACE: '1',
  PINTEREST_BOARD_ID_COMMONPLACE: '2',
  YT_CHANNEL_ID_LOOK_CLOSER: '3',
};

function healthyCtx(overrides: Partial<DoctorContext> = {}): DoctorContext {
  const db = testDb();
  syncConfig(db, loadConfig(ROOT));
  return {
    db,
    root: ROOT,
    migrationsDir: MIGRATIONS_DIR,
    env: ENV,
    now: new Date('2026-09-12T12:00:00Z'),
    freeBytes: () => 50 * 1024 ** 3,
    ...overrides,
  };
}

const byName = (ctx: DoctorContext, name: string) => runChecks(ctx).find((r) => r.name === name);

describe('runChecks', () => {
  it('reports a healthy empty system with no warnings or failures', () => {
    const results = runChecks(healthyCtx());
    expect(results.filter((r) => r.status !== 'ok')).toEqual([]);
    expect(exitCode(results)).toBe(0);
  });

  it('fails when migrations are pending', () => {
    const ctx = healthyCtx({ db: openDb(':memory:') });
    expect(byName(ctx, 'db.migrations')?.status).toBe('fail');
    expect(exitCode(runChecks(ctx))).toBe(1);
  });

  it('fails when config has not been synced', () => {
    expect(byName(healthyCtx({ db: testDb() }), 'config.synced')?.status).toBe('fail');
  });

  it('warns when a channel account_ref env var is missing', () => {
    const r = byName(healthyCtx({ env: {} }), 'channel.literature-facebook.account_ref');
    expect(r).toMatchObject({ status: 'warn' });
    expect(r?.detail).toContain('FB_PAGE_ID_COMMONPLACE');
  });

  it('warns about a thin buffer only once a channel is live', () => {
    const ctx = healthyCtx();
    expect(byName(ctx, 'channel.literature-facebook.buffer')?.status).toBe('ok');
    ctx.db.prepare("UPDATE channels SET auto_publish = 1 WHERE platform = 'facebook'").run();
    expect(byName(ctx, 'channel.literature-facebook.buffer')).toMatchObject({ status: 'warn' });
    expect(byName(ctx, 'channel.literature-facebook.last_publish')).toMatchObject({ status: 'warn' });
  });

  it('warns when disk space is low', () => {
    expect(byName(healthyCtx({ freeBytes: () => 10 * 1024 ** 2 }), 'disk.free')?.status).toBe('warn');
  });
});

describe('formatReport', () => {
  it('prints one line per check with its status', () => {
    const out = formatReport([
      { name: 'db.integrity', status: 'ok', detail: 'ok' },
      { name: 'disk.free', status: 'warn', detail: '10 MiB free' },
    ]);
    expect(out).toContain('[ ok ] db.integrity');
    expect(out).toContain('[warn] disk.free');
    expect(out).toContain('0 failed, 1 warning');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/doctor`
Expected: FAIL — cannot resolve `../../src/doctor/checks.js`.

- [ ] **Step 3: Write `src/doctor/checks.ts`**

```ts
import { statfsSync } from 'node:fs';
import { ConfigError, loadConfig, type LanternConfig, type LoadedChannel } from '../config/load.js';
import type { Db } from '../db/connection.js';
import { pendingMigrations } from '../db/migrate.js';
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

  const pending = pendingMigrations(db, ctx.migrationsDir);
  out.push(
    pending.length === 0
      ? result('db.migrations', 'ok', 'up to date')
      : result('db.migrations', 'fail', `pending: ${pending.join(', ')} — run \`lantern migrate\``),
  );

  let config: LanternConfig | undefined;
  try {
    config = loadConfig(ctx.root);
    out.push(result('config.valid', 'ok', `${config.verticals.length} verticals, ${config.channels.length} channels`));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    out.push(result('config.valid', 'fail', err.issues.join('; ')));
  }

  if (config && pending.length === 0) {
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
```

- [ ] **Step 4: Write `src/doctor/report.ts`**

```ts
import type { CheckResult } from './checks.js';

const LABEL = { ok: '[ ok ]', warn: '[warn]', fail: '[FAIL]' } as const;

export function formatReport(results: CheckResult[]): string {
  const lines = results.map((r) => `${LABEL[r.status]} ${r.name} — ${r.detail}`);
  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  lines.push('', `${failed} failed, ${warned} warning${warned === 1 ? '' : 's'}`);
  return lines.join('\n');
}

export function exitCode(results: CheckResult[]): 0 | 1 {
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/doctor && npm run typecheck`
Expected: 7 tests PASS, typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/doctor/ tests/doctor/ claude.md
git commit -m "feat(doctor): database, config, channel buffer, and disk health checks"
```

---

### Task A7: Paths, CLI entry point, and the Phase 1 done check

**Files:**
- Create: `src/lib/paths.ts`, `src/cli.ts`
- Test: `tests/lib/paths.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: everything from A2–A6.
- Produces:
  - `interface Paths { root: string; db: string; logs: string; migrations: string }`
  - `resolvePaths(env?: Record<string, string | undefined>, cwd?: string): Paths` — honours `LANTERN_ROOT`, `LANTERN_DB`, `LANTERN_LOGS`; relative values resolve against the root.
  - CLI: `lantern migrate` (apply migrations, then sync config inside a `runStage('migrate')`), `lantern doctor [--json]` (never migrates; exit 1 on any `fail`).

The CLI resolves `migrations/` from the project root, not from `import.meta.url`, so it works identically under `tsx` and from compiled `dist/`.

- [ ] **Step 1: Write the failing tests**

`tests/lib/paths.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { resolvePaths } from '../../src/lib/paths.js';

describe('resolvePaths', () => {
  it('defaults everything under the working directory', () => {
    const cwd = resolve('/work/lantern');
    expect(resolvePaths({}, cwd)).toEqual({
      root: cwd,
      db: join(cwd, 'data', 'lantern.db'),
      logs: join(cwd, 'logs'),
      migrations: join(cwd, 'migrations'),
    });
  });

  it('honours overrides, resolving relative ones against the root', () => {
    const root = resolve('/srv/lantern');
    const abs = resolve('/tmp/test.db');
    const p = resolvePaths({ LANTERN_ROOT: root, LANTERN_DB: abs, LANTERN_LOGS: 'var/logs' }, '/elsewhere');
    expect(p.db).toBe(abs);
    expect(p.logs).toBe(join(root, 'var', 'logs'));
  });
});
```

`tests/cli.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function lantern(args: string[], scratch: string) {
  const res = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      LANTERN_ROOT: ROOT,
      LANTERN_DB: join(scratch, 'lantern.db'),
      LANTERN_LOGS: join(scratch, 'logs'),
      FB_PAGE_ID_COMMONPLACE: 'x',
      PINTEREST_BOARD_ID_COMMONPLACE: 'x',
      YT_CHANNEL_ID_LOOK_CLOSER: 'x',
    },
  });
  return { code: res.status, out: res.stdout + res.stderr };
}

describe('lantern CLI', () => {
  it('doctor fails on a fresh database, then passes after migrate', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));

    const before = lantern(['doctor'], scratch);
    expect(before.code).toBe(1);
    expect(before.out).toContain('[FAIL] db.migrations');

    const migrated = lantern(['migrate'], scratch);
    expect(migrated.code).toBe(0);
    expect(migrated.out).toContain('001_initial.sql');

    const after = lantern(['doctor'], scratch);
    expect(after.code).toBe(0);
    expect(after.out).toContain('0 failed, 0 warnings');
  }, 30_000);

  it('doctor --json emits machine-readable results', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    lantern(['migrate'], scratch);
    const res = lantern(['doctor', '--json'], scratch);
    const parsed = JSON.parse(res.out) as Array<{ name: string; status: string }>;
    expect(parsed.find((r) => r.name === 'db.integrity')?.status).toBe('ok');
  }, 30_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lib/paths.test.ts tests/cli.test.ts`
Expected: FAIL — cannot resolve `src/lib/paths.js`; CLI spawn exits non-zero with a module-not-found error.

- [ ] **Step 3: Write `src/lib/paths.ts`**

```ts
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
```

- [ ] **Step 4: Write `src/cli.ts`**

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { config as loadDotenv } from 'dotenv';
import { join } from 'node:path';
import { loadConfig } from './config/load.js';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { syncConfig } from './db/sync.js';
import { runChecks } from './doctor/checks.js';
import { exitCode, formatReport } from './doctor/report.js';
import { createLogger } from './lib/log.js';
import { resolvePaths } from './lib/paths.js';
import { runStage } from './lib/run-stage.js';

const paths = resolvePaths();
loadDotenv({ path: join(paths.root, '.env'), quiet: true });
const log = createLogger({ dir: paths.logs });

const program = new Command().name('lantern').description('Automated educational social content engine');

program
  .command('migrate')
  .description('Apply pending migrations and sync config/ into the database')
  .action(async () => {
    const db = openDb(paths.db);
    const { applied } = migrate(db, paths.migrations);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'migrations: up to date');
    const counts = await runStage(db, { stage: 'migrate' }, () => syncConfig(db, loadConfig(paths.root)));
    console.log(`verticals: ${JSON.stringify(counts.verticals)}`);
    console.log(`channels:  ${JSON.stringify(counts.channels)}`);
    log.info('migrate complete', { applied, counts });
  });

program
  .command('doctor')
  .description('Report system health; exits 1 if any check fails')
  .option('--json', 'emit JSON instead of a table')
  .action((opts: { json?: boolean }) => {
    const db = openDb(paths.db);
    const results = runChecks({
      db,
      root: paths.root,
      migrationsDir: paths.migrations,
      env: process.env,
      now: new Date(),
    });
    console.log(opts.json ? JSON.stringify(results, null, 2) : formatReport(results));
    log.info('doctor complete', { results });
    process.exitCode = exitCode(results);
  });

program.parseAsync().catch((err: unknown) => {
  log.error('command failed', { err });
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
```

If `dotenv`'s installed version does not accept `quiet`, drop that option — it only suppresses a startup banner.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/lib/paths.test.ts tests/cli.test.ts && npm test && npm run typecheck`
Expected: all tests PASS across the suite, typecheck exits 0.

- [ ] **Step 6: Phase 1 done check, by hand, against the real database**

```bash
cp .env.example .env        # fill in placeholder values for the three account_ref names
npm run lantern -- migrate
npm run lantern -- doctor
echo "exit=$?"
```

Expected: `migrate` prints `applied: 001_initial.sql` and three inserted channels; `doctor` prints every check as `[ ok ]`, ends with `0 failed, 0 warnings`, and `exit=0`. Run `migrate` a second time: `migrations: up to date`, zero inserts. **This is the Phase 1 done criterion from spec §14.**

- [ ] **Step 7: Commit**

```bash
git add src/lib/paths.ts src/cli.ts tests/lib/paths.test.ts tests/cli.test.ts
git commit -m "feat(cli): lantern migrate and lantern doctor — Phase 1 spine complete"
```

---

## Part B — Phase 2: Verification Core

Pure logic with no network, built test-first (spec §15). The Phase 2 harvesters, enrichment, and image stages in Part C all call into these functions. **Nothing in Part C may write `items.status = 'verified'` except through `applyQuoteDecision`** (or its Phase 7 fact equivalent).

How spec §8 maps onto the code:

| Spec rule | Enforced by |
|---|---|
| Same line never enters twice (normalized, smart quotes folded) | `bodyHash` + `UNIQUE(vertical_id, body_hash)` |
| Tier 1: exact normalized string located in PD full text | `locateQuote` → `primary-text` evidence |
| Tier 3 alone is never enough | `decideQuote` + DB trigger `items_verified_requires_tier12` |
| Wikiquote Misattributed/Disputed → hard reject | `decideQuote` (`listed-misattributed`) |
| Sources conflict on attribution → hard reject | `decideQuote` (`attribution-conflict`, `author-mismatch`) |
| Aggregator sites may not appear in `sources` at all | `assertSourceAllowed` + DB trigger `sources_no_banned_domains` |
| Every verified item has ≥ 1 source | DB triggers (insert-as-verified blocked; last tier 1/2 source undeletable) |
| Numbers in body must match a source excerpt exactly | `unsupportedNumbers` |

Rules deliberately deferred to the harvester sub-plans (they need real data): "author died before the phrasing existed", "earliest appearance is post-1990 internet", and the Shakespeare canon list. With Tier 1/2 evidence required for every verified quote, these are defence in depth rather than the primary gate.

### As built — where the committed code differs from the task code below

Part B was executed on branch `phase-2-verification-core`. Per-task review found fail-open gaps in some of the reference code in B2 and B4, and those gaps were fixed. **The committed code is authoritative.** Where it differs from the task code below:

- **B2 — migration `003_source_guards_update.sql` (new).** Migration 002 is append-only once applied, so these guards live in 003:
  - `sources_tier_range_on_update` — the tier-range rule now also applies to `UPDATE OF tier`.
  - `sources_keep_last_tier12_on_downgrade` — a verified item's last tier 1/2 source cannot be changed to tier 3. Without this, the item stays `verified` with no qualifying source, which breaks spec §6.
  - `sources_item_id_immutable` — sources cannot be moved between items.
- **B2 — `hostOf` strips trailing dots** (`brainyquote.com.` → `brainyquote.com`). Without this, a trailing-dot aggregator URL passed `isBannedSource` and surfaced as a raw `SqliteError` instead of `SourcePolicyError`.
- **B2 — correction to the rationale below.** The SQL `LIKE` triggers do **not** "only over-reject". They cannot decode percent-encoded hosts (`brainyquote%2Ecom`), so they are a best-effort backstop for hand-typed SQL. `assertSourceAllowed`, called by `insertSource`, parses the URL and is the authoritative check.
- **B4 — `NUMERAL` keeps sign and magnitude.** The reference regex dropped minus signs (`-5` was supported by a source saying `5`) and leading-decimal magnitude (`.5` became `5`). Both let a wrong number through.
  - The committed pattern is `/(?:(?<![\p{L}\p{N}])[-\u2212])?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|(?<!\d)\.\d+)/gu`.
  - Canonicalization: strip commas, map U+2212 to `-`, prefix a bare `.` with `0`.
  - A sign counts only when it is not preceded by a letter or digit, so ranges (`10-20`) and labels (`COVID-19`) stay unsigned.
  - There is deliberately no lookbehind before digits, because a missed draft number would never be checked.

### File map for Part B

```
migrations/002_source_guards.sql
src/verify/normalize.ts        # normalizeWithMap, normalizeText, bodyHash, locateQuote
src/verify/source-policy.ts    # banned + reference domains, assertSourceAllowed
src/verify/quote-gate.ts       # decideQuote
src/verify/apply.ts            # applyQuoteDecision (the only path to 'verified')
src/verify/numbers.ts          # extractNumbers, unsupportedNumbers
src/db/sources.ts              # insertSource
tests/verify/normalize.test.ts
tests/verify/source-policy.test.ts
tests/verify/quote-gate.test.ts
tests/verify/numbers.test.ts
tests/db/source-guards.test.ts
```

### Task B1: Text normalization, body hash, and quote location

**Files:**
- Create: `src/verify/normalize.ts`
- Test: `tests/verify/normalize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface NormalizedText { source: string; text: string; map: number[] }` — `source` is the NFC form of the input; `map[i]` is the index in `source` of `text[i]`.
  - `normalizeWithMap(input: string): NormalizedText`
  - `normalizeText(input: string): string`
  - `bodyHash(input: string): string` — sha256 hex of `normalizeText`.
  - `interface Located { start: number; end: number; excerpt: string }` — offsets into `fullText.normalize('NFC')`.
  - `locateQuote(quote: string, fullText: string): Located | null` — whole-word match only.

Normalization, in one place so dedupe and location can never disagree: NFC, drop apostrophes (so `don't` = `don’t` = `dont`), NFKC-fold + lowercase each character, treat every non-letter/number/mark as a separator, collapse separators to a single space, trim. Diacritics are **kept** — `café` and `cafe` are different words.

- [ ] **Step 1: Write the failing tests** — `tests/verify/normalize.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { bodyHash, locateQuote, normalizeText } from '../../src/verify/normalize.js';

describe('normalizeText', () => {
  it('folds smart quotes and apostrophes', () => {
    expect(normalizeText('Don’t “panic”')).toBe('dont panic');
    expect(normalizeText(`Don't "panic"`)).toBe('dont panic');
  });

  it('folds dashes, ellipses, line breaks, and runs of whitespace', () => {
    expect(normalizeText('best of times—it was\r\n   the worst…')).toBe('best of times it was the worst');
    expect(normalizeText('best of times -- it was the worst...')).toBe('best of times it was the worst');
  });

  it('keeps diacritics but treats composed and decomposed forms alike', () => {
    expect(normalizeText('Café')).toBe('café');
    expect(normalizeText('Café')).toBe('café');
    expect(normalizeText('Café')).not.toBe(normalizeText('Cafe'));
  });

  it('treats Gutenberg _italic_ markers as separators', () => {
    expect(normalizeText('a _very_ fine day')).toBe('a very fine day');
  });
});

describe('bodyHash', () => {
  it('is equal for typographic variants and different for different words', () => {
    const a = bodyHash('It was the best of times, it was the worst of times.');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(bodyHash('it was the best of times — it was the worst of times')).toBe(a);
    expect(bodyHash('It was the best of times, it was the worst of crimes.')).not.toBe(a);
  });
});

describe('locateQuote', () => {
  const TALE = 'It was the best of times,\r\nit was the worst of times, it was the age of wisdom';

  it('finds a quote across line breaks and returns the original excerpt', () => {
    expect(locateQuote('it was the best of times, it was the worst of times', TALE)).toEqual({
      start: 0,
      end: 52,
      excerpt: 'It was the best of times,\r\nit was the worst of times',
    });
  });

  it('matches straight quotes in the query against smart quotes in the text', () => {
    const text = 'said Oliver. “Please, sir, I want some more.” The master';
    const hit = locateQuote('"Please, sir, I want some more"', text);
    expect(hit?.excerpt).toBe('Please, sir, I want some more');
  });

  it('only matches whole words', () => {
    expect(locateQuote('rose', 'the sun arose')).toBeNull();
    expect(locateQuote('rose', 'a rose by any other name')?.excerpt).toBe('rose');
  });

  it('skips a partial-word hit and finds a later whole-word one', () => {
    expect(locateQuote('rose', 'it arose; a rose')).toMatchObject({ excerpt: 'rose', start: 12 });
  });

  it('returns null when absent or when the quote is empty', () => {
    expect(locateQuote('call me ishmael', TALE)).toBeNull();
    expect(locateQuote(' — ', TALE)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/verify/normalize.test.ts`
Expected: FAIL — cannot resolve `../../src/verify/normalize.js`.

- [ ] **Step 3: Write `src/verify/normalize.ts`**

```ts
import { createHash } from 'node:crypto';

const APOSTROPHES = new Set(["'", '‘', '’', '‛', 'ʼ', '`']);
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

export interface NormalizedText {
  source: string;
  text: string;
  map: number[];
}

export function normalizeWithMap(input: string): NormalizedText {
  const source = input.normalize('NFC');
  let text = '';
  const map: number[] = [];
  let pendingSpace = false;

  for (let i = 0; i < source.length; ) {
    const ch = String.fromCodePoint(source.codePointAt(i)!);
    if (!APOSTROPHES.has(ch)) {
      for (const out of ch.normalize('NFKC').toLowerCase()) {
        if (!WORD_CHAR.test(out)) {
          pendingSpace = true;
          continue;
        }
        if (pendingSpace && text.length > 0) {
          text += ' ';
          map.push(i);
        }
        pendingSpace = false;
        text += out;
        for (let k = 0; k < out.length; k++) map.push(i);
      }
    }
    i += ch.length;
  }
  return { source, text, map };
}

export function normalizeText(input: string): string {
  return normalizeWithMap(input).text;
}

export function bodyHash(input: string): string {
  return createHash('sha256').update(normalizeText(input)).digest('hex');
}

export interface Located {
  start: number;
  end: number;
  excerpt: string;
}

export function locateQuote(quote: string, fullText: string): Located | null {
  const needle = normalizeText(quote);
  if (needle.length === 0) return null;
  const hay = normalizeWithMap(fullText);

  for (let from = 0; ; ) {
    const at = hay.text.indexOf(needle, from);
    if (at === -1) return null;
    const after = at + needle.length;
    const wholeWord =
      (at === 0 || hay.text[at - 1] === ' ') && (after === hay.text.length || hay.text[after] === ' ');
    if (wholeWord) {
      const start = hay.map[at]!;
      const last = hay.map[after - 1]!;
      const end = last + String.fromCodePoint(hay.source.codePointAt(last)!).length;
      return { start, end, excerpt: hay.source.slice(start, end) };
    }
    from = at + 1;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/verify/normalize.test.ts && npm run typecheck`
Expected: 10 tests PASS, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/verify/normalize.ts tests/verify/normalize.test.ts
git commit -m "feat(verify): normalization, body hash, and whole-word quote location"
```

---

### Task B2: Source policy and database guards

**Files:**
- Create: `src/verify/source-policy.ts`, `src/db/sources.ts`, `migrations/002_source_guards.sql`
- Modify: `tests/helpers/db.ts` (add `seedItem`)
- Test: `tests/verify/source-policy.test.ts`, `tests/db/source-guards.test.ts`

**Interfaces:**
- Consumes: `Db`, `testDb()`.
- Produces:
  - `BANNED_SOURCE_DOMAINS: readonly string[]`, `REFERENCE_DOMAINS: readonly string[]`
  - `type SourceTier = 1 | 2 | 3`
  - `interface SourceInput { tier: SourceTier; url?: string | null; citation: string; excerpt?: string | null }`
  - `class SourcePolicyError extends Error`
  - `hostOf(url: string): string | null` — lowercase hostname, or `null` if unparseable / not http(s).
  - `isBannedSource(url: string): boolean`
  - `assertSourceAllowed(src: SourceInput): void` — throws `SourcePolicyError`.
  - `insertSource(db: Db, itemId: number, src: SourceInput, now?: Date): number`
  - Test helper `seedItem(db: Db, body?: string): { verticalId: number; itemId: number }`

Two layers on purpose. The TypeScript policy gives good error messages; the SQL triggers make the rules hold even for a hand-typed `INSERT` in the sqlite shell or a future bug that bypasses `insertSource`. The trigger's `LIKE '%domain%'` is cruder than the host match. It does not decode percent-encoded hosts, so it is only a best-effort backstop; `assertSourceAllowed` is authoritative (see "As built" at the top of Part B). A test keeps the two lists in sync.

Goodreads is banned as a whole domain, not just `/quotes`: nothing on it is a Tier 1 or 2 source for this project.

- [ ] **Step 1: Add `seedItem` to `tests/helpers/db.ts`**

```ts
import { bodyHash } from '../../src/verify/normalize.js';

export function seedItem(db: Db, body = 'It was the best of times, it was the worst of times') {
  db.prepare(
    "INSERT OR IGNORE INTO verticals (slug, name, config_path) VALUES ('literature', 'The Commonplace Book', 'config/verticals/literature.yaml')",
  ).run();
  const verticalId = db.prepare("SELECT id FROM verticals WHERE slug = 'literature'").pluck().get() as number;
  const itemId = Number(
    db
      .prepare("INSERT INTO items (vertical_id, kind, body, body_hash, status, created_at) VALUES (?, 'quote', ?, ?, 'raw', ?)")
      .run(verticalId, body, bodyHash(body), NOW).lastInsertRowid,
  );
  return { verticalId, itemId };
}
```

(Put the `import` at the top of the file with the others.)

- [ ] **Step 2: Write the failing policy tests** — `tests/verify/source-policy.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { assertSourceAllowed, hostOf, isBannedSource, SourcePolicyError } from '../../src/verify/source-policy.js';

describe('hostOf', () => {
  it('returns a lowercase host for http(s) and null otherwise', () => {
    expect(hostOf('HTTPS://WWW.Gutenberg.org/ebooks/98')).toBe('www.gutenberg.org');
    expect(hostOf('ftp://example.com/x')).toBeNull();
    expect(hostOf('not a url')).toBeNull();
  });
});

describe('isBannedSource', () => {
  it.each([
    'https://www.brainyquote.com/quotes/charles_dickens_121045',
    'https://goodreads.com/quotes/12345',
    'HTTPS://AZQUOTES.COM/quote/1',
    'https://m.quotefancy.com/x',
  ])('bans %s', (url) => expect(isBannedSource(url)).toBe(true));

  it.each([
    'https://notgoodreads.com/page',
    'https://www.gutenberg.org/ebooks/98',
    'https://en.wikisource.org/wiki/A_Tale_of_Two_Cities',
    'https://standardebooks.org/ebooks/charles-dickens/bleak-house',
  ])('allows %s', (url) => expect(isBannedSource(url)).toBe(false));
});

describe('assertSourceAllowed', () => {
  const ok = { tier: 1 as const, citation: 'Dickens, A Tale of Two Cities (1859), Book 1, Ch. 1' };

  it('accepts a primary source with or without a url', () => {
    expect(() => assertSourceAllowed(ok)).not.toThrow();
    expect(() => assertSourceAllowed({ ...ok, url: 'https://www.gutenberg.org/ebooks/98' })).not.toThrow();
  });

  it('rejects banned domains', () => {
    expect(() => assertSourceAllowed({ ...ok, url: 'https://www.goodreads.com/quotes/1' })).toThrow(SourcePolicyError);
  });

  it('refuses to let a reference site claim tier 1 or 2', () => {
    expect(() => assertSourceAllowed({ ...ok, url: 'https://en.wikiquote.org/wiki/Charles_Dickens' })).toThrow(/reference source/);
    expect(() => assertSourceAllowed({ ...ok, tier: 3, url: 'https://en.wikiquote.org/wiki/Charles_Dickens' })).not.toThrow();
  });

  it('rejects empty citations and unparseable urls', () => {
    expect(() => assertSourceAllowed({ ...ok, citation: '   ' })).toThrow(/citation/);
    expect(() => assertSourceAllowed({ ...ok, url: 'ftp://example.com' })).toThrow(/url/);
  });
});
```

- [ ] **Step 3: Write the failing guard tests** — `tests/db/source-guards.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { insertSource } from '../../src/db/sources.js';
import { BANNED_SOURCE_DOMAINS, SourcePolicyError } from '../../src/verify/source-policy.js';
import { seedItem, testDb } from '../helpers/db.js';

const NOW = '2026-01-01T00:00:00.000Z';
const count = (db: ReturnType<typeof testDb>) => db.prepare('SELECT COUNT(*) FROM sources').pluck().get();

describe('source guards', () => {
  it('insertSource refuses banned sources and writes nothing', () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    expect(() =>
      insertSource(db, itemId, { tier: 2, citation: 'x', url: 'https://www.brainyquote.com/q' }),
    ).toThrow(SourcePolicyError);
    expect(count(db)).toBe(0);
  });

  it('the database trigger rejects every banned domain even with raw SQL', () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    const raw = db.prepare("INSERT INTO sources (item_id, tier, url, citation, retrieved_at) VALUES (?, 2, ?, 'x', ?)");
    for (const domain of BANNED_SOURCE_DOMAINS) {
      expect(() => raw.run(itemId, `https://www.${domain}/anything`, NOW), domain).toThrow(/banned source domain/);
    }
  });

  it('items cannot be inserted already verified', () => {
    const db = testDb();
    const { verticalId } = seedItem(db);
    expect(() =>
      db.prepare("INSERT INTO items (vertical_id, kind, body, body_hash, status, created_at) VALUES (?, 'quote', 'b', 'h2', 'verified', ?)").run(verticalId, NOW),
    ).toThrow(/inserted as raw/);
  });

  it('an item with only tier 3 sources cannot be verified', () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    insertSource(db, itemId, { tier: 3, citation: 'Wikiquote', url: 'https://en.wikiquote.org/wiki/Charles_Dickens' });
    expect(() => db.prepare("UPDATE items SET status = 'verified' WHERE id = ?").run(itemId)).toThrow(/tier 1 or tier 2/);
  });

  it('an item with a tier 1 source can be verified, and that source cannot then be deleted', () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    const sourceId = insertSource(db, itemId, { tier: 1, citation: 'A Tale of Two Cities, Book 1, Ch. 1' });
    db.prepare("UPDATE items SET status = 'verified' WHERE id = ?").run(itemId);
    expect(() => db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId)).toThrow(/last tier 1 or tier 2 source/);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/verify/source-policy.test.ts tests/db/source-guards.test.ts`
Expected: FAIL — cannot resolve `source-policy.js` / `sources.js`.

- [ ] **Step 5: Write `src/verify/source-policy.ts`**

```ts
export const BANNED_SOURCE_DOMAINS = [
  'brainyquote.com',
  'goodreads.com',
  'azquotes.com',
  'quotefancy.com',
  'quotes.net',
  'quotemaster.org',
  'quotationspage.com',
  'wisdomquotes.com',
  'everydaypower.com',
  'quotegarden.com',
  'quotepark.info',
  'inspiringquotes.us',
] as const;

/** Useful leads, never verification on their own (spec §8). Capped at tier 3. */
export const REFERENCE_DOMAINS = ['wikiquote.org', 'wikipedia.org'] as const;

export type SourceTier = 1 | 2 | 3;

export interface SourceInput {
  tier: SourceTier;
  url?: string | null;
  citation: string;
  excerpt?: string | null;
}

export class SourcePolicyError extends Error {
  override name = 'SourcePolicyError';
}

const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function isBannedSource(url: string): boolean {
  const host = hostOf(url);
  return host !== null && BANNED_SOURCE_DOMAINS.some((d) => onDomain(host, d));
}

export function assertSourceAllowed(src: SourceInput): void {
  if (src.citation.trim().length === 0) throw new SourcePolicyError('source citation must not be empty');
  if (![1, 2, 3].includes(src.tier)) throw new SourcePolicyError(`invalid source tier ${src.tier}`);
  if (src.url == null) return;

  const host = hostOf(src.url);
  if (host === null) throw new SourcePolicyError(`source url is not a valid http(s) url: ${src.url}`);
  if (isBannedSource(src.url)) throw new SourcePolicyError(`banned source domain: ${host}`);
  if (src.tier < 3 && REFERENCE_DOMAINS.some((d) => onDomain(host, d))) {
    throw new SourcePolicyError(`${host} is a reference source and cannot be tier ${src.tier}`);
  }
}
```

- [ ] **Step 6: Write `src/db/sources.ts`**

```ts
import { assertSourceAllowed, type SourceInput } from '../verify/source-policy.js';
import type { Db } from './connection.js';

export function insertSource(db: Db, itemId: number, src: SourceInput, now: Date = new Date()): number {
  assertSourceAllowed(src);
  return Number(
    db
      .prepare('INSERT INTO sources (item_id, tier, url, citation, excerpt, retrieved_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(itemId, src.tier, src.url ?? null, src.citation, src.excerpt ?? null, now.toISOString()).lastInsertRowid,
  );
}
```

- [ ] **Step 7: Write `migrations/002_source_guards.sql`**

The domain list must match `BANNED_SOURCE_DOMAINS` exactly; the raw-SQL test in Step 3 fails if one is missing.

```sql
CREATE TRIGGER sources_no_banned_domains
BEFORE INSERT ON sources
WHEN NEW.url IS NOT NULL AND (
     lower(NEW.url) LIKE '%brainyquote.com%'
  OR lower(NEW.url) LIKE '%goodreads.com%'
  OR lower(NEW.url) LIKE '%azquotes.com%'
  OR lower(NEW.url) LIKE '%quotefancy.com%'
  OR lower(NEW.url) LIKE '%quotes.net%'
  OR lower(NEW.url) LIKE '%quotemaster.org%'
  OR lower(NEW.url) LIKE '%quotationspage.com%'
  OR lower(NEW.url) LIKE '%wisdomquotes.com%'
  OR lower(NEW.url) LIKE '%everydaypower.com%'
  OR lower(NEW.url) LIKE '%quotegarden.com%'
  OR lower(NEW.url) LIKE '%quotepark.info%'
  OR lower(NEW.url) LIKE '%inspiringquotes.us%'
)
BEGIN
  SELECT RAISE(ABORT, 'banned source domain');
END;

CREATE TRIGGER sources_no_banned_domains_on_update
BEFORE UPDATE OF url ON sources
WHEN NEW.url IS NOT NULL AND (
     lower(NEW.url) LIKE '%brainyquote.com%'
  OR lower(NEW.url) LIKE '%goodreads.com%'
  OR lower(NEW.url) LIKE '%azquotes.com%'
  OR lower(NEW.url) LIKE '%quotefancy.com%'
  OR lower(NEW.url) LIKE '%quotes.net%'
  OR lower(NEW.url) LIKE '%quotemaster.org%'
  OR lower(NEW.url) LIKE '%quotationspage.com%'
  OR lower(NEW.url) LIKE '%wisdomquotes.com%'
  OR lower(NEW.url) LIKE '%everydaypower.com%'
  OR lower(NEW.url) LIKE '%quotegarden.com%'
  OR lower(NEW.url) LIKE '%quotepark.info%'
  OR lower(NEW.url) LIKE '%inspiringquotes.us%'
)
BEGIN
  SELECT RAISE(ABORT, 'banned source domain');
END;

CREATE TRIGGER sources_tier_range
BEFORE INSERT ON sources
WHEN NEW.tier NOT IN (1, 2, 3)
BEGIN
  SELECT RAISE(ABORT, 'source tier must be 1, 2, or 3');
END;

CREATE TRIGGER items_insert_not_verified
BEFORE INSERT ON items
WHEN NEW.status = 'verified'
BEGIN
  SELECT RAISE(ABORT, 'items must be inserted as raw and promoted after sources exist');
END;

CREATE TRIGGER items_verified_requires_tier12
BEFORE UPDATE OF status ON items
WHEN NEW.status = 'verified'
  AND NOT EXISTS (SELECT 1 FROM sources WHERE item_id = NEW.id AND tier <= 2)
BEGIN
  SELECT RAISE(ABORT, 'verified items need at least one tier 1 or tier 2 source');
END;

CREATE TRIGGER sources_keep_last_tier12_of_verified
BEFORE DELETE ON sources
WHEN OLD.tier <= 2
  AND (SELECT status FROM items WHERE id = OLD.item_id) = 'verified'
  AND (SELECT COUNT(*) FROM sources WHERE item_id = OLD.item_id AND tier <= 2) = 1
BEGIN
  SELECT RAISE(ABORT, 'cannot delete the last tier 1 or tier 2 source of a verified item');
END;
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: all tests PASS (including A2's migration tests, which now apply `002` too), typecheck exits 0.

- [ ] **Step 9: Commit**

In `claude.md` §8, add one sentence: aggregator bans and the "≥ 1 tier 1/2 source per verified item" rule are enforced by SQLite triggers in `migrations/002_source_guards.sql`.

```bash
git add src/verify/source-policy.ts src/db/sources.ts migrations/002_source_guards.sql tests/verify/source-policy.test.ts tests/db/source-guards.test.ts tests/helpers/db.ts claude.md
git commit -m "feat(verify): source policy with banned-domain and verification triggers"
```

---

### Task B3: Quote gate and the only path to `verified`

**Files:**
- Create: `src/verify/quote-gate.ts`, `src/verify/apply.ts`
- Test: `tests/verify/quote-gate.test.ts`

**Interfaces:**
- Consumes: `normalizeText` (B1); `hostOf`, `isBannedSource`, `SourceInput`, `SourcePolicyError` (B2); `insertSource` (B2); `Db`; `testDb()`, `seedItem()`.
- Produces:
  - `MIN_QUOTE_WORDS = 5`
  - `type QuoteEvidence` — discriminated union on `kind`:
    - `{ kind: 'primary-text'; citation: string; url?: string; excerpt: string; authorMatches: boolean }`
    - `{ kind: 'scholarly'; citation: string; url?: string; excerpt?: string }`
    - `{ kind: 'reference'; citation: string; url?: string; excerpt?: string }`
    - `{ kind: 'listed-misattributed'; citation: string; url?: string }`
    - `{ kind: 'attribution-conflict'; citation: string; url?: string; otherAuthor: string }`
  - `type QuoteRejectReason = 'too-short' | 'misattributed' | 'attribution-conflict' | 'author-mismatch' | 'insufficient-evidence'`
  - `type QuoteDecision = { status: 'verified'; sources: SourceInput[] } | { status: 'rejected'; reason: QuoteRejectReason; detail: string }`
  - `decideQuote(quote: string, evidence: QuoteEvidence[]): QuoteDecision` — pure.
  - `applyQuoteDecision(db: Db, itemId: number, decision: QuoteDecision, now?: Date): void` — one transaction; only `raw` items.

Decision order (first match wins):
1. Evidence with a banned or unparseable URL is **ignored** entirely. Aggregators list real quotes too, so seeing one there isn't grounds to reject, but it never counts as evidence.
2. Fewer than `MIN_QUOTE_WORDS` normalized words → `too-short`. A three-word phrase found in Dickens doesn't prove the famous line is Dickens's.
3. Any `listed-misattributed` → `misattributed`, **even if a primary-text match exists** (spec §8: hard-reject anything appearing there).
4. Any `attribution-conflict` → `attribution-conflict`.
5. A `primary-text` match with `authorMatches` → `verified` (tier 1, plus any scholarly as tier 2 and references as tier 3).
6. `primary-text` matches exist but none by the attributed author → `author-mismatch`. This is the classic misattribution.
7. Any `scholarly` → `verified` (tier 2, plus references as tier 3).
8. Otherwise → `insufficient-evidence` (this is the "Tier 3 alone is never enough" rule).

- [ ] **Step 1: Write the failing tests** — `tests/verify/quote-gate.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { applyQuoteDecision } from '../../src/verify/apply.js';
import { decideQuote, type QuoteEvidence } from '../../src/verify/quote-gate.js';
import { SourcePolicyError } from '../../src/verify/source-policy.js';
import { seedItem, testDb } from '../helpers/db.js';

const QUOTE = 'It was the best of times, it was the worst of times';

const primary = (authorMatches = true): QuoteEvidence => ({
  kind: 'primary-text',
  citation: 'Charles Dickens, A Tale of Two Cities (1859), Book 1, Chapter 1',
  url: 'https://www.gutenberg.org/ebooks/98',
  excerpt: 'It was the best of times, it was the worst of times',
  authorMatches,
});
const scholarly: QuoteEvidence = { kind: 'scholarly', citation: 'Oxford World’s Classics edition, p. 5' };
const wikiquote: QuoteEvidence = {
  kind: 'reference',
  citation: 'Wikiquote: Charles Dickens',
  url: 'https://en.wikiquote.org/wiki/Charles_Dickens',
};

describe('decideQuote', () => {
  it('verifies a primary-text match by the attributed author as tier 1', () => {
    const d = decideQuote(QUOTE, [primary(), wikiquote]);
    expect(d.status).toBe('verified');
    if (d.status !== 'verified') return;
    expect(d.sources.map((s) => s.tier)).toEqual([1, 3]);
    expect(d.sources[0]).toMatchObject({ excerpt: QUOTE, url: 'https://www.gutenberg.org/ebooks/98' });
  });

  it('rejects quotes too short to verify meaningfully', () => {
    expect(decideQuote('Bah! Humbug!', [primary()])).toMatchObject({ status: 'rejected', reason: 'too-short' });
  });

  it('hard-rejects anything listed as misattributed, even with a primary match', () => {
    const listed: QuoteEvidence = { kind: 'listed-misattributed', citation: 'Wikiquote: Misattributed' };
    expect(decideQuote(QUOTE, [primary(), listed])).toMatchObject({ status: 'rejected', reason: 'misattributed' });
  });

  it('rejects conflicting attributions', () => {
    const conflict: QuoteEvidence = { kind: 'attribution-conflict', citation: 'Some anthology', otherAuthor: 'Thomas Carlyle' };
    const d = decideQuote(QUOTE, [scholarly, conflict]);
    expect(d).toMatchObject({ status: 'rejected', reason: 'attribution-conflict' });
    if (d.status === 'rejected') expect(d.detail).toContain('Thomas Carlyle');
  });

  it('rejects a quote found only in a different author’s work', () => {
    expect(decideQuote(QUOTE, [primary(false)])).toMatchObject({ status: 'rejected', reason: 'author-mismatch' });
  });

  it('verifies on scholarly evidence as tier 2', () => {
    const d = decideQuote(QUOTE, [scholarly]);
    expect(d.status === 'verified' && d.sources.map((s) => s.tier)).toEqual([2]);
  });

  it('never verifies on reference sources alone', () => {
    expect(decideQuote(QUOTE, [wikiquote])).toMatchObject({ status: 'rejected', reason: 'insufficient-evidence' });
    expect(decideQuote(QUOTE, [])).toMatchObject({ status: 'rejected', reason: 'insufficient-evidence' });
  });

  it('ignores evidence from banned or unparseable urls', () => {
    const aggregator: QuoteEvidence = { ...scholarly, url: 'https://www.brainyquote.com/quotes/x' };
    const junk: QuoteEvidence = { ...scholarly, url: 'not a url' };
    expect(decideQuote(QUOTE, [aggregator, junk])).toMatchObject({ status: 'rejected', reason: 'insufficient-evidence' });
  });
});

describe('applyQuoteDecision', () => {
  const statusOf = (db: ReturnType<typeof testDb>, id: number) =>
    db.prepare('SELECT status, reject_reason FROM items WHERE id = ?').get(id);

  it('writes sources and promotes a verified item', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [primary()]));
    expect(statusOf(db, itemId)).toEqual({ status: 'verified', reject_reason: null });
    expect(db.prepare('SELECT tier FROM sources WHERE item_id = ?').pluck().all(itemId)).toEqual([1]);
  });

  it('records the reason for a rejection and writes no sources', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [wikiquote]));
    expect(statusOf(db, itemId)).toMatchObject({ status: 'rejected', reject_reason: expect.stringMatching(/^insufficient-evidence: /) });
    expect(db.prepare('SELECT COUNT(*) FROM sources').pluck().get()).toBe(0);
  });

  it('refuses to re-decide an item that is not raw', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [wikiquote]));
    expect(() => applyQuoteDecision(db, itemId, decideQuote(QUOTE, [primary()]))).toThrow(/only raw items/);
  });

  it('rolls back entirely if any source violates policy', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    const forged = {
      status: 'verified' as const,
      sources: [
        { tier: 1 as const, citation: 'A Tale of Two Cities' },
        { tier: 2 as const, citation: 'x', url: 'https://www.goodreads.com/quotes/1' },
      ],
    };
    expect(() => applyQuoteDecision(db, itemId, forged)).toThrow(SourcePolicyError);
    expect(statusOf(db, itemId)).toMatchObject({ status: 'raw' });
    expect(db.prepare('SELECT COUNT(*) FROM sources').pluck().get()).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/verify/quote-gate.test.ts`
Expected: FAIL — cannot resolve `quote-gate.js` / `apply.js`.

- [ ] **Step 3: Write `src/verify/quote-gate.ts`**

```ts
import { normalizeText } from './normalize.js';
import { hostOf, isBannedSource, type SourceInput, type SourceTier } from './source-policy.js';

export const MIN_QUOTE_WORDS = 5;

export type QuoteEvidence =
  | { kind: 'primary-text'; citation: string; url?: string; excerpt: string; authorMatches: boolean }
  | { kind: 'scholarly'; citation: string; url?: string; excerpt?: string }
  | { kind: 'reference'; citation: string; url?: string; excerpt?: string }
  | { kind: 'listed-misattributed'; citation: string; url?: string }
  | { kind: 'attribution-conflict'; citation: string; url?: string; otherAuthor: string };

export type QuoteRejectReason =
  | 'too-short'
  | 'misattributed'
  | 'attribution-conflict'
  | 'author-mismatch'
  | 'insufficient-evidence';

export type QuoteDecision =
  | { status: 'verified'; sources: SourceInput[] }
  | { status: 'rejected'; reason: QuoteRejectReason; detail: string };

const reject = (reason: QuoteRejectReason, detail: string): QuoteDecision => ({ status: 'rejected', reason, detail });

const toSource = (tier: SourceTier, e: { citation: string; url?: string; excerpt?: string }): SourceInput => ({
  tier,
  citation: e.citation,
  url: e.url ?? null,
  excerpt: e.excerpt ?? null,
});

const usable = (e: QuoteEvidence) => e.url === undefined || (hostOf(e.url) !== null && !isBannedSource(e.url));

export function decideQuote(quote: string, evidence: QuoteEvidence[]): QuoteDecision {
  const words = normalizeText(quote).split(' ').filter(Boolean).length;
  if (words < MIN_QUOTE_WORDS) return reject('too-short', `${words} words; minimum is ${MIN_QUOTE_WORDS}`);

  const ev = evidence.filter(usable);
  const of = <K extends QuoteEvidence['kind']>(kind: K) =>
    ev.filter((e): e is Extract<QuoteEvidence, { kind: K }> => e.kind === kind);

  const listed = of('listed-misattributed');
  if (listed.length > 0) return reject('misattributed', listed.map((e) => e.citation).join('; '));

  const conflicts = of('attribution-conflict');
  if (conflicts.length > 0) {
    return reject('attribution-conflict', conflicts.map((e) => `also attributed to ${e.otherAuthor} (${e.citation})`).join('; '));
  }

  const primaries = of('primary-text');
  const byAuthor = primaries.filter((e) => e.authorMatches);
  const scholarly = of('scholarly');
  const references = of('reference').map((e) => toSource(3, e));

  if (byAuthor.length > 0) {
    return {
      status: 'verified',
      sources: [...byAuthor.map((e) => toSource(1, e)), ...scholarly.map((e) => toSource(2, e)), ...references],
    };
  }
  if (primaries.length > 0) {
    return reject('author-mismatch', `found only in works not by the attributed author: ${primaries.map((e) => e.citation).join('; ')}`);
  }
  if (scholarly.length > 0) {
    return { status: 'verified', sources: [...scholarly.map((e) => toSource(2, e)), ...references] };
  }
  return reject('insufficient-evidence', references.length > 0 ? 'reference sources only' : 'no usable evidence');
}
```

- [ ] **Step 4: Write `src/verify/apply.ts`**

```ts
import { insertSource } from '../db/sources.js';
import type { Db } from '../db/connection.js';
import type { QuoteDecision } from './quote-gate.js';

/** The only code path that moves a quote item out of 'raw'. */
export function applyQuoteDecision(db: Db, itemId: number, decision: QuoteDecision, now: Date = new Date()): void {
  db.transaction(() => {
    const item = db.prepare('SELECT status FROM items WHERE id = ?').get(itemId) as { status: string } | undefined;
    if (!item) throw new Error(`item ${itemId} not found`);
    if (item.status !== 'raw') throw new Error(`item ${itemId} is ${item.status}; only raw items can be decided`);

    if (decision.status === 'verified') {
      for (const source of decision.sources) insertSource(db, itemId, source, now);
      db.prepare("UPDATE items SET status = 'verified', reject_reason = NULL WHERE id = ?").run(itemId);
    } else {
      db.prepare("UPDATE items SET status = 'rejected', reject_reason = ? WHERE id = ?").run(
        `${decision.reason}: ${decision.detail}`,
        itemId,
      );
    }
  })();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/verify/quote-gate.test.ts && npm run typecheck`
Expected: 12 tests PASS, typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/verify/quote-gate.ts src/verify/apply.ts tests/verify/quote-gate.test.ts
git commit -m "feat(verify): quote attribution gate and transactional apply"
```

---

### Task B4: Numeric claim check

**Files:**
- Create: `src/verify/numbers.ts`
- Test: `tests/verify/numbers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `extractNumbers(text: string): string[]` — canonical numeral strings in order of appearance (thousands separators removed).
  - `unsupportedNumbers(draft: string, excerpts: string[]): string[]` — unique numerals in `draft` that appear in no excerpt. Non-empty means the post goes to `needs_review` (wired in 2.4).

Deliberately strict, so it fails closed. `93 million` in a draft does not match `93,000,000` in a source, and `9.8` does not match `9.81`. A human resolves those in review. Number *words* (`three`) are out of scope here; the fact-check model pass (2.4) covers them.

- [ ] **Step 1: Write the failing tests** — `tests/verify/numbers.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { extractNumbers, unsupportedNumbers } from '../../src/verify/numbers.js';

describe('extractNumbers', () => {
  it('extracts integers, decimals, and comma-grouped thousands', () => {
    expect(extractNumbers('About 1,000 objects fall at 9.8 m/s² — first measured before 1859.')).toEqual(['1000', '9.8', '1859']);
  });

  it('pulls the digits out of ordinals and decades', () => {
    expect(extractNumbers('the 19th century and the 1990s')).toEqual(['19', '1990']);
  });

  it('does not swallow a sentence-ending period', () => {
    expect(extractNumbers('Pi is roughly 3.14.')).toEqual(['3.14']);
  });

  it('returns nothing for text without numerals', () => {
    expect(extractNumbers('three blind mice')).toEqual([]);
  });
});

describe('unsupportedNumbers', () => {
  it('accepts numbers present in any excerpt, regardless of grouping', () => {
    expect(unsupportedNumbers('Dickens wrote it in 1859; it sold 1000 copies.', ['published 1859', 'sold 1,000 copies'])).toEqual([]);
  });

  it('flags numbers that do not appear verbatim in a source', () => {
    const draft = 'Sunlight takes 8 minutes to cross 93 million miles.';
    expect(unsupportedNumbers(draft, ['about 8 minutes', 'roughly 93,000,000 miles'])).toEqual(['93']);
  });

  it('treats a rounded number as unsupported', () => {
    expect(unsupportedNumbers('Gravity pulls at 9.8 m/s².', ['g = 9.81 m/s²'])).toEqual(['9.8']);
  });

  it('reports each unsupported number once', () => {
    expect(unsupportedNumbers('42, then 42 again', [])).toEqual(['42']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/verify/numbers.test.ts`
Expected: FAIL — cannot resolve `../../src/verify/numbers.js`.

- [ ] **Step 3: Write `src/verify/numbers.ts`**

```ts
const NUMERAL = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

export function extractNumbers(text: string): string[] {
  return [...text.matchAll(NUMERAL)].map((m) => m[0].replaceAll(',', ''));
}

export function unsupportedNumbers(draft: string, excerpts: string[]): string[] {
  const supported = new Set(excerpts.flatMap(extractNumbers));
  return [...new Set(extractNumbers(draft))].filter((n) => !supported.has(n));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: the full suite PASSES, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/verify/numbers.ts tests/verify/numbers.test.ts
git commit -m "feat(verify): programmatic numeric claim check"
```

*Part B done when:* `npm test` is green, and every row of the §8 mapping table at the top of Part B names a passing test.

---

## Part C — Milestones (each gets its own detailed plan before work starts)

### Prerequisites carried from the Phase 1 final review

The whole-branch review of Part A found issues that are real but out of scope for
that fix wave. They are not forgotten — they must land before the milestone named
below, not later.

| Item | Why it matters | Land before |
|---|---|---|
| **I4** — the migration runner cannot run a SQLite table-rebuild migration on a populated DB, because `PRAGMA foreign_keys=OFF` is a no-op inside a transaction, and tests only migrate empty DBs. | A table-rebuild migration (e.g. dropping/renaming a column) run against a real, populated `data/lantern.db` would either fail or silently skip the FK check. | **The first table-rebuild migration.** Fix: turn FKs off outside the transaction; run `PRAGMA foreign_key_check` before commit; add a test that applies `001`, seeds data, then applies the rest. |
| **I6** — channel identity is keyed on the env var *name* (`account_ref`), not the underlying account. Renaming the var, or two names pointing at the same page id, creates a new `channel_id`, bypassing `UNIQUE(post_id, channel_id)` for the same real page. | Silently defeats the schema's core double-post guarantee (§6) once a channel is renamed or duplicated. | **Phase 4 queue/publish.** Fix: add a doctor/config `fail` when two channels on one platform resolve to the same env value; add a publish-time guard or an explicit channel-rename command; add the missing duplicate-destination test (A3); decide deliberately whether a removed-then-re-added channel keeps its old `auto_publish=1` (A5); update spec §6/§11. |
| **Doctor exit-code contract for warnings** (Minor 3) — doctor currently exits 0 on warnings only. | Phase 5 alerting cannot key on a thin buffer or other warn-level conditions without a distinct exit code. | **Decide before Phase 5** (e.g. exit 2 = warnings). |
| **Buffer definition** (Minor 9) — spec §12 asks for a 30-day buffer of *approved posts*, but doctor counts *scheduled publications*. | The buffer check can read healthy while the real safety margin (approved-but-unscheduled content) is thin. | **Resolve during the Phase 4 queue design.** |
| **Missing channel credentials** (Minor 10) — `account_ref` unset is only a `warn`. | A live channel with no credential should never be allowed to reach `publish`. | **Make it `fail` for live channels in Phase 4.** |
| **Unknown-command logging** (Minor 2) — a mistyped scheduled command exits 1 with nothing in `logs/`. | Silent failure defeats the "a cron job leaves a log" rationale in §4. | **Before Phase 5:** use commander `exitOverride()` and log the error. |
| **Migration drift** (Minor 6) — doctor cannot detect a DB that is ahead of the code, or an applied migration file edited after the fact. | A hotfixed or hand-edited migration file would apply differently on a fresh environment than it did in production, undetected. | **Before Phase 5:** store a checksum of each LF-normalized file. |

Every milestone below follows the same opening ritual:

1. Fetch one or more **real** responses from each external API it touches and save them under `data/cache/<source>/`.
2. Write `docs/plans/<phase>-<name>.md` in the same bite-sized TDD format as Parts A–B, written against the real response shapes.
3. For anything touching Claude, load the `claude-api` skill before writing that plan. For Meta, Pinterest, and YouTube, read the platform's current docs, not `claude.md`.

### C0 — HTTP client and response cache (start of Phase 2, before any harvester)

- **Files:** `src/lib/http.ts`, `src/lib/cache.ts`, `tests/lib/http.test.ts`
- **Scope:** `fetch` wrapper with exponential backoff on 5xx and 429, honouring `Retry-After`; **never** retries any other 4xx (spec §11). A descriptive `User-Agent` with a contact address (Wikimedia requires one). Read-through cache at `data/cache/<source>/<sha256(method+url+body)>.json` storing status, headers, and body, with a `--refresh` escape hatch.
- **Tests:** against a throwaway `node:http` server started in the test, which is real HTTP rather than a mocked `fetch`.
- **Done when:** a second identical request is served from disk without touching the network, and a 404 is attempted exactly once.

### Phase 2 remainder — literature content end to end, no publishing

*Done when (spec §14):* 20 finished literature posts exist on disk in `square` and `pin` that you would be happy to publish.

**2.1 Gutendex harvester** — `src/harvest/gutendex.ts`
- Author list lives in `literature.yaml` under a new `harvest.authors: [{ name, wikidata_id }]` key (extend `verticalSchema`; strict schemas mean this must be explicit).
- Resolve works via Gutendex, download the plain-text format, strip the Project Gutenberg header/footer, and cache the text.
- **Candidate selection (proposed, confirm in the sub-plan):** Claude proposes quotable passages from a chapter. Every candidate must then pass `locateQuote` against that same text or it is discarded. The passage is Tier 1 by construction (spec §8: "prefer harvesting from the texts themselves"), and the model can only *choose*, never *author*, quote text.
- Cross-check the Gutendex author against the subject's Wikidata ID to set `authorMatches`. Filter out anthologies and translations whose text isn't the author's.
- Insert with `INSERT OR IGNORE` on `(vertical_id, body_hash)`.

**2.2 Wikiquote misattribution check** — `src/verify/wikiquote.ts`
- MediaWiki API: parse the author page's "Misattributed" and "Disputed" sections, normalize each entry, and emit `listed-misattributed` evidence on a match. This runs **even for primary-text harvests** because the spec says hard-reject anything that appears there.
- Optional lead generator: sourced Wikiquote entries become `raw` items with `reference` evidence, and they still need Tier 1/2 to verify.

**2.3 `lantern harvest` and `lantern verify` commands**
- Both wrapped in `runStage`. Verify gathers evidence (2.1, 2.2), calls `decideQuote`, then `applyQuoteDecision`.
- Rejections are kept. Add `lantern verify --retry-insufficient` to re-open only `insufficient-evidence` rejects after new evidence sources are added. Every other reject reason stays final.

**2.4 Enrichment and fact-check** — `src/enrich/`, `prompts/`
- Prompts in version-controlled files: `prompts/literature/enrich.md`, `prompts/shared/fact-check.md`. The vertical `voice`, `post_shape`, and `banned_topics` are injected as context.
- Call 1 writes `{ hook, body, closer, alt_text }` as structured output. Call 2 gets **only** the stored sources plus the draft and returns unsupported claims.
- Gate: any unsupported claim **or** a non-empty `unsupportedNumbers(hook + body + closer, sourceExcerpts)` → `needs_review` with the reasons stored. This applies to every vertical, not just science, because dates in literature posts are numbers too.
- Model tier for each call is an open decision (below).

**2.5 Wikimedia image lookup** — `src/media/wikimedia.ts`
- Wikidata `P18` → Commons `imageinfo` + `extmetadata`. Map the license to the whitelist (`public-domain` | `cc0` | `cc-by`); anything else is rejected. Store attribution.
- Reject a short edge under 1500 px. Keep the original under `data/media/source/`.
- Fallback order for authors without a usable portrait: title page, manuscript page, period image of the setting. **Never generated.** Make `generateImage` refuse structurally when `subject.kind === 'author'` and give that refusal its own test.
- Never replace the image on an `approved` post.

**2.6 Composition** — `src/compose/`, one template per (vertical, format)
- Sharp + SVG text overlay for `square` (1200×1200) and `pin` (1000×1500). Shared margin system, two typefaces (bundle OFL-licensed fonts and record their licenses), consistent wordmark, scrim over busy images.
- Tests: exact output dimensions, text never overflows its box (measure before render and fail the rendition rather than shrink to illegibility), and the `renditions` row is replaced per format on re-run.
- Check the output on a real phone, then stop fiddling (spec §10).

**2.7 Captions** — `src/caption/facebook.ts`, `src/caption/pinterest.ts`
- Enforce `caption.text_max` / `title_max` from the channel config. Pinterest copy is written for search: plain keywords, no hashtag spam.
- Always append the AI disclosure for `generated` images, and the attribution when the license requires it.
- Re-run the fact-check gate on any caption that isn't a pure truncation of approved text.

### Phase 3 — Review UI

- `lantern review` serves `localhost:4321` using `node:http` and server-rendered HTML. No frontend framework unless it proves necessary.
- The page shows each rendition inside a true phone-scale frame (≈390×844 CSS px), every caption, sources with clickable links, gate failure reasons, and approve / reject (with reason) / edit.
- Edits to post text re-run the fact-check and numbers gates before approval is allowed. Every approve/reject writes an audit `run_log` row.
- **Resolve open decision #2 in this sub-plan before building.**
- *Done when:* approve or reject takes two clicks and the sources are visible.

### Phase 4 — Facebook publishing

- **Start the slow parts early:** create the Meta app and begin business verification and App Review during Phase 2. Review takes calendar time and needs a screencast of a working flow.
- `src/publish/types.ts`: the `Publisher` interface from spec §11. `src/publish/facebook.ts` does selection and formatting only.
- `lantern auth facebook`: short-lived user token → long-lived user token → `GET /me/accounts` → Page token, stored encrypted (open decision #4).
- `lantern queue --channel <slug>`: create `publications` using the spacing rules in spec §12 (30-day subject gap, 14-day work gap, kind variety, ±15 min jitter, ≥ 1 day cross-channel stagger). These rules are pure logic, so write them test-first.
- `lantern publish [--publication <id>]`: `scheduled` → `publishing` → `published` | `failed`, with backoff and a maximum of three attempts. `idempotency_key = sha256(post_id:channel_id)`.
- **Crash safety:** a row found stuck in `publishing` is never retried automatically. Facebook has no idempotency key, so the remote post may already exist. Mark the row for manual check (fail closed).
- `doctor` gains token validity via `GET /debug_token`.
- *Done when:* a post appears on the Page without you touching Meta's UI.

### Phase 5 — Automation

- Scheduled entries (Windows Task Scheduler on this machine, or cron on a host, per open decision #3): `publish` every 5 minutes, the content pipeline daily, `doctor` daily.
- Alerts (open decision #5) fire when any `doctor` check reports `fail`, a channel buffer drops under 30 days, or a publication fails.
- `lantern channel auto-publish <slug> --on` refuses unless ≥ 20 publications on **that channel** were human-approved. This is the per-channel gate from spec §2.5.
- *Done when:* it runs a full week untouched.

### Phase 6 — Pinterest

- OAuth plus `src/publish/pinterest.ts` (`POST /pins`). No new pipeline stages. The `pin` rendition and caption already exist from Phase 2.
- Pins want a destination `link` to the archive site, which the spec schedules for Phase 8 (open decision #7).
- *Done when:* the same approved post reaches Facebook and Pinterest on separate schedules. If this is painful, fix spec §5–6 before going further.

### Phase 7 — Science vertical

- Adds one harvester for fact items from `.gov`/`.edu`/NASA/NOAA/USGS/Smithsonian sources, plus `decideFact` alongside `decideQuote`: at least one Tier 1/2 source, numbers must match.
- Kid-safe gates: a programmatic readability score must meet `audience.reading_level` (e.g. Flesch-Kincaid grade ≤ 5), plus a `banned_topics` classifier pass. Either failure → `needs_review`.
- AI image generation fallback, for concepts only, with the provider behind a one-method interface.
- *Done when:* the vertical works from config + one harvester in about a day. If it takes longer, fix the abstraction instead of special-casing.

### Phase 8 — Archive site, video, YouTube Shorts

- Static archive site generated from the DB: one page per post, with the write-up, image, and **visible sources**. It also hosts rendition files (`renditions.public_url`).
- Reuse the Remotion setup from the brain-teaser reel pipeline; locate that repo first. `src/render/` adds the `short` format (1080×1920, under 60 s). TTS sits behind `synthesize(text): Promise<{ path: string; durationMs: number }>`.
- `src/publish/youtube.ts` uses `videos.insert`. `doctor` tracks quota headroom. `madeForKids` is set deliberately after reading current COPPA guidance.
- Do not start until Phases 1–7 are boring.

### Phase 9 — Instagram

- Container → `media_publish` via the same Meta app. Needs `public_url` from Phase 8. `doctor` tracks the 25-posts/24h limit.

### Phase 10 — Growth

- `src/publish/tiktok.ts` as an export-only adapter: a dated folder holding the 9:16 video and caption for manual upload.
- Email list on the archive site, and more verticals, only after existing channels have run clean for a month.

---

## Open decisions (need the user)

| # | Decision | Needed before | Notes |
|---|---|---|---|
| 1 | Final page names + handle check on FB / IG / YouTube / TikTok / Pinterest / .com at the same time | Creating any platform account (Phase 4 prep) | The env var names in config use the working names; renaming them later is cheap |
| 2 | How per-channel review maps onto post-level `posts.status` | Phase 3 sub-plan | Spec gates on the *channel* but `approved` is a *post* status. Proposal: channels with `auto_publish = 0` only queue posts a human approved **for that channel**, which needs a small `publication_reviews` table or a `needs_review` publication status |
| 3 | Where it runs unattended: this Windows PC via Task Scheduler, or a small always-on host | Phase 5 | A sleeping desktop silently stops posting, which is the exact failure the spec warns about |
| 4 | Token encryption at rest (Windows DPAPI vs. libsodium with a key in `.env`) | Phase 4 | |
| 5 | Alert channel (email, push, …) | Phase 5 | |
| 6 | Claude model tier for enrichment vs. fact-check | Phase 2.4 | Consult the `claude-api` skill; the fact-check can likely use a cheaper model with a tight rubric |
| 7 | Archive hosting, and whether a minimal archive ships with Pinterest in Phase 6 instead of Phase 8 | Phase 6 | Pinterest's value is mostly the link |
| 8 | TTS provider, or no narration at all | Phase 8 | |
| 9 | The two typefaces and wordmark | Phase 2.6 | Must be OFL or otherwise redistributable |
| 10 | Passage-selection strategy in 2.1 (Claude chooses, exact match verifies) | Phase 2.1 sub-plan | |

## Spec coverage check

| Spec section | Where it lands |
|---|---|
| §2 Non-negotiables | Global Constraints; B2 triggers; B3 gate; 2.4 fact-check; 2.5 image rules; Phase 5 per-channel gate |
| §3 Channels & branding | Config in A3; open decision #1 |
| §4 Stack & conventions | A1–A7; C0 |
| §5 Content model | A2 schema (unchanged from spec) |
| §6 Data model + indexes | A2 (`001`), B2 (`002`) |
| §7 Pipeline stages | `migrate`/`doctor` in A7; harvest/verify 2.3; enrich 2.4; media 2.5; compose 2.6; caption 2.7; review Phase 3; queue/publish Phase 4; render Phase 8 |
| §8 Verification | B1–B4; 2.1–2.3; Phase 7 facts |
| §9 Voice & safety | A3 schema; 2.4 prompts; Phase 7 readability + banned topics |
| §10 Image sourcing | 2.5, 2.6; Phase 7 generation fallback |
| §11 Platforms | Phases 4, 6, 8, 9, 10 |
| §12 Scheduling | Phase 4 `queue`; A6 buffer check; Phase 5 alerts |
| §13 Archive site | Phase 8; open decision #7 |
| §14 Build phases | Parts A–C, in order |
| §15 Working agreements | "How this plan is organized"; Part C opening ritual |

