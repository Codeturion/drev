# T05: core/git-ops.ts + core/identity.ts

**Phase:** A · **Depends on:** T01 · **Blocks:** T08, T13, T14, T15, T18, T20, T24
**Architecture refs:** §6 (modules), §17 (style — no shell-true), §3.6 (no native deps)

## Scope

Async wrappers around `git` and (for scrub) `git filter-repo`, using Node's `execFile` from `node:child_process`. **Never `exec`. Never `shell: true`.** Each function returns parsed stdout or throws a `RepoError`.

### `core/git-ops.ts` — minimum surface

```ts
async function clone(url: string, dest: string): Promise<void>;
async function pullRebase(repoDir: string, timeoutMs?: number): Promise<void>;
async function add(repoDir: string, paths: string[]): Promise<void>;
async function commit(repoDir: string, message: string): Promise<void>;
async function push(repoDir: string): Promise<void>;
async function mv(repoDir: string, from: string, to: string): Promise<void>;
async function rm(repoDir: string, path: string, recursive?: boolean): Promise<void>;
async function revParse(repoDir: string, ref: string): Promise<string>;
async function showTopLevel(cwd: string): Promise<string | null>; // git rev-parse --show-toplevel
async function configGet(key: string): Promise<string | null>; // global; null if unset
async function remoteShowDefaultBranch(repoDir: string): Promise<string>;
async function filterRepo(repoDir: string, args: string[]): Promise<void>; // shells `git filter-repo`; throws if not on PATH
async function isAvailable(binName: string): Promise<boolean>; // for `which git`/`where git`-style probe
```

All functions:
- Throw `RepoError` (from T01) with stderr captured
- Take an optional `timeoutMs` where applicable (default 30s, sweep uses 10s per §10)
- Return parsed strings (trimmed) where stdout is meaningful

### `core/identity.ts`

```ts
async function currentUserEmail(): Promise<string>; // throws if `git config user.email` returns empty
async function shortUsername(email: string): string; // local part of email, sanitized: lowercase, [a-z0-9-]
```

The shortUsername is what populates `users/<username>/` directories.

## Files

- `src/core/git-ops.ts`
- `src/core/git-ops.test.ts` — test against a tmp git repo, no real network
- `src/core/identity.ts`
- `src/core/identity.test.ts`

## Acceptance

- Every function uses `execFile` with `shell: false` (verify with code review)
- `git-ops` tests cover happy paths and the most common failure (non-zero exit, missing binary, timeout) per function
- `identity` tests cover: trimmed email, missing email throws, sanitization rules
- Integration smoke: clone a tmp repo, add file, commit, verify HEAD via `revParse`
- ≥85% line coverage

## Out of scope

- High-level repo lifecycle — that's T08 `core/repo.ts`
- Outbox queueing on push failure — that's T10
- Conflict resolution UI — out of v0
- Authentication (token, ssh-key handling) — defer to git's own config
