# T01: lib/errors.ts + lib/logger.ts

**Phase:** A · **Depends on:**, · **Blocks:** all subsequent tasks
**Architecture refs:** §17 (style, typed errors, structured logging), §6 (module layout)

## Scope

Two small foundation modules used everywhere downstream.

### `lib/errors.ts`
Typed error classes that `core/` modules throw. Per §17: "never throw plain `Error` from `core/`." Aim for a small, focused taxonomy, not a class per failure mode.

Suggested classes (refine as needed):
- `DrevError`: abstract base, has a `code: string` and optional `cause`
- `ConfigError`: bad/missing config, schema mismatch
- `RepoError`: git op failure, repo not initialized, schema-version mismatch
- `SessionError`: JSONL not found, parse failure
- `ValidationError`: meta.yaml or input violates schema
- `RedactionError`: pattern compile failure
- `OwnershipError`: caller can't perform op on someone else's session

Each subclass overrides `name` and provides a `code` (e.g., `'CONFIG_MISSING'`). `cause` chains the underlying Node error.

### `lib/logger.ts`
Structured logger that writes to `~/.drev/logs/<file>.log` (rolling, keep last 30 days per §10). Levels: `info`, `warn`, `error`. Each entry: timestamp, level, scope, message, optional structured data. JSON-line format.

Hooks log silently to file only, never stdout/stderr per §10. CLI's user-facing output is `chalk` in `cli/ui.ts` (T12), not this logger.

## Files

- `src/lib/errors.ts`
- `src/lib/errors.test.ts`
- `src/lib/logger.ts`
- `src/lib/logger.test.ts`

## Acceptance

- All error classes extend `DrevError`, have `code`, support `cause`
- Logger writes valid JSON-Line, creates the log dir, rotates by date (one file per day, 30-day retention)
- Tests cover: error subclassing, code stability, JSON serialization (errors); log file creation, rotation eligibility, level filtering (logger)
- `npm test` green, `npm run typecheck` green

## Out of scope

- Telemetry / remote logging
- Pretty-printing for CLI, that's `cli/ui.ts` (T12)
- Async log batching, synchronous writes are fine for v0; sweep volume is low
