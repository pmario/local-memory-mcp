/**
 * memory_get: full text of learnings, decisions and sessions by the ids other tools list as headlines.
 * An open counts as a use, like an edit does; archived learnings resolve too, so an id from an old handoff still opens.
 * An id of 8 to 35 hex characters opens by prefix when exactly one entry starts with it, and lands in ambiguous when several do.
 */
import { z } from 'zod';
import { getDb, nowIso } from '../db/client.js';
import type { ToolResult } from '../lib/types.js';

export const getSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(20),
});

interface LearningRow {
  id: string;
  date: string;
  category: string;
  content: string;
  project: string | null;
  tags_json: string;
  confidence: number;
  memory_type: string;
  lifecycle_state: string;
  archived: number;
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
      `SELECT id, date, category, content, project, tags_json, confidence, memory_type, lifecycle_state, archived
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
  for (const { tags_json, archived, ...row } of learnings) {
    found.set(row.id, { type: 'learning', ...row, tags: JSON.parse(tags_json), archived: archived === 1 });
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
