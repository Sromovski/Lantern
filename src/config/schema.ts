import { z } from 'zod';

export const PLATFORMS = ['facebook', 'pinterest', 'youtube', 'instagram', 'tiktok'] as const;
export const RENDITION_FORMATS = ['square', 'portrait', 'pin', 'short', 'landscape'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type RenditionFormat = (typeof RENDITION_FORMATS)[number];

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24h)');

export const harvestAuthorSchema = z
  .strictObject({
    name: z.string().min(1),
    /** Exactly as Gutendex lists the author ("Surname, Given"); matched with the years to set authorMatches. */
    gutendex_name: z.string().regex(/^[^,]+, [^,]+$/, 'must be "Surname, Given" as Gutendex lists it'),
    wikidata_id: z.string().regex(/^Q[1-9]\d*$/, 'must be a Wikidata Q-number'),
    birth_year: z.number().int(),
    death_year: z.number().int(),
  })
  .refine((a) => a.death_year >= a.birth_year, { message: 'death_year must not be before birth_year', path: ['death_year'] });

export const harvestSchema = z.strictObject({
  authors: z.array(harvestAuthorSchema).min(1),
  picker: z.strictObject({
    model: z.string().min(1),
    batch_size: z.number().int().min(10).max(500),
    max_batches_per_work: z.number().int().min(1).max(50),
  }),
});

export const verticalSchema = z
  .strictObject({
    slug,
    name: z.string().min(1),
    kid_safe: z.boolean(),
    audience: z.strictObject({
      reading_level: z.string().regex(/^grade-\d{1,2}$/).optional(),
      age_range: z.tuple([z.number().int(), z.number().int()]).optional(),
    }),
    voice: z.string().min(1),
    post_shape: z.strictObject({ hook: z.string(), body: z.string(), closer: z.string() }),
    banned_topics: z.array(z.string().min(1)).default([]),
    image: z.strictObject({
      style: z.string().min(1),
      generated_disclosure: z.literal(true),
    }),
    harvest: harvestSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kid_safe && (!v.audience.reading_level || v.banned_topics.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['kid_safe'],
        message: 'kid_safe verticals require audience.reading_level and at least one banned_topics entry',
      });
    }
  });

export const channelSchema = z
  .strictObject({
    vertical: slug,
    platform: z.enum(PLATFORMS),
    handle: z.string().min(1).optional(),
    account_ref: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an env var NAME, not a value'),
    formats: z.array(z.enum(RENDITION_FORMATS)).min(1),
    cadence: z.strictObject({
      posts_per_day: z.number().int().min(1).max(2),
      times: z.array(hhmm).min(1),
    }),
    made_for_kids: z.boolean().optional(),
    caption: z.strictObject({
      title_max: z.number().int().positive().optional(),
      text_max: z.number().int().positive(),
    }),
  })
  .superRefine((c, ctx) => {
    if (c.cadence.times.length !== c.cadence.posts_per_day) {
      ctx.addIssue({
        code: 'custom',
        path: ['cadence', 'times'],
        message: `must list exactly posts_per_day (${c.cadence.posts_per_day}) times`,
      });
    }
    if (c.platform === 'youtube' && c.made_for_kids === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['made_for_kids'],
        message: 'youtube channels must set made_for_kids explicitly (spec §11)',
      });
    }
  });

export type VerticalConfig = z.infer<typeof verticalSchema>;
export type ChannelConfig = z.infer<typeof channelSchema>;
export type HarvestConfig = z.infer<typeof harvestSchema>;
