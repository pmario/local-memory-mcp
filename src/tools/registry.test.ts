/**
 * Tests for the Zod -> JSON Schema conversion behind tools/list.
 *
 * A client sees only this schema, so a constraint the server enforces must
 * appear in it. By hand: call tools/list over stdio and read inputSchema of
 * memory_learn_bulk and memory_entity_open.
 */
import { describe, it, expect } from 'vitest';

type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; items?: JsonSchema; minItems?: number; maxItems?: number };

async function schemaOf(tool: string): Promise<JsonSchema> {
  const { toMcpToolList } = await import('./registry.js');
  const found = toMcpToolList().find((t) => t.name === tool);
  if (!found) throw new Error(`tool ${tool} not listed`);
  return found.inputSchema as JsonSchema;
}

describe('tool JSON schemas', () => {
  it('keeps the length limits of an array parameter', async () => {
    const items = (await schemaOf('memory_learn_bulk')).properties?.items;
    expect(items?.type).toBe('array');
    expect(items?.minItems).toBe(1);
    expect(items?.maxItems).toBe(500);
  });

  it('keeps a minimum without a maximum', async () => {
    const tags = (await schemaOf('memory_search')).properties?.tags;
    expect(tags?.minItems).toBe(1);
    expect(tags?.maxItems).toBeUndefined();
  });

  it('describes a validated date string as a string', async () => {
    expect((await schemaOf('memory_entity_open')).properties?.asOf?.type).toBe('string');
    expect((await schemaOf('memory_observation_supersede')).properties?.validTo?.type).toBe('string');
  });

  it('leaves the import envelope a loose object', async () => {
    // memoryImport parses the envelope itself, so its free-form record stays the fallback.
    expect((await schemaOf('memory_import')).properties?.data?.type).toBe('object');
  });
});
