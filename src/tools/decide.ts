/**
 * Decision logging — strategic choices with reasoning and alternatives.
 *
 * Decisions are treated separately from learnings because they represent
 * "what we chose" rather than "what we learned". They're often revisited
 * and reviewed over time.
 *
 * v2.0.0+: a decision's embedding is the title + decision + reasoning
 * concatenated, so a search for "Postgres vs SQLite" finds a decision
 * whose title is "Database choice" but whose reasoning text discusses both.
 *
 * F4 fix (Critic R1): the embedding is computed outside any transaction,
 * then the row insert + embedding insert commit atomically together.
 */
import { z } from 'zod';
import { getDb, newId, nowIso } from '../db/client.js';
import { decisionEmbeddingText, prepareEmbedding, writeEmbeddingSync } from '../db/vector.js';
import type { ToolResult } from '../lib/types.js';

// The embedding text moved to db/vector.ts, which the backfill needs too; re-exported for existing imports.
export { decisionEmbeddingText };

export const decideSchema = z.object({
  title: z.string().min(1).max(200),
  decision: z.string().min(1).max(10000),
  reasoning: z.string().min(1).max(10000),
  alternatives: z.string().max(10000).optional(),
  project: z.string().optional(),
  tags: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export async function decide(input: z.infer<typeof decideSchema>): Promise<ToolResult> {
  const db = getDb();
  const id = newId();

  const vec = await prepareEmbedding(decisionEmbeddingText(input));

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO decisions
       (id, date, title, decision, alternatives, reasoning, project, tags_json, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      nowIso(),
      input.title,
      input.decision,
      input.alternatives ?? null,
      input.reasoning,
      input.project ?? null,
      JSON.stringify(input.tags ?? []),
      input.confidence ?? 0.7
    );
    writeEmbeddingSync(db, id, 'decision', vec);
  });
  tx();

  return {
    success: true,
    data: { id },
    message: `Decision "${input.title}" saved.`,
  };
}

// A decision cannot be edited, so a replaced one is retired like an archived learning (wikilabs-kfw).
export const decisionArchiveSchema = z.object({
  decisionId: z.string().min(1),
  reason: z.string().min(1).max(500),
  supersededBy: z.array(z.string().min(1)).min(1).max(20).optional(),
});

export function decisionArchive(input: z.infer<typeof decisionArchiveSchema>): ToolResult {
  const db = getDb();
  const existing = db
    .prepare('SELECT id, archived FROM decisions WHERE id = ?')
    .get(input.decisionId) as { id: string; archived: number } | undefined;

  if (!existing) {
    return { success: false, error: 'Decision not found.', code: 'NOT_FOUND' };
  }
  if (existing.archived === 1) {
    return {
      success: true,
      data: { id: input.decisionId, action: 'already_archived' },
      message: 'Decision was already archived.',
    };
  }

  const successors = [...new Set(input.supersededBy ?? [])];
  if (successors.includes(input.decisionId)) {
    return { success: false, error: 'A decision cannot supersede itself.', code: 'SELF_SUPERSEDE' };
  }
  // A successor may itself be archived later, so only its existence is checked.
  const exists = db.prepare('SELECT 1 FROM decisions WHERE id = @id UNION SELECT 1 FROM learnings WHERE id = @id');
  const unknown = successors.filter((id) => !exists.get({ id }));
  if (unknown.length > 0) {
    return { success: false, error: `Successor not found: ${unknown.join(', ')}. Pass full decision or learning ids.`, code: 'SUPERSEDER_NOT_FOUND' };
  }

  const lifecycle = `archived:${input.reason}`;
  db.prepare(
    `UPDATE decisions
       SET archived = 1,
           archived_at = ?,
           lifecycle_state = ?,
           superseded_by_json = ?
     WHERE id = ?`
  ).run(nowIso(), lifecycle, JSON.stringify(successors), input.decisionId);

  return {
    success: true,
    data: { id: input.decisionId, action: 'archived', lifecycleState: lifecycle, supersededBy: successors },
    message: `Decision archived: ${input.reason}.`,
  };
}
