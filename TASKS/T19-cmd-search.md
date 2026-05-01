# T19: drev search

**Phase:** C · **Depends on:** T06, T08, T12
**Architecture refs:** §9.7 (full)

## Scope

Implement `drev search <query>` per §9.7.

### Flow

1. `gitOps.pullRebase`
2. `repo.listMetaFiles` → parse each
3. Substring match (case-insensitive) against:
   - `meta.name`
   - `meta.title`
   - `meta.summary`
   - any item in `meta.files_touched`
4. Render results with `ui.table` (same shape as `list`)

## Files

- `src/cli/commands/search.ts`
- `src/cli/commands/search.test.ts`

## Acceptance

- Each searchable field tested independently
- Multiple matches sorted by `shared_at` desc
- No matches prints "no sessions match '<query>'"
- Same table format as `list` for visual consistency

## Out of scope

- Full-text JSONL search (search inside session content), v0.5 (§14.4)
- Boolean operators / regex queries, v0.5
- Search ranking by relevance, substring is enough for v0
