/**
 * Tests for the server instructions every MCP client puts into each session's system prompt.
 * By hand: the `instructions` field of the initialize result is INSTRUCTIONS verbatim.
 */
import { describe, it, expect } from 'vitest';

describe('INSTRUCTIONS', () => {
  it('stays under 1,000 chars, well inside the 2,048 Claude Code shows', async () => {
    const { INSTRUCTIONS } = await import('./instructions.js');
    expect(INSTRUCTIONS.length).toBeLessThan(1000);
  });

  it('names only tools that exist', async () => {
    const { INSTRUCTIONS } = await import('./instructions.js');
    const { TOOLS } = await import('./tools/registry.js');
    const names = TOOLS.map((t) => t.name);
    const named = INSTRUCTIONS.match(/memory_[a-z_]+/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(names).toContain(name);
  });

  it('tells the model to start the session and read entries by id', async () => {
    const { INSTRUCTIONS } = await import('./instructions.js');
    expect(INSTRUCTIONS).toContain('memory_session_start');
    expect(INSTRUCTIONS).toContain('memory_get');
    expect(INSTRUCTIONS).toContain('memory_session_end');
    expect(INSTRUCTIONS).toContain('memory_guide');
  });
});

describe('memory_guide keeps what INSTRUCTIONS no longer carries', () => {
  async function topic(name: string): Promise<string> {
    const { guide } = await import('./tools/insights.js');
    const result = guide({ topic: name });
    if (!result.success) throw new Error(result.error);
    return (result.data as { content: string }).content;
  }

  it('lists lifecycle and portability among the topics', async () => {
    const { guide } = await import('./tools/insights.js');
    const result = guide({});
    if (!result.success) throw new Error(result.error);
    const { topics } = result.data as { topics: string[] };
    expect(topics).toContain('lifecycle');
    expect(topics).toContain('portability');
  });

  it('lifecycle covers asOf, contradictions, archive, update, supersede and reflect', async () => {
    const content = await topic('lifecycle');
    for (const text of [
      'memory_entity_open',
      'asOf',
      'memory_contradictions',
      'memory_learn_archive',
      'memory_learn_update',
      'memory_observation_supersede',
      'memory_reflect',
    ]) {
      expect(content).toContain(text);
    }
  });

  it('portability covers bulk insert, export and import', async () => {
    const content = await topic('portability');
    for (const text of ['memory_learn_bulk', 'memory_export', 'memory_import']) expect(content).toContain(text);
  });

  it('search names the three modes and the FTS5 fallback', async () => {
    const content = await topic('search');
    for (const text of ['fts', 'vector', 'hybrid', 'falls back']) expect(content).toContain(text);
  });
});
