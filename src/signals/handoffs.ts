import type { Signal } from './types.js';
import { unique } from './text.js';

const HANDOFF = /HANDOFF_[\w.-]+?\.md/g;

/** Facts from several sessions: two or more cited handoffs. */
export const handoffs: Signal = {
  id: 'handoffs',
  kind: 'score',
  fires: (ctx) => unique(ctx.text.match(HANDOFF) ?? []).length >= 2,
};
