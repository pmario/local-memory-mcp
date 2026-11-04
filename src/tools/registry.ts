/**
 * Tool registry — the single source of truth for:
 *   1. The list of tools exposed via MCP (inputSchema in JSON Schema format).
 *   2. The dispatch table that maps tool name → handler.
 *
 * Each tool has a Zod schema for validation + a handler. We convert Zod to
 * JSON Schema inline via a tiny custom converter (no runtime dep on
 * zod-to-json-schema — we only need the basics for our own schemas).
 */
import { z } from 'zod';
import type { ToolResult } from '../lib/types.js';
import { STYLE_REQUIRED } from '../lib/style.js';

import { sessionStart, sessionStartSchema, sessionEnd, sessionEndSchema } from './session.js';
import {
  learn, learnSchema,
  recall, recallSchema,
  learnArchive, learnArchiveSchema,
  learnUpdate, learnUpdateSchema,
  learnBulk, learnBulkSchema,
} from './learn.js';
import { search, searchSchema } from './search.js';
import { memoryGet, getSchema } from './get.js';
import { decide, decideSchema, decisionArchive, decisionArchiveSchema } from './decide.js';
import {
  entityCreateEmbedded, entityCreateSchema,
  entityObserve, entityObserveSchema,
  entitySearch, entitySearchSchema,
  entityOpen, entityOpenSchema,
  entityRelate, entityRelateSchema,
  entityDelete, entityDeleteSchema,
  observationSupersede, observationSupersedeSchema,
} from './entity.js';
import { contradictions, contradictionsSchema } from './contradictions.js';
import {
  memoryExport, memoryExportSchema,
  memoryImport, memoryImportSchema,
} from './export.js';
import { reflect, reflectSchema } from './reflect.js';
import {
  insights, insightsSchema,
  profile, profileSchema,
  guide, guideSchema, GUIDE_TOPIC_NAMES,
  goal, goalSchema,
  health,
} from './insights.js';

// Empty-object schema for tools without inputs (memory_health).
const noInputSchema = z.object({}).strict();

