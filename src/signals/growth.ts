import type { Signal, SignalContext } from './types.js';
import { bodyParagraphs } from './text.js';

const MIN_RATIO = 1.3;

// Link lists change freely, so only the body counts, as for append.
const body = (text: string) => bodyParagraphs(text).join('\n\n').length;

// The growth over the oldest known version as "+45%", or null below MIN_RATIO.
const grown = (ctx: SignalContext) => {
  const before = body(ctx.first);
  const ratio = before > 0 ? body(ctx.text) / before : 0;
  return ratio >= MIN_RATIO ? `+${Math.round((ratio - 1) * 100)}%` : null;
};

/** Facts added across sessions: the text grew by 30% or more over its first version. */
export const growth: Signal = {
  id: 'growth',
  kind: 'score',
  check: 'atomic',
  fires: (ctx) => grown(ctx) !== null,
  matches: (ctx) => [grown(ctx)].filter((g): g is string => g !== null),
  notice: (ctx) => {
    const g = grown(ctx);
    return g !== null ? `The text is ${g} longer than its earlier version: check whether it gathered a second subject, and split it if so.` : null;
  },
};
