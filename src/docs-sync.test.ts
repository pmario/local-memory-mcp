/**
 * Docs that list or count the tools must agree with the registry, so a new tool cannot ship half-documented.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf-8');

describe('tool docs match the registry', () => {
  it('the mcpb manifest lists exactly the registered tools', async () => {
    const { TOOLS } = await import('./tools/registry.js');
    const manifest = JSON.parse(read('mcpb-build/manifest.json')) as { tools: Array<{ name: string }> };
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it('every tool count in README, WHITEPAPER and the manifest is the registry size', async () => {
    const { TOOLS } = await import('./tools/registry.js');
    const readme = read('README.md');
    const counts = [
      /\*\*Persistent local memory[^*]*?(\d+) tools\./.exec(readme)?.[1],
      /^## Tools \((\d+)\)$/m.exec(readme)?.[1],
      ...[...read('WHITEPAPER.md').matchAll(/(\d+) tools/g)].map((m) => m[1]),
      /(\d+) tools/.exec(JSON.parse(read('mcpb-build/manifest.json')).long_description)?.[1],
    ];
    expect(counts).toEqual(Array(6).fill(String(TOOLS.length)));
  });

  it('the manifest memory_guide entry names every guide topic', async () => {
    const { guide } = await import('./tools/insights.js');
    const result = guide({});
    if (!result.success) throw new Error(result.error);
    const manifest = JSON.parse(read('mcpb-build/manifest.json')) as { tools: Array<{ name: string; description: string }> };
    const entry = manifest.tools.find((t) => t.name === 'memory_guide');
    for (const topic of (result.data as { topics: string[] }).topics) expect(entry?.description).toContain(topic);
  });
});
