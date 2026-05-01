# Drev v0 — Task Index

Operational view of v0 work. Each row links to a task file with full scope, acceptance, and references. Strategic plan: [`docs/v0-plan.md`](../docs/v0-plan.md).

**Legend:** `☐` pending · `▶` in progress · `✓` done

## Phase A — Foundations

| ID | Task | Status | Depends on | Notes |
|----|------|--------|------------|-------|
| [T01](T01-lib.md) | `lib/errors.ts` + `lib/logger.ts` | ✓ | — | Typed errors, structured log |
| [T02](T02-claude-paths.md) | `core/claude-paths.ts` | ✓ | T01 | encoded-cwd computation |
| [T03](T03-path-rewriter.md) | `core/path-rewriter.ts` | ✓ | T01 | **Load-bearing.** §7 + CORRECTIONS §1 |
| [T04](T04-redaction.md) | `core/redaction.ts` | ✓ | T01 | **Load-bearing.** §8 secret patterns |
| [T05](T05-git-ops.md) | `core/git-ops.ts` + `core/identity.ts` | ✓ | T01 | execFile wrappers; user email |

## Phase B — Stateful modules

| ID | Task | Status | Depends on | Notes |
|----|------|--------|------------|-------|
| [T06](T06-metadata.md) | `core/metadata.ts` | ✓ | T01 | meta.yaml schema + I/O |
| [T07](T07-config.md) | `core/config.ts` | ✓ | T01 | user + repo yaml configs |
| [T08](T08-repo.md) | `core/repo.ts` | ✓ | T05, T07 | local clone management |
| [T09](T09-session.md) | `core/session.ts` | ✓ | T02 | JSONL + subagent discovery |
| [T10](T10-outbox.md) | `core/outbox.ts` | ✓ | T08 | offline queue |
| [T11](T11-name-resolver.md) | `core/name-resolver.ts` | ✓ | T06 | name vs ID resolution |

## Phase C — Commands

| ID | Task | Status | Depends on | Spec |
|----|------|--------|------------|------|
| [T12](T12-cli-program.md) | `cli/index.ts` + `cli/ui.ts` | ✓ | — | Commander shell |
| [T13](T13-cmd-init.md) | `drev init` | ✓ | T05, T07, T08, T12 | §9.1 |
| [T14](T14-cmd-share.md) | `drev share` | ✓ | T03, T04, T05, T06, T07, T08, T09, T10, T11, T12 | §9.2 |
| [T15](T15-cmd-resume.md) | `drev resume` | ✓ | T02, T03, T05, T06, T08, T09, T11, T12 | §9.5 |
| [T16](T16-cmd-list.md) | `drev list` | ✓ | T06, T08, T12 | §9.4 |
| [T17](T17-cmd-backup.md) | `drev backup` | ✓ | T14 | §9.3 |
| [T18](T18-cmd-rename.md) | `drev rename` | ✓ | T05, T06, T08, T11, T12 | §9.6 |
| [T19](T19-cmd-search.md) | `drev search` | ✓ | T06, T08, T12 | §9.7 |
| [T20](T20-cmd-mark.md) | `drev mark` | ✓ | T05, T06, T08, T11, T12 | §9.8 |
| [T21](T21-cmd-sync.md) | `drev sync` | ✓ | T08, T10, T12 | §9.9 |
| [T22](T22-cmd-hooks.md) | `drev hooks` | ✓ | T07, T12 | §9.11 |
| [T23](T23-cmd-autoshare-sweep.md) | autoshare-sweep (internal) | ✓ | T07, T08, T09, T14 | §9.12, §10 |
| [T24](T24-cmd-scrub.md) | `drev scrub` | ✓ | T05, T08, T11, T12 | §9.10 |

## Phase D — Ship gates

| ID | Task | Status | Depends on | Notes |
|----|------|--------|------------|-------|
| [T25](T25-readme-quickstart.md) | README quickstart | ✓ | Phase C complete | §16 DoD |
| [T26](T26-integration-test.md) | E2E integration test | ✓ | T13, T14, T15 | §13.2, §16 DoD |
| [T27](T27-manual-cross-machine.md) | Manual cross-machine resume | ▶ | T26 | §13.3, §16 DoD |
| [T28](T28-publish.md) | `npm publish` to npm | ▶ | T25, T26 | §16 DoD |

## Workflow

1. Pick the first ☐ task whose dependencies are all ✓.
2. Mark it ▶ in this file.
3. Read its task file front to back.
4. Implement to its acceptance criteria.
5. `npm test`, `npm run typecheck`, `npm run build` all green.
6. Commit, push, mark ✓ here, move on.

## Phase gates

Don't skip these. Each gate is a checkpoint where we verify the assumption layer is sound before stacking on top.

- **Phase A → B:** all of T01-T05 are ✓; `experiment/rewrite.mjs` output matches what `core/path-rewriter.ts` produces.
- **Phase B → C:** all of T06-T11 are ✓; `core/` ≥80% line coverage.
- **Phase C → D:** all of T12-T24 are ✓; manual smoke test of init→share→list→resume passes.
- **Phase D → ship:** all of T25-T28 are ✓; demo video recorded; docs/MANUAL_TESTS.md and docs/REDACTION.md committed.
