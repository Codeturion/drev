# T14: drev share

**Phase:** C · **Depends on:** T03, T04, T05, T06, T07, T08, T09, T10, T11, T12
**Blocks:** T17, T23, T26
**Architecture refs:** §9.2 (full), §8.4 (first-share confirmation)

## Scope

Implement `drev share [--name N] [--private] [--session-id ID]` per §9.2. This is the highest-fanout command in the project, touches almost every core module.

### Flow (from §9.2)

1. Read user config; load default repo
2. Resolve target session via `--session-id` or most-recent JSONL
3. Read JSONL stats: turns, files touched, created_at, via `core/session`
4. Capture git state at project root: HEAD SHA, branch (best-effort)
5. Resolve name: `--name`, sanitized via `repo.sanitizeName`; else prompt with auto-suggestion
6. Run redaction over JSONL via `core/redaction`
7. Build `meta.yaml` per §5.1
8. `gitOps.pullRebase` in repo clone
9. Compute target dir: `users/<self>/<YYYY-MM-DD>-<name-or-shortid>/`
10. Write redacted `session.jsonl` and `meta.yaml`
11. Also copy subagent JSONLs into `<target>/subagents/*` (per CORRECTIONS §2)
12. `gitOps.add`, `commit -m "share: <name>"`, `push`
13. On push failure: enqueue via `outbox.enqueue`, log, print warning
14. Print success summary (id-prefix, name, file count, redaction count)

### First-share confirmation (§8.4)

If this is the first share to the target repo (`users/<self>/` empty), show redaction summary and confirm via `ui.confirm`. Subsequent shares are silent unless redactions occurred.

## Files

- `src/cli/commands/share.ts`
- `src/cli/commands/share.test.ts`

## Acceptance

- All §9.2 steps implemented
- Subagent JSONLs included when present (CORRECTIONS §2)
- First-share confirmation triggers correctly; subsequent shares don't re-prompt
- Push failure correctly enqueues to outbox, returns non-zero exit code, prints recovery hint
- Tests with mocked `core/` modules cover: happy path, push failure, no session found, ambiguous session
- Manual test: share a real session, verify the resulting `meta.yaml` matches §5.1 and `session.jsonl` has redactions applied

## Out of scope

- Auto-summarize via API call (§9.2 step 5, `auto_summarize: true`), defer to v0.1
- Forking with `parent_session` lineage, v0.5
- Selective file inclusion, share is all-or-nothing for v0
