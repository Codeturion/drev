# T06: core/metadata.ts

**Phase:** B · **Depends on:** T01 · **Blocks:** T11, T13, T14, T15, T16, T18, T19, T20, T23
**Architecture refs:** §5.1 (schema)

## Scope

Type definitions, validation, and YAML I/O for `meta.yaml` files.

### Contract

```ts
interface SessionMeta {
  schema_version: 1;
  id: string;                    // UUID
  name?: string;
  purpose: 'share' | 'backup';
  user: string;                  // short username
  user_email: string;
  project?: string;
  project_root: string;
  branch?: string;
  commit_sha?: string;
  created_at: string;            // ISO 8601
  shared_at: string;             // ISO 8601
  title?: string;
  summary?: string;
  visibility: 'team' | 'private';
  files_touched?: string[];
  parent_session?: string | null; // v0.5+, but keep field optional
  turns: number;
  size_bytes: number;
  redactions: Array<{ type: string; count: number }>;
}

function parseMeta(yamlText: string): SessionMeta; // throws ValidationError
function serializeMeta(meta: SessionMeta): string;
async function readMeta(filePath: string): Promise<SessionMeta>;
async function writeMeta(filePath: string, meta: SessionMeta): Promise<void>;
```

### Validation rules

- `schema_version === 1` — anything else throws with "upgrade Drev" message (per §15.3)
- All required fields per §5.1 must be present and well-typed
- `id` must be UUID-ish (lenient regex: 32 hex chars + dashes)
- `created_at` and `shared_at` must parse as ISO dates
- Extra unknown fields are allowed (forward-compat) — validate but don't reject

## Files

- `src/core/metadata.ts`
- `src/core/metadata.test.ts`

## Acceptance

- Round-trip: `serializeMeta(parseMeta(yaml)) === yaml` for canonical samples (modulo key order)
- Schema version mismatch throws `ValidationError` with code `SCHEMA_VERSION_MISMATCH`
- Missing required fields throw with field name in message
- Migration stub (per §13.1): a `migrateMeta(input: unknown): SessionMeta` that today only handles v1, throws on others, but has the shape to evolve
- ≥90% line coverage

## Out of scope

- Auto-summarize via API call (§9.2 step 5) — defer to v0.1
- Schema v2 migration — when needed
