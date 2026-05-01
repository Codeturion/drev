# How drev was built

Drev is a working CLI plus a deliberate experiment in **how to ship a multi-component product with Claude Code as the orchestrator and parallel sub-agents as the workforce.** This document is the build narrative: what was attempted, what worked, what failed, and what the receipts look like in the repo.

If you're at Anthropic and reading this as evaluation material, the short answer: one engineer + Claude Code + a disciplined wave-based dispatch pattern shipped a feature-complete CLI with 572 passing tests, 96% line coverage on `core/`, and verified bidirectional cross-OS behavior in a single working session.

## What was actually built

Drev is a TypeScript CLI plus optional MCP-style integration that lets engineers share Claude Code sessions through a Git repo. Producer runs `drev share`, consumer runs `drev resume`, native `claude --resume` continues with full transcript fidelity. The load-bearing technical pieces are path rewriting (sessions reference absolute paths that don't exist on the receiver) and secret redaction (sessions contain real-world credentials).

Numbers, all from the repo:

| Metric | Value |
|---|---|
| Source files | ~50 across `src/cli/`, `src/core/`, `src/lib/` |
| Tests | 572 across 28 files |
| `core/` line coverage | 96.11% |
| Commands shipped | 13 (`init`, `share`, `resume`, `list`, `rename`, `mark`, `search`, `sync`, `scrub`, `hooks`, `autoshare`, `backup`, `autoshare-sweep`) |
| Commits on main | 34 |
| Cross-OS validated | Windows ↔ macOS, both directions |
| Architectural corrections caught by real-world testing | 4, see [`CORRECTIONS.md`](CORRECTIONS.md) |

## The orchestration pattern

The interesting part isn't what got built, it's the dispatch pattern. The architecture document ([`ARCHITECTURE.md`](../ARCHITECTURE.md)) was written first as an immutable spec. Then the work was decomposed into 30 narrowly-scoped tasks, indexed in [`TASKS/README.md`](../TASKS/README.md), grouped into 4 phases with explicit gates between them ([`docs/v0-plan.md`](v0-plan.md)).

Each phase ran as a sequence of waves. A wave dispatches N agents in parallel, each on a single task with a hard scope boundary (typically: "modify only these two files; do not touch anything else"). The orchestrator (Claude Code in the main session) waits for all agents to report, runs verification on the shared tree (typecheck, full test suite, scope diff), then commits and moves to the next wave.

Concretely:

| Phase | Tasks | Waves | Peak parallelism |
|---|---|---|---|
| A: Foundations (`lib/`, `core/path-rewriter`, `core/redaction`, `core/git-ops`, `core/claude-paths`) | 5 | 2 | 4 agents in Wave 2 |
| B: Stateful modules (`metadata`, `config`, `repo`, `session`, `outbox`, `name-resolver`) | 6 | 3 | 3 agents in Wave 1 |
| C: CLI commands (the 13 commands) | 13 | 3 | **10 agents in Wave 2** |
| D: Ship gates (README, integration test, cross-machine validation, npm publish prep) | 4 | mixed | 2 agents (test in parallel with docs writing) |

You can see the wave boundaries in the git log. Examples:

- `27f45cf T06,T07,T09: Phase B Wave 1 (metadata, config, session)` — three agents, one commit
- `ae30aa1 T13-T16,T18-T22,T24: Phase C Wave 2 (10 commands in parallel)` — ten agents, one commit
- `381318d T17,T23: Phase C Wave 3 (backup, autoshare-sweep)` — two agents that depended on T14's `executeShare` helper, ran together once T14 was done

Each commit message names which tasks landed and what dependency gate had to clear first.

## Why the dispatch had to be disciplined

The naive pattern (just spawn agents on whatever) doesn't work past about three concurrent agents. Specific failure modes the wave structure prevents:

1. **Consumer overlap**: two agents both modifying `cli/index.ts` produce conflicting diffs. The wave structure pre-identifies all files each agent will touch, including consumers, and runs sequential when there's overlap.
2. **Stale worktree state**: agents start from the working tree at dispatch time. If T05 commits a new file at minute 10 and T08 was dispatched at minute 5 expecting that file, T08's view is stale. Solution: T08 lands in a later wave than T05.
3. **Agent confabulation**: agents claim work they didn't do, or do work outside their scope. Defense: every wave commit is preceded by a `git diff --stat` check that the agent's scope is clean (no out-of-scope files modified) plus a full `npm test` from the orchestrator, not the agent.

The orchestration prompt for each agent always specified:

- Hard scope: the exact file paths the agent may write to
- Required reading: which `ARCHITECTURE.md` sections, which `CORRECTIONS.md` overrides, which sibling modules to consult
- Acceptance criteria: tests that must pass before the agent reports done
- Verification step: agent must run `npm run typecheck` and the relevant test files itself, not just claim they pass

The orchestrator then re-runs verification on its own. About 10% of the time, an agent's "all green" claim didn't survive the orchestrator's re-check, and the agent had to be re-dispatched with the failure pasted into its prompt.

## What real-world testing caught that the architecture missed

The architecture spec was built up-front and locked. Three of its claims turned out to be wrong, and a fourth scenario was completely undocumented. All four are recorded in [`docs/CORRECTIONS.md`](CORRECTIONS.md):

1. **§7.4 case 3** said Claude Code uses forward slashes internally on Windows. Verified false: 134 backslash occurrences vs 0 forward-slash occurrences in a real session JSONL on Windows. The path rewriter would have produced no replacements and silently broken every cross-machine resume.
2. **§3.9** said auto-share must be opt-in to avoid eroding trust. Product feedback flipped this: opt-in by default kills adoption because the friction (open a new terminal, run `drev share`) is too high. The opt-in ergonomics got rebuilt around per-project whitelist scoping, so the default isn't "share everything from this machine".
3. **Subagent JSONLs**: Claude Code writes `<session-id>/subagents/agent-*.jsonl` siblings for delegated work. The spec assumed `<session-id>.jsonl` was the only artifact. Sharing without subagents broke transcript fidelity for any session that used parallel agents (i.e., this very project).
4. **Thinking-block signatures** (caught only on the cross-OS test): Anthropic's API validates `signature` fields on thinking blocks against the API key that produced them. Cross-account resume rejected with HTTP 400. The first fix attempt (`7a3775d`) was wrong (stripped just the signature, API requires it to be present whenever a thinking block exists, returned `Field required`). The second fix (`e1674a7`) drops the entire thinking block, which the API accepts and which preserves all conceptual context via the surrounding text blocks.

These are the kind of bugs that only surface when real users actually use the thing. The cross-OS manual test ([`docs/MANUAL_TESTS.md`](MANUAL_TESTS.md) Test 2) caught them. The integration test couldn't have, because it was running pure-`core/` composition without spawning real `claude --resume`.

## What didn't work the first time

Honest list of things I had to redo or course-correct:

- **First share command's first-share confirmation prompt** hangs when stdin isn't a TTY (which is how Claude's Bash tool runs CLI commands inside an active session). Logged as `T30` in the post-v0.1 backlog. Fix is simple, hadn't shipped yet at this writing.
- **`drev init --reinit`** initially failed when the local clone path already existed, because the reinit guard only cleared the user-config check, not the on-disk path collision. Fixed in `90f1f07`.
- **Stale `dist/` after `git pull`** burned about 30 minutes of bug-hunting on the cross-OS test. The fix in source code didn't reach the running binary because `dist/` wasn't rebuilt after pulling. Solved by adding a `prepare` script to `package.json` so `npm install` (and `npm link`) automatically rebuild.
- **Whitelist path-normalization inconsistency** stored some entries with backslashes (Windows native) and others with forward slashes (because bash cwd produced `/`-form paths). Functional via case-insensitive normalize-and-compare in the matcher, but cosmetically gross. Fixed in `2e739f9` to apply `path.normalize()` on persist.
- **My first composition test** (a programmatic share→resume integration test that ran modules without going through the CLI) was abandoned mid-write when it caught a bug in *my own assertion* (looking for backslash-form path in JSON-double-escaped JSONL bytes). The actual modules were fine. The test was a useful diagnostic that proved Phase A+B compose correctly, but the maintenance overhead wasn't worth it given the proper integration test (`tests/integration/share-resume.test.ts`) was already shipped in T26.

## Bidirectional cross-OS validation

The cross-OS work was the moment of truth. Captured a real Claude Code session on Windows (216 turns, 467 KB), shared via drev, resumed on macOS. Verified Claude on the Mac side recalled session content correctly AND that file paths in tool calls were valid POSIX paths (not Windows backslashes that would have errored).

Then ran it the reverse direction (Mac producer, Windows consumer). Both directions passed. The path-rewriter's separator-translation pass handles both `\` → `/` (escaped form `\\` in JSONL becomes single `/`) and `/` → `\` (single `/` becomes escaped `\\`).

Run records are in [`docs/MANUAL_TESTS.md`](MANUAL_TESTS.md). Setup recipe (because the Mac was logged into a different GitHub account from the producer, and we wanted no interference with that user's other repos) is in [`docs/SETUP_MULTI_ACCOUNT.md`](SETUP_MULTI_ACCOUNT.md).

## What's not v0

The post-v0 backlog is two issues from real-world testing, both flagged in [`TASKS/README.md`](../TASKS/README.md):

- `T29 SessionEnd hook reliability`: the hook doesn't always fire, so the auto-share sweep can miss sessions. Needs instrumentation + likely the absolute-path-in-hook fix.
- `T30 non-interactive from skill`: `drev share` and `drev init` wizard hang when invoked from Claude Code's Bash tool because stdin isn't a TTY. Needs `process.stdin.isTTY` detection in `ui.confirm` / `ui.prompt`.

Both are deliberately scoped to v0.1.x rather than blocking v0.1.0, because the workarounds (use `drev hooks install` after init; use `drev share --name <slug>` to skip the prompt) are obvious.

## Try it

```bash
git clone https://github.com/Codeturion/drev.git
cd drev
npm install
npm test          # 572 passing
npm run build
npm link          # makes `drev` global
drev --help       # 11 commands
```

To see the orchestration in action, the most informative reads are:

- `git log --oneline` for the wave-named commit history
- `TASKS/README.md` for the task index
- `docs/v0-plan.md` for the phase/wave/gate strategy
- `docs/CORRECTIONS.md` for what got caught after the spec was locked

## A note on the scope of what's claimed

This was built in a single working session, by one engineer, using Claude Code Opus 4.7 (1M context) as orchestrator with parallel sub-agents (general-purpose Sonnet) as the workforce. No team, no prior drev codebase, no incremental ship-and-iterate over weeks. The architecture spec was the input; the working CLI plus tests plus docs plus cross-OS validation was the output.

The pattern is reproducible. The orchestrator's job is to write narrow scope-bounded prompts, identify which work parallelizes safely, run verification independent of the agents' self-reports, and gate phases on real evidence (compile + test + manual verification). The agents do the actual code writing inside their scope. The discipline isn't the AI part, it's the orchestration part: knowing when to parallelize, when not to, and what verification is actually trustworthy.
