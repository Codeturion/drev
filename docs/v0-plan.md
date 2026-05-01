# Drev v0: Milestone Plan

## Why this exists

`ARCHITECTURE.md` is the design specification (~770 lines). It tells us *what* Drev is and *how* the modules fit together. It does not tell us:

- What to build first
- Which tasks block which
- When v0 is shippable

This document is the operational layer on top of the spec. Each task lives in `TASKS/T<id>-<slug>.md` with concrete scope and acceptance criteria. This file is the strategic view.

## Status

- ✓ §14.1 mandatory experiment (path-rewrite + `claude --resume`), passed 2026-05-01
- ✓ Scaffold (package.json, tsconfig, tsup, vitest, src/ skeleton, git, GitHub)
- ✓ Phase A, foundations (T01-T05; 123 tests)
- ✓ Phase B, stateful modules (T06-T11; 200 tests)
- ✓ Phase C, commands (T12-T24; 155 tests + init wizard refresh)
- ▶ Phase D, ship gates (T25 ✓, T26 ✓, T27 awaits real cross-machine run, T28 awaits `npm publish`)

**Cumulative test count:** 549 across 28 files. **Tag:** `v0.1.0` pushed.

## Known issues found during v0.1.0 testing

Logged as backlog tasks; address before tagging v0.1.1:

- **[T29](../TASKS/T29-fix-sessionend-reliability.md)**, `SessionEnd` hook doesn't reliably fire. Auto-share's headline UX depends on it; if it misses, sweep never runs. Need instrumentation + likely use absolute path in hook command + verify SessionStart fallback.
- **[T30](../TASKS/T30-noninteractive-from-skill.md)**, `drev share` and the `drev init` wizard hang when stdin isn't a TTY (which is how Claude's Bash tool runs them, per the bundled skill flow). Need TTY detection in `ui.confirm` / `ui.prompt` and a clear non-interactive code path.

## Picking up where we left off

Two user-driven steps remain:

1. **Run T27, cross-machine manual test.** Procedure in [`docs/MANUAL_TESTS.md`](MANUAL_TESTS.md) Test 2. Append the run record to that file's run log when done.
2. **Run T28, `npm publish`.** From `F:\Nuts Projects\drev`: `npm login`, then `npm publish --access public`. Verify with `npm view drev` and a fresh-install smoke test.

Everything else is committed, pushed, tagged, and tested.

## Phases

### Phase A: Foundations

Modules with no internal dependencies (or only `lib/errors`). Critical correctness, ≥90% coverage target. Can be implemented in parallel after T01.

| Task | Module | Load-bearing |
|------|--------|--------------|
| [T01](../TASKS/T01-lib.md) | `lib/errors.ts` + `lib/logger.ts` |  |
| [T02](../TASKS/T02-claude-paths.md) | `core/claude-paths.ts` |  |
| [T03](../TASKS/T03-path-rewriter.md) | `core/path-rewriter.ts` | **YES** |
| [T04](../TASKS/T04-redaction.md) | `core/redaction.ts` | **YES** |
| [T05](../TASKS/T05-git-ops.md) | `core/git-ops.ts` + `core/identity.ts` |  |

**Phase A gate:** all five tasks merged, `npm test` green, `npm run typecheck` green, `core/path-rewriter.ts` reproduces `experiment/rewrite.mjs` output byte-for-byte.

### Phase B: Stateful modules

Schema, config, and I/O modules. Depend on Phase A.

| Task | Module | Depends on |
|------|--------|------------|
| [T06](../TASKS/T06-metadata.md) | `core/metadata.ts` | T01 |
| [T07](../TASKS/T07-config.md) | `core/config.ts` | T01 |
| [T08](../TASKS/T08-repo.md) | `core/repo.ts` | T05, T07 |
| [T09](../TASKS/T09-session.md) | `core/session.ts` | T02 |
| [T10](../TASKS/T10-outbox.md) | `core/outbox.ts` | T08 |
| [T11](../TASKS/T11-name-resolver.md) | `core/name-resolver.ts` | T06 |

**Phase B gate:** all six tasks merged, ≥80% coverage on `core/`, integration test scaffolding compiles.

### Phase C: Commands

CLI surface. Each command is one task. Depend on Phases A and B.

| Task | Command | Spec | Notes |
|------|---------|------|-------|
| [T12](../TASKS/T12-cli-program.md) | `cli/index.ts` + `cli/ui.ts` |  | Commander shell, registers commands |
| [T13](../TASKS/T13-cmd-init.md) | `drev init` | §9.1 | First user-facing flow |
| [T14](../TASKS/T14-cmd-share.md) | `drev share` | §9.2 | Highest complexity, touches almost every module |
| [T15](../TASKS/T15-cmd-resume.md) | `drev resume` | §9.5 | Second highest, spawns `claude` subprocess |
| [T16](../TASKS/T16-cmd-list.md) | `drev list` | §9.4 | Walks `users/*/*/meta.yaml` |
| [T17](../TASKS/T17-cmd-backup.md) | `drev backup` | §9.3 | Thin wrapper around share |
| [T18](../TASKS/T18-cmd-rename.md) | `drev rename` | §9.6 | Ownership check |
| [T19](../TASKS/T19-cmd-search.md) | `drev search` | §9.7 | Substring match across metadata |
| [T20](../TASKS/T20-cmd-mark.md) | `drev mark` | §9.8 | Visibility / delete flag |
| [T21](../TASKS/T21-cmd-sync.md) | `drev sync` | §9.9 | Drains outbox |
| [T22](../TASKS/T22-cmd-hooks.md) | `drev hooks` | §9.11 | Manage Claude Code hooks |
| [T23](../TASKS/T23-cmd-autoshare-sweep.md) | internal | §9.12, §10 | Called by hooks, never user-invoked |
| [T24](../TASKS/T24-cmd-scrub.md) | `drev scrub` | §9.10 | Shells `git filter-repo` |

