/**
 * Default fields left out of read results (local-memory-mcp-2mi), so a plain entry carries only what it says.
 */

// Column defaults from schema.sql that a result leaves out, besides null, false and [].
const DEFAULTS: Record<string, unknown> = { confidence: 0.7, memory_type: 'semantic', lifecycle_state: 'active' };

/**
 * Drops the fields of a result entry that hold their default.
 * @param entry - a learning, decision, session or version as a read tool returns it
 * @returns the entry without null, false, empty-list and column-default fields
 */
export function withoutDefaults(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry).filter(([key, value]) => {
      if (value === null || value === undefined || value === false) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return !(key in DEFAULTS && DEFAULTS[key] === value);
    })
  );
}
