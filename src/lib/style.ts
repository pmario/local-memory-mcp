/**
 * The writing styles a learning can carry (local-memory-mcp-57k).
 *
 * `atomic`: one subject per entry. `factual`: all the facts, the current state
 * only, no story; a correction is rewritten into the text, never appended.
 */
import { z } from 'zod';

export const STYLES = ['atomic', 'factual'] as const;
export type Style = (typeof STYLES)[number];

// Every newly written text carries these; there is no way out.
export const DEFAULT_STYLE: Style[] = ['atomic', 'factual'];

export const zStyle = z.array(z.enum(STYLES));

// A line that opens an appended correction, e.g. "=== AMENDED 2026-09-08 ===" or "AMENDED: ...".
const AMENDMENT_SECTION = /^[ \t]*(?:=+[ \t]*)?AMENDED\b/m;

export function hasAmendmentSection(content: string): boolean {
  return AMENDMENT_SECTION.test(content);
}

export const AMENDMENT_ERROR = {
  success: false as const,
  error: 'A factual entry states the current state: rewrite the text instead of appending an AMENDED section.',
  code: 'AMENDMENT_SECTION',
};

/** The known styles in `values`, in list order, without duplicates; unknown values are dropped. */
export function knownStyles(values: readonly unknown[]): Style[] {
  return STYLES.filter((s) => values.includes(s));
}

/** A stored style_json value as an array; the column is only ever written by this server. */
export function parseStyle(json: string): Style[] {
  return knownStyles(JSON.parse(json) as unknown[]);
}
