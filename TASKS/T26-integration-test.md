# T26: E2E integration test

**Phase:** D · **Depends on:** T13, T14, T15 (minimum: init + share + resume working)
**Architecture refs:** §13.2 (full), §16 DoD

## Scope

One end-to-end integration test that exercises the full producer → repo → consumer flow on a single machine, simulating two users via separate working directories.

### Test outline

```
1. Create a temp directory acting as both Git remote (bare) and two simulated users.
2. As user A:
   a. drev init <bare-repo>
   b. Generate a fixture JSONL session (hand-crafted, not a real one, keeps test deterministic)
   c. drev share --name test-session
3. As user B:
   a. drev init <bare-repo>
   b. drev list, verify the session appears
   c. drev resume test-session --no-launch, verify the file is at the right encoded-cwd path
   d. Read the placed JSONL, verify path rewriting was applied (user A's project root → user B's)
4. Assert exit codes, file presence, content match.
```

### What to test specifically

- `users/<userA>/<date>-test-session/` exists in repo
- `meta.yaml` round-trips correctly
- `session.jsonl` at user B's encoded-cwd has user B's paths, not user A's
- Subagent JSONLs are also placed and rewritten if the fixture has them
- Concurrent-share scenario from §13.2 ("two simulated users do not conflict")

## Files

- `tests/integration/share-resume.test.ts` (or place under `src/` if you prefer per §6, discuss in implementation)
- Test fixtures under `tests/fixtures/`

## Acceptance

- Test runs in <30s
- Test passes locally on Windows; documented as the platform tested (other platforms deferred to community)
- Test runs as part of `npm test`
- Setting up the bare git repo and two clones is done in test setup, no external services
- Demonstrates the §16 DoD bullet "One end-to-end integration test passing"

## Out of scope

- Multi-platform CI matrix, defer until CI is set up
- Real-network tests (actual GitHub), too flaky for v0
- Performance / load tests, not in DoD
