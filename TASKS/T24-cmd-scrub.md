# T24: drev scrub

**Phase:** C · **Depends on:** T05, T08, T11, T12
**Architecture refs:** §9.10 (full), §8.5 (purpose)

## Scope

Implement `drev scrub <name-or-id> [--confirm]` per §9.10, permanently remove a session from Git history. Emergency hatch when redaction missed something.

### Flow

1. Resolve session
2. Verify ownership
3. Without `--confirm`: print explanation and exit. Explanation must say:
   - This rewrites Git history
   - Force-pushes to remote
   - Other engineers must re-clone after
4. With `--confirm`:
   - Verify `git filter-repo` is on PATH; if not, error with install instructions
   - Run `gitOps.filterRepo([..., '--path', '<session-dir>', '--invert-paths'])`
   - Force-push (this is one of very few places force-push is correct)
5. Print warning that other engineers must re-clone

## Files

- `src/cli/commands/scrub.ts`
- `src/cli/commands/scrub.test.ts`

## Acceptance

- Without `--confirm` is purely informational; never modifies anything
- Missing `git filter-repo` → clear install instructions for macOS/Linux/Windows
- Ownership rejection same as `rename` and `mark`
- Tests use a tmp git repo with multiple commits; verify scrubbed dir is gone from history
- Force-push is gated behind `--confirm`: never done implicitly

## Out of scope

- Bundling `git filter-repo`: third-party install per §3.6 (no native deps)
- Partial scrub (just one file from a session), out of v0
- Coordinated team-wide re-clone, communication is the user's responsibility; we only print the warning
