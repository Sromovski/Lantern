import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.js';
import { enrichSchema } from '../../src/config/schema.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const valid = { writer_model: 'claude-opus-5', checker_model: 'claude-sonnet-5', author_article_chars: 30000, work_article_chars: 18000 };

describe('enrich config', () => {
  it('loads the chosen writer and checker models for literature, and no enrich section for science', () => {
    const verticals = loadConfig(ROOT).verticals;
    expect(verticals.find((v) => v.slug === 'literature')?.enrich).toEqual(valid);
    expect(verticals.find((v) => v.slug === 'science-curious')?.enrich).toBeUndefined();
  });

  it('accepts a valid enrich section', () => {
    expect(enrichSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['an empty writer model', { writer_model: '' }],
    ['an article budget under 1000 characters', { author_article_chars: 500 }],
    ['a fractional article budget', { work_article_chars: 1000.5 }],
    ['an unknown key', { extra: true }],
  ])('rejects %s', (_label, change) => {
    expect(enrichSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});
