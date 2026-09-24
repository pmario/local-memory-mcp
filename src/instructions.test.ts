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

describe('the writing rule reaches every session that writes (local-memory-mcp-lfu)', () => {
  it('memory_guide has a writing topic with the whole atomic/factual rule', async () => {
    const { guide } = await import('./tools/insights.js');
    const result = guide({ topic: 'writing' });
    if (!result.success) throw new Error(result.error);
    const content = (result.data as { content: string }).content;
    for (const text of ['atomic', 'factual', 'one subject', 'verbatim', 'sentence case', 'first line', 'AMENDED', 'memory_learn_update', 'split']) {
      expect(content).toContain(text);
    }
  });

  it('the writing topic also covers what surrounds the text (local-memory-mcp-x2t)', async () => {
    const { guide } = await import('./tools/insights.js');
    const result = guide({ topic: 'writing' });
    if (!result.success) throw new Error(result.error);
    const content = (result.data as { content: string }).content;
    for (const text of [
      'memory_search', // search before writing
      'outlives the session', // what qualifies
      'memoryType', // metadata
      'source',
      'store the split-off parts first', // splitting order
      'memory_learn_archive', // superseded entries
      'handoff pointer',
      'date', // when it was measured
      'secret', // never store one
      'promise', // the style label
    ]) {
      expect(content).toContain(text);
    }
  });

  it('the writing topic states the checked-style contract and the split shape (local-memory-mcp-i8n, -0eq)', async () => {
    const { guide } = await import('./tools/insights.js');
    const result = guide({ topic: 'writing' });
    if (!result.success) throw new Error(result.error);
    const content = (result.data as { content: string }).content;
    for (const text of ['REQUIRED', 'splitFrom', 'checklist', 'links every part']) expect(content).toContain(text);
    for (const text of ['stamps', 'the server stores each new learning']) expect(content).not.toContain(text);
  });

  it('the writing topic makes atomic a test, not a judgment (local-memory-mcp-jz8)', async () => {
    const { guide } = await import('./tools/insights.js');
    const result = guide({ topic: 'writing' });
    if (!result.success) throw new Error(result.error);
    const content = (result.data as { content: string }).content;
    for (const text of ['every paragraph and every rule', 'Before drafting', 'stated reason', 'fewer entries', 'style last']) {
      expect(content).toContain(text);
    }
  });

  it('the writing topic defines project as scope, not provenance (local-memory-mcp-ler)', async () => {
    const { guide } = await import('./tools/insights.js');
    const result = guide({ topic: 'writing' });
    if (!result.success) throw new Error(result.error);
    const content = (result.data as { content: string }).content;
    expect(content).toContain('`project` is the scope a learning applies to');
    expect(content).toContain('rules that hold across projects');
    expect(content).not.toContain('SHOULD be set as provenance');
  });

  it('the writing topic defines source and how a part fills it (local-memory-mcp-ag7)', async () => {
    const { guide } = await import('./tools/insights.js');
    const result = guide({ topic: 'writing' });
    if (!result.success) throw new Error(result.error);
    const content = (result.data as { content: string }).content;
    for (const text of ['where the finding came from', 'set once', "SHOULD copy the hub's", 'MUST NOT record the split']) {
      expect(content).toContain(text);
    }
  });

  it('the writing topic states its rules in RFC 2119 key words (local-memory-mcp-jz8)', async () => {
    const { guide } = await import('./tools/insights.js');
    const result = guide({ topic: 'writing' });
    if (!result.success) throw new Error(result.error);
    const content = (result.data as { content: string }).content;
    for (const text of ['RFC 2119', 'MUST', 'MUST NOT', 'REQUIRED', 'SHOULD']) expect(content).toContain(text);
    for (const text of ['Always pass', 'Never store', 'Never rewrite']) expect(content).not.toContain(text);
  });

  it('the server instructions send a writer to that topic', async () => {
    const { INSTRUCTIONS } = await import('./instructions.js');
    expect(INSTRUCTIONS).toContain('memory_guide({topic: "writing"})');
  });

  it('every tool that writes a learning text points to that topic', async () => {
    const { toMcpToolList } = await import('./tools/registry.js');
    for (const name of ['memory_learn', 'memory_learn_update', 'memory_learn_bulk']) {
      const description = toMcpToolList().find((t) => t.name === name)?.description;
      expect(description).toContain('memory_guide({topic: "writing"})');
    }
  });
});

describe('memory_guide matches the code', () => {
  async function topic(name: string): Promise<string> {
    const { guide } = await import('./tools/insights.js');
    const result = guide({ topic: name });
    if (!result.success) throw new Error(result.error);
    return (result.data as { content: string }).content;
  }

  it('search says a multi-word query matches any word, as escapeFtsQuery ORs the tokens', async () => {
    const content = await topic('search');
    expect(content).not.toContain('AND-combined');
    expect(content).toContain('any of the words');
  });

  it('quickstart and session point to memory_get and the brief default', async () => {
    const quickstart = await topic('quickstart');
    const session = await topic('session');
    expect(quickstart).toContain('memory_get');
    expect(session).toContain('memory_get');
    expect(session).toContain('brief');
    expect(session).not.toContain('last 3 sessions.');
  });

  it('learn no longer promises merging of similar entries, removed in v2.4.0', async () => {
    const content = await topic('learn');
    expect(content).not.toContain('merged');
    expect(content).toContain('memory_learn_update');
  });

  it('the memory_guide tool description names every topic, so the model finds them without a call', async () => {
    const { guide } = await import('./tools/insights.js');
    const { toMcpToolList } = await import('./tools/registry.js');
    const result = guide({});
    if (!result.success) throw new Error(result.error);
    const description = toMcpToolList().find((t) => t.name === 'memory_guide')?.description;
    for (const name of (result.data as { topics: string[] }).topics) expect(description).toContain(name);
  });
});
