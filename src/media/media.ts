import { join } from 'node:path';
import type { Db } from '../db/connection.js';
import { attachImage, insertImage, postsNeedingImage, subjectImage, type PostNeedingImage } from '../db/images.js';
import { SourceStatusError, type HttpGet } from '../harvest/sources.js';
import { DownloadStatusError, DownloadTooLargeError } from '../lib/download.js';
import type { Logger } from '../lib/log.js';
import { bestPortrait, ImageLookupError, type CommonsImage, type MediaEndpoints } from './commons.js';

/** Streams a url to a path and reports what landed there; `downloadWithRetry` has this shape. */
export type DownloadFn = (url: string, destPath: string) => Promise<{ bytes: number; sha256: string }>;

export interface MediaOptions {
  db: Db;
  verticalId: number;
  get: HttpGet;
  endpoints: MediaEndpoints;
  download: DownloadFn;
  /** The media directory; originals are kept under its `source/` folder, never in the cache. */
  mediaDir: string;
  /** The most posts to give an image in one run. */
  limit: number;
  now?: () => Date;
  log?: Logger;
}

export type PostOutcome =
  | { status: 'attached'; imageId: number; title: string; from: 'wikidata' | 'depicts'; refused: number }
  | { status: 'reused'; imageId: number }
  | { status: 'failed'; reason: string };

export interface PostImageReport {
  postId: number;
  author: string;
  outcome: PostOutcome;
}

export interface MediaReport {
  /** Posts without an image that this run took up. */
  considered: number;
  attached: number;
  reused: number;
  failed: number;
  items: PostImageReport[];
}

const EXTENSIONS: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/tiff': '.tif' };

/** Where a subject's original is kept, relative to the media directory: readable, and the same every run. */
export function imagePath(subjectSlug: string, image: CommonsImage): string {
  const name = image.title
    .replace(/^File:/, '')
    .replace(/\.[A-Za-z0-9]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return `source/${subjectSlug}-${name}${EXTENSIONS[image.mime] ?? '.bin'}`;
}

/**
 * Gives a vertical's posts their source image (spec section 7, `lantern media`).
 *
 * Each post without an image is taken oldest first. A subject whose image is already stored reuses it,
 * so one portrait serves all of that author's posts (user decision 2026-09-15) and nothing is
 * downloaded twice. Otherwise the portrait is chosen from Wikidata's P18, or from the files Commons
 * records as depicting the subject, and only a public-domain or CC0 still image large enough to crop
 * both ways can win (spec sections 2.3 and 10). The original is streamed under `data/media/source/`,
 * never into the response cache, and is refused when its size does not match what Commons reported.
 *
 * A post whose image cannot be found or downloaded is reported as failed and keeps no image; the run
 * continues, and the next run tries it again. Any other error stops the run.
 */
export async function mediaVertical(options: MediaOptions): Promise<MediaReport> {
  const now = options.now ?? (() => new Date());
  const posts = postsNeedingImage(options.db, options.verticalId, options.limit);
  const report: MediaReport = { considered: posts.length, attached: 0, reused: 0, failed: 0, items: [] };
  for (const post of posts) {
    let outcome: PostOutcome;
    try {
      outcome = await imageFor(options, post, now());
    } catch (err) {
      if (
        !(
          err instanceof ImageLookupError ||
          err instanceof SourceStatusError ||
          err instanceof DownloadStatusError ||
          err instanceof DownloadTooLargeError
        )
      ) {
        throw err;
      }
      outcome = { status: 'failed', reason: err.message };
    }
    if (outcome.status === 'attached') report.attached++;
    else if (outcome.status === 'reused') report.reused++;
    else report.failed++;
    report.items.push({ postId: post.postId, author: post.author, outcome });
    options.log?.info('media post', { postId: post.postId, outcome });
  }
  return report;
}

async function imageFor(options: MediaOptions, post: PostNeedingImage, now: Date): Promise<PostOutcome> {
  const stored = subjectImage(options.db, post.subjectId);
  if (stored !== undefined) {
    attachImage(options.db, post.postId, stored.id);
    return { status: 'reused', imageId: stored.id };
  }

  const choice = await bestPortrait(options.get, options.endpoints, post.wikidataId);
  const localPath = imagePath(post.subjectSlug, choice.image);
  const downloaded = await options.download(choice.image.fileUrl, join(options.mediaDir, localPath));
  if (downloaded.bytes !== choice.image.bytes) {
    throw new ImageLookupError(`${choice.image.title} downloaded as ${downloaded.bytes} bytes, but Commons reported ${choice.image.bytes}`);
  }
  options.log?.info('media downloaded an image', {
    subjectId: post.subjectId,
    title: choice.image.title,
    from: choice.from,
    refused: choice.refused,
  });
  const imageId = insertImage(
    options.db,
    {
      subjectId: post.subjectId,
      origin: 'wikimedia',
      sourceUrl: choice.image.fileUrl,
      filePageUrl: choice.image.filePageUrl,
      license: choice.image.license,
      attribution: choice.image.attribution,
      localPath,
      width: choice.image.width,
      height: choice.image.height,
      mime: choice.image.mime,
      bytes: downloaded.bytes,
      sha256: downloaded.sha256,
    },
    now,
  );
  attachImage(options.db, post.postId, imageId);
  return { status: 'attached', imageId, title: choice.image.title, from: choice.from, refused: choice.refused.length };
}
