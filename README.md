<p align="center">
  <img src="./drev_logo.png" alt="Drev: save × share × resume" width="600" />
</p>

# Drev

**Drev makes Claude Code sessions durable.** When you hand work off today, your code and a Slack thread survive. The actual Claude Code session where you tried, failed, and eventually figured it out dies with the terminal. Drev moves that session to a Git repo your team controls. Teammates resume where you left off with every tool call intact. Solo, your sessions become a personal memory across machines and projects.

The bundled Claude Code skill makes the flow feel native: just say *"save this session as foo"* and Claude runs `drev share` for you. Native `claude --resume` continues the receiver's session with full transcript fidelity.

| Today's handoff | With drev |
|---|---|
| Slack thread summarizing what you tried | Full Claude Code transcript |
| Commit messages reconstructing the path | Every tool call, every read, every edit |
| Loom video (sometimes) | Interactive: the receiver can continue, ask Claude to elaborate, or take a different path |
| Lost when the engineer logs off | Persists in your team's Git repo |

> v0. See [ARCHITECTURE.md](./ARCHITECTURE.md) and [docs/CORRECTIONS.md](./docs/CORRECTIONS.md). License: MIT.

## <img src="./assets/icons/demo.png" alt="" width="40" align="absmiddle"> Demo

<p align="center">
  <img src="./demo.gif" alt="Drev demo: producer shares a session, consumer resumes on a different machine" width="800" />
</p>

*Engineer A finishes a debugging session in Claude Code and says "save this as auth-fix". Engineer B, on a different machine and a different OS, runs `drev resume auth-fix`. Claude Code opens with the full transcript loaded, every path rewritten to B's machine.*

## <img src="./assets/icons/quick-start.png" alt="" width="40" align="absmiddle"> Quick start

```bash
npm install -g drev
drev init
```

What you'll see:

```
$ drev init
Got a Drev repo URL from your team? (paste, or leave empty to create new):
Create private repo at fuat/drev-sessions? [Y/n] Y
✓ Cloning https://github.com/fuat/drev-sessions.git ...
✓ Drev initialized at /home/fuat/.drev/repos/drev-sessions.
✓ Auto-share enabled. Hooks + skill installed.
✓ Added /home/fuat/work/inventory-app to auto-share whitelist.
```

Two questions, accept the defaults, you're done. You now have a private GitHub repo for sessions, hooks installed for auto-share, the bundled skill so Claude Code understands `drev`, and the current project on the auto-share whitelist.

Requires Node ≥20, `git`, and the [`gh` CLI](https://cli.github.com) (the wizard uses it). For non-GitHub hosts or offline use, see [Reference](#reference).

## <img src="./assets/icons/example.png" alt="" width="40" align="absmiddle"> Example: a session end-to-end

You finish a debugging session in `~/work/inventory-app`. Inside Claude Code, you say:

> save this session as inventory-sync-fix

Claude runs `drev share --name inventory-sync-fix` for you. Drev redacts secrets, writes the session into your team repo at `users/fuat/2026-05-01-inventory-sync-fix/`, and pushes to GitHub.

Next morning, your teammate picks it up. From their machine, in their copy of the project:

```bash
cd ~/code/inventory-app
drev resume inventory-sync-fix
```

Drev pulls the latest, rewrites every path from your machine to theirs (including the OS conventions if you're on different platforms), places the JSONL at `~/.claude/projects/<encoded>/<id>.jsonl`, and spawns `claude --resume <id>`. Claude Code opens with the full transcript loaded.

If you forgot to ask Claude to share, the `SessionEnd` hook would have shared automatically when you closed your session. Either way the receiver flow is identical.

## <img src="./assets/icons/inside-claude-code.png" alt="" width="40" align="absmiddle"> Use it inside Claude Code

The bundled skill teaches Claude to recognize what you mean, so you talk to it naturally:

| You say | Claude runs |
|---|---|
| *"save this session as auth-fix"* | `drev share --name auth-fix` |
| *"what sessions are available?"* | `drev list` |
| *"search for auth bug"* | `drev search "auth bug"` |
| *"mark the foo one private"* | `drev mark foo --private` |

Sharing, listing, searching, renaming, marking, scrubbing all run inside the active session. **Resume is the exception:** it has to spawn a fresh `claude --resume` as a subprocess that takes over the terminal, and Claude's Bash tool doesn't have an interactive TTY to hand over. To resume someone else's session, open a new terminal and run `drev resume <name>` there.

## <img src="./assets/icons/from-terminal.png" alt="" width="40" align="absmiddle"> Use it from the terminal

```bash
drev share --name auth-fix          # share the most recent session
drev list                           # see what's available
drev resume auth-fix                # rewrites paths, places file, spawns Claude Code
```

Drev redacts common secrets (Anthropic, OpenAI, GitHub, AWS, Slack, JWTs, private keys, …) before pushing. Full list in [docs/REDACTION.md](./docs/REDACTION.md). For accidents that slip through, `drev scrub <name> --confirm` rewrites history.

## <img src="./assets/icons/auto-share.png" alt="" width="40" align="absmiddle"> Auto-share

After `drev init`, sessions whose project is on the whitelist auto-share when they end. The `SessionEnd` hook in `~/.claude/settings.json` fires `drev autoshare-sweep`, which walks `~/.claude/projects/`, picks up anything new in a whitelisted project, and shares it with `visibility: team` by default.

```bash
drev autoshare add                  # whitelist the current project
drev autoshare list                 # show whitelist + current mode
drev autoshare on | private | off   # team / private / disable
drev hooks uninstall                # remove triggers (skill stays)
```

The current project is whitelisted automatically by `drev init`. Other projects on the same machine don't auto-share until you opt them in. To skip the whole install, run `drev init --no-auto-share`.

> **Heads up:** the `SessionEnd` hook isn't always reliable across Claude Code versions and exit paths. Treat auto-share as best-effort. **For sessions you definitely want shared, ask Claude to share explicitly during the conversation** ("save this session as foo"). The skill route runs `drev share` synchronously and you see it succeed before you close the session. Hook reliability is tracked as a known issue in [`TASKS/T29-fix-sessionend-reliability.md`](./TASKS/T29-fix-sessionend-reliability.md).

---

## <img src="./assets/icons/reference.png" alt="" width="40" align="absmiddle"> Reference

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

## <img src="./assets/icons/how-built.png" alt="" width="40" align="absmiddle"> How this was built

Drev v0 was built in a single working session by one engineer using Claude Code as orchestrator with parallel sub-agents as the workforce. 30 narrowly-scoped tasks across 4 phases, up to 10 agents in parallel at peak, 572 passing tests, 96% line coverage on `core/`, bidirectional cross-OS validation. Build narrative, dispatch pattern, and the four architectural corrections caught by real-world testing: [docs/HOW_THIS_WAS_BUILT.md](./docs/HOW_THIS_WAS_BUILT.md).

## <img src="./assets/icons/license.png" alt="" width="40" align="absmiddle"> License

MIT.
