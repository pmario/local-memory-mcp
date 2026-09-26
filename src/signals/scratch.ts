import type { Signal } from './types.js';
import { unique } from './text.js';

// A drive-letter or POSIX temp directory, up to the end of the path (a closing period is sentence punctuation).
const SCRATCH = /(?:\b[A-Za-z]:[\\/]tmp[\\/]|(?<![\w.~])\/tmp\/)[^\s`'"()<>,;]*[^\s`'"()<>,;.]/g;

export function scratchPaths(text: string): string[] {
  return unique(text.match(SCRATCH) ?? []);
}

/** A cited scratch file does not last, so the evidence it holds is lost. */
export const scratch: Signal = {
  id: 'scratch',
  kind: 'hard',
  fires: (ctx) => scratchPaths(ctx.text).length > 0,
  notice: (ctx) => {
    const paths = scratchPaths(ctx.text);
    return paths.length > 0
      ? `The text cites a scratch path (${paths.join(', ')}): a scratch file does not last, so keep the evidence in a versioned directory and cite that path.`
      : null;
  },
};
