import type { Signal } from './types.js';
import { unique } from './text.js';

// A tmp or temp directory anywhere in a drive path, /tmp/ or /var/tmp/, or %TEMP%, %TMP% or $TMPDIR, up to the end of
// the path (a closing period is sentence punctuation).
const SCRATCH =
  /(?:\b[A-Za-z]:[\\/](?:[^\s\\/`'"()<>,;]+[\\/])*?te?mp[\\/]|(?<![\w.~])\/(?:var\/)?tmp\/|%te?mp%[\\/]|\$tmpdir\/)[^\s`'"()<>,;]*[^\s`'"()<>,;.]/gi;

export function scratchPaths(text: string): string[] {
  return unique(text.match(SCRATCH) ?? []);
}

/** A cited scratch file does not last, so the evidence it holds is lost. */
export const scratch: Signal = {
  id: 'scratch',
  kind: 'hard',
  check: 'factual',
  fires: (ctx) => scratchPaths(ctx.text).length > 0,
  matches: (ctx) => scratchPaths(ctx.text),
  notice: (ctx) => {
    const paths = scratchPaths(ctx.text);
    return paths.length > 0
      ? `The text cites a scratch path (${paths.join(', ')}): a scratch file does not last, so keep the evidence in a versioned directory and cite that path.`
      : null;
  },
};
