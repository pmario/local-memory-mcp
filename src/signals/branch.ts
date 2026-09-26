import type { Signal } from './types.js';

const BRANCH = /\bbranch [a-z][\w/-]+|\b[a-z0-9-]+:[a-z0-9-]+\//i;

/** A branch reference ties the entry to one branch's state. */
export const branch: Signal = {
  id: 'branch',
  kind: 'score',
  fires: (ctx) => BRANCH.test(ctx.text),
};
