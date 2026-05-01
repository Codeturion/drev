# Drev

Share Claude Code sessions through a Git repo. The producer runs `drev share`, the consumer runs `drev resume`, and native `claude --resume` continues with full transcript fidelity. Built around a bundled Claude Code skill so you don't have to leave the conversation.

> v0. See [ARCHITECTURE.md](./ARCHITECTURE.md) and [docs/CORRECTIONS.md](./docs/CORRECTIONS.md). License: MIT.

## Quick start

```bash
npm install -g drev
drev init
```

The wizard asks two questions; accept the defaults and you're done. drev creates a private repo at `<your-gh-user>/drev-sessions`, installs Claude Code hooks for auto-share, and drops a skill at `~/.claude/skills/drev/SKILL.md`.

Requires Node ≥20, `git`, and the [`gh` CLI](https://cli.github.com) (the wizard uses it). For non-GitHub hosts or offline use, see [Reference](#reference).

## Use it inside Claude Code

The bundled skill teaches Claude to recognize what you mean, so you talk to it naturally:

| You say | Claude runs |
|---|---|
| *"save this session as auth-fix"* | `drev share --name auth-fix` |
| *"what sessions are available?"* | `drev list` |
| *"resume the auth-fix one"* | `drev resume auth-fix` |

No commands to memorize. No new terminal.

## Use it from the terminal

```bash
drev share --name auth-fix          # share the most recent session
drev list                           # see what's available
drev resume auth-fix                # rewrites paths, places file, spawns Claude Code
```

Drev redacts common secrets (Anthropic, OpenAI, GitHub, AWS, Slack, JWTs, private keys, …) before pushing. Full list in [docs/REDACTION.md](./docs/REDACTION.md). For accidents that slip through, `drev scrub <name> --confirm` rewrites history.

## Auto-share

After `drev init`, sessions whose project is on the whitelist auto-share when they end. The `SessionEnd` hook in `~/.claude/settings.json` fires `drev autoshare-sweep`, which walks `~/.claude/projects/`, picks up anything new in a whitelisted project, and shares it with `visibility: team` by default.

```bash
drev autoshare add                  # whitelist the current project
drev autoshare list                 # show whitelist + current mode
drev autoshare on | private | off   # team / private / disable
drev hooks uninstall                # remove triggers (skill stays)
```

The current project is whitelisted automatically by `drev init`. Other projects on the same machine don't auto-share until you opt them in. To skip the whole install, run `drev init --no-auto-share`.

---

## Reference

### All `drev init` forms

```bash
drev init                                # wizard (default)
drev init <git-url>                      # bring your own repo
drev init <owner>/<name>                 # github shorthand: clone if exists, else create private
drev init --local [--at <path>]          # local bare repo, no GitHub
drev init <anything> --reinit            # repoint an existing setup or reuse a clone
drev init --no-auto-share <X>            # skip hooks, skill, and whitelist install
```

The wizard sequence:

```
$ drev init
Got a Drev repo URL from your team? (paste, or leave empty to create new):
Create private repo at fuat/drev-sessions? [Y/n] Y
✓ Drev initialized at /home/fuat/.drev/repos/drev-sessions
✓ Auto-share enabled. Hooks + skill installed.
```

### All commands

Each command supports `--help` for the full option list.

| Command | Purpose |
|---|---|
| `drev init` | one-time setup |
| `drev share [--name N]` | share the most recent session |
| `drev backup --name N` | private backup of the most recent session |
| `drev list [filters]` | browse available sessions (filters: `--mine`, `--team`, `--days N`, `--user X`, …) |
| `drev resume <name-or-id>` | pull, rewrite paths, and resume a shared session |
| `drev rename <old> <new>` | rename your share (date prefix preserved) |
| `drev mark <X> --private` | change visibility (also `--team`, `--delete`) |
| `drev search <query>` | substring across name, title, summary, files-touched |
| `drev sync` | pull + drain the offline outbox |
| `drev scrub <X> --confirm` | rewrite history to remove a leak (requires `git-filter-repo`) |
| `drev hooks install \| uninstall` | manage Claude Code triggers |
| `drev autoshare add \| remove \| list \| status \| on \| private \| off` | manage the per-project whitelist and mode |

### Non-GitHub hosts (GitLab, Bitbucket, self-hosted)

Auto-create only knows GitHub. For other hosts, pre-create the repo on the host's UI or CLI, then init with the URL:

```bash
# GitLab
glab repo create team/sessions --private
drev init https://gitlab.com/team/sessions.git

# Bitbucket
drev init https://bitbucket.org/team/sessions.git

# Self-hosted (Gitea, Forgejo, GitLab CE, …)
drev init https://git.company.internal/team/sessions.git

# SSH form works too
drev init git@gitlab.com:team/sessions.git
```

Every command after init is pure `git` and works against any remote.

### Multi-account setup (one machine, two GitHub identities)

If your machine has two GitHub accounts (e.g. work and personal) and only one has access to your Drev repo: see [docs/SETUP_MULTI_ACCOUNT.md](./docs/SETUP_MULTI_ACCOUNT.md). The recommended path is an SSH host alias so the two accounts stay fully isolated.

---

## How this was built

Drev v0 was built in a single working session by one engineer using Claude Code as orchestrator with parallel sub-agents as the workforce. 30 narrowly-scoped tasks across 4 phases, up to 10 agents in parallel at peak, 572 passing tests, 96% line coverage on `core/`, bidirectional cross-OS validation. Build narrative, dispatch pattern, and the four architectural corrections caught by real-world testing: [docs/HOW_THIS_WAS_BUILT.md](./docs/HOW_THIS_WAS_BUILT.md).

## License

MIT.
