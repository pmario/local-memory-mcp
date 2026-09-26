import type { Signal, SignalContext } from './types.js';
import { addedParagraphs } from './text.js';

// Brief results show only the first line, which an added paragraph leaves unchanged.
const APPEND_NOTICE = 'Appended without changing the start: check that the first line still states the current claim, or rewrite the entry.';

// New paragraphs anywhere, or text after the old end that is more than a link.
function appended(ctx: SignalContext): boolean {
  if (ctx.previous === null || ctx.previous === ctx.text) return false;
  if (addedParagraphs(ctx.previous, ctx.text) > 0) return true;
  const tail = ctx.text.startsWith(ctx.previous) ? ctx.text.slice(ctx.previous.length).trim() : '';
  return tail !== '' && !/^(Related:|Part of \[\[|,?\s*\[\[)/.test(tail);
}

/** An entry amended by addition collects subjects its first line does not cover. */
export const append: Signal = {
  id: 'append',
  kind: 'score',
  fires: appended,
  notice: (ctx) => (appended(ctx) ? APPEND_NOTICE : null),
};