// What the write tools say about style, following the MEMORY_REQUIRE_STYLE start switch.
const STYLE_RULE = STYLE_REQUIRED
  ? 'style ["atomic", "factual"] is REQUIRED, MUST NOT be passed before checking the text against memory_guide({topic: "writing"}), and is not stored'
  : 'style ["atomic", "factual"] is OPTIONAL, MUST NOT be passed before checking the text against memory_guide({topic: "writing"}), and is not stored';

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: (input: unknown) => ToolResult | Promise<ToolResult>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'memory_session_start',
    description: "Call FIRST in every conversation. Lists headlines and ids of the latest session and learnings, the project's only when project is given; memory_get opens them, detail: full returns whole texts.",
    schema: sessionStartSchema,
    handler: (input) => sessionStart(input as z.infer<typeof sessionStartSchema>),
  },
  {
    name: 'memory_session_end',
    description: 'End the session with an optional summary; call at the end of each conversation.',
    schema: sessionEndSchema,
    handler: (input) => sessionEnd(input as z.infer<typeof sessionEndSchema>),
  },
  {
    name: 'memory_learn',
    description: `Store a learning; an exact duplicate only bumps its usage count. ${STYLE_RULE}. Refused: a factual text with a scratch path or an appended correction section (AMENDED, UPDATE, …), and a split part (splitFrom: the hub's full id) whose text does not link the hub as [[id8]].`,
    schema: learnSchema,
    handler: (input) => learn(input as z.infer<typeof learnSchema>),
  },
  {
    name: 'memory_recall',
    description: 'Keyword recall (FTS5) over learnings only; memory_search does hybrid. Omit query for the most recent. Optional project/tags scoping and excludeProjects/excludeTags; detail: brief returns headlines.',
    schema: recallSchema,
    handler: (input) => recall(input as z.infer<typeof recallSchema>),
  },
  {
    name: 'memory_learn_archive',
    description: 'Soft-delete a learning, with an optional reason: memory_get still opens it, recall and search skip it.',
    schema: learnArchiveSchema,
    handler: (input) => learnArchive(input as z.infer<typeof learnArchiveSchema>),
  },
  {
    name: 'memory_learn_update',
    description: `Edit a live learning; project null unscopes it, splitFrom null takes it out of a split, a content change re-embeds it. For a content rewrite ${STYLE_RULE}; it is refused like a memory_learn text, and a hub's text MUST link every active part.`,
    schema: learnUpdateSchema,
    handler: (input) => learnUpdate(input as z.infer<typeof learnUpdateSchema>),
  },
  {
    name: 'memory_learn_bulk',
    description: `Insert up to 500 learnings in one atomic call, skipping exact duplicates; for migrations and seeding, restores use memory_import. Each item follows memory_learn: ${STYLE_RULE}; one refused item refuses the batch.`,
    schema: learnBulkSchema,
    handler: (input) => learnBulk(input as z.infer<typeof learnBulkSchema>),
  },
  {
    name: 'memory_search',
    description: 'Hybrid search over learnings, decisions, entities and observations (FTS5 and vector, fused with RRF); mode: fts, vector or hybrid (default). Optional project/tags scoping and excludeProjects/excludeTags; detail: brief returns headlines, which memory_get opens.',
    schema: searchSchema,
    handler: (input) => search(input as z.infer<typeof searchSchema>),
  },
  {
    name: 'memory_get',
    description: 'Full text of learnings, decisions and sessions by id or unique 8+ character id prefix (1-20); a session id opens the summary a brief start cuts. Archived entries included; unknown ids land in missing, shared prefixes in ambiguous. asOf returns a learning as stored then, history: true its earlier versions. A field at its default is left out.',
    schema: getSchema,
    handler: (input) => memoryGet(input as z.infer<typeof getSchema>),
  },
  {
    name: 'memory_decide',
    description: 'Record a decision with reasoning and alternatives.',
    schema: decideSchema,
    handler: (input) => decide(input as z.infer<typeof decideSchema>),
  },
  {
    name: 'memory_decision_archive',
    description: 'Retire a decision that was replaced or proved wrong: reason required, supersededBy the full ids of its successors. memory_get still opens it, marked archived; search and reflect skip it.',
    schema: decisionArchiveSchema,
    handler: (input) => decisionArchive(input as z.infer<typeof decisionArchiveSchema>),
  },
  {
    name: 'memory_entity_create',
    description: 'Create an entity without an observation; idempotent on name and entityType, and embedded for search.',
    schema: entityCreateSchema,
    handler: (input) => entityCreateEmbedded(input as z.infer<typeof entityCreateSchema>),
  },
  {
    name: 'memory_entity_observe',
    description: 'Record a fact about an entity. Creates the entity if missing.',
    schema: entityObserveSchema,
    handler: (input) => entityObserve(input as z.infer<typeof entityObserveSchema>),
  },
  {
    name: 'memory_entity_search',
    description: 'Search entities by name or observation content (FTS5 fuzzy).',
    schema: entitySearchSchema,
    handler: (input) => entitySearch(input as z.infer<typeof entitySearchSchema>),
  },
  {
    name: 'memory_entity_open',
    description: 'Load an entity with its current observations and relations; asOf (ISO date) gives a point-in-time view.',
    schema: entityOpenSchema,
    handler: (input) => entityOpen(input as z.infer<typeof entityOpenSchema>),
  },
  {
    name: 'memory_entity_relate',
    description: 'Create a typed relation (edge) between two entities.',
    schema: entityRelateSchema,
    handler: (input) => entityRelate(input as z.infer<typeof entityRelateSchema>),
  },
  {
    name: 'memory_entity_delete',
    description: 'Delete an entity with all its observations and relations; destructive.',
    schema: entityDeleteSchema,
    handler: (input) => entityDelete(input as z.infer<typeof entityDeleteSchema>),
  },
  {
    name: 'memory_contradictions',
    description: 'Find observation pairs with high cosine similarity but opposite negation or confidence; LLM-free, needs sqlite-vec, scans at most maxObservationsPerEntity (default 200) per entity.',
    schema: contradictionsSchema,
    handler: (input) => contradictions(input as z.infer<typeof contradictionsSchema>),
  },
  {
    name: 'memory_observation_supersede',
    description: "Retire an observation by setting valid_to: asOf queries still see it, live views drop it. supersededById takes the newer fact's valid_from as the cutoff.",
    schema: observationSupersedeSchema,
    handler: (input) => observationSupersede(input as z.infer<typeof observationSupersedeSchema>),
  },
  {
    name: 'memory_reflect',
    description: 'LLM-free reflection on recent memory: most-used and stale learnings, hot entities, open decisions, as data and markdown.',
    schema: reflectSchema,
    handler: (input) => reflect(input as z.infer<typeof reflectSchema>),
  },
  {
    name: 'memory_insights',
    description: 'Stats and reflection: days of memory, totals, category breakdown, entity type breakdown.',
    schema: insightsSchema,
    handler: (input) => insights(input as z.infer<typeof insightsSchema>),
  },
  {
    name: 'memory_profile',
    description: 'Read or write a user profile field (name, role, preferences, …).',
    schema: profileSchema,
    handler: (input) => profile(input as z.infer<typeof profileSchema>),
  },
  {
    name: 'memory_guide',
    description: `On-demand help. Topics: ${GUIDE_TOPIC_NAMES.join(', ')}.`,
    schema: guideSchema,
    handler: (input) => guide(input as z.infer<typeof guideSchema>),
  },
  {
    name: 'memory_goal',
    description: 'Read, set, or clear a single user goal stored in the profile table.',
    schema: goalSchema,
    handler: (input) => goal(input as z.infer<typeof goalSchema>),
  },
  {
    name: 'memory_export',
    description: 'Export the whole memory (learnings, decisions, knowledge graph, sessions, profile) as a versioned JSON envelope; import re-derives embeddings.',
    schema: memoryExportSchema,
    handler: (input) => memoryExport(input as z.infer<typeof memoryExportSchema>),
  },
  {
    name: 'memory_import',
    description: 'Import a memory_export envelope as {data: <envelope>}: additive, idempotent on source ids, re-embeds.',
    schema: memoryImportSchema,
    handler: (input) => memoryImport(input as z.infer<typeof memoryImportSchema>),
  },
  {
    name: 'memory_health',
    description: 'Integrity, size and vector status, plus the re-check queue: learnings that a scratch path or a risk score of 3 or more flags, not re-checked since their last change, most-read first, as [id8, score, reads, {check: [signal ids]}]; a re-check starts there. No input.',
    schema: noInputSchema,
    handler: () => health(),
  },
];

