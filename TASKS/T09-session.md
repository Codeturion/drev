# T09: core/session.ts

**Phase:** B · **Depends on:** T02 · **Blocks:** T14, T15, T23, T26
**Architecture refs:** §7.1 (paths), §9.2 step 3 (extraction)
**Corrections:** [`docs/CORRECTIONS.md`](../docs/CORRECTIONS.md) §2 (subagent JSONLs)

## Scope

Read and analyze Claude Code session JSONLs. Crucially: **discover and include subagent JSONLs** (`<id>/subagents/*.jsonl`), not addressed in original architecture, but required for transcript fidelity.

### Contract

```ts
interface SessionFiles {
  parent: string;              // absolute path to <id>.jsonl
  subagents: string[];         // absolute paths to <id>/subagents/*.jsonl
}

interface SessionStats {
  id: string;
  cwd: string;                 // absolute path from JSONL
  turns: number;
  toolCalls: number;
  filesTouched: string[];      // unique file paths from tool calls within cwd
  createdAt: string;           // ISO 8601 from first event
  modifiedAt: string;          // ISO 8601 from last event
  sizeBytes: number;
}

async function findSessionFiles(absolutePath: string, sessionId: string): Promise<SessionFiles>;
async function findMostRecentSession(): Promise<SessionFiles | null>;
async function readSessionStats(files: SessionFiles): Promise<SessionStats>;
```

`findMostRecentSession` walks `~/.claude/projects/*/*.jsonl`, picks the one with the latest mtime. Used by `share` when no `--session-id` flag.

`readSessionStats` parses JSONL line-by-line. Counts `type === 'user' || 'assistant'` events as turns; `type === 'tool_use'` content blocks as tool calls. Files touched = union of `file_path` fields from tool inputs that fall under `cwd`.

## Files

- `src/core/session.ts`
- `src/core/session.test.ts`: fixtures from a real (anonymized) JSONL

## Acceptance

- `findSessionFiles` returns parent + zero or more subagent files
- Subagent discovery matches reality: tested against a real session that has subagents (find one in `~/.claude/projects/`)
- `readSessionStats` produces correct counts on the §14.1 reference session (157 lines, 31 tool calls)
- Memory-conscious: large JSONLs (10MB+) parsed via streaming, not full string read
- ≥85% line coverage

## Out of scope

- Path rewriting, T03 handles that
- Schema migration of JSONL itself, out of v0 (defer to v0.1 per §15.3)
- Session diffing / forking, v0.5
