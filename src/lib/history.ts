/**
 * Learning history (local-memory-mcp-mnb): a change to a learning first copies the row it replaces into learnings_history.
 */
import type Database from 'better-sqlite3';
import { newId, nowIso } from '../db/client.js';

// Read once at server start; import-md.mjs sets "0", because a synced change brings its version from the machine that made it.
export const RECORD_HISTORY = process.env.MEMORY_RECORD_HISTORY !== '0';

// Every learnings column a writer can change; usage_count and last_used are not versions.
export const VERSIONED_COLUMNS = [
  'category',
  'content',
  'project',
  'tags_json',
  'confidence',
  'memory_type',
  'style_json',
  'split_from',
  'archived',
  'lifecycle_state',
] as const;

const COLUMNS = VERSIONED_COLUMNS.join(', ');

/**
 * Reads the earlier contents of every learning, for the signals that compare versions.
 * @param db - the store
 * @returns earlier contents per learning id, oldest first
 */
export function contentVersions(db: Database.Database): Map<string, string[]> {
  const versions = new Map<string, string[]>();
  const rows = db.prepare('SELECT learning_id, content FROM learnings_history ORDER BY learning_id, expired_at, rowid').all() as Array<{
    learning_id: string;
    content: string;
  }>;
  for (const v of rows) {
    const list = versions.get(v.learning_id) ?? [];
    list.push(v.content);
    versions.set(v.learning_id, list);
  }
  return versions;
}

/** When the current version of a learning became current: the end of its latest version, else its creation. */
export function currentSince(db: Database.Database, learningId: string): string | null {
  const row = db
    .prepare(
      `SELECT COALESCE((SELECT MAX(expired_at) FROM learnings_history WHERE learning_id = l.id), l.date) AS since
       FROM learnings l WHERE l.id = ?`
    )
    .get(learningId) as { since: string } | undefined;
  return row?.since ?? null;
}

/**
 * Runs `change` and, when it altered a versioned column, stores the row as it was before.
 * Call inside the transaction that makes the change, so the version and the change commit together.
 */
export function withHistory(db: Database.Database, learningId: string, change: () => void): void {
  if (!RECORD_HISTORY) {
    change();
    return;
  }
  const read = db.prepare(`SELECT ${COLUMNS} FROM learnings WHERE id = ?`);
  const before = read.get(learningId) as Record<string, unknown> | undefined;
  const since = currentSince(db, learningId);
  change();
  const after = read.get(learningId) as Record<string, unknown> | undefined;
  if (!before || !after || VERSIONED_COLUMNS.every((c) => before[c] === after[c])) return;
  db.prepare(
    `INSERT INTO learnings_history (id, learning_id, ${COLUMNS}, recorded_at, expired_at)
     VALUES (?, ?, ${VERSIONED_COLUMNS.map(() => '?').join(', ')}, ?, ?)`
  ).run(newId(), learningId, ...VERSIONED_COLUMNS.map((c) => before[c]), since, nowIso());
}
