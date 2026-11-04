import type { Signal } from './types.js';
import { unique } from './text.js';

const DATE = /\b20\d\d-\d\d-\d\d\b/g;
const MIN_DATES = 3;

const dateList = (text: string) => unique(text.match(DATE) ?? []);

/** Facts from several days: three or more distinct dates. */
export const dates: Signal = {
  id: 'dates',
  kind: 'score',
  check: 'atomic',
  fires: (ctx) => dateList(ctx.text).length >= MIN_DATES,
  matches: (ctx) => dateList(ctx.text),
  notice: (ctx) => {
    const found = dateList(ctx.text);
    return found.length >= MIN_DATES
      ? `Facts from ${found.length} days (${found.join(', ')}): one finding per learning; split it, or keep only the date of the measurement.`
      : null;
  },
};
