# Manual Tests

Some Drev behaviors can't be reasonably automated. These procedures must be re-run before each release. Record outcomes inline at the end of this file.

## Test 1 — §14.1 path-rewrite reproducibility

**Purpose:** Verify that a JSONL whose paths have been rewritten via `core/path-rewriter` is still loadable by `claude --resume` with full session context.

**Last passed:** 2026-05-01 (manual rewrite via `experiment/rewrite.mjs`, real session `83a0c3cb-6410-441a-a57c-99e44fda268e` from `F:\Unity Projects\deep-cleaning-services`, rewritten to `F:\drev-experiment`, recall verified).

**Procedure:**

1. Identify a real Claude Code session of ≥30 turns and ≥5 tool calls. Note its session id and project root.
2. Run `experiment/rewrite.mjs` adjusted to point at the chosen session and a destination project root.
3. Verify the rewritten JSONL passes `JSON.parse` line-by-line.
4. Compute the destination's encoded-cwd: every non-alphanumeric character in the absolute path becomes `-`. Place the rewritten JSONL at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
5. From the destination project root, run `claude --resume <session-id>`.
6. Ask Claude a recall question whose answer only the original session would know.
7. Verify Claude answers correctly with details from the original session.

**Pass criterion:** Step 7 succeeds.

**If it fails:** the path rewriter has regressed (reproduce against `experiment/rewrite.mjs`'s output as the oracle), or Claude Code's resume behavior has changed.

## Test 2 — Real cross-machine resume

**Purpose:** Validate the full producer→consumer flow on two physically distinct machines (or at minimum, two distinct user accounts on one machine), through the actual `drev share` and `drev resume` CLI.

**Last passed:** *Not yet run on v0.*

**Procedure:**

### Machine A (producer)

1. Have a real Claude Code session of ≥30 turns and ≥5 tool calls available.
2. `drev init <private-repo>` (or `drev init Codeturion/test-cross-machine`)
3. `drev share --session-id <id> --name xmachine-test`

### Machine B (consumer)

4. `drev init <same-private-repo>` (or `drev init Codeturion/test-cross-machine` — shorthand idempotent)
5. `drev list` — confirm `xmachine-test` appears
6. From any directory you want as the destination project root, `drev resume xmachine-test` (passes `--into <path>` if you're not inside a git repo)
7. Claude Code launches with the resumed session
8. Ask a recall question whose answer only the original session would know
9. Verify Claude answers correctly

### Document the run

Append a row to the table at the bottom of this file with:

- Date
- Source machine OS + Claude Code version
- Destination machine OS + Claude Code version
- Session size (turns, tool calls, JSONL bytes)
- Recall question + answer received
- Pass / fail / caveat

**Pass criterion:** Step 9 succeeds. If subagent JSONLs were present in the source session, verify they're also present at the destination encoded-cwd's `<id>/subagents/` directory.

**If it fails:** check `docs/CORRECTIONS.md` §1 (Windows separator handling) and §2 (subagent JSONLs). Compare the destination JSONL against `experiment/rewrite.mjs` output for the same source — they should be byte-identical.

## Test 3 — End-to-end smoke (single machine, two simulated users)

**Purpose:** Quick sanity check that `init → share → list → resume --no-launch` works without any real GitHub or Claude binary.

**Last passed:** *Run as part of the integration test in `tests/integration/share-resume.test.ts` — see `npm test`.*

This is the automated check. If `npm test` is green, this passes.

## Test 4 — `drev hooks install` against real Claude Code config

**Purpose:** Verify hooks install without corrupting the user's `~/.claude/settings.json`.

**Procedure:**

1. Back up `~/.claude/settings.json` (`cp ~/.claude/settings.json ~/.claude/settings.backup.json`)
2. `drev hooks install`
3. Inspect `~/.claude/settings.json` — Drev's entries should be present in `SessionStart` and `SessionEnd`, all other entries preserved.
4. `drev hooks uninstall`
5. Inspect again — Drev's entries gone, all other entries still there.
6. Compare against backup — should match the original.

**Pass criterion:** Step 6 matches.

## Run log

| Date | Test | Result | Notes |
|------|------|--------|-------|
| 2026-05-01 | §14.1 path rewrite | PASS | Real session 83a0c3cb-…, src=F:\Unity Projects\deep-cleaning-services → dest=F:\drev-experiment, recall verified (Gio/2D Unity/Photoshop/Figma) |
| 2026-05-01 | Test 2 — cross-machine resume | PASS | Windows 11 (producer) → macOS (consumer). Session ab1704f8-… ("xos-fix"), 216 turns, 467 KB. Cross-OS path rewrite verified (mid-path separators translated to `/`). Two real bugs surfaced and fixed during the test: (1) thinking-block signatures broke cross-account resume (CORRECTIONS §4) and (2) `drev init --reinit` collided on existing local clones. After both fixes + dist rebuild, full recall confirmed by continuing the conversation on Mac without API errors. |
