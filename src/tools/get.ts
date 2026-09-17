/**
 * memory_get: full text of learnings and decisions by the ids other tools list as headlines.
 * An open counts as a use, like an edit does; archived learnings resolve too, so an id from an old handoff still opens.
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

export function memoryGet(input: z.infer<typeof getSchema>): ToolResult {
  const db = getDb();
  const ids = [...new Set(input.ids)];
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

  const found = new Map<string, Record<string, unknown>>();
  for (const { tags_json, archived, ...row } of learnings) {
    found.set(row.id, { type: 'learning', ...row, tags: JSON.parse(tags_json), archived: archived === 1 });
  }
  for (const { tags_json, ...row } of decisions) {
    found.set(row.id, { type: 'decision', ...row, tags: JSON.parse(tags_json) });
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
  const missing = ids.filter((id) => !found.has(id));
  return {
    success: true,
    data: { results, missing },
    message: `${results.length} found${missing.length > 0 ? `, ${missing.length} missing` : ''}.`,
  };
}
