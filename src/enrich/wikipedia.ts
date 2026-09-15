import { z } from 'zod';
import { SourceStatusError, type HttpGet } from '../harvest/sources.js';
import type { HttpResult } from '../lib/http.js';

export interface WikiEndpoints {
  wikidata: string;
  wikipedia: string;
}

export const DEFAULT_WIKI_ENDPOINTS: WikiEndpoints = { wikidata: 'https://www.wikidata.org', wikipedia: 'https://en.wikipedia.org' };

/** Wikidata or Wikipedia answered, but not with the article a post needs. */
export class WikiLookupError extends Error {
  override name = 'WikiLookupError';
}

const QID = /^Q[1-9]\d*$/;

// Wikidata writes an empty map as [] in some answers, so both forms are accepted.
const emptyMap = z.tuple([]);
const entitySchema = z.object({
  id: z.string(),
  labels: z.union([z.record(z.string(), z.object({ value: z.string() })), emptyMap]).optional(),
  sitelinks: z.union([z.record(z.string(), z.object({ title: z.string() })), emptyMap]).optional(),
});
const entitiesSchema = z.object({ entities: z.record(z.string(), entitySchema) });
const searchSchema = z.object({ query: z.object({ search: z.array(z.object({ title: z.string() })) }) });
const articleSchema = z.object({
  query: z.object({
    pages: z.array(
      z.object({
        title: z.string(),
        missing: z.literal(true).optional(),
        invalid: z.literal(true).optional(),
        extract: z.string().optional(),
        revisions: z.array(z.object({ revid: z.number().int(), timestamp: z.string() })).optional(),
        pageprops: z.object({ wikibase_item: z.string().optional() }).optional(),
      }),
    ),
  }),
});
const apiErrorSchema = z.object({ error: z.object({ code: z.string(), info: z.string() }) });

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** A cached GET of a JSON answer. Only a 200 with the expected shape is cached; an API error answered with 200 is fetched again next time. */
async function getJson<T>(get: HttpGet, url: string, source: string, schema: z.ZodType<T>): Promise<{ data: T; fetchedAt: string }> {
  const result = await get(url, source, (r: HttpResult) => r.status === 200 && schema.safeParse(parseJson(r.body)).success);
  if (result.status !== 200) throw new SourceStatusError(result.url, result.status);
  const body = parseJson(result.body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const error = apiErrorSchema.safeParse(body);
    throw new WikiLookupError(error.success ? `${error.data.error.code} from ${url}: ${error.data.error.info}` : `unexpected answer from ${url}`);
  }
  return { data: parsed.data, fetchedAt: result.fetchedAt };
}

export function entitiesUrl(endpoints: WikiEndpoints, ids: readonly string[]): string {
  return `${endpoints.wikidata}/w/api.php?action=wbgetentities&ids=${ids.join('|')}&props=labels|sitelinks&languages=en&sitefilter=enwiki&format=json`;
}

interface EntityInfo {
  label: string | null;
  enwiki: string | null;
}

async function entityInfo(get: HttpGet, endpoints: WikiEndpoints, ids: readonly string[]): Promise<Map<string, EntityInfo>> {
  const { data } = await getJson(get, entitiesUrl(endpoints, ids), 'wikidata', entitiesSchema);
  const info = new Map<string, EntityInfo>();
  for (const entity of Object.values(data.entities)) {
    const labels = Array.isArray(entity.labels) ? undefined : entity.labels;
    const sitelinks = Array.isArray(entity.sitelinks) ? undefined : entity.sitelinks;
    info.set(entity.id, { label: labels?.['en']?.value ?? null, enwiki: sitelinks?.['enwiki']?.title ?? null });
  }
  return info;
}

/** The English Wikipedia article title of a Wikidata entity (an author's subject). */
export async function authorArticleTitle(get: HttpGet, endpoints: WikiEndpoints, qid: string): Promise<string> {
  if (!QID.test(qid)) throw new WikiLookupError(`${qid} is not a Wikidata id`);
  const title = (await entityInfo(get, endpoints, [qid])).get(qid)?.enwiki ?? null;
  if (title === null) throw new WikiLookupError(`${qid} has no English Wikipedia article`);
  return title;
}

