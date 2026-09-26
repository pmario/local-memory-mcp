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
import { maxim } from './maxim.js';
import { owner } from './owner.js';
import { scratch } from './scratch.js';
import { story } from './story.js';
import { workSession } from './work-session.js';

export type { Assessment, Signal, SignalContext } from './types.js';

export const SIGNALS: readonly Signal[] = [scratch, hedge, append, growth, handoffs, dates, branch, story, owner, maxim, workSession];

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

/** Notices for defects the writer can fix now, in signal order. */
export function writeNotices(ctx: SignalContext, signals: readonly Signal[] = SIGNALS): string[] {
  return signals.map((s) => s.notice?.(ctx) ?? null).filter((n): n is string => n !== null);
}

export function assess(ctx: SignalContext, signals: readonly Signal[] = SIGNALS): Assessment {
  const fired = signals.filter((s) => s.fires(ctx));
  const hard = fired.filter((s) => s.kind === 'hard').map((s) => s.id);
  const score = fired.filter((s) => s.kind === 'score').reduce((sum, s) => sum + (s.weight ?? 1), 0);
  return { score, hard, flagged: hard.length > 0 || score >= FLAG_SCORE };
}
