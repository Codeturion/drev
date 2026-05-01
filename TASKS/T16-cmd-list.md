# T16: drev list

**Phase:** C · **Depends on:** T06, T08, T12
**Architecture refs:** §9.4 (full)

## Scope

Implement `drev list [filters]` per §9.4.

### Filters

- `--mine`: own sessions only
- `--team`: team-visible (excludes own private/backups)
- `--backups`: own backups only
- `--project <name>`: substring on `meta.project`
- `--user <username>`: exact match on `meta.user`
- `--days <n>`: within last N days (by `shared_at`)
- `--limit <n>`: cap (default 20)

### Flow

1. `gitOps.pullRebase` with timeout fallback to local state
2. `repo.listMetaFiles` then parse each via `metadata.readMeta`
3. Apply filters
4. Sort by `shared_at` descending
5. Render table: ID-prefix (8 chars), Name, User, Project, "Xh ago", Title

## Files

- `src/cli/commands/list.ts`
- `src/cli/commands/list.test.ts`

## Acceptance

- Each filter independently tested
- Filters combine with AND semantics
- Empty result prints "no sessions match filters"
- Pull failure → fall back to local state with one-line warning, do not error
- Table renders aligned with `ui.table` from T12

## Out of scope

- Pagination, `--limit` is enough
- Output formats other than the default table, defer to v0.1
- Server-side filtering, there is no server
