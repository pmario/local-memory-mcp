/**
 * Paragraph helpers shared by the signals.
 */

// Paragraphs that only link other entries change freely and say nothing about the entry's own subject.
const LINKS = /^(Related:|Part of \[\[|The (parts|other)|.*separate learnings)/;

export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** The paragraphs that are not link lists. */
export function bodyParagraphs(text: string): string[] {
  return paragraphs(text).filter((p) => !LINKS.test(p));
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Paragraphs `after` adds when it keeps every paragraph of `before`; 0 for a rewrite. Link paragraphs do not count. */
export function addedParagraphs(before: string, after: string): number {
  const old = bodyParagraphs(before);
  const now = bodyParagraphs(after);
  return old.every((p) => now.includes(p)) ? Math.max(0, now.length - old.length) : 0;
}