/** The part of a Gutendex title that names the work: before any subtitle, without a trailing ", Complete". */
export function workSearchTitle(workTitle: string): string {
  return (workTitle.split(/[:;]/)[0] ?? '')
    .replace(/,\s*complete\s*$/i, '')
    .replace(/"/g, '')
    .trim();
}

/** A title compared without case, accents, curly apostrophes or extra spaces, so an accented title matches its plain spelling. */
export function foldTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u2018\u2019]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function workSearchUrl(endpoints: WikiEndpoints, authorQid: string, title: string): string {
  const query = `haswbstatement:P50=${authorQid} "${title}"`;
  return `${endpoints.wikidata}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=10&format=json&formatversion=2`;
}

export interface WorkArticle {
  qid: string;
  title: string;
}

/**
 * The Wikipedia article about a work: the first Wikidata item by the author (P50) found for the work's
 * title whose English label is that title and which has an English article. Editions and translations
 * have no English label or article, so they never match. Null when nothing matches.
 */
export async function workArticle(get: HttpGet, endpoints: WikiEndpoints, authorQid: string, workTitle: string): Promise<WorkArticle | null> {
  if (!QID.test(authorQid)) throw new WikiLookupError(`${authorQid} is not a Wikidata id`);
  const title = workSearchTitle(workTitle);
  if (title.length === 0) return null;
  const { data } = await getJson(get, workSearchUrl(endpoints, authorQid, title), 'wikidata', searchSchema);
  const hits = data.query.search.map((hit) => hit.title).filter((id) => QID.test(id));
  if (hits.length === 0) return null;
  const entities = await entityInfo(get, endpoints, hits);
  const wanted = foldTitle(title);
  for (const qid of hits) {
    const entity = entities.get(qid);
    if (entity?.enwiki != null && entity.label !== null && foldTitle(entity.label) === wanted) return { qid, title: entity.enwiki };
  }
  return null;
}

export function articleUrl(endpoints: WikiEndpoints, title: string): string {
  const titles = encodeURIComponent(title.replace(/ /g, '_'));
  return `${endpoints.wikipedia}/w/api.php?action=query&prop=extracts|revisions|pageprops&explaintext=1&rvprop=ids|timestamp&redirects=1&format=json&formatversion=2&titles=${titles}`;
}

/** A permanent link to one revision of an article, so a stored source never changes under its citation. */
export function revisionUrl(endpoints: WikiEndpoints, title: string, revid: number): string {
  return `${endpoints.wikipedia}/w/index.php?title=${encodeURIComponent(title.replace(/ /g, '_'))}&oldid=${revid}`;
}

export interface WikipediaArticle {
  title: string;
  qid: string;
  revid: number;
  /** The plain text of the article, as the extracts API gives it. */
  extract: string;
  /** The permanent link to this revision. */
  url: string;
  /** When the article was fetched (UTC ISO-8601), which is earlier than now when it came from the cache. */
  fetchedAt: string;
}

/**
 * The plain text and current revision of a Wikipedia article, from one request. Redirects are followed,
 * and the article must be the one Wikidata links to `qid`, so a title that now names something else is
 * refused rather than read.
 */
export async function fetchArticle(get: HttpGet, endpoints: WikiEndpoints, title: string, qid: string): Promise<WikipediaArticle> {
  const { data, fetchedAt } = await getJson(get, articleUrl(endpoints, title), 'wikipedia', articleSchema);
  const page = data.query.pages[0];
  if (page === undefined || data.query.pages.length !== 1) throw new WikiLookupError(`expected one Wikipedia page for ${title}`);
  if (page.missing === true || page.invalid === true) throw new WikiLookupError(`Wikipedia has no article ${title}`);
  const item = page.pageprops?.wikibase_item;
  if (item !== qid) throw new WikiLookupError(`the Wikipedia article ${page.title} is ${item ?? 'not linked to Wikidata'}, not ${qid}`);
  const revision = page.revisions?.[0];
  if (revision === undefined || page.extract === undefined || page.extract.trim() === '') {
    throw new WikiLookupError(`the Wikipedia article ${page.title} has no text or no revision`);
  }
  return { title: page.title, qid, revid: revision.revid, extract: page.extract, url: revisionUrl(endpoints, page.title, revision.revid), fetchedAt };
}
