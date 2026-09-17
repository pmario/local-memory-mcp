/**
 * Tests for the chunker that splits long entries for embedding.
 * The counter here is a word count, so budgets read as "words"; production passes the model tokenizer.
 */
import { describe, it, expect } from 'vitest';
import { chunkText } from './chunk.js';

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe('chunkText', () => {
  it('returns a text that fits as its only chunk', () => {
    const text = 'Claim line.\n\nOne short paragraph.';
    expect(chunkText(text, words, 20)).toEqual([text]);
  });

  it('packs whole paragraphs into chunks within the budget, in order', () => {
    const text = 'Head line here.\n\nalpha beta gamma delta.\n\nepsilon zeta eta theta.\n\niota kappa lambda mu.';
    const chunks = chunkText(text, words, 12);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(words(c)).toBeLessThanOrEqual(12);
    const order = ['alpha', 'epsilon', 'iota'].map((w) => chunks.findIndex((c) => c.includes(w)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const para of text.split('\n\n').slice(1)) expect(chunks.some((c) => c.includes(para))).toBe(true);
  });

  it('starts every chunk after the first with the first line and a blank line', () => {
    const text = 'Head line here.\n\nalpha beta gamma delta.\n\nepsilon zeta eta theta.\n\niota kappa lambda mu.';
    const [first, ...rest] = chunkText(text, words, 12);
    expect(first!.startsWith('Head line here.\n\n')).toBe(true);
    expect(rest.length).toBeGreaterThan(0);
    for (const c of rest) expect(c.startsWith('Head line here.\n\n')).toBe(true);
    expect(first!.indexOf('Head line here.', 1)).toBe(-1);
  });

  it('splits a paragraph longer than the budget at sentence ends', () => {
    const text = 'Head.\n\nOne two three. Four five six. Seven eight nine. Ten eleven twelve.';
    const chunks = chunkText(text, words, 8);
    for (const c of chunks) expect(words(c)).toBeLessThanOrEqual(8);
    expect(chunks.some((c) => c.endsWith('three.') || c.includes('One two three. Four five six.'))).toBe(true);
    expect(chunks.join(' ')).toContain('Ten eleven twelve.');
  });

  it('hard-splits a sentence longer than the budget, keeping every word', () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    const text = `Head.\n\n${long}`;
    const chunks = chunkText(text, words, 8);
    for (const c of chunks) expect(words(c)).toBeLessThanOrEqual(8);
    for (let i = 0; i < 30; i++) expect(chunks.some((c) => c.split(/\s+/).includes(`w${i}`))).toBe(true);
  });

  it('treats CRLF line endings like LF', () => {
    const lf = 'Head line.\n\nalpha beta gamma delta.\n\nepsilon zeta eta theta.';
    expect(chunkText(lf.replace(/\n/g, '\r\n'), words, 10)).toEqual(chunkText(lf, words, 10));
  });

  it('cuts a long first line to 200 chars in the prefix', () => {
    const head = 'x'.repeat(300);
    const text = `${head}\n\nalpha beta gamma.\n\ndelta epsilon zeta.`;
    const chunks = chunkText(text, (t) => t.split(/\s+/).filter(Boolean).length + (t.length > 400 ? 50 : 0), 6);
    const prefixed = chunks.slice(1);
    expect(prefixed.length).toBeGreaterThan(0);
    for (const c of prefixed) expect(c.split('\n\n')[0]!.length).toBeLessThanOrEqual(200);
  });
});
