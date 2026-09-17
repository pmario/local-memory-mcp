/**
 * Session tracking — the entry/exit points for a working session.
 *
 * Philosophy: a session is a conversation window. session_start loads context
 * from the last N sessions so the AI knows where it left off. session_end
 * stores a summary so the next session can pick up.
 */
import { z } from 'zod';
import { getDb, newId, nowIso } from '../db/client.js';
import { firstParagraph, headline } from '../lib/brief.js';
import type { ToolResult } from '../lib/types.js';

// ─── session_start ───────────────────────────────────

export const sessionStartSchema = z.object({
  project: z.string().optional(),
  // brief (default) lists headlines and ids to open with memory_get; full returns whole texts.
  detail: z.enum(['brief', 'full']).optional(),
});

export function sessionStart(input: z.infer<typeof sessionStartSchema>): ToolResult {
  const db = getDb();
  const id = newId();
  db.prepare('INSERT INTO sessions (id, started_at, project) VALUES (?, ?, ?)').run(
    id,
    nowIso(),
    input.project ?? null
  );

  const brief = (input.detail ?? 'brief') === 'brief';

  // Load context from previous sessions (same project preferred)
  const prevSessions = db
    .prepare(
      `SELECT id, started_at, ended_at, project, summary
       FROM sessions
       WHERE id != ? AND summary IS NOT NULL
       ORDER BY
         CASE WHEN project = ? THEN 0 ELSE 1 END,
         started_at DESC
       LIMIT ?`
    )
    .all(id, input.project ?? '', brief ? 1 : 3) as Array<{
    id: string;
    started_at: string;
    ended_at: string | null;
    project: string | null;
    summary: string;
  }>;

  // Total session count + recent learnings; brief scopes them to the project when one is given.
  const totalSessions = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c;
  const scoped = brief && input.project !== undefined;
  const recentLearnings = db
    .prepare(
      `SELECT id, category, content, date
       FROM learnings
       WHERE archived = 0 ${scoped ? 'AND project = ?' : ''}
       ORDER BY date DESC
       LIMIT 5`
    )
    .all(...(scoped ? [input.project] : [])) as Array<{ id: string; category: string; content: string; date: string }>;

  return {
    success: true,
    data: {
      sessionId: id,
      totalSessions,
      previousSessions: brief ? prevSessions.map((s) => ({ ...s, summary: firstParagraph(s.summary) })) : prevSessions,
      recentLearnings: brief
        ? recentLearnings.map(({ id, category, date, content }) => ({ id, category, date, headline: headline(content) }))
        : recentLearnings,
    },
    message: `Session #${totalSessions} started.${input.project ? ` Project: ${input.project}` : ''}`,
  };
}

// ─── session_end ─────────────────────────────────────

export const sessionEndSchema = z.object({
  sessionId: z.string().optional(),
  summary: z.string().optional(),
  tasks: z.array(z.string()).optional(),
});

export function sessionEnd(input: z.infer<typeof sessionEndSchema>): ToolResult {
  const db = getDb();

  // If no sessionId provided, use the most recent open session
  let targetId = input.sessionId;
  if (!targetId) {
    const latest = db
      .prepare('SELECT id FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
      .get() as { id: string } | undefined;
    if (!latest) {
      return { success: false, error: 'No active session to end.', code: 'NO_ACTIVE_SESSION' };
    }
    targetId = latest.id;
  }

  db.prepare('UPDATE sessions SET ended_at = ?, summary = ?, tasks_json = ? WHERE id = ?').run(
    nowIso(),
    input.summary ?? null,
    input.tasks ? JSON.stringify(input.tasks) : null,
    targetId
  );

  return {
    success: true,
    data: { sessionId: targetId },
    message: 'Session ended.',
  };
}
