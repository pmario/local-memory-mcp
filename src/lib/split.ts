/**
 * A split learning (local-memory-mcp-i8n): each part names its hub in split_from, and hub and parts link each other with [[id8]].
 */
import type Database from 'better-sqlite3';

type Refusal = { success: false; error: string; code: string };

const id8 = (id: string) => id.slice(0, 8);
const links = (content: string, id: string) => content.includes(`[[${id8(id)}]]`) || content.includes(`[[${id}]]`);

/** Ids of the active learnings that name `hubId` as their hub, oldest first. */
export function activeParts(db: Database.Database, hubId: string): string[] {
  const rows = db
    .prepare('SELECT id FROM learnings WHERE split_from = ? AND archived = 0 ORDER BY date, id')
    .all(hubId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Why `content`, written as a part of `hubId`, may not be stored; null when it may. `partId` is null for a new entry. */
export function checkPart(db: Database.Database, partId: string | null, hubId: string, content: string): Refusal | null {
  const hub = db.prepare('SELECT id, split_from FROM learnings WHERE id = ?').get(hubId) as
    | { id: string; split_from: string | null }
    | undefined;
  if (!hub) return { success: false, error: `Hub ${hubId} not found; splitFrom takes the full id.`, code: 'HUB_NOT_FOUND' };
  if (hub.id === partId || hub.split_from !== null || (partId !== null && activeParts(db, partId).length > 0)) {
    return { success: false, error: 'A split has one level: a hub is not a part, and a part is not a hub.', code: 'NESTED_SPLIT' };
  }
  if (!links(content, hubId)) {
    return { success: false, error: `A part links its hub: add [[${id8(hubId)}]] to the text.`, code: 'SPLIT_LINK_MISSING' };
  }
  return null;
}

/** Why `content`, written as hub `hubId`, may not be stored; null when it links every active part. */
export function checkHub(db: Database.Database, hubId: string, content: string): Refusal | null {
  const missing = activeParts(db, hubId).filter((id) => !links(content, id));
  if (missing.length === 0) return null;
  return {
    success: false,
    error: `A hub links every active part; missing: ${missing.map((id) => `[[${id8(id)}]]`).join(', ')}.`,
    code: 'SPLIT_LINK_MISSING',
  };
}
