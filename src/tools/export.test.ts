/**
 * Tests for memory_export + memory_import (v2.2.0). The roundtrip case seeds
 * one DB, exports, switches MEMORY_DB_PATH to a fresh file, and imports —
 * proving the envelope is a faithful, portable backup. Embedding re-derivation
 * is exercised but only asserted when sqlite-vec loaded (isVectorEnabled).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Hand-written import fixtures use real UUIDs since #29. A non-UUID id is not
// rejected — it is canonicalised — so a fixture written as 'e1' would still
// import, but under a DERIVED id, and the dangling-reference assertions below
// would then be measuring the mapping instead of the reference check they exist
// to cover. Fixed values, not randomUUID(), so a failure is reproducible.
const ID = {
  observation: '11111111-1111-4111-8111-111111111111',
  ghostEntity: '22222222-2222-4222-8222-222222222222',
  entity: '33333333-3333-4333-8333-333333333333',
  relation: '44444444-4444-4444-8444-444444444444',
  missingEntity: '55555555-5555-4555-8555-555555555555',
  decision: '66666666-6666-4666-8666-666666666666',
};

let tmp = '';
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'local-memory-export-'));
  process.env.MEMORY_DB_PATH = join(tmp, 'a.sqlite');
});
afterEach(async () => {
  const { closeDb } = await import('../db/client.js');
  closeDb();
  delete process.env.MEMORY_DB_PATH;
  rmSync(tmp, { recursive: true, force: true });
});

async function seed(): Promise<{ entityId: string }> {
  const { learn } = await import('./learn.js');
  const { decide } = await import('./decide.js');
  const { entityCreate, entityObserve, entityRelate } = await import('./entity.js');
  const { profile, goal } = await import('./insights.js');

  await learn({ category: 'pattern', content: 'export uses a versioned envelope' });
  await decide({ title: 'Use RRF', decision: 'fuse BM25 + vector', reasoning: 'best recall' });

  const e1 = entityCreate({ name: 'Matthias', entityType: 'person' });
  const e2 = entityCreate({ name: 'StudioMeyer', entityType: 'company' });
  const eid1 = (e1.data as { id: string }).id;
  const eid2 = (e2.data as { id: string }).id;
  await entityObserve({ entityId: eid1, content: 'builds local-first memory tooling' });
  entityRelate({ fromEntityId: eid1, toEntityId: eid2, relationType: 'founder_of' });

  profile({ action: 'set', field: 'name', value: 'Matthias' });
  goal({ action: 'set', goal: 'ship v2.2.0' });

  return { entityId: eid1 };
}

describe('memory_export', () => {
  it('exports an empty DB as a well-formed envelope with zero counts', async () => {
    const { memoryExport } = await import('./export.js');
    const r = memoryExport({});
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as {
        format: string;
        version: number;
        counts: Record<string, number>;
        learnings: unknown[];
      };
      expect(d.format).toBe('studiomeyer-memory-export');
      expect(d.version).toBe(1);
      expect(d.counts.learnings).toBe(0);
      expect(d.learnings).toEqual([]);
    }
  });

  it('captures learnings, decisions, graph, profile and goal', async () => {
    const { memoryExport } = await import('./export.js');
    await seed();
    const r = memoryExport({});
    expect(r.success).toBe(true);
    if (r.success) {
      const d = r.data as {
        counts: Record<string, number>;
        profile: Record<string, string>;
        goal: string | null;
        relations: unknown[];
      };
      expect(d.counts.learnings).toBe(1);
      expect(d.counts.decisions).toBe(1);
      expect(d.counts.entities).toBe(2);
      expect(d.counts.observations).toBe(1);
      expect(d.counts.relations).toBe(1);
      expect(d.profile.name).toBe('Matthias');
      expect(d.goal).toBe('ship v2.2.0');
    }
  });

  it('honours includeSessions: false', async () => {
    const { memoryExport } = await import('./export.js');
    const { sessionStart } = await import('./session.js');
    await sessionStart({});
    const r = memoryExport({ includeSessions: false });
    if (r.success) {
      const d = r.data as { counts: Record<string, number>; sessions: unknown[] };
      expect(d.counts.sessions).toBe(0);
      expect(d.sessions).toEqual([]);
    }
  });
});

describe('memory_import', () => {
  it('roundtrips a full memory into a fresh database', async () => {
    const { memoryExport, memoryImport } = await import('./export.js');
    const { closeDb } = await import('../db/client.js');
    const { recall } = await import('./learn.js');
    const { entityOpen } = await import('./entity.js');

    await seed();
    const exp = memoryExport({});
    if (!exp.success) throw new Error('export failed');
    const envelope = exp.data;

    // Switch to a brand-new DB file and import there.
    closeDb();
    process.env.MEMORY_DB_PATH = join(tmp, 'b.sqlite');

    const imp = await memoryImport({ data: envelope as Record<string, unknown> });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number> };
      expect(d.imported.learnings).toBe(1);
      expect(d.imported.decisions).toBe(1);
      expect(d.imported.entities).toBe(2);
      expect(d.imported.observations).toBe(1);
      expect(d.imported.relations).toBe(1);
    }

    // Verify the data is actually queryable in the new DB.
    const rec = recall({ query: 'envelope' });
    if (rec.success) expect((rec.data as { count: number }).count).toBeGreaterThanOrEqual(1);

    const ent = entityOpen({ name: 'Matthias', entityType: 'person' });
    expect(ent.success).toBe(true);
    if (ent.success) {
      const d = ent.data as { observations: unknown[]; relations: unknown[] };
      expect(d.observations.length).toBe(1);
      expect(d.relations.length).toBe(1);
    }
  });

  it('is idempotent — re-importing the same envelope adds nothing', async () => {
    const { memoryExport, memoryImport } = await import('./export.js');
    await seed();
    const exp = memoryExport({});
    if (!exp.success) throw new Error('export failed');

    // Import back into the SAME (already-populated) DB → everything is a dup.
    const imp = await memoryImport({ data: exp.data as Record<string, unknown> });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number> };
      expect(d.imported.learnings).toBe(0);
      expect(d.imported.entities).toBe(0);
      expect(d.imported.observations).toBe(0);
      expect(d.imported.relations).toBe(0);
    }
  });

  it('skips an observation whose entity is absent (dangling reference)', async () => {
    const { memoryImport } = await import('./export.js');
    const envelope = {
      format: 'studiomeyer-memory-export',
      version: 1,
      entities: [],
      observations: [{ id: ID.observation, entityId: ID.ghostEntity, content: 'orphan fact' }],
      relations: [],
      learnings: [],
      decisions: [],
      sessions: [],
    };
    const imp = await memoryImport({ data: envelope });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as {
        imported: Record<string, number>;
        skipped: Record<string, number>;
      };
      expect(d.imported.observations).toBe(0);
      expect(d.skipped.observationsMissingEntity).toBe(1);
    }
  });

  it('skips a relation whose endpoint is absent', async () => {
    const { memoryImport } = await import('./export.js');
    const envelope = {
      format: 'studiomeyer-memory-export',
      version: 1,
      entities: [{ id: ID.entity, name: 'Solo', entityType: 'person' }],
      observations: [],
      relations: [
        { id: ID.relation, fromEntityId: ID.entity, toEntityId: ID.missingEntity, relationType: 'knows' },
      ],
      learnings: [],
      decisions: [],
      sessions: [],
    };
    const imp = await memoryImport({ data: envelope });
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number>; skipped: Record<string, number> };
      expect(d.imported.entities).toBe(1);
      expect(d.imported.relations).toBe(0);
      expect(d.skipped.relationsMissingEndpoint).toBe(1);
    }
  });

  it('rejects an unrecognised format', async () => {
    const { memoryImport } = await import('./export.js');
    const r = await memoryImport({ data: { format: 'mem0-export', version: 1 } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('BAD_FORMAT');
  });

  it('rejects a future export version', async () => {
    const { memoryImport } = await import('./export.js');
    const r = await memoryImport({ data: { format: 'studiomeyer-memory-export', version: 999 } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('UNSUPPORTED_VERSION');
  });

  it('rejects version 0, negative, non-integer, and NaN (C2)', async () => {
    const { memoryImport } = await import('./export.js');
    for (const v of [0, -1, 1.5, NaN]) {
      const r = await memoryImport({ data: { format: 'studiomeyer-memory-export', version: v } });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.code).toBe('UNSUPPORTED_VERSION');
    }
  });

  it('skips a decision missing its NOT-NULL reasoning instead of inserting "" (C1)', async () => {
    const { memoryImport } = await import('./export.js');
    const envelope = {
      format: 'studiomeyer-memory-export',
      version: 1,
      entities: [],
      observations: [],
      relations: [],
      sessions: [],
      learnings: [],
      decisions: [{ id: ID.decision, title: 'No reasoning', decision: 'do X' }], // reasoning omitted
    };
    const imp = await memoryImport({ data: envelope });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number>; skipped: Record<string, number> };
      expect(d.imported.decisions).toBe(0);
      expect(d.skipped.malformed).toBeGreaterThanOrEqual(1);
    }
  });

  // ─── #29: import must enforce the same constraints as every other write ───
  //
  // Reported by @pmario with a runnable repro. Before v2.4.3 memory_import
  // guarded records with isStr()/asNum() only, so an envelope could write rows
  // no interactive tool could produce. Each test below fails if the zod shapes
  // in export.ts are weakened back toward the old guards.

  const envelopeWith = (over: Record<string, unknown>) => ({
    format: 'studiomeyer-memory-export',
    version: 1,
    entities: [],
    observations: [],
    relations: [],
    sessions: [],
    learnings: [],
    decisions: [],
    ...over,
  });

  it('rejects the exact #29 repro record and writes nothing', async () => {
    const { memoryImport } = await import('./export.js');
    const { getDb } = await import('../db/client.js');
    const imp = await memoryImport({
      data: envelopeWith({
        learnings: [
          {
            id: '../x',
            category: 'nope',
            content: 'A'.repeat(50000),
            confidence: 999,
            memoryType: 'bogus',
          },
        ],
      }),
    });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number>; skipped: Record<string, number> };
      expect(d.imported.learnings).toBe(0);
      expect(d.skipped.malformed).toBe(1);
    }
    // The row must be absent from the table, not merely uncounted.
    const row = getDb().prepare('SELECT COUNT(*) AS c FROM learnings').get() as { c: number };
    expect(row.c).toBe(0);
  });

  it('canonicalises a traversal-shaped id instead of storing it', async () => {
    // The guarantee is NOT "the record is rejected" — rejecting a legacy id
    // would silently drop rows from a restore. It is "no id that is not a UUID
    // ever reaches the database", which closes the traversal path while
    // keeping the import lossless.
    const { memoryImport } = await import('./export.js');
    const { getDb } = await import('../db/client.js');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const nasty = ['../x', 'o1', 'a/b', '..\\win', 'ghost-entity', '../../etc/passwd', 'a b'];
    for (const badId of nasty) {
      const imp = await memoryImport({
        data: envelopeWith({
          learnings: [{ id: badId, category: 'pattern', content: `content for ${badId}` }],
        }),
      });
      if (imp.success) {
        const d = imp.data as { imported: Record<string, number> };
        expect(d.imported.learnings, `id ${JSON.stringify(badId)} should still import`).toBe(1);
      }
    }
    const ids = (getDb().prepare('SELECT id FROM learnings').all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toHaveLength(nasty.length);
    for (const id of ids) expect(id, `stored id ${id}`).toMatch(uuid);
    // An empty id is still malformed — there is nothing to canonicalise.
    const empty = await memoryImport({
      data: envelopeWith({ learnings: [{ id: '', category: 'pattern', content: 'x' }] }),
    });
    if (empty.success) {
      const d = empty.data as { imported: Record<string, number>; skipped: Record<string, number> };
      expect(d.imported.learnings).toBe(0);
      expect(d.skipped.malformed).toBe(1);
    }
  });

  it('maps a legacy id deterministically, so re-import stays idempotent', async () => {
    const { memoryImport } = await import('./export.js');
    const { getDb } = await import('../db/client.js');
    const envelope = envelopeWith({
      learnings: [{ id: 'legacy-1', category: 'pattern', content: 'written by a hand-rolled importer' }],
    });
    const first = await memoryImport({ data: envelope });
    const second = await memoryImport({ data: envelope });
    // Asserted OUTSIDE the guard on purpose: with only `if (first.success &&
    // second.success)` a failing second import would skip both assertions while
    // the row count still read 1, so the test would pass covering nothing.
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success && second.success) {
      expect((first.data as { imported: Record<string, number> }).imported.learnings).toBe(1);
      // Second run must dedupe against the first, not double-insert under a
      // different derived id — that is what makes the mapping safe.
      expect((second.data as { imported: Record<string, number> }).imported.learnings).toBe(0);
    }
    const rows = getDb().prepare('SELECT COUNT(*) AS c FROM learnings').get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it('keeps foreign keys pointing at their record after canonicalisation', async () => {
    // A relation referencing legacy entity ids must still resolve: the mapping
    // is pure, so 'e-1' derives the same UUID whether it appears as an id or
    // as a foreign key. If that broke, the endpoints would look missing.
    const { memoryImport } = await import('./export.js');
    const { getDb } = await import('../db/client.js');
    const imp = await memoryImport({
      data: envelopeWith({
        entities: [
          { id: 'e-1', name: 'Alice', entityType: 'person' },
          { id: 'e-2', name: 'Acme', entityType: 'company' },
        ],
        observations: [{ id: 'o-1', entityId: 'e-1', content: 'works at Acme' }],
        relations: [{ id: 'r-1', fromEntityId: 'e-1', toEntityId: 'e-2', relationType: 'works_at' }],
      }),
    });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number>; skipped: Record<string, number> };
      expect(d.imported.entities).toBe(2);
      expect(d.imported.observations).toBe(1);
      expect(d.imported.relations).toBe(1);
      expect(d.skipped.observationsMissingEntity).toBe(0);
      expect(d.skipped.relationsMissingEndpoint).toBe(0);
    }
    const joined = getDb()
      .prepare(
        `SELECT e.name FROM entity_relations r
         JOIN entities e ON e.id = r.from_entity_id`
      )
      .get() as { name: string };
    expect(joined.name).toBe('Alice');
  });

  it('drops a duplicate id within one envelope instead of crossing the wires', async () => {
    // Valid UUID syntax is not uniqueness. Two records sharing an id would
    // collide in the id-keyed vecMap and one could receive the other's vector.
    const { memoryImport } = await import('./export.js');
    const { getDb } = await import('../db/client.js');
    const imp = await memoryImport({
      data: envelopeWith({
        learnings: [
          { id: ID.observation, category: 'pattern', content: 'the first claimant' },
          { id: ID.observation, category: 'insight', content: 'the impostor' },
        ],
      }),
    });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number>; skipped: Record<string, number> };
      expect(d.imported.learnings).toBe(1);
      expect(d.skipped.malformed).toBe(1);
    }
    const row = getDb().prepare('SELECT content FROM learnings').get() as { content: string };
    expect(row.content).toBe('the first claimant'); // first wins
  });

  it('bounds the meta writes that had no length check at all', async () => {
    const { memoryImport } = await import('./export.js');
    const { getDb } = await import('../db/client.js');
    await memoryImport({
      data: envelopeWith({
        profile: {
          name: 'Alice',
          'display name': 'Alice M.', // legitimate: profileSchema takes any string as `field`
          huge: 'A'.repeat(20000), // over MAX_META_VALUE
          ['bad\u0000key']: 'x', // control character
          ['k'.repeat(200)]: 'x', // over MAX_META_KEY
        },
        goal: 'B'.repeat(20000), // over MAX_META_VALUE
      }),
    });
    const keys = (getDb().prepare('SELECT key FROM meta').all() as Array<{ key: string }>).map((r) => r.key);
    expect(keys).toContain('profile_name');
    // A space is not a reason to drop a user's own profile field — only length
    // and control characters are. Rejecting it would repeat the silent-data-loss
    // mistake the id rule was corrected for.
    expect(keys).toContain('profile_display name');
    expect(keys).not.toContain('profile_huge');
    expect(keys.some((k) => k.includes(' '))).toBe(false);
    expect(keys.some((k) => k.length > 120)).toBe(false);
    expect(keys).not.toContain('current_goal');
  });

  it('bounds an individual task, not just the number of them', async () => {
    const { memoryImport } = await import('./export.js');
    const { getDb } = await import('../db/client.js');
    const imp = await memoryImport({
      data: envelopeWith({
        sessions: [{ id: ID.observation, project: 'x', tasks: ['ok', 'A'.repeat(5000)] }],
      }),
    });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number>; skipped: Record<string, number> };
      expect(d.imported.sessions).toBe(0);
      expect(d.skipped.malformed).toBe(1);
    }
    const c = (getDb().prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
    expect(c).toBe(0);
  });

  it('keeps a session id and an entity id independent of each other', async () => {
    // Sessions and relations carry no embedding, so their ids only need to be
    // unique within their own table. A legacy envelope numbering its sessions
    // and its entities from the same sequence must not lose one of them.
    const { memoryImport } = await import('./export.js');
    const { getDb } = await import('../db/client.js');
    const imp = await memoryImport({
      data: envelopeWith({
        sessions: [{ id: 'shared-1', project: 'x' }],
        entities: [{ id: 'shared-1', name: 'Alice', entityType: 'person' }],
      }),
    });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number>; skipped: Record<string, number> };
      expect(d.imported.sessions).toBe(1);
      expect(d.imported.entities).toBe(1);
      expect(d.skipped.malformed).toBe(0);
    }
    const db = getDb();
    expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number }).c).toBe(1);
  });

  it('does not collapse two ids that differ only by an unpaired surrogate', async () => {
    // UTF-8 maps every unpaired surrogate to U+FFFD, so hashing the raw id as
    // utf8 would make "\uD800" and "\uD801" — both valid in JSON — collide, and
    // the second record would be discarded as a duplicate of the first.
    const { memoryImport } = await import('./export.js');
    const { getDb } = await import('../db/client.js');
    const imp = await memoryImport({
      data: envelopeWith({
        learnings: [
          { id: '\uD800', category: 'pattern', content: 'first surrogate' },
          { id: '\uD801', category: 'pattern', content: 'second surrogate' },
        ],
      }),
    });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number>; skipped: Record<string, number> };
      expect(d.imported.learnings).toBe(2);
      expect(d.skipped.malformed).toBe(0);
    }
    const ids = (getDb().prepare('SELECT id FROM learnings').all() as Array<{ id: string }>).map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('rejects out-of-range and off-enum values a tool could never produce', async () => {
    const { memoryImport } = await import('./export.js');
    const valid = { id: ID.decision, category: 'pattern', content: 'ok' };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['category off enum', { ...valid, category: 'nope' }],
      ['confidence above 1', { ...valid, confidence: 999 }],
      ['confidence below 0', { ...valid, confidence: -0.5 }],
      ['content over the 10k cap', { ...valid, content: 'A'.repeat(10001) }],
      ['content empty', { ...valid, content: '' }],
      ['memoryType off enum', { ...valid, memoryType: 'bogus' }],
      ['lifecycleState off enum', { ...valid, lifecycleState: 'zombie' }],
      ['usageCount negative', { ...valid, usageCount: -1 }],
    ];
    for (const [label, learning] of cases) {
      const imp = await memoryImport({ data: envelopeWith({ learnings: [learning] }) });
      if (imp.success) {
        const d = imp.data as { imported: Record<string, number>; skipped: Record<string, number> };
        expect(d.imported.learnings, label).toBe(0);
        expect(d.skipped.malformed, label).toBe(1);
      }
    }
  });

  it('stays additive: one malformed record does not drop the valid ones', async () => {
    const { memoryImport } = await import('./export.js');
    const { getDb } = await import('../db/client.js');
    const imp = await memoryImport({
      data: envelopeWith({
        learnings: [
          { id: ID.observation, category: 'pattern', content: 'first good one' },
          { id: '../evil', category: 'nope', content: 'bad' },
          { id: ID.entity, category: 'insight', content: 'second good one' },
        ],
      }),
    });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number>; skipped: Record<string, number> };
      expect(d.imported.learnings).toBe(2);
      expect(d.skipped.malformed).toBe(1);
    }
    const ids = (getDb().prepare('SELECT id FROM learnings ORDER BY id').all() as Array<{ id: string }>)
      .map((r) => r.id);
    expect(ids).toEqual([ID.observation, ID.entity].sort());
  });

  it('does not embed a record it is going to skip', async () => {
    const { memoryImport } = await import('./export.js');
    const { getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;
    await memoryImport({
      data: envelopeWith({
        learnings: [{ id: '../x', category: 'nope', content: 'A'.repeat(50000), confidence: 999 }],
      }),
    });
    // The old guards embedded first and skipped afterwards, so a 50k field was
    // paid for in inference before being thrown away.
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('accepts a valid record and keeps unknown fields from breaking the import', async () => {
    const { memoryImport } = await import('./export.js');
    const { getDb } = await import('../db/client.js');
    const imp = await memoryImport({
      data: envelopeWith({
        learnings: [
          {
            id: ID.observation,
            category: 'security',
            content: 'validated on the way in',
            confidence: 0.9,
            memoryType: 'semantic',
            lifecycleState: 'active',
            tags: ['import', 'zod'],
            verified: true,
            // A newer exporter adding a column must not make its envelopes
            // unimportable by an older server: unknown keys are stripped,
            // not rejected.
            somethingFromTheFuture: { nested: true },
          },
        ],
      }),
    });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number>; skipped: Record<string, number> };
      expect(d.imported.learnings).toBe(1);
      expect(d.skipped.malformed).toBe(0);
    }
    const row = getDb()
      .prepare('SELECT id, category, confidence, verified, memory_type FROM learnings')
      .get() as { id: string; category: string; confidence: number; verified: number; memory_type: string };
    expect(row.id).toBe(ID.observation);
    expect(row.category).toBe('security');
    expect(row.confidence).toBe(0.9);
    expect(row.verified).toBe(1); // boolean true normalised to the SQLite flag
    expect(row.memory_type).toBe('semantic');
  });

  it('applies the same id rule to entities, observations, relations and sessions', async () => {
    // Every table, not just learnings: whatever id shape goes in, only UUIDs
    // come out. The observation and relation here point at entities that do
    // not exist, so they are skipped for REFERENTIAL reasons — which is what
    // those counters are for, and proves the id rule did not swallow them.
    const { memoryImport } = await import('./export.js');
    const { getDb } = await import('../db/client.js');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const imp = await memoryImport({
      data: envelopeWith({
        sessions: [{ id: 's1', project: 'x' }],
        entities: [{ id: '../e', name: 'Evil', entityType: 'person' }],
        observations: [{ id: 'o1', entityId: ID.ghostEntity, content: 'orphan' }],
        relations: [
          { id: 'r1', fromEntityId: ID.entity, toEntityId: ID.missingEntity, relationType: 'knows' },
        ],
      }),
    });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { imported: Record<string, number>; skipped: Record<string, number> };
      expect(d.imported.sessions).toBe(1);
      expect(d.imported.entities).toBe(1);
      expect(d.imported.observations).toBe(0);
      expect(d.imported.relations).toBe(0);
      expect(d.skipped.observationsMissingEntity).toBe(1);
      expect(d.skipped.relationsMissingEndpoint).toBe(1);
      expect(d.skipped.malformed).toBe(0);
    }
    const db = getDb();
    const sid = (db.prepare('SELECT id FROM sessions').get() as { id: string }).id;
    const eid = (db.prepare('SELECT id FROM entities').get() as { id: string }).id;
    expect(sid).toMatch(uuid);
    expect(eid).toMatch(uuid);
    expect(eid).not.toContain('..');
  });

  it('still round-trips a real export after the tightening', async () => {
    const { memoryExport, memoryImport } = await import('./export.js');
    const { closeDb, getDb } = await import('../db/client.js');
    await seed();
    const exp = memoryExport({});
    if (!exp.success) throw new Error('export failed');

    closeDb();
    process.env.MEMORY_DB_PATH = join(tmp, 'tightened.sqlite');
    const imp = await memoryImport({ data: exp.data as Record<string, unknown> });
    expect(imp.success).toBe(true);
    if (imp.success) {
      const d = imp.data as { skipped: Record<string, number> };
      // The guarantee that matters: our OWN exporter produces envelopes that
      // survive the stricter import untouched.
      expect(d.skipped.malformed).toBe(0);
    }
    const db = getDb();
    expect((db.prepare('SELECT COUNT(*) AS c FROM learnings').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number }).c).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS c FROM entity_relations').get() as { c: number }).c).toBe(1);
  });

  it('re-derives embeddings on import when vec is enabled', async () => {
    const { memoryExport, memoryImport } = await import('./export.js');
    const { closeDb, getDb } = await import('../db/client.js');
    const { isVectorEnabled } = await import('../db/vector.js');
    if (!isVectorEnabled()) return;

    await seed();
    const exp = memoryExport({});
    if (!exp.success) throw new Error('export failed');

    closeDb();
    process.env.MEMORY_DB_PATH = join(tmp, 'c.sqlite');
    await memoryImport({ data: exp.data as Record<string, unknown> });

    // 1 learning + 1 decision + 1 observation = 3 embeddable rows.
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number }).c;
    expect(count).toBe(3);
  });
});
