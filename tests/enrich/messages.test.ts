import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.js';
import { loadEnrichPrompts } from '../../src/enrich/anthropic.js';
import type { SourceParagraph } from '../../src/enrich/context.js';
import type { Draft } from '../../src/enrich/draft.js';
import { checkerMessage, fillPrompt, reviseMessage, writerMessage } from '../../src/enrich/messages.js';
import type { WikipediaArticle } from '../../src/enrich/wikipedia.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VOICE = { voice: '  Warm and precise.\n', post_shape: { hook: '1 sentence', body: '2-4 short paragraphs', closer: '1 question' }, banned_topics: [] };
const QUOTE = { body: 'It was the best of times.', author: 'Charles Dickens', workTitle: 'A Tale of Two Cities' };
const ARTICLE: WikipediaArticle = {
  title: 'Charles Dickens',
  qid: 'Q5686',
  revid: 1,
  extract: '',
  url: 'https://en.wikipedia.org/w/index.php?title=Charles_Dickens&oldid=1',
  fetchedAt: '2026-09-15T00:00:00.000Z',
};
const PARAGRAPHS: SourceParagraph[] = [
  { id: 'S1', article: ARTICLE, section: 'Lead', text: 'Dickens was an English novelist.' },
  { id: 'S2', article: ARTICLE, section: 'Early life', text: 'Dickens was born in Portsmouth.' },
];
const DRAFT: Draft = { hook: { text: 'A hook.', sources: ['S1'] }, body: [], closer: { text: 'A closer?', sources: [] } };

describe('fillPrompt', () => {
  it('fills the voice, the post shape and the banned topics', () => {
    expect(fillPrompt('{{voice}} | {{hook}} | {{body}} | {{closer}}\n{{banned_topics}}', VOICE)).toBe(
      'Warm and precise. | 1 sentence | 2-4 short paragraphs | 1 question\n- none',
    );
    expect(fillPrompt('{{banned_topics}}', { ...VOICE, banned_topics: ['politics', 'weapons'] })).toBe('- politics\n- weapons');
    expect(fillPrompt('{{voice}}', { ...VOICE, voice: 'Costs $1 and $& nothing.' })).toBe('Costs $1 and $& nothing.');
  });

  it('refuses an unknown placeholder', () => {
    expect(() => fillPrompt('Write in {{tone}}.', VOICE)).toThrow('prompt has an unknown placeholder {{tone}}');
  });

  it('fills every committed prompt with every configured vertical', () => {
    const prompts = loadEnrichPrompts(ROOT, 'literature');
    for (const vertical of loadConfig(ROOT).verticals) {
      for (const prompt of [prompts.write, prompts.revise, prompts.check]) expect(fillPrompt(prompt, vertical)).not.toContain('{{');
    }
  });
});

describe('model messages', () => {
  it('gives the writer the quotation, author, work and labelled paragraphs', () => {
    expect(writerMessage(QUOTE, PARAGRAPHS)).toBe(
      [
        'Quotation: It was the best of times.',
        'Author: Charles Dickens',
        'Work: A Tale of Two Cities',
        '',
        'Source paragraphs:',
        '',
        '[S1] (Charles Dickens: Lead) Dickens was an English novelist.',
        '',
        '[S2] (Charles Dickens: Early life) Dickens was born in Portsmouth.',
      ].join('\n'),
    );
  });

  it('gives the reviser the same, then the draft and the problems', () => {
    expect(reviseMessage(QUOTE, PARAGRAPHS, DRAFT, ['first problem', 'second problem'])).toBe(
      `${writerMessage(QUOTE, PARAGRAPHS)}\n\nDraft:\n${JSON.stringify(DRAFT, null, 2)}\n\nProblems the reviewer found:\n- first problem\n- second problem`,
    );
  });

  it('gives the checker only the quotation, the cited paragraphs and the numbered sentences', () => {
    const sentences = [
      { n: 1, part: 'hook', text: 'A hook.' },
      { n: 2, part: 'closer', text: 'A closer?' },
    ];
    expect(checkerMessage(QUOTE, PARAGRAPHS.slice(1), sentences)).toBe(
      [
        'Source paragraphs:',
        '',
        '[Q] (the quotation, from A Tale of Two Cities by Charles Dickens) It was the best of times.',
        '',
        '[S2] (Charles Dickens: Early life) Dickens was born in Portsmouth.',
        '',
        'Draft sentences:',
        '(1) A hook.',
        '(2) A closer?',
      ].join('\n'),
    );
  });
});
