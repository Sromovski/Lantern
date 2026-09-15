import { z } from 'zod';

/** One part of a draft: its text and the labels (S1, S2, ...) of the source paragraphs its facts come from. */
export const draftPartSchema = z.object({ text: z.string(), sources: z.array(z.string()) });

/** The writer's structured output: the platform-neutral post (spec section 5). */
export const draftSchema = z.object({ hook: draftPartSchema, body: z.array(draftPartSchema), closer: draftPartSchema });

/** The fact checker's structured output: one verdict per numbered sentence of the draft. */
export const checkSchema = z.object({
  sentences: z.array(
    z.object({
      id: z.number().int(),
      kind: z.enum(['fact', 'interpretation', 'other']),
      supported: z.boolean(),
      sources: z.array(z.string()),
      problem: z.string(),
    }),
  ),
});

export type DraftPart = z.infer<typeof draftPartSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type Check = z.infer<typeof checkSchema>;

export interface NamedPart {
  /** "hook", "body paragraph 1", ..., "closer" */
  name: string;
  part: DraftPart;
}

export function draftParts(draft: Draft): NamedPart[] {
  return [
    { name: 'hook', part: draft.hook },
    ...draft.body.map((part, i) => ({ name: `body paragraph ${i + 1}`, part })),
    { name: 'closer', part: draft.closer },
  ];
}

const SENTENCES = new Intl.Segmenter('en', { granularity: 'sentence' });
/** A segment ending like this stopped at an abbreviation or an initial, not at the end of a sentence. */
const ABBREVIATION_END = /(?:^|[\s(])(?:Mr|Mrs|Ms|Dr|St|Messrs|Mme|Mlle|Col|Capt|Gen|Rev|Hon|Esq|Jr|Sr|Mt|No|Vol|Ch|ca?|vs|[A-Z])\.$/;

/** The sentences of a text, keeping "Mr. Dickens" and "J. M. W. Turner" whole. */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let carry = '';
  for (const { segment } of SENTENCES.segment(text)) {
    carry += segment;
    if (ABBREVIATION_END.test(carry.trimEnd())) continue;
    if (carry.trim() !== '') sentences.push(carry.trim());
    carry = '';
  }
  if (carry.trim() !== '') sentences.push(carry.trim());
  return sentences;
}

export interface DraftSentence {
  /** 1-based, across the whole draft. */
  n: number;
  part: string;
  text: string;
}

/** Every sentence of the draft in order, numbered as the checker sees them. */
export function draftSentences(draft: Draft): DraftSentence[] {
  let n = 0;
  return draftParts(draft).flatMap(({ name, part }) => splitSentences(part.text).map((text) => ({ n: ++n, part: name, text })));
}
