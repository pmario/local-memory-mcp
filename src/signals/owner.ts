import type { Signal } from './types.js';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The owner named in the text ("the maintainer", "the user" or a configured name): rulings arrive with their story. */
export const owner: Signal = {
  id: 'owner',
  kind: 'score',
  fires: (ctx) => new RegExp(`\\b(maintainer|the user${ctx.ownerNames.map((n) => '|' + escape(n)).join('')})\\b`, 'i').test(ctx.text),
};
