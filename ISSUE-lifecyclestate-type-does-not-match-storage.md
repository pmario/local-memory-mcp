# Archiving a learning with a reason makes it unimportable

**Severity: high. This is live data loss, not a latent trap.** An archived
learning whose reason was recorded is silently dropped by `memory_import`, so
it does not survive an export/import restore.

Reported 2026-09-01 as a type/storage mismatch; re-verified and re-classified
2026-09-01 against `2d36006`. The original report is preserved below under
"The underlying defect", because it is the correct root cause — only the
severity was wrong, and it was wrong because the consumer was missed.

## The live failure

`memory_learn_archive` stores the reason INSIDE the state column
([learn.ts:187](src/tools/learn.ts#L187)):

```ts
const lifecycle = input.reason ? `archived:${input.reason}` : 'archived';
```

`memory_import` validates that same column against a three-value enum
([export.ts:368](src/tools/export.ts#L368)):

```ts
lifecycleState: z.enum(['active', 'ephemeral', 'archived']).nullish(),
```

`parseRecord` rejects the **whole record** on any failed field
([export.ts:398-411](src/tools/export.ts#L398-L411)), so the learning is not
imported with a defaulted state — it is counted in `skipped.malformed` and
lost. `memory_export` defaults `includeArchived: true`, so the record IS in the
envelope; it is discarded on the way back in.

### Measured

Round-trip probe: two learnings, one archived with `reason: "superseded by X"`,
exported and imported into a fresh DB.

```
EXPORT counts.learnings = 2
EXPORT lifecycleState values = ["archived:superseded by X","active"]
IMPORT imported = {"learnings":1, ...}
IMPORT skipped  = {"malformed":1, ...}
[warn] [import] skipped malformed learning: lifecycleState: Invalid enum value.
       Expected 'active' | 'ephemeral' | 'archived', received 'archived:superseded by X'
```

The warning is logged, which is the only reason this is recoverable at all. The
tool's own `skipped.malformed` count is the user-visible signal, and it does not
say which record or why.

**Table 1: affected rows in the live store** (`%APPDATA%\local-memory-mcp\memory.sqlite`)

| `lifecycle_state` | rows |
|---|---|
| `active` | 357 |
| `archived:<300-char reason>` | 2 |

Two of 359 learnings would not survive a restore today.

### Why it is live now and was not before

[806aec8](https://github.com/studiomeyer-io/local-memory-mcp/commit/806aec8)
(`fix(import): validate every record with the interactive tools' zod shapes`,
the fix for #29) added the validation. Before it, the malformed value was
written straight through and the record survived. Closing the injection hole
turned a cosmetic type mismatch into data loss, because the enum describes the
intent of the column and not its contents.

## The underlying defect

`src/lib/types.ts:17` declares:

```ts
export type LifecycleState = 'active' | 'ephemeral' | 'archived';
```

The column is free-form `TEXT`, as the comment at
[learn.ts:183](src/tools/learn.ts#L183) states. The union is therefore not a
description of what the column holds; it is a description of what somebody
intended it to hold.

The column carries **two things in one field**: a state, and a reason for that
state. `archived` and `archived:superseded by X` are the same state with
different annotations, but nothing can tell them apart without string surgery,
and any code that groups on the column treats every distinct reason as a
distinct state. The live store shows this concretely: both archived rows carry
a 300-character prose reason as their "state".

The `TypeScript` type has no consumers outside its own declaration, so a
`switch` over it does not exist yet and cannot be falling through. The zod enum
at `export.ts:368` is the consumer that matters, and it is not typed from
`LifecycleState` — it repeats the three values as a literal, which is why the
drift went unnoticed.

## Fix

**Split the columns.** `lifecycle_state` holds one of the three declared
values; a new `lifecycle_reason TEXT` holds the free text. Then the type
describes reality, grouping works, the reason stays human-readable, and the
import enum stops rejecting valid rows.

Needs, at minimum:

1. A migration adding `lifecycle_reason`, splitting existing values on the
   first `:`.
2. `learnArchive` writing the two columns separately (its return value already
   exposes `lifecycleState`, so decide whether to keep echoing the joined form
   for compatibility).
3. Export/import carrying `lifecycleReason`, with the import schema tolerating
   an OLD envelope's joined `archived:<reason>` value rather than dropping the
   record — otherwise every envelope exported before the fix stays unimportable,
   which is the actual failure this issue is about.
4. `LifecycleState` derived from one place, so the zod enum and the TS union
   cannot drift again.

Point 3 is the part that fixes existing damage; points 1-2 only stop new damage.

Weaker alternatives, both of which leave the two-values-in-one-column problem in
place: widen the type to `` 'active' | 'ephemeral' | 'archived' | `archived:${string}` `` and
widen the import schema to match; or parse at the boundary, exposing a narrow
state plus a reason while leaving storage alone.

## Reproduce

```
memory_learn         { content: "...", category: "insight" }
memory_learn_archive { learningId: <id>, reason: "superseded by X" }
memory_export        {}
# import the envelope into a fresh DB
memory_import        { data: <envelope> }
```

`imported.learnings` is one short; `skipped.malformed` is one high.
