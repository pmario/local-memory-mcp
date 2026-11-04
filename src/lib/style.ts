/**
 * The writing styles a writer declares (local-memory-mcp-57k, -i8n, -zpz): an attestation on each write, not stored.
 *
 * `atomic`: one subject per entry; `factual`: all the facts, the current state only, no story.
 */
import { z } from 'zod';
import { scratchPaths } from '../signals/scratch.js';

export const STYLES = ['atomic', 'factual'] as const;
export type Style = (typeof STYLES)[number];

// Read once at server start, like MEMORY_REQUIRE_VEC; "0" lets text writes through without a style.
export const STYLE_REQUIRED = process.env.MEMORY_REQUIRE_STYLE !== '0';

export const zStyle = z.array(z.enum(STYLES));

const STYLE_REQUIRED_MESSAGE =
  'A learning text MUST declare style ["atomic", "factual"], and MUST NOT pass it before checking the text against memory_guide({topic: "writing"}).';

/** True when `style` holds every known value. */
export function isChecked(style: readonly unknown[]): boolean {
  return STYLES.every((s) => style.includes(s));
}

// The style field of a tool that writes a new text: required with both values unless switched off.
export const zWrittenStyle = STYLE_REQUIRED
  ? z.array(z.enum(STYLES), { required_error: STYLE_REQUIRED_MESSAGE }).refine(isChecked, { message: STYLE_REQUIRED_MESSAGE })
  : zStyle.optional();

export const STYLE_REQUIRED_ERROR = {
  success: false as const,
  error: STYLE_REQUIRED_MESSAGE,
  code: 'STYLE_REQUIRED',
};

// A line that opens an appended correction, e.g. "=== AMENDED 2026-09-08 ===" or "UPDATE: ...".
// UPDATE counts only before ":", "=", a date or the line end, because SQL opens lines with it.
const CORRECTION_SECTION =
  /^[ \t]*(?:=+[ \t]*)?(?:(?:AMENDED|SUPERSEDED|CORRECTED|ADDENDUM)\b|UPDATE[ \t]*(?:[:=]|\d{4}-\d{2}-\d{2}|$))/m;
const FENCED_CODE = /^```[\s\S]*?^```/gm;

export function hasAmendmentSection(content: string): boolean {
  return CORRECTION_SECTION.test(content.replace(FENCED_CODE, ''));
}

export const AMENDMENT_ERROR = {
  success: false as const,
  error: 'A factual entry MUST state the current state: rewrite the text, and MUST NOT append an AMENDED, SUPERSEDED, CORRECTED, UPDATE or ADDENDUM section.',
  code: 'AMENDMENT_SECTION',
};

/**
 * Refuses a text declared factual that contradicts the declaration (local-memory-mcp-zpz): an amendment section or a scratch path.
 * @param style - the declared style
 * @param content - the text to write
 * @returns the refusal, or null when the text may be written
 */
export function factualRefusal(style: readonly unknown[], content: string) {
  if (!style.includes('factual')) return null;
  if (hasAmendmentSection(content)) return AMENDMENT_ERROR;
  const paths = scratchPaths(content);
  if (paths.length === 0) return null;
  return {
    success: false as const,
    error: `Refused: the text is declared factual but cites a scratch path (${paths.join(', ')}). A scratch file does not last, so the evidence it holds is lost: move it to a versioned directory and cite that path, or state the result without the path.`,
    code: 'SCRATCH_PATH',
  };
}

/** The known styles in `values`, in list order, without duplicates; unknown values are dropped. */
export function knownStyles(values: readonly unknown[]): Style[] {
  return STYLES.filter((s) => values.includes(s));
}

/** A stored style_json value as an array; the column is only ever written by this server. */
export function parseStyle(json: string): Style[] {
  return knownStyles(JSON.parse(json) as unknown[]);
}