// ─── Zod → JSON Schema (minimal) ────────────────────
// Claude Desktop needs JSON Schema, not raw Zod. We support the subset our
// tools actually use: object, string, number, boolean, array, enum, optional,
// and a refined string.

type JsonSchema = Record<string, unknown>;

// A field's .describe() text becomes its JSON Schema description, which is what a model reads.
function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const result = convertZod(schema);
  const description = (schema as unknown as { _def: { description?: string } })._def.description;
  return description && result.description === undefined ? { ...result, description } : result;
}

function convertZod(schema: z.ZodTypeAny): JsonSchema {
  const def = (schema as unknown as { _def: { typeName: string } })._def;

  if (def.typeName === 'ZodObject') {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(shape)) {
      const fieldDef = (val as unknown as { _def: { typeName: string } })._def;
      const isOptional = fieldDef.typeName === 'ZodOptional' || fieldDef.typeName === 'ZodDefault';
      properties[key] = zodToJsonSchema(val as z.ZodTypeAny);
      if (!isOptional) required.push(key);
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault') {
    return zodToJsonSchema((schema as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType);
  }

  if (def.typeName === 'ZodNullable') {
    const inner = zodToJsonSchema((schema as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType);
    return { ...inner, type: [inner.type, 'null'] };
  }

  // A .refine()/.transform() wrapper, e.g. the date strings of entity_open and
  // observation_supersede, which the fallback below would advertise as objects.
  if (def.typeName === 'ZodEffects') {
    return zodToJsonSchema((schema as unknown as { _def: { schema: z.ZodTypeAny } })._def.schema);
  }

  if (def.typeName === 'ZodString') {
    const checks = (def as unknown as { checks?: Array<{ kind: string; value?: number }> }).checks ?? [];
    const result: JsonSchema = { type: 'string' };
    for (const c of checks) {
      if (c.kind === 'min' && c.value !== undefined) result.minLength = c.value;
      if (c.kind === 'max' && c.value !== undefined) result.maxLength = c.value;
    }
    return result;
  }

  if (def.typeName === 'ZodNumber') {
    const checks = (def as unknown as { checks?: Array<{ kind: string; value?: number }> }).checks ?? [];
    const result: JsonSchema = { type: 'number' };
    for (const c of checks) {
      if (c.kind === 'min' && c.value !== undefined) result.minimum = c.value;
      if (c.kind === 'max' && c.value !== undefined) result.maximum = c.value;
      if (c.kind === 'int') result.type = 'integer';
    }
    return result;
  }

  if (def.typeName === 'ZodBoolean') return { type: 'boolean' };

  if (def.typeName === 'ZodArray') {
    const arrayDef = def as unknown as {
      type: z.ZodTypeAny;
      minLength: { value: number } | null;
      maxLength: { value: number } | null;
      exactLength: { value: number } | null;
    };
    const min = arrayDef.exactLength ?? arrayDef.minLength;
    const max = arrayDef.exactLength ?? arrayDef.maxLength;
    return {
      type: 'array',
      items: zodToJsonSchema(arrayDef.type),
      ...(min ? { minItems: min.value } : {}),
      ...(max ? { maxItems: max.value } : {}),
    };
  }

  if (def.typeName === 'ZodEnum') {
    const values = (def as unknown as { values: string[] }).values;
    return { type: 'string', enum: values };
  }

  // Fallback — let Claude Desktop show the tool even if the schema is loose
  return { type: 'object' };
}

// ─── MCP tool annotations (2026 spec hints) ─────────
// Clients read these to decide whether to auto-run a tool or ask the user
// first. openWorldHint is false for EVERY tool — this server only ever touches
// the local SQLite file, never an external/unbounded system. We annotate
// behaviour honestly: idempotentHint means "repeating the call has no further
// effect" (not "safe"); destructiveHint flags retire/delete/overwrite ops so a
// client can gate them behind a confirmation.
interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

const ANNOTATIONS: Record<string, ToolAnnotations> = {
  memory_session_start: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  memory_session_end: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  memory_learn: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  memory_recall: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  memory_learn_archive: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  memory_learn_update: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  memory_learn_bulk: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  memory_search: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  memory_get: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  memory_decide: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  memory_decision_archive: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // NOT idempotent: a repeat call with a different summary UPDATEs the entity
  // (entity.ts entityCreate), so the second call can change state. (R2 FINDING-A.)
  memory_entity_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  memory_entity_observe: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  memory_entity_search: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  memory_entity_open: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  memory_entity_relate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  memory_entity_delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  memory_observation_supersede: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  memory_contradictions: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  memory_reflect: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  memory_insights: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  memory_profile: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  memory_guide: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  memory_goal: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  memory_export: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  memory_import: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  memory_health: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
};

export function toMcpToolList(): Array<{ name: string; description: string; inputSchema: JsonSchema; annotations?: ToolAnnotations }> {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema),
    ...(ANNOTATIONS[t.name] ? { annotations: ANNOTATIONS[t.name] } : {}),
  }));
}

export function getHandler(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
