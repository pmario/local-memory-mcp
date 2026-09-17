/**
 * Splits an entry into chunks the embedding model reads whole; the model truncates at 512 tokens.
 * Chunks after the first repeat the entry's first line so a paragraph keeps its subject.
 */
import { headline } from './brief.js';

export const CHUNK_TOKEN_BUDGET = 500;
export const CHUNKER_ID = 'paragraph-500-headline-v1';

type Counter = (text: string) => number;

// Finer split levels, tried in order when a piece is still over the limit.
const SPLITS: Array<[RegExp, string]> = [
  [/\n/, '\n'],
  [/(?<=[.!?])\s+/, ' '],
  [/\s+/, ' '],
];

function cutChars(text: string, max: number, count: Counter): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > 0 && count(rest) > max) {
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (count(rest.slice(0, mid)) <= max) lo = mid;
      else hi = mid - 1;
    }
    out.push(rest.slice(0, lo));
    rest = rest.slice(lo);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

function pack(parts: string[], separator: string, max: number, count: Counter): string[] {
  const out: string[] = [];
  let current = '';
  for (const part of parts) {
    const candidate = current ? `${current}${separator}${part}` : part;
    if (current && count(candidate) > max) {
      out.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

function pieces(text: string, max: number, count: Counter, level = 0): string[] {
  if (count(text) <= max) return [text];
  if (level === SPLITS.length) return cutChars(text, max, count);
  const [pattern, separator] = SPLITS[level];
  const parts = text.split(pattern).filter((p) => p.length > 0);
  if (parts.length <= 1) return pieces(text, max, count, level + 1);
  return pack(parts.flatMap((p) => pieces(p, max, count, level + 1)), separator, max, count);
}

/** `countTokens` must count what the model sees, including its passage prefix and special tokens. */
export function chunkText(text: string, countTokens: Counter, budget = CHUNK_TOKEN_BUDGET): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length === 0 || countTokens(normalized) <= budget) return [normalized.length > 0 ? normalized : text];

  const prefix = `${headline(normalized)}\n\n`;
  const prefixTokens = countTokens(prefix);
  const head = prefixTokens * 2 < budget ? prefix : '';
  const unitMax = budget - (head ? prefixTokens : 0);
  const units = normalized
    .split(/\n\s*\n/)
    .filter((p) => p.trim().length > 0)
    .flatMap((p) => pieces(p, unitMax, countTokens));

  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    const lead = chunks.length > 0 ? head : '';
    if (current && countTokens(lead + candidate) > budget) {
      chunks.push(lead + current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push((chunks.length > 0 ? head : '') + current);
  return chunks;
}
