# T10: core/outbox.ts

**Phase:** B · **Depends on:** T08 · **Blocks:** T14, T21
**Architecture refs:** §5.4 (outbox layout), §9.2 step 12 (queueing on push failure), §9.9 (drain via sync)

## Scope

Offline queue for shares that failed to push. Layout per §5.4:

```
~/.drev/outbox/<id>/
  ├── session.jsonl
  └── meta.yaml
```

### Contract

```ts
async function enqueue(id: string, sessionJsonl: string, metaYaml: string): Promise<void>;
async function listQueued(): Promise<string[]>;          // returns IDs
async function readQueued(id: string): Promise<{ session: string; meta: string }>;
async function dequeue(id: string): Promise<void>;       // removes the dir
async function isQueued(id: string): Promise<boolean>;
```

## Files

- `src/core/outbox.ts`
- `src/core/outbox.test.ts`

## Acceptance

- Enqueue + dequeue is round-trip safe: content read after enqueue matches content written
- `dequeue` is idempotent (calling on a missing id is a no-op, not an error)
- `listQueued` returns sorted IDs (deterministic for tests)
- Concurrent enqueue from two simulated processes does not corrupt either queue (use temp filenames + rename for atomicity)
- ≥85% line coverage

## Out of scope

- Network detection / online check — that's the job of `git push` failing in `T14`/`T21`
- TTL / expiration of queued items — out of v0
