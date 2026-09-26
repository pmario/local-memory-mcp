/**
 * The read counter (local-memory-mcp-w8u): read_count grows each time a tool delivers a learning's full text,
 * which is what a defect in that text costs; usage_count also counts updates and duplicate writes.
 */
import type Database from 'better-sqlite3';

export function countReads(db: Database.Database, ids: readonly string[]): void {
  if (ids.length === 0) return;
  db.prepare(`UPDATE learnings SET read_count = read_count + 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
}
