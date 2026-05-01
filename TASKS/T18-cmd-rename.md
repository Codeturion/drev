# T18: drev rename

**Phase:** C · **Depends on:** T05, T06, T08, T11, T12
**Architecture refs:** §9.6 (full)

## Scope

Implement `drev rename <name-or-id> <new-name>` per §9.6.

### Flow

1. `gitOps.pullRebase`
2. Resolve session via `core/name-resolver`
3. Verify ownership: `meta.user_email === gitConfig.user.email`. Error if mismatch
4. Sanitize new name via `repo.sanitizeName`
5. `gitOps.mv` from `users/<self>/<old-dir>` to `users/<self>/<new-date>-<new-name>` (preserve original date prefix)
6. Update `meta.yaml.name` via `metadata.writeMeta`
7. Commit + push

## Files

- `src/cli/commands/rename.ts`
- `src/cli/commands/rename.test.ts`

## Acceptance

- Ownership check rejects with `OwnershipError` (from T01)
- Date prefix preserved (renamed dir keeps original `YYYY-MM-DD-` prefix)
- `meta.yaml.name` field updated
- Tests cover: ownership rejection, sanitization, name collision (existing dir at target → error)

## Out of scope

- Renaming someone else's session via admin override, never in v0
- Renaming `id`: IDs are immutable per §5.1
