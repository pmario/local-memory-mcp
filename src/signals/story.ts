import type { Signal } from './types.js';
import { unique } from './text.js';

const STORY = /\b(found (it|that|twice|while)|while (looking|building|debugging|testing)|turned out|mishap|incident|we |our |I )\b/gi;

const words = (text: string) => unique((text.match(STORY) ?? []).map((w) => w.trim().toLowerCase()));

/** Words of a discovery story rather than of a result. */
export const story: Signal = {
  id: 'story',
  kind: 'score',
  check: 'factual',
  fires: (ctx) => words(ctx.text).length > 0,
  matches: (ctx) => words(ctx.text),
  notice: (ctx) => {
    const found = words(ctx.text);
    return found.length > 0
      ? `The text tells how it was found (${found.join(', ')}): state the result; the story belongs in the commit or the handoff.`
      : null;
  },
};
