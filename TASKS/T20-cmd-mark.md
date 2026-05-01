# T20: drev mark

**Phase:** C · **Depends on:** T05, T06, T08, T11, T12
**Architecture refs:** §9.8 (full)

## Scope

Implement `drev mark <name-or-id> <flag>` per §9.8.

### Flags (mutually exclusive)

- `--public` / `--team`: set `meta.visibility = 'team'`
- `--private`: set `meta.visibility = 'private'`
- `--delete`: `gitOps.rm` (recursive) the session directory

### Flow

1. `gitOps.pullRebase`
2. Resolve session
3. Verify ownership (all flags require ownership)
4. Apply change:
   - Visibility flags: update `meta.yaml`, commit
   - Delete: `gitOps.rm`, commit. Print warning that history retains data; recommend `drev scrub` for true removal
5. Push

## Files

- `src/cli/commands/mark.ts`
- `src/cli/commands/mark.test.ts`

## Acceptance

- Mutual exclusion enforced (commander handles via option groups)
- Ownership rejection for all paths including delete
- Delete prints history-retention warning
- Tests cover all three flags + ownership rejection

## Out of scope

- Bulk mark (mark multiple sessions), out of v0
- Soft-delete with recovery window, `mark --delete` is committed; use git revert if needed
