import type { QuoteEvidence } from '../verify/quote-gate.js';
import type { Db } from './connection.js';

export class EvidenceError extends Error {
  override name = 'EvidenceError';
}

interface EvidenceRow {
  kind: string;
  citation: string;
  url: string | null;
  excerpt: string | null;
  location: string | null;
  author_matches: number | null;
  other_author: string | null;
}

/** Stores one piece of evidence for a quote item; returns the new row id. */
export function insertEvidence(db: Db, itemId: number, evidence: QuoteEvidence, now: Date = new Date()): number {
  const authorMatches =
    evidence.kind === 'primary-text' || evidence.kind === 'scholarly' ? (evidence.authorMatches ? 1 : 0) : null;
  const excerpt =
    evidence.kind === 'primary-text' || evidence.kind === 'scholarly' || evidence.kind === 'reference'
      ? (evidence.excerpt ?? null)
      : null;
  const otherAuthor = evidence.kind === 'attribution-conflict' ? evidence.otherAuthor : null;
  const location = evidence.kind === 'primary-text' ? (evidence.location ?? null) : null;
  return Number(
    db
      .prepare(
        `INSERT INTO item_evidence (item_id, kind, citation, url, excerpt, location, author_matches, other_author, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(itemId, evidence.kind, evidence.citation, evidence.url ?? null, excerpt, location, authorMatches, otherAuthor, now.toISOString())
      .lastInsertRowid,
  );
}

/**
 * The stored evidence for an item, in insertion order, rebuilt as QuoteEvidence for the gate. A row
 * missing a field its kind requires (for example one written by hand in SQL) throws instead of
 * being guessed at.
 */
export function loadEvidence(db: Db, itemId: number): QuoteEvidence[] {
  const rows = db
    .prepare(
      'SELECT kind, citation, url, excerpt, location, author_matches, other_author FROM item_evidence WHERE item_id = ? ORDER BY id',
    )
    .all(itemId) as EvidenceRow[];
  return rows.map((row): QuoteEvidence => {
    const url = row.url === null ? {} : { url: row.url };
    const excerpt = row.excerpt === null ? {} : { excerpt: row.excerpt };
    switch (row.kind) {
      case 'primary-text':
        if (row.excerpt === null || row.author_matches === null) {
          throw new EvidenceError(`primary-text evidence for item ${itemId} lacks an excerpt or author_matches`);
        }
        return {
          kind: 'primary-text',
          citation: row.citation,
          ...url,
          excerpt: row.excerpt,
          ...(row.location === null ? {} : { location: row.location }),
          authorMatches: row.author_matches === 1,
        };
      case 'scholarly':
        if (row.author_matches === null) throw new EvidenceError(`scholarly evidence for item ${itemId} lacks author_matches`);
        return { kind: 'scholarly', citation: row.citation, ...url, ...excerpt, authorMatches: row.author_matches === 1 };
      case 'reference':
        return { kind: 'reference', citation: row.citation, ...url, ...excerpt };
      case 'listed-misattributed':
        return { kind: 'listed-misattributed', citation: row.citation, ...url };
      case 'attribution-conflict':
        if (row.other_author === null) {
          throw new EvidenceError(`attribution-conflict evidence for item ${itemId} lacks other_author`);
        }
        return { kind: 'attribution-conflict', citation: row.citation, ...url, otherAuthor: row.other_author };
      default:
        throw new EvidenceError(`unknown evidence kind ${row.kind} for item ${itemId}`);
    }
  });
}
