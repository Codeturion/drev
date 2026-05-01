# T08: core/repo.ts

**Phase:** B · **Depends on:** T05, T07 · **Blocks:** T10, T13, T14, T15, T16, T18, T19, T20, T21, T23, T24
**Architecture refs:** §4 (layout), §9.1 (init), §3.4 (no central index)

## Scope

Manage the local Git clone of a Drev repo: scaffold structure on first init, walk the directory tree, locate session paths, ensure `.drev/` invariants.

### Contract (suggested: refine during implementation)

```ts
async function ensureScaffold(repoDir: string, teamName: string): Promise<void>;
// Creates .drev/schema-version, .drev/config.yaml, users/.gitkeep, README.md if missing.
// Idempotent. Validates schema-version === 1 if .drev/ already exists.

async function listMetaFiles(repoDir: string): Promise<string[]>;
// Walks users/*/*/meta.yaml, returns absolute paths. Used by `list`, `search`, etc.

function sessionDir(repoDir: string, username: string, dateAndName: string): string;
// `<repoDir>/users/<username>/<YYYY-MM-DD>-<name-or-shortid>`

function sanitizeName(input: string): string;
// lowercase, whitespace → '-', strip non-[a-z0-9-_], collapse runs of '-'

function dateAndNamePrefix(date: Date, name: string | null, shortId: string): string;
// `2026-04-30-auth-refactor` or `2026-04-30-7f3a2b1c`
```

## Files

- `src/core/repo.ts`
- `src/core/repo.test.ts`

## Acceptance

- `ensureScaffold` is idempotent (running twice doesn't duplicate or fail)
- `listMetaFiles` correctly walks the per-user tree (test with a mock filesystem layout)
- `sanitizeName` handles edge cases: emoji (stripped), unicode letters (transliterated or stripped, pick one and document), excessive length (truncate to 64 chars)
- `dateAndNamePrefix` always produces a valid filesystem name on Windows + POSIX
- ≥85% line coverage

## Out of scope

- Conflict resolution between users, handled by `users/<username>/` partitioning per §3.3
- Git operations, those are in T05
- Outbox handling, that's T10
