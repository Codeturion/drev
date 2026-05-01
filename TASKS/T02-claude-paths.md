# T02: core/claude-paths.ts

**Phase:** A · **Depends on:** T01 · **Blocks:** T09, T15, T23
**Architecture refs:** §7.1 (encoded-cwd format)

## Scope

Helpers for Claude Code's filesystem layout. Pure functions, no I/O.

### Functions

```ts
encodedCwd(absolutePath: string): string;
// `/Users/fuat/work/forever-town` → `-Users-fuat-work-forever-town`
// `F:\Nuts Projects\drev` → `F--Nuts-Projects-drev`
// Replace every non-alphanumeric character with `-`.

claudeProjectsDir(): string;
// `~/.claude/projects` resolved to absolute path

sessionPath(absolutePath: string, sessionId: string): string;
// `<claudeProjectsDir>/<encodedCwd>/<sessionId>.jsonl`

subagentDir(absolutePath: string, sessionId: string): string;
// `<claudeProjectsDir>/<encodedCwd>/<sessionId>/subagents`

drevHome(): string;
// `~/.drev` resolved to absolute path
```

## Files

- `src/core/claude-paths.ts`
- `src/core/claude-paths.test.ts`

## Acceptance

- `encodedCwd` produces the correct form for: POSIX paths, Windows paths with drive letters and spaces, paths with special chars (`+`, `(`, `)`, `[`)
- All path functions return absolute paths
- Tests cover real examples from this machine: `F:\Unity Projects\deep-cleaning-services` → `F--Unity-Projects-deep-cleaning-services`
- ≥95% line coverage

## Out of scope

- File I/O, this module is pure computation
- Path rewriting, that's T03
