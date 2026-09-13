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
