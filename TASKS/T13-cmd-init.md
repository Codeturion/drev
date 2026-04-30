# T13: drev init

**Phase:** C · **Depends on:** T05, T07, T08, T12 · **Blocks:** T26, T27
**Architecture refs:** §9.1 (full)

## Scope

Implement `drev init <repo-url> [--name <local-name>]` per §9.1.

### Flow

1. Validate URL syntax (https / ssh / git protocols)
2. Resolve local clone path: `~/.drev/repos/<local-name-or-url-segment>`
3. If clone path exists, error
4. `gitOps.clone(url, path)`
5. Detect default branch via `gitOps.remoteShowDefaultBranch`
6. If repo lacks `.drev/`, scaffold via `repo.ensureScaffold` and commit/push
7. If repo has `.drev/`, validate `schema-version === 1`
8. Update `~/.drev/config.yaml` to set `default_repo` to the clone path
9. Print success

### Failure modes to handle gracefully

- URL malformed → error with example
- Clone path exists → error with "drev is already initialized at X; use a different --name"
- Schema mismatch → error pointing to upgrade path
- Push of scaffold fails → keep local clone, print warning, recommend `drev sync`

## Files

- `src/cli/commands/init.ts`
- `src/cli/commands/init.test.ts` (mock git-ops; full unit coverage of branching logic)

## Acceptance

- All §9.1 steps implemented
- All listed failure modes have explicit branches with helpful messages
- Tests cover happy path + each failure mode
- Manual test: run against a real empty private GitHub repo, verify scaffold gets committed and `.drev/config.yaml` is correct

## Out of scope

- Auto-discovery of existing Drev repos in `~/.drev/repos/` (defer to v0.1)
- Migration from a non-Drev repo with conflicts — assume clean target
