# T21: drev sync

**Phase:** C · **Depends on:** T08, T10, T12
**Architecture refs:** §9.9 (full)

## Scope

Implement `drev sync` per §9.9 — pull and drain the outbox.

### Flow

1. `gitOps.pullRebase`
2. For each item in `outbox.listQueued`:
   - Read via `outbox.readQueued`
   - Copy `session.jsonl` and `meta.yaml` to the repo at the right `users/<user>/<dir>/` path
   - `gitOps.add`, `commit`, `push`
   - On success: `outbox.dequeue`
   - On failure: leave in place, accumulate for summary
3. Print summary: pulled X new, drained Y, kept Z queued

## Files

- `src/cli/commands/sync.ts`
- `src/cli/commands/sync.test.ts`

## Acceptance

- Empty outbox: prints "outbox is empty" and exits 0 after pull
- Mixed result (some drain, some fail): each item handled independently, summary accurate
- A persistently-failing item doesn't block subsequent items in the queue
- Tests cover: empty queue, all drain, partial drain, all fail

## Out of scope

- Scheduled / background sync — that's `drev autoshare-sweep` (T23)
- Conflict resolution if push fails due to remote changes — `pullRebase` first should handle most cases; if not, item stays queued
