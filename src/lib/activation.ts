/**
 * ACT-R base-level activation (local-memory-mcp-y0l) in Petrov's (2006) hybrid approximation, which needs only a read
 * count, the time of the last read and the time since the first possible read.
 */

// The standard ACT-R decay.
const DECAY = 0.5;
// A time under an hour counts as an hour, so a read this instant stays finite.
const MIN_DAYS = 1 / 24;

/**
 * Computes base-level activation: the last read exactly, the earlier reads spread evenly back to the first possible one.
 * @param input - reads counted, days since the first possible read, days since the last read
 * @returns the activation, higher for more and more recent reads; null when never read
 */
export function activation(input: { reads: number; ageDays: number; lastReadDays: number }): number | null {
  const { reads } = input;
  if (reads <= 0) return null;
  const tn = Math.max(input.ageDays, MIN_DAYS);
  const t1 = Math.min(Math.max(input.lastReadDays, MIN_DAYS), tn);
  const last = t1 ** -DECAY;
  if (reads === 1) return Math.log(last);
  if (tn - t1 < 1e-9) return Math.log(reads * last);
  return Math.log(last + ((reads - 1) * (tn ** (1 - DECAY) - t1 ** (1 - DECAY))) / ((1 - DECAY) * (tn - t1)));
}
