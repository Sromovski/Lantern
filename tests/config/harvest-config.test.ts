import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.js';
import { harvestSchema } from '../../src/config/schema.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const valid = {
  authors: [
    { name: 'Charles Dickens', gutendex_name: 'Dickens, Charles', wikidata_id: 'Q5686', birth_year: 1812, death_year: 1870 },
  ],
  picker: { model: 'claude-sonnet-5', batch_size: 150, max_batches_per_work: 6, picks_per_batch: 3 },
};

describe('harvest config', () => {
  it('loads the four chosen literature authors and the picker settings', () => {
    const literature = loadConfig(ROOT).verticals.find((v) => v.slug === 'literature');
    expect(literature?.harvest?.authors.map((a) => a.wikidata_id)).toEqual(['Q5686', 'Q36322', 'Q7245', 'Q30875']);
    expect(literature?.harvest?.authors.map((a) => a.gutendex_name)).toEqual([
      'Dickens, Charles',
      'Austen, Jane',
      'Twain, Mark',
      'Wilde, Oscar',
    ]);
    expect(literature?.harvest?.picker).toEqual({ model: 'claude-sonnet-5', batch_size: 150, max_batches_per_work: 6, picks_per_batch: 3 });
  });

  it('accepts a valid harvest section', () => {
    expect(harvestSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['a lowercase Wikidata id', { authors: [{ ...valid.authors[0]!, wikidata_id: 'q5686' }] }],
    ['a Gutendex name not in "Surname, Given" form', { authors: [{ ...valid.authors[0]!, gutendex_name: 'Charles Dickens' }] }],
    ['a death year before the birth year', { authors: [{ ...valid.authors[0]!, death_year: 1800 }] }],
    ['an unknown key', { extra: true }],
  ])('rejects %s', (_label, change) => {
    expect(harvestSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});
