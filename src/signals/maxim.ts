import type { Signal } from './types.js';
import { bodyParagraphs } from './text.js';

/** A later paragraph without a code span, digit, path, link or quote: the usual shape of a closing maxim. */
export const maxim: Signal = {
  id: 'maxim',
  kind: 'score',
  fires: (ctx) => bodyParagraphs(ctx.text).slice(1).some((p) => !/[`\d/[\]"]/.test(p)),
};
