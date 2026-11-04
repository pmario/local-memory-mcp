/**
 * Tool output layout (local-memory-mcp-2mi): tab-indented JSON that keeps an array or object on one line when it fits.
 */

/** Columns a tab counts for when measuring a line against the width. */
const TAB_COLUMNS = 4;

/**
 * Serializes a value as JSON, putting each array or object on one line when that line fits within `width` columns.
 * @param value - any JSON-serializable value
 * @param width - maximum line width in columns, tabs counting as 4
 * @returns JSON text that parses to the same value as `JSON.stringify(value)`
 */
export function formatJson(value: unknown, width = 120): string {
  const normalized: unknown = JSON.parse(JSON.stringify(value) ?? 'null');
  return layout(normalized, 0, 0, width);
}

/**
 * Lays out one value that starts at `column`, expanding it only when its one-line form overflows.
 * @param value - a normalized JSON value
 * @param depth - nesting depth, the number of tabs before the closing bracket
 * @param column - column where the value starts
 * @param width - maximum line width in columns
 * @returns the value's JSON text
 */
function layout(value: unknown, depth: number, column: number, width: number): string {
  const flat = oneLine(value);
  // The +1 leaves room for the comma that follows an entry.
  if (value === null || typeof value !== 'object' || column + flat.length + 1 <= width) return flat;
  const pad = '\t'.repeat(depth + 1);
  const start = (depth + 1) * TAB_COLUMNS;
  const lines = Array.isArray(value)
    ? value.map((item) => pad + layout(item, depth + 1, start, width))
    : Object.entries(value).map(([key, item]) => {
      const prefix = `${JSON.stringify(key)}: `;
      return pad + prefix + layout(item, depth + 1, start + prefix.length, width);
    });
  if (lines.length === 0) return flat;
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return `${open}\n${lines.join(',\n')}\n${'\t'.repeat(depth)}${close}`;
}

/**
 * Serializes a normalized JSON value on one line, with a space after each comma and colon.
 * @param value - a normalized JSON value
 * @returns the value's one-line JSON text
 */
function oneLine(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(oneLine).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${oneLine(item)}`).join(', ')}}`;
  }
  return JSON.stringify(value);
}