**Phase C gate:** all 13 tasks merged, manual smoke test of init → share → list → resume passes on this machine, `npm run build` produces working binaries.

### Phase D: Ship gates

Final §16 Definition-of-Done items.

| Task | Deliverable | Spec |
|------|-------------|------|
| [T25](../TASKS/T25-readme-quickstart.md) | `README.md` install/init/share/resume in <50 lines | §16 |
| [T26](../TASKS/T26-integration-test.md) | One end-to-end integration test passing in CI | §13.2, §16 |
| [T27](../TASKS/T27-manual-cross-machine.md) | Real cross-machine resume tested + documented | §13.3, §16 |
| [T28](../TASKS/T28-publish.md) | `npm publish` with proper version, README, LICENSE | §16 |

**v0 ship gate:** Phase D tasks complete, demo video recorded (per §16), `docs/MANUAL_TESTS.md` and `docs/REDACTION.md` committed.

## Dependency graph

```text
                ┌─────────────────────────┐
                │  T01 lib (errors+log)   │
                └────────────┬────────────┘
                             │
        ┌──────────┬─────────┼─────────┬──────────┐
        ▼          ▼         ▼         ▼          ▼
    ┌──────┐  ┌────────┐ ┌─────────┐ ┌────────┐ ┌────────┐
    │ T02  │  │  T03   │ │  T04    │ │  T05   │ │  T06   │
    │claude│  │ path-  │ │redaction│ │git-ops │ │metadata│
    │paths │  │rewriter│ │         │ │identity│ │        │
    └──┬───┘  └───┬────┘ └────┬────┘ └───┬────┘ └────┬───┘
       │          │            │          │            │
       │       (load          (load        │            │
       │        bearing)      bearing)     │            │
       │                                   │            │
       ▼                                   ▼            ▼
    ┌──────┐                          ┌────────┐  ┌─────────────┐
    │ T09  │                          │  T08   │  │    T11      │
    │sess- │                          │  repo  │  │name-resolver│
    │ ion  │                          └───┬────┘  └─────────────┘
    └──┬───┘                              │              │
       │                            ┌─────▼─────┐        │
       │                            │   T10     │        │
       │                            │  outbox   │        │
       │                            └─────┬─────┘        │
       │                                  │              │
       └──────────────┬───────────────────┴──────────────┘
                      ▼
              ┌────────────────┐
              │  Phase C       │
              │  Commands      │
              │  (T12-T24)     │
              └───────┬────────┘
                      ▼
              ┌────────────────┐
              │  Phase D       │
              │  Ship gates    │
              │  (T25-T28)     │
              └────────────────┘
```

## What's NOT in v0

Listed here so we don't drift. Cross-reference §14:

- MCP server (dropped from roadmap entirely; the bundled skill covers Claude Code integration)
- Claude Code plugin marketplace package (§14.3 v0.1)
- `parent_session` lineage / forking (§14.4 v0.5)
- Encryption (§14.4 v0.5)
- Full-text search index (§14.4 v0.5), `drev search` is substring-only
- Multi-repo support per user (§14.4 v0.5)
- Web UI / Obsidian plugin (§14.5 v1.0)
- Cross-tool support: Cursor, Codex, Gemini (§14.5 v1.0)
- API-based title/summary auto-generation (§14.3 v0.1)
- CI/CD setup, defer until first command lands
- ESLint / Prettier, defer until churn warrants

## Risks (from §15)

| Risk | Status | Mitigation |
|------|--------|------------|
| Path rewriting doesn't work | ✓ Resolved 2026-05-01 | §14.1 experiment passed |
| Anthropic ships native team resume | Open | Position Drev as the open-source reference. Ship fast. |
| JSONL format changes | Open | `schema_version` pinning, detect on read |
| Secret leakage | Open (T04 mitigates) | Aggressive default redaction, user-extensible patterns, `drev scrub` emergency hatch |
| Path collision false matches | Open (T03 mitigates) | Boundary-aware replacement, comprehensive unit tests |
| Subagent JSONLs lost on resume | Open (docs/CORRECTIONS.md §2; T09 mitigates) | Discover and rewrite alongside parent |
| Windows path encoding bugs | Resolved (docs/CORRECTIONS.md §1) | No separator normalization; preserve native form |

## How to use this plan

1. **Starting work?** Open `TASKS/README.md`, find the first task in your phase with no unresolved dependencies, read its task file, follow the acceptance criteria.
2. **Stuck on scope?** Cross-reference the task's `Architecture refs` line, those are the authoritative sections in `ARCHITECTURE.md`. Also check `docs/CORRECTIONS.md` for any in-flight overrides.
3. **Adding a discovery?** If you find a new constraint or correction during implementation, append it to `docs/CORRECTIONS.md` and link from the task file. Don't edit `ARCHITECTURE.md` in place.
4. **Done with a task?** Mark it ✓ in `TASKS/README.md` and the corresponding row here. Phase gates are real, don't skip them.
