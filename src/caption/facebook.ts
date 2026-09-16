import type { PostForCaption } from '../db/posts.js';
import { BOILERPLATE, fitSentences, joinParagraphs } from './text.js';

export interface CaptionLimits {
  /** The channel's cap on the caption body. */
  textMax: number;
  /** The channel's cap on a title, where the platform has one. Facebook does not. */
  titleMax?: number | undefined;
}

export interface BuiltCaption {
  title: string | null;
  text: string;
  hashtags: string | null;
  link: string | null;
}

/** An AI-generated image must say so (spec section 9). No whitelisted licence obliges a credit line; that belongs on the archive page (spec section 10). */
export function disclosureFor(imageLicense: string | null): string | null {
  return imageLicense === 'generated' ? (BOILERPLATE[0] ?? null) : null;
}

/**
 * Facebook's caption: the post's own prose, trimmed to the channel's limit.
 *
 * A Facebook post is a paragraph of writing under a picture, so the caption is the write-up itself
 * rather than anything reshaped for it. Nothing here calls a model: every sentence is approved prose
 * carried over whole, which is what keeps this a formatting step (spec sections 7 and 15).
 *
 * The disclosure is reserved out of the budget before the prose is fitted, so a caption can never be
 * trimmed to exactly the limit and then pushed over it by the line that has to be there.
 */
export function facebookCaption(post: PostForCaption, limits: CaptionLimits): BuiltCaption {
  const disclosure = disclosureFor(post.imageLicense);
  const reserved = disclosure === null ? 0 : [...disclosure].length + 2;
  const prose = fitSentences(joinParagraphs([post.hook, post.body, post.closer]), Math.max(0, limits.textMax - reserved));
  return {
    title: null,
    text: disclosure === null ? prose : `${prose}\n\n${disclosure}`,
    hashtags: null,
    link: null,
  };
}
