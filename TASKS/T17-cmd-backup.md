# T17: drev backup

**Phase:** C · **Depends on:** T14
**Architecture refs:** §9.3 (full)

## Scope

Implement `drev backup --name N [--session-id ID]` per §9.3. Identical to `share` except:

- `purpose: 'backup'` (instead of `'share'`)
- `visibility: 'private'` (forced; `--private` flag not needed)
- `--name` is required; error if missing

### Implementation

Most of this is one call into the shared share-implementation function with different defaults. Refactor `share`'s core into something like `executeShare(opts: ShareOptions)` if helpful. Don't duplicate code.

## Files

- `src/cli/commands/backup.ts`
- `src/cli/commands/backup.test.ts`

## Acceptance

- Missing `--name` exits non-zero with helpful message
- Visibility forced to `'private'` regardless of repo `default_visibility`
- Tests cover: missing name, valid backup, ID override

## Out of scope

- Backup retention policy, informational `retention_days` only
- Compression / deduplication, out of v0
