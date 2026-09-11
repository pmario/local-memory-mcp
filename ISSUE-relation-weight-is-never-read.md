# `entity_relations.weight` is written but never read

**Severity: low.** Nothing behaves incorrectly. This is a field that costs
schema, API surface and caller attention while affecting no outcome.

Reported 2026-09-01, independently verified 2026-09-01 against `2d36006`.

## What

`weight` is accepted on `memory_entity_relate`, stored, returned and exported.
No code path ever reads it to make a decision.

**Table 1: every `weight` reference in `src/`**

| Step | Location |
|---|---|
| Declared | [entity.ts:386](src/tools/entity.ts#L386), `weight: z.number().min(0).max(1).optional()` |
| Written | [entity.ts:395-397](src/tools/entity.ts#L395-L397), `INSERT INTO entity_relations (..., weight)` with `input.weight ?? 1.0` |
| Selected | [entity.ts:357](src/tools/entity.ts#L357) and [:362](src/tools/entity.ts#L362) (the traversal union), [export.ts:147,156](src/tools/export.ts#L147) |
| Validated on import | [export.ts:348](src/tools/export.ts#L348), re-inserted at [:694,708](src/tools/export.ts#L694) |
| Asserted in a test | [entity.test.ts:754-770](src/tools/entity.test.ts#L754-L770) — asserts only that the column holds what was written |
| Used in a decision | nowhere |

Searched for `ORDER BY .*weight`, `weight [<>=]`, `weight *`, `sort.*weight`
across `src/`, excluding the unrelated `usageWeight` / `recencyWeight` /
`importanceWeight` ranking knobs. Zero hits. Confirmed by re-grepping every
occurrence of the bare word: the table above is the complete set.

So a relation stored with weight 0.1 and one stored with weight 0.9 are treated
identically by every query. The value is echoed back to the caller and written
to the export envelope, and that is all it does.

## Reproduce

```
memory_entity_create { name: "A", entityType: "project" }
memory_entity_create { name: "B", entityType: "tool" }
memory_entity_relate { fromEntityId: A, toEntityId: B, relationType: "uses", weight: 0.1 }
memory_entity_open   { name: "A" }
```

The relation comes back carrying `weight: 0.1`. Change it to `0.9` and re-run:
no ordering, filtering or scoring anywhere in the codebase differs. There is no
query whose result depends on the value.

## Why it is worth deciding rather than leaving

An optional numeric a caller must think about, that changes nothing, is a
standing invitation to build on it. Anyone adding graph traversal will assume
existing weights are meaningful, and they are not: every row written without an
explicit value holds the `1.0` default, so the column is mostly a constant.

## Options

1. **Remove it.** Cheapest in code, most expensive in compatibility: `weight`
   is part of the published MCP tool surface and of the v1 export envelope, so
   removing it breaks existing envelopes and callers.
2. **Use it.** The relation traversal at
   [entity.ts:355-367](src/tools/entity.ts#L355-L367) has **no `ORDER BY` at
   all**, so its output order is whatever SQLite returns. Adding
   `ORDER BY r.weight DESC, r.relation_type` gives the field an outcome and
   makes the result deterministic in the same line. A `minWeight` filter on
   `memory_entity_open` is the larger version of the same idea.
3. **Keep it deliberately** as forward schema for a planned feature, and say so
   in a comment, so the next reader does not have to re-derive this.

**Recommended: option 2**, restricted to the `ORDER BY`. It is one clause, it
breaks nothing, it fixes an undeclared-ordering wart that exists independently,
and it converts the column from decoration into behaviour. The current state,
where the answer is not recorded anywhere, is the only bad one.
