import type { Signal } from './types.js';

/** Doc harvests, filed as research, pass the check far more often than entries written from work sessions. */
export const workSession: Signal = {
  id: 'work-session',
  kind: 'score',
  fires: (ctx) => ctx.category !== 'research',
};
