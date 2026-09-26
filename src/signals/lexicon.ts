import type { Signal } from './types.js';
import { unique } from './text.js';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Quoted text is a verbatim quote, which the writing guide keeps as it was said: "…", “…”, „…“, «…» and »…«.
const QUOTED = /"[^"\n]*"|“[^”\n]*”|„[^“\n]*“|«[^»\n]*»|»[^«\n]*«/g;

/**
 * A score signal that fires on any hedge in `terms` (per language) as whole words outside quotation marks, and
 * names those it found. It adds a point rather than flagging alone: across one store, 8 of 32 entries hedged
 * only inside quotes, and about 9 of the other 24 used the word for no guess ("possibly null").
 */
export function hedgeSignal(id: string, terms: Record<string, readonly string[]>): Signal {
  // \b counts only ASCII letters as word characters, so accented words need Unicode-aware boundaries.
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(${unique(Object.values(terms).flat()).map(escape).join('|')})(?![\\p{L}\\p{N}_])`,
    'giu'
  );
  const found = (text: string) => unique((text.replace(QUOTED, ' ').match(pattern) ?? []).map((w) => w.toLowerCase()));
  return {
    id,
    kind: 'score',
    fires: (ctx) => found(ctx.text).length > 0,
    notice: (ctx) => {
      const words = found(ctx.text);
      return words.length > 0 ? `The text hedges (${words.join(', ')}): state what was measured, or name the doubt and lower confidence.` : null;
    },
  };
}
