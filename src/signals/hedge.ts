import { hedgeSignal } from './lexicon.js';

/** A hedge states a guess where a learning should state a measurement or name its doubt: English and German. */
export const hedge = hedgeSignal('hedge', {
  en: ['likely', 'probably', 'possibly', 'presumably', 'seems to', 'appears to'],
  de: ['wahrscheinlich', 'vermutlich', 'möglicherweise', 'womöglich', 'mutmaßlich', 'anscheinend', 'scheinbar', 'scheint'],
});
