/**
 * Short stand-ins for full text in brief tool results; memory_get returns the full text by id.
 */

const HEADLINE_MAX = 200;
const PARAGRAPH_MAX = 400;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function headline(text: string): string {
  return cut(text.trim().split(/\r?\n/)[0].trimEnd(), HEADLINE_MAX);
}

export function firstParagraph(text: string): string {
  return cut(text.trim().split(/\r?\n\s*\r?\n/)[0].trimEnd(), PARAGRAPH_MAX);
}
