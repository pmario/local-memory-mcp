import type { Signal } from './types.js';

/** Facts added across sessions: the text grew by 30% or more over its first version. */
export const growth: Signal = {
  id: 'growth',
  kind: 'score',
  fires: (ctx) => ctx.first.length > 0 && ctx.text.length / ctx.first.length >= 1.3,
};
