/**
 * memory_get: full text of learnings, decisions and sessions by the ids other tools list as headlines.
 * An open counts as a use, like an edit does; archived learnings resolve too, so an id from an old handoff still opens.
 * An id of 8 to 35 hex characters opens by prefix when exactly one entry starts with it, and lands in ambiguous when several do.
 */
import { z } from 'zod';
import { getDb, nowIso } from '../db/client.js';
import { parseStyle } from '../lib/style.js';
import { activeParts } from '../lib/split.js';
import { VERSIONED_COLUMNS, currentSince } from '../lib/history.js';
import { headline } from '../lib/brief.js';
import type { ToolResult } from '../lib/types.js';

export const getSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(20),
  // A learning as the store held it at this instant (local-memory-mcp-mnb); decisions and sessions have no history.
  asOf: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), {
      message: 'asOf must be a parseable date string (ISO 8601 or SQLite-compatible)',
    })
    .optional(),
  history: z.boolean().optional(),
});

// The columns a version replaces in a learning row; see VERSIONED_COLUMNS in src/lib/history.ts.
type VersionRow = Pick<
  LearningRow,
  'category' | 'content' | 'project' | 'tags_json' | 'confidence' | 'memory_type' | 'style_json' | 'split_from' | 'archived' | 'lifecycle_state'
> & { recorded_at: string; expired_at: string };

interface LearningRow {
  id: string;
  date: string;
  category: string;
  content: string;
  project: string | null;
  tags_json: string;
  style_json: string;
  confidence: number;
  memory_type: string;
  lifecycle_state: string;
  archived: number;
  split_from: string | null;
  verified: number;
  verified_at: string | null;
}

interface SessionRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  project: string | null;
  summary: string | null;
  tasks_json: string | null;
}

interface DecisionRow {
  id: string;
  date: string;
  title: string;
  decision: string;
  alternatives: string | null;
  reasoning: string;
  project: string | null;
  tags_json: string;
  confidence: number;
}

// Handoffs quote the first 8 characters of a UUID; a shorter string could open an arbitrary entry.
const ID_PREFIX = /^[0-9a-f]{8}[0-9a-f-]{0,27}$/;

