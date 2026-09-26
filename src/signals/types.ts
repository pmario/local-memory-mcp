/**
 * The contract of a re-check signal (local-memory-mcp-w8u). The server calls signals only through
 * writeNotices() and assess() in ./index.ts, so a signal can be added or changed without touching its callers.
 */

/** What a signal may look at: a learning's text, the text before the change, its first version and metadata. */
export interface SignalContext {
  text: string;
  // The text this change replaced (an update) or the previous distinct version (the queue); null for a new learning.
  previous: string | null;
  // The oldest known version; the text itself when there is no history.
  first: string;
  category: string;
  // Names of the store's owner, whose rulings tend to arrive with their story.
  ownerNames: readonly string[];
}

export interface Signal {
  // Short name, shown in the re-check queue for a hard signal.
  id: string;
  // hard: flags an entry on its own; score: adds its weight to the risk score.
  kind: 'hard' | 'score';
  // Points a score signal adds when it fires; 1 when omitted.
  weight?: number;
  fires(ctx: SignalContext): boolean;
  // A write-time notice for a defect the writer can fix while the text is in context; null when there is none.
  notice?(ctx: SignalContext): string | null;
}

export interface Assessment {
  score: number;
  // Ids of the hard signals that fired.
  hard: string[];
  flagged: boolean;
}
