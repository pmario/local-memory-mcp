import type { Signal } from './types.js';
import { unique } from './text.js';

const HEDGE = /\b(likely|probably|possibly|presumably|seems to|appears to)\b/gi;

export function hedgeWords(text: string): string[] {
  return unique((text.match(HEDGE) ?? []).map((w) => w.toLowerCase()));
}

/** A hedge states a guess where a learning should state a measurement or name its doubt. */
export const hedge: Signal = {
  id: 'hedge',
  kind: 'hard',
  fires: (ctx) => hedgeWords(ctx.text).length > 0,
  notice: (ctx) => {
    const words = hedgeWords(ctx.text);
    return words.length > 0 ? `The text hedges (${words.join(', ')}): state what was measured, or name the doubt and lower confidence.` : null;
  },
};
