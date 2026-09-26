import type { Signal } from './types.js';

const STORY = /\b(found (it|that|twice|while)|while (looking|building|debugging|testing)|turned out|mishap|incident|we |our |I )\b/i;

/** Words of a discovery story rather than of a result. */
export const story: Signal = {
  id: 'story',
  kind: 'score',
  fires: (ctx) => STORY.test(ctx.text),
};
