/**
 * Re-check signals (local-memory-mcp-w8u): what a server can see in a learning's text and history that predicts
 * a failed atomic/factual check, without an LLM. The server uses only signalContext(), writeNotices() and assess();
 * a signal is one module implementing Signal (./types.ts), listed in SIGNALS. Validated blind on 30 entries of one
 * store: the set flagged 14, 12 of them real fails, and every entry with a second subject.
 */
import type { Assessment, Signal, SignalContext } from './types.js';
import { append } from './append.js';
import { branch } from './branch.js';
import { dates } from './dates.js';
import { growth } from './growth.js';
import { handoffs } from './handoffs.js';
import { hedge } from './hedge.js';
import { hedgeRomance } from './hedge-romance.js';
import { maxim } from './maxim.js';
import { owner } from './owner.js';
import { scratch } from './scratch.js';
import { story } from './story.js';
import { workSession } from './work-session.js';

export type { Assessment, Signal, SignalContext } from './types.js';

export const SIGNALS: readonly Signal[] = [scratch, hedge, hedgeRomance, append, growth, handoffs, dates, branch, story, owner, maxim, workSession];

export const SIGNAL_IDS = SIGNALS.map((s) => s.id) as [string, ...string[]];

// A risk score at or above this flags an entry for a re-check.
export const FLAG_SCORE = 3;

// Read once at server start, like the other MEMORY_* switches.
const OWNER_NAMES = (process.env.MEMORY_RECHECK_NAMES ?? '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

/** The context of the last of `versions` (oldest first); consecutive equal versions count once. */
export function signalContext(versions: readonly string[], category: string, ownerNames: readonly string[] = OWNER_NAMES): SignalContext {
  const distinct = versions.filter((v, i) => i === 0 || v !== versions[i - 1]);
  return {
    text: distinct[distinct.length - 1] ?? '',
    previous: distinct.length > 1 ? distinct[distinct.length - 2]! : null,
    first: distinct[0] ?? '',
    category,
    ownerNames,
  };
}

/**
 * Builds the notices for defects the writer can fix now, each prefixed with the check it concerns.
 * @param ctx - the written learning's signal context
 * @param signals - the signals to run
 * @returns the notices, in signal order
 */
export function writeNotices(ctx: SignalContext, signals: readonly Signal[] = SIGNALS): string[] {
  return signals.flatMap((s) => {
    const notice = s.notice?.(ctx) ?? null;
    return notice === null ? [] : [s.check ? `${s.check}: ${notice}` : notice];
  });
}

/**
 * Groups fired signals by the check they concern; a prior goes under "other".
 * @param fired - the signals that fired
 * @param value - what to record for each signal
 * @returns the groups that hold a signal
 */
function byCheck<T>(fired: readonly Signal[], value: (s: Signal) => T): Record<string, Record<string, T>> {
  const groups: Record<string, Record<string, T>> = {};
  for (const s of fired) (groups[s.check ?? 'other'] ??= {})[s.id] = value(s);
  return groups;
}

/**
 * Runs the signals named in `ids` on one learning.
 * @param ctx - the learning's signal context
 * @param ids - signal ids to run
 * @returns per check, each fired signal's id with what it matched, [] for a signal that names no match
 */
export function firedSignals(ctx: SignalContext, ids: readonly string[]): Record<string, Record<string, string[]>> {
  return byCheck(
    SIGNALS.filter((s) => ids.includes(s.id) && s.fires(ctx)),
    (s) => s.matches?.(ctx) ?? []
  );
}

/**
 * Names the checks a learning likely fails and the signals that say so, priors left out.
 * @param ctx - the learning's signal context
 * @param signals - the signals to run
 * @returns signal ids per check, only checks with a fired signal
 */
export function reasons(ctx: SignalContext, signals: readonly Signal[] = SIGNALS): Record<string, string[]> {
  return checkReasons(signals.filter((s) => s.fires(ctx)));
}

/**
 * Lists fired signals per check, priors left out.
 * @param fired - the signals that fired
 * @returns signal ids per check
 */
function checkReasons(fired: readonly Signal[]): Record<string, string[]> {
  const { other: _prior, ...groups } = byCheck(fired, () => true);
  return Object.fromEntries(Object.entries(groups).map(([check, ids]) => [check, Object.keys(ids)]));
}

/**
 * Scores a learning for the re-check queue.
 * @param ctx - the learning's signal context
 * @param signals - the signals to run
 * @returns score, hard signals, whether it is flagged, and the reasons per check
 */
export function assess(ctx: SignalContext, signals: readonly Signal[] = SIGNALS): Assessment {
  const fired = signals.filter((s) => s.fires(ctx));
  const hard = fired.filter((s) => s.kind === 'hard').map((s) => s.id);
  const score = fired.filter((s) => s.kind === 'score').reduce((sum, s) => sum + (s.weight ?? 1), 0);
  return { score, hard, flagged: hard.length > 0 || score >= FLAG_SCORE, reasons: checkReasons(fired) };
}
