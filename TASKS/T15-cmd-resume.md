# T15: drev resume

**Phase:** C · **Depends on:** T02, T03, T05, T06, T08, T09, T11, T12
**Blocks:** T26, T27
**Architecture refs:** §9.5 (full), §3.8 (auto-launch contract)
**Corrections:** [`docs/CORRECTIONS.md`](../docs/CORRECTIONS.md) §1, §2

## Scope

Implement `drev resume <name-or-id> [--into <path>] [--no-launch]` per §9.5.

### Flow (from §9.5)

1. `gitOps.pullRebase`
2. Resolve session via `core/name-resolver`
3. Load `meta.yaml` and `session.jsonl`
4. Determine destination project root:
   - `--into <path>` if given
   - Else `gitOps.showTopLevel(cwd)`
   - Else prompt user
5. Compare `meta.commit_sha` to local HEAD; warn if files in `meta.files_touched` have changed since
6. Run `pathRewriter.rewritePaths(jsonl, meta.project_root, destRoot)`: preserving native separators (CORRECTIONS §1)
7. Compute destination encoded-cwd via `core/claude-paths`
8. Write rewritten JSONL to `<claudeProjectsDir>/<encoded>/<id>.jsonl`
9. Also rewrite + place each subagent JSONL at `<claudeProjectsDir>/<encoded>/<id>/subagents/*.jsonl` (CORRECTIONS §2)
10. Print "Resuming '<name>' in <destRoot>..."
11. Locate `claude` binary via `which claude` / `where claude`
12. If found, spawn `claude --resume <id>` with `cwd=destRoot`, `stdio='inherit'`, `shell: false`. Drev exits with the subprocess's exit code.
13. If not found, or `--no-launch`, or spawn errors: print fallback instructions per §9.5 step 12 and exit 0.

## Files

- `src/cli/commands/resume.ts`
- `src/cli/commands/resume.test.ts`

## Acceptance

- All §9.5 steps implemented
- Spawn uses `shell: false`, `stdio: 'inherit'`
- `--no-launch` skips spawn cleanly
- Fallback message shows the exact `cd` + `claude --resume <id>` command
- Subagent JSONLs are rewritten and placed correctly (CORRECTIONS §2)
- Tests cover: missing claude binary, spawn error, into-flag override, ambiguous session
- Manual test: resume a session shared by `T14`'s integration test, verify Claude Code picks up full context

## Out of scope

- Auto-rebase the user's working tree to `meta.commit_sha`: too invasive for v0
- Conflict reconciliation when files differ, only warn, don't try to merge
- Detached-mode resume (without spawning) for CI, already covered by `--no-launch`
