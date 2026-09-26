import { hedgeSignal } from './lexicon.js';

/**
 * The English hedges' equivalents in the five Romance languages the embedding model handles best.
 * Italian "possibilmente" is left out: it means "if possible".
 */
export const hedgeRomance = hedgeSignal('hedge-romance', {
  es: ['probablemente', 'posiblemente', 'presumiblemente', 'aparentemente', 'parece que', 'parece ser'],
  ca: ['probablement', 'possiblement', 'presumiblement', 'aparentment', 'sembla que', 'sembla ser'],
  pt: ['provavelmente', 'possivelmente', 'presumivelmente', 'aparentemente', 'parece que', 'parece ser'],
  it: ['probabilmente', 'presumibilmente', 'apparentemente', 'sembra che', 'sembra essere'],
  fr: ['probablement', 'vraisemblablement', 'possiblement', 'présumément', 'apparemment', 'il semble', 'semble-t-il', 'sans doute'],
});
