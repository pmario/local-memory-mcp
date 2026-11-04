/**
 * Tests for the tool output layout. Replicate by hand in node:
 * `import('./dist/lib/format-json.js').then((m) => console.log(m.formatJson({ next: [['0105c70b', 1, 7]] })))`
 */
import { describe, it, expect } from 'vitest';
import { formatJson } from './format-json.js';

describe('formatJson', () => {
  it('keeps a value on one line when it fits', () => {
    expect(formatJson({ a: [1, 'x'], b: { c: null } })).toBe('{"a": [1, "x"], "b": {"c": null}}');
  });

  it('expands an overflowing list and keeps each fitting entry on one line, indented with tabs', () => {
    const next = Array.from({ length: 10 }, (_, i) => [`id${i}`, 3, i]);
    expect(formatJson({ recheck: { pending: 2, next } }, 40)).toBe([
      '{',
      '\t"recheck": {',
      '\t\t"pending": 2,',
      '\t\t"next": [',
      ...next.map((e, i) => `\t\t\t["id${i}", 3, ${i}]${i < 9 ? ',' : ''}`),
      '\t\t]',
      '\t}',
      '}',
    ].join('\n'));
  });

  it('counts a tab as 4 columns and the key toward the width', () => {
    // At depth 1 the entry starts at column 4; `"k": ` adds 5, `[1, 2]` adds 6, the comma 1: 16 columns.
    expect(formatJson({ k: [1, 2], pad: 'xxxxxxxxxxxxxxxxxxxxxxxx' }, 16)).toContain('\t"k": [1, 2]');
    expect(formatJson({ k: [1, 2], pad: 'xxxxxxxxxxxxxxxxxxxxxxxx' }, 15)).toContain('\t"k": [\n\t\t1,\n\t\t2\n\t]');
  });

  it('parses back to the same value as JSON.stringify, including JSON.stringify edge cases', () => {
    const value = {
      text: 'brackets [ ] { }, commas, "quotes"\nand a newline',
      skipped: undefined,
      list: [undefined, () => 1, 0, false, ''],
      date: new Date('2026-11-04T00:00:00Z'),
      empty: { obj: {}, arr: [] },
      nested: Array.from({ length: 30 }, (_, i) => ({ i, tags: ['a', 'b'] })),
    };
    expect(JSON.parse(formatJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
  });

  it('prints empty containers as {} and [] and a top-level undefined as null', () => {
    expect(formatJson({ obj: {}, arr: [] }, 1)).toBe('{\n\t"obj": {},\n\t"arr": []\n}');
    expect(formatJson(undefined)).toBe('null');
  });
});
