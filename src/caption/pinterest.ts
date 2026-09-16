import type { PostForCaption } from '../db/posts.js';
import type { BuiltCaption, CaptionLimits } from './facebook.js';
import { disclosureFor } from './facebook.js';
import { CaptionConfigError, fitSentences, joinParagraphs, truncateAtWord } from './text.js';

/**
 * Pinterest's pin: a title, a description, and no link yet.
 *
 * The title is the post's approved hook, cut at a word boundary to the channel's title_max (user
 * decision 2026-09-16). The hook is already written to be the compelling first line, so nothing has
 * to invent a title, and because the result is verbatim approved text it costs no fact check.
 *
 * `hashtags` stays null: Pinterest is a search surface and the spec asks for plain keywords, not
 * hashtag spam (section 11). `link` stays null until the archive site ships in Phase 8 (section 13),
 * because there is nowhere honest to point it in the meantime.
 */
export function pinterestCaption(post: PostForCaption, limits: CaptionLimits): BuiltCaption {
  if (limits.titleMax === undefined) {
    throw new CaptionConfigError('a pinterest channel must set caption.title_max, since every pin carries a title');
  }
  const disclosure = disclosureFor(post.imageLicense);
  const reserved = disclosure === null ? 0 : [...disclosure].length + 2;
  if (disclosure !== null && limits.textMax <= reserved) {
    throw new CaptionConfigError(
      `a channel with text_max ${limits.textMax} cannot carry the ${[...disclosure].length}-character AI disclosure this image requires`,
    );
  }
  const description = fitSentences(joinParagraphs([post.body, post.closer]), Math.max(0, limits.textMax - reserved));
  return {
    title: truncateAtWord(post.hook.trim(), limits.titleMax),
    text: disclosure === null ? description : `${description}\n\n${disclosure}`,
    hashtags: null,
    link: null,
  };
}
