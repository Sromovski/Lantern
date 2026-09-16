import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import type { ComposeConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import type { PostImage } from '../db/images.js';
import { postImage } from '../db/images.js';
import type { PostToCompose } from '../db/posts.js';
import { postToCompose, updateAltText } from '../db/posts.js';
import { upsertRendition } from '../db/renditions.js';
import type { Logger } from '../lib/log.js';
import type { ImageFormat } from './formats.js';
import { IMAGE_FORMATS } from './formats.js';
import { cardLayout, TextTooLongError } from './template.js';
import type { Font } from './text.js';
import { loadFont } from './text.js';

/** A card this post cannot have: the run says why rather than writing a broken rendition. */
export class ComposeError extends Error {
  override name = 'ComposeError';
}

export interface ComposeOptions {
  db: Db;
  postId: number;
  formats: readonly ImageFormat[];
  config: ComposeConfig;
  /** Where the bundled fonts live, so a card never depends on a font the machine happens to have. */
  fontsDir: string;
  /** The media directory: originals are read from it, composed cards written under its renditions/ folder. */
  mediaDir: string;
  now?: () => Date;
  log?: Logger;
}

export type FormatOutcome =
  | {
      status: 'written';
      renditionId: number;
      localPath: string;
      bytes: number;
      /** The size the quote was set at: a card at the smallest size is one worth looking at. */
      quoteSize: number;
      lines: number;
    }
  | { status: 'failed'; reason: string };

export interface FormatReport {
  format: ImageFormat;
  outcome: FormatOutcome;
}

export interface ComposeReport {
  postId: number;
  considered: number;
  written: number;
  failed: number;
  items: FormatReport[];
}

/**
 * Composed cards live under the media directory by post and format, as the package layout in spec
 * section 4 lays out.
 *
 * Built with forward slashes rather than join(), because this is what the database stores: the
 * images table already holds posix-style paths, and a rendition's stored path becomes a public url
 * later (spec section 13). Only the absolute filesystem path is joined, and only at the point of use.
 */
export function renditionPath(postId: number, format: ImageFormat): string {
  return `renditions/${postId}/${format}.jpg`;
}

/** The work as the card prints it: the title, and the year when the item records one. */
export function workLine(post: PostToCompose): string {
  return post.workYear === null ? post.workTitle : `${post.workTitle}, ${post.workYear}`;
}

/**
 * What a reader who cannot see the card is told. Enrich's placeholder describes the quote alone;
 * once a portrait is behind it, the description says so (plan 2.6).
 */
export function composeAltText(post: PostToCompose, image: PostImage): string {
  return `Quote card: a portrait of ${image.author} behind the quotation from ${workLine(post)}: "${post.body}"`;
}

/** Renders one format and writes its rendition row. Throws TextTooLongError when the quote cannot be set legibly. */
async function renderFormat(
  options: ComposeOptions,
  post: PostToCompose,
  image: PostImage,
  fonts: { quote: Font; meta: Font },
  format: ImageFormat,
  now: Date,
): Promise<FormatOutcome> {
  const spec = IMAGE_FORMATS[format];
  const layout = cardLayout(spec, fonts, {
    quote: post.body,
    author: image.author,
    work: workLine(post),
    wordmark: options.config.wordmark,
  });

  const localPath = renditionPath(post.postId, format);
  const destPath = join(options.mediaDir, localPath);
  mkdirSync(dirname(destPath), { recursive: true });

  // The portrait is cropped from the top: a head is nearer the top of a plate than its centre.
  const base = await sharp(join(options.mediaDir, image.localPath))
    .resize(spec.width, spec.height, { fit: 'cover', position: 'top' })
    .toBuffer();
  const info = await sharp(base)
    .composite([{ input: Buffer.from(layout.svg), top: 0, left: 0 }])
    .jpeg({ quality: options.config.jpeg_quality })
    .toFile(destPath);

  // From here until the row exists, any failure removes the file. A rendition row must name a file
  // that exists, and a file must not outlive the failure of the row meant to describe it.
  try {
    // The rendition matrix is exact (spec section 11); a card of the wrong size is a failure, not a variation.
    if (info.width !== spec.width || info.height !== spec.height) {
      throw new ComposeError(`${format} rendered ${info.width}x${info.height}, but must be ${spec.width}x${spec.height}`);
    }

    const renditionId = upsertRendition(
      options.db,
      {
        postId: post.postId,
        format,
        mediaType: 'image',
        aspect: spec.aspect,
        width: info.width,
        height: info.height,
        localPath,
        bytes: info.size,
        status: 'ready',
        error: null,
      },
      now,
    );
    return { status: 'written', renditionId, localPath, bytes: info.size, quoteSize: layout.quoteSize, lines: layout.quoteLines.length };
  } catch (err) {
    rmSync(destPath, { force: true });
    throw err;
  }
}

/**
 * Composes a post's cards, one per requested format.
 *
 * Safe to re-run: regenerating a format replaces that format's rendition row and nothing else (spec
 * section 7). A format that cannot be set legibly fails on its own and leaves the others alone, and a
 * failed format writes no rendition row at all, because a row's local_path must name a file that
 * exists. Anything unexpected aborts the run rather than being recorded as a tidy failure.
 */
export async function composePost(options: ComposeOptions): Promise<ComposeReport> {
  const now = options.now ?? (() => new Date());
  const post = postToCompose(options.db, options.postId);
  if (post === undefined) {
    // postToCompose joins subjects and items.subject_id is nullable, so distinguish the two cases
    // rather than telling someone their post does not exist when it does.
    const exists = options.db.prepare('SELECT 1 FROM posts WHERE id = ?').pluck().get(options.postId) !== undefined;
    throw new ComposeError(exists ? `post ${options.postId} has no subject, so its card has no author` : `post ${options.postId} does not exist`);
  }
  const image = postImage(options.db, options.postId);
  if (image === undefined) throw new ComposeError(`post ${options.postId} has no image yet; run lantern media first`);

  // Loaded once per run, so every format shares one outline cache.
  const fonts = {
    quote: loadFont(join(options.fontsDir, options.config.quote_font)),
    meta: loadFont(join(options.fontsDir, options.config.meta_font)),
  };

  const report: ComposeReport = { postId: post.postId, considered: options.formats.length, written: 0, failed: 0, items: [] };
  for (const format of options.formats) {
    let outcome: FormatOutcome;
    try {
      outcome = await renderFormat(options, post, image, fonts, format, now());
    } catch (err) {
      if (!(err instanceof TextTooLongError) && !(err instanceof ComposeError)) throw err;
      outcome = { status: 'failed', reason: `${format}: ${err.message}` };
    }
    if (outcome.status === 'written') report.written++;
    else report.failed++;
    report.items.push({ format, outcome });
    options.log?.info('compose format', { postId: post.postId, format, outcome });
  }

  // The alt text describes the card, so it is only rewritten once a card exists - and only while the
  // post is still ours to edit. An approved post's alt text may have been corrected by a human in
  // review, and the media stage likewise refuses to touch an approved post (spec sections 7 and 10).
  if (report.written > 0 && (post.status === 'draft' || post.status === 'needs_review')) {
    updateAltText(options.db, post.postId, composeAltText(post, image));
  }
  return report;
}
