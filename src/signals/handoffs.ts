import type { Signal } from './types.js';
import { unique } from './text.js';

const HANDOFF = /HANDOFF_[\w.-]+?\.md/g;
const MIN_HANDOFFS = 2;

const handoffList = (text: string) => unique(text.match(HANDOFF) ?? []);

/** Facts from several sessions: two or more cited handoffs. */
export const handoffs: Signal = {
  id: 'handoffs',
  kind: 'score',
  check: 'atomic',
  fires: (ctx) => handoffList(ctx.text).length >= MIN_HANDOFFS,
  matches: (ctx) => handoffList(ctx.text),
  notice: (ctx) => {
    const found = handoffList(ctx.text);
    return found.length >= MIN_HANDOFFS
      ? `Facts from ${found.length} sessions (${found.join(', ')}): split it into one learning per finding.`
      : null;
  },
};
