import { z } from 'zod';
import { SourceStatusError, type HttpGet } from '../harvest/sources.js';
import type { HttpResult } from '../lib/http.js';

export interface MediaEndpoints {
  wikidata: string;
  commons: string;
}

export const DEFAULT_MEDIA_ENDPOINTS: MediaEndpoints = { wikidata: 'https://www.wikidata.org', commons: 'https://commons.wikimedia.org' };

/** Commons has no image for a subject that meets the rules, or an answer could not be used. */
export class ImageLookupError extends Error {
  override name = 'ImageLookupError';
}

/** Spec section 2.3 (user decision 2026-09-15): public domain or CC0 only, so a caption carries no licence obligation. */
export type ImageLicense = 'public-domain' | 'cc0';

/** A source image must survive being cropped to 1:1 and 9:16 (spec section 10). */
export const MIN_SHORT_EDGE = 1500;

/** Still images only: a video or an SVG is not a photograph of the subject, and a PDF or DjVu is a book scan. */
export const STILL_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/tiff'] as const;

/**
 * The largest original worth keeping. Commons holds archival scans of hundreds of megabytes (the 1870
 * Austen engraving is 83 MB), which are far past what a 1200 px rendition needs; the next candidate is
 * taken instead. The media stage passes the same cap to the download, so nothing larger arrives anyway.
 */
export const MAX_IMAGE_BYTES = 64 * 1024 ** 2;

/** Wording that means someone claims rights in this reproduction, whatever the licence tag says (spec section 10). */
const CLAIMED = /copyright claim|copyright is claimed|personality rights|trademark/i;

/** Commons licence values (extmetadata `License`) this project may publish. */
export function mappedLicense(value: string): ImageLicense | null {
  const license = value.trim().toLowerCase();
  if (/^pd(-|$)/.test(license)) return 'public-domain';
  if (/^cc0(-|$)/.test(license)) return 'cc0';
  return null;
}

const metadataSchema = z.record(z.string(), z.object({ value: z.unknown() }));
const imageInfoSchema = z.object({
  url: z.string(),
  descriptionurl: z.string(),
  mime: z.string(),
  size: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  sha1: z.string(),
  extmetadata: metadataSchema.optional(),
});
const pagesSchema = z.object({
  query: z.object({ pages: z.array(z.object({ title: z.string(), missing: z.literal(true).optional(), imageinfo: z.array(imageInfoSchema).optional() })) }),
});
const entitiesSchema = z.object({
  entities: z.record(z.string(), z.object({ id: z.string(), claims: z.record(z.string(), z.array(z.unknown())).optional() })),
});
const portraitClaimsSchema = z.array(z.object({ mainsnak: z.object({ datavalue: z.object({ value: z.string() }).optional() }), rank: z.string() }));
const apiErrorSchema = z.object({ error: z.object({ code: z.string(), info: z.string() }) });

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** A cached GET of a JSON answer. Only a 200 of the expected shape is cached, so an API error answered with 200 is fetched again. */
async function getJson<T>(get: HttpGet, url: string, source: string, schema: z.ZodType<T>): Promise<T> {
  const result = await get(url, source, (r: HttpResult) => r.status === 200 && schema.safeParse(parseJson(r.body)).success);
  if (result.status !== 200) throw new SourceStatusError(result.url, result.status);
  const body = parseJson(result.body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const error = apiErrorSchema.safeParse(body);
    throw new ImageLookupError(error.success ? `${error.data.error.code} from ${url}: ${error.data.error.info}` : `unexpected answer from ${url}`);
  }
  return parsed.data;
}

export function claimsUrl(endpoints: MediaEndpoints, qid: string): string {
  return `${endpoints.wikidata}/w/api.php?action=wbgetentities&ids=${qid}&props=claims&format=json`;
}

/** The file titles of a subject's Wikidata images (P18), preferred rank first, deprecated ones dropped. */
export async function portraitTitles(get: HttpGet, endpoints: MediaEndpoints, qid: string): Promise<string[]> {
  if (!/^Q[1-9]\d*$/.test(qid)) throw new ImageLookupError(`${qid} is not a Wikidata id`);
  const { entities } = await getJson(get, claimsUrl(endpoints, qid), 'wikidata', entitiesSchema);
  const claims = entities[qid]?.claims?.['P18'];
  if (claims === undefined) return [];
  const parsed = portraitClaimsSchema.safeParse(claims);
  if (!parsed.success) throw new ImageLookupError(`${qid} has P18 claims in an unexpected shape`);
  const ranked = parsed.data.filter((claim) => claim.rank !== 'deprecated' && claim.mainsnak.datavalue !== undefined);
  const preferred = ranked.filter((claim) => claim.rank === 'preferred');
  const rest = ranked.filter((claim) => claim.rank !== 'preferred');
  return [...preferred, ...rest].map((claim) => `File:${claim.mainsnak.datavalue!.value}`);
}

export function imageInfoUrl(endpoints: MediaEndpoints, titles: readonly string[]): string {
  const query = encodeURIComponent(titles.join('|'));
  return `${endpoints.commons}/w/api.php?action=query&prop=imageinfo&iiprop=url|size|mime|sha1|extmetadata&iiextmetadatalanguage=en&format=json&formatversion=2&titles=${query}`;
}