function idsStartingWith(db: ReturnType<typeof getDb>, prefix: string): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM learnings WHERE id GLOB @pattern
       UNION SELECT id FROM decisions WHERE id GLOB @pattern
       UNION SELECT id FROM sessions WHERE id GLOB @pattern
       ORDER BY id`
    )
    .all({ pattern: `${prefix}*` }) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function memoryGet(input: z.infer<typeof getSchema>): ToolResult {
  const db = getDb();
  const requested = [...new Set(input.ids)];

  const fullIdOf = new Map<string, string>();
  const ambiguous: Array<{ id: string; candidates: string[] }> = [];
  for (const id of requested) {
    const prefix = id.toLowerCase();
    if (!ID_PREFIX.test(prefix)) {
      fullIdOf.set(id, id);
      continue;
    }
    const candidates = idsStartingWith(db, prefix);
    if (candidates.length === 1) fullIdOf.set(id, candidates[0]!);
    else if (candidates.length > 1) ambiguous.push({ id, candidates });
  }

  const ids = [...new Set(fullIdOf.values())];
  const placeholders = ids.map(() => '?').join(',');

  const learnings = db
    .prepare(
      `SELECT id, date, category, content, project, tags_json, style_json, confidence, memory_type, lifecycle_state, archived, split_from,
              verified, verified_at
       FROM learnings WHERE id IN (${placeholders})`
    )
    .all(...ids) as LearningRow[];
  const decisions = db
    .prepare(
      `SELECT id, date, title, decision, alternatives, reasoning, project, tags_json, confidence
       FROM decisions WHERE id IN (${placeholders})`
    )
    .all(...ids) as DecisionRow[];
  // A brief memory_session_start lists a previous session's first paragraph only, so its id has to open the rest.
  const sessions = db
    .prepare(
      `SELECT id, started_at, ended_at, project, summary, tasks_json
       FROM sessions WHERE id IN (${placeholders})`
    )
    .all(...ids) as SessionRow[];

  const found = new Map<string, Record<string, unknown>>();
  const isAtOrAfter = db.prepare('SELECT datetime(?) >= datetime(?) AS yes');
  const versionColumns = `${VERSIONED_COLUMNS.join(', ')}, recorded_at, expired_at`;
  const versionAt = db.prepare(
    `SELECT ${versionColumns} FROM learnings_history
     WHERE learning_id = ? AND datetime(recorded_at) <= datetime(@asOf) AND datetime(@asOf) < datetime(expired_at)
     ORDER BY expired_at DESC, rowid DESC LIMIT 1`
  );
  const versionsOf = db.prepare(`SELECT ${versionColumns} FROM learnings_history WHERE learning_id = ? ORDER BY expired_at, rowid`);
  for (const current of learnings) {
    let learning: LearningRow = current;
    let version: { recordedAt: string; expiredAt: string | null } | undefined;
    if (input.asOf !== undefined) {
      const since = currentSince(db, current.id)!;
      if ((isAtOrAfter.get(input.asOf, since) as { yes: number | null }).yes === 1) {
        version = { recordedAt: since, expiredAt: null };
      } else {
        const old = versionAt.get(current.id, { asOf: input.asOf }) as VersionRow | undefined;
        if (!old) continue; // the learning did not exist yet, so it lands in missing
        const { recorded_at, expired_at, ...columns } = old;
        learning = { ...current, ...columns };
        version = { recordedAt: recorded_at, expiredAt: expired_at };
      }
    }
    const { tags_json, style_json, archived, split_from, verified, verified_at, ...row } = learning;
    const parts = input.asOf === undefined ? activeParts(db, row.id) : [];
    const history = input.history
      ? (versionsOf.all(row.id) as VersionRow[]).map((v) => ({
          recordedAt: v.recorded_at,
          expiredAt: v.expired_at,
          headline: headline(v.content),
          style: parseStyle(v.style_json),
          archived: v.archived === 1,
        }))
      : undefined;
    found.set(row.id, {
      type: 'learning',
      ...row,
      tags: JSON.parse(tags_json),
      style: parseStyle(style_json),
      archived: archived === 1,
      // Storing a learning is its first confirmation (local-memory-mcp-4ip).
      verified: verified === 1,
      verifiedAt: verified_at ?? row.date,
      ...(split_from !== null ? { splitFrom: split_from } : {}),
      ...(parts.length > 0 ? { parts } : {}),
      ...(version ? { version } : {}),
      ...(history ? { history } : {}),
    });
  }
  for (const { tags_json, ...row } of decisions) {
    found.set(row.id, { type: 'decision', ...row, tags: JSON.parse(tags_json) });
  }
  for (const { tasks_json, ...row } of sessions) {
    found.set(row.id, { type: 'session', ...row, tasks: tasks_json ? JSON.parse(tasks_json) : [] });
  }

  // Counting the open keeps usage_count meaning "recalled", which memory_reflect's
  // most-used and stale lists assume; the counter is metadata, so the tool stays read-only for clients.
  if (learnings.length > 0) {
    const opened = learnings.map((row) => row.id);
    db.prepare(
      `UPDATE learnings SET usage_count = usage_count + 1, last_used = ?
       WHERE id IN (${opened.map(() => '?').join(',')})`
    ).run(nowIso(), ...opened);
  }

  const results = ids.filter((id) => found.has(id)).map((id) => found.get(id));
  const ambiguousIds = new Set(ambiguous.map((entry) => entry.id));
  const missing = requested.filter((id) => !ambiguousIds.has(id) && !found.has(fullIdOf.get(id) ?? ''));
  const counts = [
    `${results.length} found`,
    ...(missing.length > 0 ? [`${missing.length} missing`] : []),
    ...(ambiguous.length > 0 ? [`${ambiguous.length} ambiguous`] : []),
  ];
  return {
    success: true,
    data: { results, missing, ambiguous },
    message: `${counts.join(', ')}.`,
  };
}
