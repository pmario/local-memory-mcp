/**
 * Insights, health, profile, guide — the "reflective" tools.
 *
 * insights: stats + what Claude has learned about the user
 * health:   DB size, counts, integrity, vector status (v2.0.0+)
 * profile:  read/write user profile (stored in meta)
 * goal:     current goal (stored in meta)
 * guide:    embedded how-to text, per topic
 */
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { vectorStatus } from '../db/vector.js';
import { embedMode, embedModelId, EMBEDDING_DIM } from '../lib/embed.js';
import { STYLES } from '../lib/style.js';
import type { ToolResult } from '../lib/types.js';

// ─── insights ────────────────────────────────────────

export const insightsSchema = z.object({
  project: z.string().optional(),
});

export function insights(input: z.infer<typeof insightsSchema>): ToolResult {
  const db = getDb();
  const projectFilter = input.project ? 'WHERE project = ?' : '';
  const projectArgs = input.project ? [input.project] : [];

  const totalSessions = (db.prepare(`SELECT COUNT(*) as c FROM sessions ${projectFilter}`).get(...projectArgs) as { c: number }).c;
  const totalLearnings = (db.prepare(`SELECT COUNT(*) as c FROM learnings WHERE archived = 0 ${projectFilter ? 'AND project = ?' : ''}`).get(...projectArgs) as { c: number }).c;
  const totalDecisions = (db.prepare(`SELECT COUNT(*) as c FROM decisions ${projectFilter}`).get(...projectArgs) as { c: number }).c;
  const totalEntities = (db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c;

  const categoryBreakdown = db
    .prepare(
      `SELECT category, COUNT(*) as count
       FROM learnings
       WHERE archived = 0 ${projectFilter ? 'AND project = ?' : ''}
       GROUP BY category
       ORDER BY count DESC`
    )
    .all(...projectArgs);

  const entityTypeBreakdown = db
    .prepare('SELECT entity_type, COUNT(*) as count FROM entities GROUP BY entity_type ORDER BY count DESC')
    .all();

  // How many days of memory? First session → now.
  const firstSession = db.prepare('SELECT MIN(started_at) as first FROM sessions').get() as { first: string | null };
  const daysOfMemory = firstSession.first
    ? Math.max(1, Math.floor((Date.now() - new Date(firstSession.first).getTime()) / 86400000))
    : 0;

  return {
    success: true,
    data: {
      daysOfMemory,
      totalSessions,
      totalLearnings,
      totalDecisions,
      totalEntities,
      categoryBreakdown,
      entityTypeBreakdown,
    },
    message: `Claude has known you for ${daysOfMemory} days and remembers ${totalLearnings} things.`,
  };
}

// ─── health ──────────────────────────────────────────

export function health(): ToolResult {
  const db = getDb();

  const integrity = db.pragma('integrity_check', { simple: true });
  const pageCount = (db.pragma('page_count', { simple: true }) as number) ?? 0;
  const pageSize = (db.pragma('page_size', { simple: true }) as number) ?? 0;
  const sizeBytes = pageCount * pageSize;

  // v2.0.0+: surface vector + embedding status so users can see whether
  // hybrid mode is live or we're running FTS5-only. The tables exist whenever vectors are enabled.
  const vec = vectorStatus();
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  const embeddingsCount = vec.enabled ? count('embedding_sources') : 0;
  const chunksCount = vec.enabled ? count('embedding_chunks') : 0;

  // How far the rewrite to the atomic + factual rule has got, and the next candidates.
  const styleCount = (value: string) =>
    (db.prepare('SELECT COUNT(*) AS c FROM learnings l WHERE archived = 0 AND EXISTS (SELECT 1 FROM json_each(l.style_json) WHERE value = ?)').get(value) as { c: number }).c;
  const styles = {
    ...Object.fromEntries(STYLES.map((s) => [s, styleCount(s)])),
    none: (db.prepare("SELECT COUNT(*) AS c FROM learnings WHERE archived = 0 AND json_array_length(style_json) = 0").get() as { c: number }).c,
    longestWithoutFactual: (
      db
        .prepare(
          `SELECT substr(id, 1, 8) AS id8, length(content) AS chars FROM learnings l
           WHERE archived = 0 AND NOT EXISTS (SELECT 1 FROM json_each(l.style_json) WHERE value = 'factual')
           ORDER BY chars DESC LIMIT 5`
        )
        .all() as Array<{ id8: string; chars: number }>
    ).map((r) => [r.id8, r.chars]),
  };

  return {
    success: true,
    data: {
      integrity,
      sizeBytes,
      sizeMB: Math.round((sizeBytes / 1024 / 1024) * 100) / 100,
      schemaVersion: (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value ?? 'unknown',
      firstRunAt: (db.prepare("SELECT value FROM meta WHERE key = 'first_run_at'").get() as { value: string } | undefined)?.value ?? null,
      vector: {
        enabled: vec.enabled,
        error: vec.error,
        embeddingsCount,
        chunksCount,
        dim: EMBEDDING_DIM,
      },
      embedding: {
        mode: embedMode(),
        model: embedModelId(),
      },
      styles,
    },
    message: integrity === 'ok'
      ? `All healthy. Hybrid: ${vec.enabled && embedMode() !== 'disabled' ? 'on' : 'off (FTS5-only)'}.`
      : `Integrity issue: ${integrity}`,
  };
}

// ─── profile ─────────────────────────────────────────

export const profileSchema = z.object({
  action: z.enum(['get', 'set']),
  field: z.string().optional(),
  value: z.string().optional(),
});

export function profile(input: z.infer<typeof profileSchema>): ToolResult {
  const db = getDb();

  if (input.action === 'get') {
    if (input.field) {
      const row = db
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get(`profile_${input.field}`) as { value: string } | undefined;
      return { success: true, data: { field: input.field, value: row?.value ?? null } };
    }
    // Return all profile fields
    const rows = db
      .prepare("SELECT key, value FROM meta WHERE key LIKE 'profile_%'")
      .all() as Array<{ key: string; value: string }>;
    const profile: Record<string, string> = {};
    for (const r of rows) profile[r.key.replace(/^profile_/, '')] = r.value;
    return { success: true, data: profile };
  }

  // set
  if (!input.field || input.value === undefined) {
    return { success: false, error: 'field and value required for set.', code: 'MISSING_ARGS' };
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    `profile_${input.field}`,
    input.value
  );
  return { success: true, data: { field: input.field, value: input.value }, message: 'Profile updated.' };
}

// ─── goal ────────────────────────────────────────────

export const goalSchema = z.object({
  action: z.enum(['get', 'set', 'clear']),
  goal: z.string().optional(),
});

export function goal(input: z.infer<typeof goalSchema>): ToolResult {
  const db = getDb();

  if (input.action === 'get') {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'current_goal'").get() as { value: string } | undefined;
    return { success: true, data: { goal: row?.value ?? null } };
  }
  if (input.action === 'set') {
    if (!input.goal) return { success: false, error: 'goal required for set.', code: 'MISSING_ARGS' };
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('current_goal', input.goal);
    return { success: true, data: { goal: input.goal }, message: 'Goal set.' };
  }
  db.prepare("DELETE FROM meta WHERE key = 'current_goal'").run();
  return { success: true, data: { goal: null }, message: 'Goal cleared.' };
}

// ─── guide ───────────────────────────────────────────

const GUIDE_TOPICS: Record<string, string> = {
  quickstart: `# Local Memory — Quickstart

This MCP server gives your AI assistant persistent memory across conversations. All data stays on your machine in a single SQLite file.

## Basic flow

1. Call \`memory_session_start\` at the beginning of each conversation: it lists headlines and ids of recent context.
2. Call \`memory_get\` with the ids whose full text you need.
3. As the conversation progresses, call \`memory_learn\` to store knowledge and \`memory_entity_observe\` to add facts about people/projects/tools.
4. Call \`memory_search\` or \`memory_recall\` to find past knowledge.
5. Call \`memory_session_end\` at the end to store a summary for next time.

## Philosophy

- **Local-first** — everything lives in a SQLite file on your machine. No cloud, no API keys.
- **Works everywhere** — Claude Desktop, Claude Code, Cursor, Codex, Continue.
- **Knowledge Graph** — not just flat text. Entities, observations, relations.
- **Duplicate guard** — the gatekeeper prevents storing the same thing twice.`,

  session: `# Sessions

A session is one conversation window. It captures context, goals, and outcomes.

- \`session_start\` — begin a session. The default \`detail: "brief"\` returns the first paragraph of the latest summary (same project preferred) and headlines of the 5 newest learnings, only the project's when \`project\` is given. \`detail: "full"\` returns the last 3 summaries and 5 whole learnings.
- \`memory_get\` — the full text behind the ids a brief result lists; a session id opens its whole summary and open tasks.
- \`session_end\` — close the current session with a summary.

Tip: let \`session_end\` auto-detect the active session — no sessionId argument needed.`,

  search: `# Search

Use \`search\` for broad queries across everything (learnings, decisions, entities, observations).
Use \`recall\` for quick keyword search on learnings only, or without arguments to get the most recent.

\`memory_search\` modes: \`hybrid\` (default) fuses FTS5 (BM25) and vector cosine with Reciprocal Rank Fusion; \`fts\` and \`vector\` run one ranker alone. Embeddings come from multilingual-e5-small (100+ languages); long entries are embedded in chunks of up to 500 tokens, so vector search covers the whole text. If the vector extension can't load, search falls back to FTS5 and says so in \`notice\`.

FTS5 uses bm25 ranking. Short queries work. Multi-word queries match any of the words; entries matching more of them rank higher.`,

  entities: `# Knowledge Graph

Entities are nodes: people, projects, companies, tools. Observations are facts about them. Relations are edges.

- \`entity_observe\` — record a fact about an entity (auto-creates if missing).
- \`entity_search\` — fuzzy search across entities and their observations.
- \`entity_open\` — load an entity with all its observations and relations.
- \`entity_relate\` — create a typed edge between two entities.`,

  learn: `# Learnings

Learnings are facts, patterns, insights that should persist across sessions.

- Categories: pattern, mistake, insight, research, architecture, infrastructure, tool, workflow, performance, security.
- Memory type: episodic ("it happened") or semantic ("it is true"). Auto-classified.
- Duplicate handling: exact duplicates are skipped and bump the usage counter; similar entries are stored as new rows. To enrich an existing entry, call \`memory_learn_update\` with its id.`,

  writing: `# Writing a learning: atomic and factual

Write every learning atomic and factual; the server stores each new learning and each content rewrite with style ["atomic", "factual"]. The rule serves two goals: fewer tokens when an entry is read, and a better hit when it is searched. Hybrid search embeds chunks of up to 500 tokens, split at paragraph boundaries, with a model trained on human language, and keyword search needs the exact tokens.

An atomic learning has one subject. Split an entry with several subjects into separate learnings and link them with [[id8]]. In one measured store, two long entries rewritten and split this way ranked first for 12 of 13 symptom queries in hybrid search; the long originals ranked first for 8, and a rewrite that still kept six subjects in one entry for 9.

A factual learning has the prose removed and all the information kept, with no length cap.
- Keep: symptoms as a user would describe them, error texts verbatim, versions and platform, file and line, log lines and numbers, what was absent, rulings in the maintainer's own words, sources (test file, issue, bead) and [[id8]] cross-references.
- Drop: the story of how it was found, emphasis and ALL CAPS, repetition, restatements of the same rule, and superseded claims; the handoff or commit keeps the history.

The text is plain sentences in sentence case. The first line states the current rule, because brief results show only that line. Every paragraph opens with a sentence naming its subject, because a chunk may start at any paragraph. Identifiers stay verbatim inside the sentences.

A correction rewrites the entry to the current state with \`memory_learn_update\`; a factual text with an appended \`AMENDED\` section is refused. Before storing a rewrite, check it line by line against the old text, so no fact is lost.

A learning is worth storing only when it was measured rather than assumed, outlives the session (a property of a tool, runtime or convention, not one branch's state), and is not recorded elsewhere (code, git history, CLAUDE.md or AGENTS.md). Strong candidates are a diagnostic signature, a constraint no test catches, a corrected belief, an API unlike its obvious sibling, and a maintainer ruling with its reason. "We implemented X" or "improved" without a number does not qualify.

Before writing, run \`memory_search\` on the subject. When an entry already covers it, rewrite that entry instead of adding a second one, because two entries on one subject compete for the same queries and a reader may find only the older one. Skip a finding that is already recorded or true only of the session.

Metadata decides how an entry is found and filtered. Always pass \`memoryType\` (semantic for what is true, episodic for what happened): without it the classifier marks every \`mistake\` entry episodic, and any other entry whose text contains today, heute, yesterday, gestern, happened, passiert, incident, vorfall, just now or gerade, and \`memory_learn_update\` cannot change it afterwards. Pick the category from the fixed list. Set \`project\` as provenance, and leave it empty for rules about the machine or about how the assistant works; \`memory_learn_update\` can change project and category later. Add tags that are useful as filters, and name the handoff or file the finding came from in \`source\`. A measured fact carries the date it was measured, beside the version and platform.

Splitting follows an order that keeps every subject in the store: store the split-off parts first to get their ids, then rewrite the original to keep the subject a search most likely lands on, and link both directions with [[id8]]. Never rewrite the original before its parts exist.

A superseded entry is archived with \`memory_learn_archive\`, with a reason that names its successor, rather than left active with a "SUPERSEDED" first line. A handoff pointer names the handoff file, its chain and sequence, the status and the next step; keep one per chain and archive the previous pointer when writing the next, and store the session's lessons as their own entries.

Never store a secret: no passphrase, key, token or credential, not even a test one; name the file or script that holds or mints it instead.

The style label is the writer's promise. The server stamps ["atomic", "factual"] on every text it writes but checks only for appended AMENDED sections, so everything else in this guide is the writer's job.`,

  lifecycle: `# Lifecycle

- \`memory_entity_open({asOf: "2026-04-15"})\` — point-in-time view: the observations whose validity window contained that instant.
- \`memory_contradictions()\` — LLM-free scan for observation pairs with high cosine similarity but disagreeing negation or confidence. Needs sqlite-vec.
- \`memory_observation_supersede({observationId, supersededById?})\` — retire a stale fact by setting valid_to; it stays for asOf queries. With supersededById, the newer fact's valid_from is the cutoff.
- \`memory_learn_archive({learningId, reason?})\` — soft-delete a learning: it never resurfaces in search, \`memory_get\` still opens it.
- \`memory_learn_update({learningId, content?, confidence?, tags?, project?, category?, style?})\` — edit a live learning; project null unscopes it; re-embeds when the content changes, and a rewritten text is stored as atomic + factual.
- \`memory_reflect({lookbackDays?: 7})\` — most-used and stale learnings, hot entities, open decisions, as data plus a markdown summary. No LLM call.`,

  portability: `# Portability

- \`memory_learn_bulk({items: [...]})\` — insert up to 500 learnings in one atomic call (parallel embedding, exact duplicates skipped). For restores, migrations, seeding a fresh store.
- \`memory_export({includeSessions?, includeArchived?})\` — dump everything to a versioned JSON envelope. Embeddings are re-derived on import.
- \`memory_import({data})\` — load an export envelope. Additive and idempotent. The same envelope also imports into the hosted tier (memory.studiomeyer.io).`,

  privacy: `# Privacy

Your memory file lives at:
- macOS: ~/Library/Application Support/local-memory-mcp/memory.sqlite
- Linux: ~/.local/share/local-memory-mcp/memory.sqlite
- Windows: %APPDATA%\\local-memory-mcp\\memory.sqlite

Nothing is sent over the network. Ever. No telemetry, no phone-home, no account.
You can back up, copy, delete, or move the file at any time.
Override the path: set MEMORY_DB_PATH=/your/preferred/path.sqlite`,
};

// The memory_guide tool description lists these, so a new topic cannot be missing from it.
export const GUIDE_TOPIC_NAMES = Object.keys(GUIDE_TOPICS);

export const guideSchema = z.object({
  topic: z.string().optional(),
});

export function guide(input: z.infer<typeof guideSchema>): ToolResult {
  if (!input.topic) {
    return {
      success: true,
      data: {
        topics: Object.keys(GUIDE_TOPICS),
        hint: 'Call guide({topic: "quickstart"}) for specific help.',
      },
    };
  }
  const content = GUIDE_TOPICS[input.topic];
  if (!content) {
    return {
      success: false,
      error: `Unknown topic: ${input.topic}. Available: ${Object.keys(GUIDE_TOPICS).join(', ')}`,
      code: 'UNKNOWN_TOPIC',
    };
  }
  return { success: true, data: { topic: input.topic, content } };
}