/** Files Commons records as depicting the subject (structured data P180). One page of results, best-scoring first. */
export function depictsSearchUrl(endpoints: MediaEndpoints, qid: string, limit: number): string {
  const search = encodeURIComponent(`haswbstatement:P180=${qid}`);
  return `${endpoints.commons}/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${search}&gsrlimit=${limit}&prop=imageinfo&iiprop=url|size|mime|sha1|extmetadata&iiextmetadatalanguage=en&format=json&formatversion=2`;
}

/** How many depicts results one lookup reads. Commons scores by relevance, and the rules keep only a few. */
export const DEPICTS_LIMIT = 50;

export interface CommonsImage {
  /** The Commons file title, "File:..." included. */
  title: string;
  /** The file itself, without the tracking query Commons appends. */
  fileUrl: string;
  /** The Commons file page, which shows the licence and the credit. */
  filePageUrl: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  license: ImageLicense;
  /** The creator as Commons states it, plain text; null when Commons names none. */
  attribution: string | null;
}

/** extmetadata values are HTML; this is the plain text, with runs of whitespace collapsed. */
function plainText(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const field = (metadata: Record<string, { value: unknown }> | undefined, name: string) => plainText(metadata?.[name]?.value);

/** Why an image cannot be used, or null when it can be (spec sections 2.3 and 10). */
export function imageRefusal(info: z.infer<typeof imageInfoSchema>, title: string): string | null {
  const metadata = info.extmetadata;
  const license = mappedLicense(field(metadata, 'License'));
  if (license === null) {
    const shown = field(metadata, 'License') || 'none';
    return `${title} is licensed ${shown}, not public domain or CC0`;
  }
  if (!STILL_IMAGE_TYPES.includes(info.mime as (typeof STILL_IMAGE_TYPES)[number])) return `${title} is ${info.mime}, not a still image`;
  const short = Math.min(info.width, info.height);
  if (short < MIN_SHORT_EDGE) return `${title} is ${info.width}x${info.height}; the short edge must be at least ${MIN_SHORT_EDGE} px`;
  if (info.height <= info.width) return `${title} is ${info.width}x${info.height}; a portrait must be taller than it is wide`;
  if (info.size > MAX_IMAGE_BYTES) return `${title} is ${info.size} bytes; the file must be at most ${MAX_IMAGE_BYTES} bytes`;
  const restrictions = field(metadata, 'Restrictions');
  if (restrictions !== '') return `${title} carries the Commons restriction ${restrictions}`;
  const text = Object.values(metadata ?? {})
    .map((entry) => plainText(entry.value))
    .join(' ');
  if (CLAIMED.test(text)) return `${title} carries a third-party rights claim on the reproduction`;
  return null;
}

function toImage(title: string, info: z.infer<typeof imageInfoSchema>): CommonsImage {
  const metadata = info.extmetadata;
  const artist = field(metadata, 'Artist');
  return {
    title,
    fileUrl: info.url.split('?')[0] ?? info.url,
    filePageUrl: info.descriptionurl,
    mime: info.mime,
    bytes: info.size,
    width: info.width,
    height: info.height,
    license: mappedLicense(field(metadata, 'License'))!,
    attribution: artist === '' ? null : artist,
  };
}

export interface ImageCandidate {
  title: string;
  info: z.infer<typeof imageInfoSchema>;
}

async function candidates(get: HttpGet, url: string): Promise<ImageCandidate[]> {
  const { query } = await getJson(get, url, 'commons', pagesSchema);
  return query.pages.flatMap((page) => {
    const info = page.imageinfo?.[0];
    return page.missing === true || info === undefined ? [] : [{ title: page.title, info }];
  });
}

export interface PortraitChoice {
  image: CommonsImage;
  /** Why each rejected candidate was rejected, in the order they were considered. */
  refused: string[];
  /** Whether the image came from Wikidata's P18 or from the Commons depicts search. */
  from: 'wikidata' | 'depicts';
}

/**
 * The portrait to publish for a subject (spec section 10, user decision 2026-09-15).
 *
 * Wikidata's own images (P18) are tried first, in rank order. If none of them passes the rules, the
 * files Commons records as depicting the subject are read in one search, and the largest that passes
 * wins. A subject with nothing usable raises ImageLookupError rather than settling for a file this
 * project may not publish; no image is ever generated for a person (spec section 9).
 */
export async function bestPortrait(get: HttpGet, endpoints: MediaEndpoints, qid: string): Promise<PortraitChoice> {
  const refused: string[] = [];
  const titles = await portraitTitles(get, endpoints, qid);
  if (titles.length > 0) {
    const named = await candidates(get, imageInfoUrl(endpoints, titles));
    // Commons answers in its own order, so the P18 order is restored here.
    for (const title of titles) {
      const candidate = named.find((entry) => entry.title === title);
      if (candidate === undefined) {
        refused.push(`${title} is not on Commons`);
        continue;
      }
      const refusal = imageRefusal(candidate.info, title);
      if (refusal === null) return { image: toImage(title, candidate.info), refused, from: 'wikidata' };
      refused.push(refusal);
    }
  }

  const depicted = await candidates(get, depictsSearchUrl(endpoints, qid, DEPICTS_LIMIT));
  const usable: CommonsImage[] = [];
  for (const candidate of depicted) {
    const refusal = imageRefusal(candidate.info, candidate.title);
    if (refusal === null) usable.push(toImage(candidate.title, candidate.info));
    else refused.push(refusal);
  }
  usable.sort((a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height));
  const best = usable[0];
  if (best === undefined) throw new ImageLookupError(`no Commons image for ${qid} meets the rules (${refused.length} refused)`);
  return { image: best, refused, from: 'depicts' };
}
