import type { Signal } from './types.js';
import { bodyParagraphs } from './text.js';

const QUOTE_LENGTH = 60;

// Later paragraphs without a code span, digit, path, link or quote, each quoted up to QUOTE_LENGTH characters.
const bare = (text: string) =>
  bodyParagraphs(text)
    .slice(1)
    .filter((p) => !/[`\d/[\]"]/.test(p))
    .map((p) => (p.length > QUOTE_LENGTH ? `${p.slice(0, QUOTE_LENGTH)}…` : p));

/** A later paragraph without a code span, digit, path, link or quote: the usual shape of a closing maxim. */
export const maxim: Signal = {
  id: 'maxim',
  kind: 'score',
  check: 'factual',
  fires: (ctx) => bare(ctx.text).length > 0,
  matches: (ctx) => bare(ctx.text),
  notice: (ctx) => {
    const found = bare(ctx.text);
    return found.length > 0
      ? `A later paragraph states a rule without evidence ("${found[0]}"): cut it, or give its evidence (a measurement, file, quote or link).`
      : null;
  },
};
