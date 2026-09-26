import type { Signal } from './types.js';
import { unique } from './text.js';

const DATE = /\b20\d\d-\d\d-\d\d\b/g;

/** Facts from several days: three or more distinct dates. */
export const dates: Signal = {
  id: 'dates',
  kind: 'score',
  fires: (ctx) => unique(ctx.text.match(DATE) ?? []).length >= 3,
};
