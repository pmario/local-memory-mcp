import type { Signal } from './types.js';
import { unique } from './text.js';

// A tmp or temp directory anywhere in a drive path, /tmp/ or /var/tmp/, or %TEMP%, %TMP% or $TMPDIR, up to the end of
// the path (a closing period is sentence punctuation).
const SCRATCH =
  /(?:\b[A-Za-z]:[\\/](?:[^\s\\/`'"()<>,;]+[\\/])*?te?mp[\\/]|(?<![\w.~])\/(?:var\/)?tmp\/|%te?mp%[\\/]|\$tmpdir\/)[^\s`'"()<>,;]*[^\s`'"()<>,;.]/gi;

// A fenced code block holds what the writer kept on purpose, such as verbatim output.
const FENCED_CODE = /^```[\s\S]*?^```/gm;
// Code spans, paired left to right; one with whitespace inside holds a command, whose paths are arguments, not cited evidence.
const CODE_SPAN = /`([^`\n]*)`/g;

// What the writer can do about a cited scratch path, shared by the notice and the refusal.
export const SCRATCH_FIX =
  'move the evidence to a versioned directory and cite that, state the result without the path, or, when the path itself is the subject (verbatim output, a documented location), put it in a fenced code block';

/**
 * Lists the scratch paths a text cites, leaving out those in a fenced code block or a command span.
 * @param text - a learning's text
 * @returns the paths, in order of appearance, without duplicates
 */
export function scratchPaths(text: string): string[] {
  const cited = text.replace(FENCED_CODE, ' ').replace(CODE_SPAN, (span, inner: string) => (/\s/.test(inner) ? ' ' : span));
  return unique(cited.match(SCRATCH) ?? []);
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
      ? `The text cites a scratch path (${paths.join(', ')}), whose evidence will not last: ${SCRATCH_FIX}.`
      : null;
  },
};
