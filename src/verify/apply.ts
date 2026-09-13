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
