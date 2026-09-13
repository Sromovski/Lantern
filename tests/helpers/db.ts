import { openDb, type Db } from '../../src/db/connection.js';
import { migrate, MIGRATIONS_DIR } from '../../src/db/migrate.js';
import { bodyHash } from '../../src/verify/normalize.js';

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
