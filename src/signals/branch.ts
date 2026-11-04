import type { Signal } from './types.js';
import { unique } from './text.js';

const BRANCH = /\bbranch [a-z][\w/-]+|\b[a-z0-9-]+:[a-z0-9-]+\//gi;

const branches = (text: string) => unique(text.match(BRANCH) ?? []);

/** A branch reference ties the entry to one branch's state. */
export const branch: Signal = {
  id: 'branch',
  kind: 'score',
  check: 'factual',
  fires: (ctx) => branches(ctx.text).length > 0,
  matches: (ctx) => branches(ctx.text),
  notice: (ctx) => {
    const found = branches(ctx.text);
    return found.length > 0 ? `The text names a branch (${found.join(', ')}): branch state changes, so cite the commit.` : null;
  },
};
