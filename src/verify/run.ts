import type { Db } from '../db/connection.js';
import { EvidenceError, loadEvidence } from '../db/evidence.js';
import { hasWikiquoteCheck } from '../db/quotes.js';
import type { Logger } from '../lib/log.js';
import { parseRejectReason, reopenInsufficientEvidence, verifyQuoteItem } from './apply.js';

export interface VerifyOptions {
  /** First reopen quotes rejected only for insufficient evidence, so they are decided again. */
  retryInsufficient?: boolean;
  now?: () => Date;
  log?: Logger;
}

export interface VerifyReport {
  /** Raw quotes found for the vertical. */
  considered: number;
  verified: number;
  /** Rejections by reason. */
  rejected: Record<string, number>;
  /** Raw quotes left raw because no Wikiquote check was recorded for them. */
  unchecked: number;
  /** Raw quotes left raw because a stored evidence row is malformed. */
  malformed: number;
  reopened: number;
}

/**
 * Decides every raw quote in a vertical (spec section 7, `lantern verify`). A quote is decided only
 * when its Wikiquote Misattributed and Disputed check was recorded, and only from evidence that loads
 * cleanly: otherwise it stays raw and is counted, never decided on partial evidence. Each decision
 * goes through verifyQuoteItem, which runs the quote gate against the stored body.
 */
export function verifyVertical(db: Db, verticalId: number, options: VerifyOptions = {}): VerifyReport {
  const now = options.now ?? (() => new Date());
  let reopened = 0;
  if (options.retryInsufficient === true) {
    const rejected = db
      .prepare("SELECT id, reject_reason FROM items WHERE vertical_id = ? AND kind = 'quote' AND status = 'rejected' ORDER BY id")
      .all(verticalId) as { id: number; reject_reason: string | null }[];
    for (const item of rejected) {
      if (parseRejectReason(item.reject_reason ?? '').reason !== 'insufficient-evidence') continue;
      reopenInsufficientEvidence(db, item.id);
      reopened++;
    }
  }

  const raw = db
    .prepare("SELECT id FROM items WHERE vertical_id = ? AND kind = 'quote' AND status = 'raw' ORDER BY id")
    .pluck()
    .all(verticalId) as number[];
  const report: VerifyReport = { considered: raw.length, verified: 0, rejected: {}, unchecked: 0, malformed: 0, reopened };

  for (const itemId of raw) {
    if (!hasWikiquoteCheck(db, itemId)) {
      report.unchecked++;
      continue;
    }
    let evidence: ReturnType<typeof loadEvidence>;
    try {
      evidence = loadEvidence(db, itemId);
    } catch (err) {
      if (!(err instanceof EvidenceError)) throw err;
      report.malformed++;
      options.log?.warn('verify left a quote raw: malformed evidence', { itemId, error: err.message });
      continue;
    }
    const decision = verifyQuoteItem(db, itemId, evidence, now());
    if (decision.status === 'verified') report.verified++;
    else report.rejected[decision.reason] = (report.rejected[decision.reason] ?? 0) + 1;
  }
  return report;
}
