import type { RenditionFormat } from '../config/schema.js';

export interface FormatSpec {
  /** The exact pixel width every rendition of this format has. */
  width: number;
  /** The exact pixel height every rendition of this format has. */
  height: number;
  aspect: string;
}

/**
 * The image formats this stage composes, with the exact dimensions from the rendition matrix in
 * spec section 11. Video formats (`short`) belong to the render stage in phase 8, and `portrait`
 * and `landscape` are not built until the channels that need them exist, so asking for either is
 * an error rather than a silently empty run.
 */
export const IMAGE_FORMATS = {
  square: { width: 1200, height: 1200, aspect: '1:1' },
  pin: { width: 1000, height: 1500, aspect: '2:3' },
} as const satisfies Partial<Record<RenditionFormat, FormatSpec>>;

export type ImageFormat = keyof typeof IMAGE_FORMATS;

export const IMAGE_FORMAT_NAMES = Object.keys(IMAGE_FORMATS) as ImageFormat[];

export function isImageFormat(value: string): value is ImageFormat {
  return Object.hasOwn(IMAGE_FORMATS, value);
}
