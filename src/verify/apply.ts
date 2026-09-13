import { insertSource } from '../db/sources.js';
import type { Db } from '../db/connection.js';
import type { QuoteDecision } from './quote-gate.js';

export class ItemNotFoundError extends Error {
  override name = 'ItemNotFoundError';

  constructor(readonly itemId: number) {
    super(`item ${itemId} not found`);
  }
}

export class ItemNotRawError extends Error {
  override name = 'ItemNotRawError';

  constructor(
    readonly itemId: number,
    readonly status: string,
  ) {
    super(`item ${itemId} is ${status}; only raw items can be decided`);
  }
}

export class NotAQuoteError extends Error {
  override name = 'NotAQuoteError';

  constructor(
    readonly itemId: number,
    readonly kind: string,
  ) {
    super(`item ${itemId} is a ${kind}, not a quote`);
  }
}

export class NotReopenableError extends Error {
  override name = 'NotReopenableError';

  constructor(
    readonly itemId: number,
    readonly why: string,
  ) {
    super(`item ${itemId} cannot be reopened: ${why}`);
  }
}

/** reject_reason is stored as "<reason>: <detail>"; this is the one place that reads it. */
export function parseRejectReason(text: string): { reason: string; detail: string } {
  const at = text.indexOf(': ');
  return at === -1 ? { reason: text, detail: '' } : { reason: text.slice(0, at), detail: text.slice(at + 2) };
}

interface ItemRow {
  status: string;
  kind: string;
  reject_reason: string | null;
}

function loadQuote(db: Db, itemId: number): ItemRow {
  const item = db.prepare('SELECT status, kind, reject_reason FROM items WHERE id = ?').get(itemId) as
    | ItemRow
    | undefined;
  if (!item) throw new ItemNotFoundError(itemId);
  if (item.kind !== 'quote') throw new NotAQuoteError(itemId, item.kind);
  return item;
}

/** The only code path that moves a quote item out of 'raw'. */
export function applyQuoteDecision(db: Db, itemId: number, decision: QuoteDecision, now: Date = new Date()): void {
  db.transaction(() => {
    const item = loadQuote(db, itemId);
    if (item.status !== 'raw') throw new ItemNotRawError(itemId, item.status);

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

/**
 * Moves a quote rejected for insufficient evidence back to 'raw' so it can be re-verified once
 * better evidence exists. Every other rejection reason is final, and raw or verified items are
 * refused.
 */
export function reopenInsufficientEvidence(db: Db, itemId: number): void {
  db.transaction(() => {
    const item = loadQuote(db, itemId);
    if (item.status !== 'rejected') throw new NotReopenableError(itemId, `status is ${item.status}`);
    const { reason } = parseRejectReason(item.reject_reason ?? '');
    if (reason !== 'insufficient-evidence') {
      throw new NotReopenableError(itemId, `rejected as ${reason}, which is final`);
    }
    db.prepare("UPDATE items SET status = 'raw', reject_reason = NULL WHERE id = ?").run(itemId);
  })();
}
