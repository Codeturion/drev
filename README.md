<p align="center">
  <img src="./drev_logo.png" alt="Drev: save × share × resume" width="600" />
</p>

# Drev

[![npm Version](https://img.shields.io/npm/v/@codeturion/drev.svg)](https://www.npmjs.com/package/@codeturion/drev)
[![npm Downloads](https://img.shields.io/npm/dm/@codeturion/drev.svg)](https://www.npmjs.com/package/@codeturion/drev)
[![Build Status](https://github.com/Codeturion/drev/actions/workflows/publish.yml/badge.svg?event=push)](https://github.com/Codeturion/drev/actions/workflows/publish.yml)
[![GitHub Stars](https://img.shields.io/github/stars/Codeturion/drev)](https://github.com/Codeturion/drev)
[![GitHub Last Commit](https://img.shields.io/github/last-commit/Codeturion/drev)](https://github.com/Codeturion/drev)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20+-blue.svg)](https://nodejs.org)

**Drev makes Claude Code sessions portable: share one with a friend or teammate, or resume it yourself on any machine, Mac or PC.**

You finish a long debugging session and hand the work to a teammate. Your colleague leaves on vacation mid-feature and someone has to pick it up. You started something on your work PC and want to keep going from your laptop at home. In all three cases, today the actual Claude Code conversation, every step, every dead end, every "ah, that's why", dies the moment the terminal closes. The next person starts from scratch, even if that next person is *you*.

Drev keeps the conversation alive. The session moves with the work, not the machine.

The bundled Claude Code skill makes the flow feel native: just say *"save this session as foo"* and Claude runs `drev share` for you. Native `claude --resume` continues the receiver's session with full transcript fidelity.

| Today's handoff | With drev |
|---|---|
| Slack thread summarizing what you tried | Full Claude Code transcript |
| Commit messages reconstructing the path | Every tool call, every read, every edit |
| Loom video (sometimes) | Interactive: the receiver can continue, ask Claude to elaborate, or take a different path |
| Lost when the engineer logs off | Persists in your team's Git repo |

> v0. See [ARCHITECTURE.md](./ARCHITECTURE.md) and [docs/CORRECTIONS.md](./docs/CORRECTIONS.md). License: MIT.

## <img src="./assets/icons/demo.png" alt="" width="40" align="absmiddle"> Demo

> 🚧 **Demo recording in progress.** A gif of the cross-machine handoff flow is being prepared. Until then, the scene below describes what you'll see.

*Engineer A finishes a debugging session in Claude Code and says "save this as auth-fix". Engineer B, on a different machine and a different OS, runs `drev resume auth-fix`. Claude Code opens with the full transcript loaded, every path rewritten to B's machine.*

## <img src="./assets/icons/quick-start.png" alt="" width="40" align="absmiddle"> Quick start

```bash
npm install -g @codeturion/drev
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
| `drev share [--name N] [--auto]` | share the most recent session (`--auto` skips prompts; non-TTY contexts auto-detect) |
| `drev backup --name N` | private backup of the most recent session |
| `drev list [filters]` | browse available sessions (filters: `--mine`, `--team`, `--days N`, `--user X`, …) |
| `drev resume <name-or-id> [--force] [--checkout]` | pull, rewrite paths, and resume a shared session |
| `drev export <name-or-id> [--out <path>]` | render a shared session as a self-contained HTML transcript |
| `drev rename <old> <new>` | rename your share (date prefix preserved) |
| `drev mark <X> --private` | change visibility (also `--team`, `--delete`) |
| `drev search <query>` | substring across name, title, summary, files-touched |
| `drev sync` | pull + drain the offline outbox |
| `drev scrub <X> --confirm` | rewrite history to remove a leak (requires `git-filter-repo`) |
| `drev hooks install \| uninstall` | manage Claude Code triggers |
| `drev autoshare add \| remove \| list \| status \| on \| private \| off` | manage the per-project whitelist and mode |

#### `drev resume` flags

When the working tree on the receiver's machine has drifted from the commit recorded with the session (`commit_sha` in `meta.yaml`), file paths and line numbers in the transcript can point at code that has moved or been rewritten. Two flags handle this:

- `--checkout` runs `git checkout <commit_sha>` on the destination repo so the tree matches what the sender saw. A dirty working tree is auto-stashed first; drev prints `git checkout - && git stash pop` so you can recover when you're done.
- `--force` overwrites an existing local session JSONL without prompting (useful when re-resuming after a remote update).

#### `drev export` (HTML transcripts)

For reviewers who don't have Claude Code installed (PMs, designers, leads), render a session as a static HTML file:

```bash
drev export auth-fix                       # writes <repo>/transcripts/auth-fix.html
drev export auth-fix --out ~/share/x.html  # custom path
```

The output is self-contained: inlined CSS, no JS, no external dependencies. Tool calls and thinking blocks are collapsed via native `<details>` so the prose reads cleanly; click to expand. Open the file in any browser, attach it to a ticket, drop it on a wiki, or commit it back to the sessions repo if your team wants shareable URLs in git history. Drev does not pick a hosting policy, where the transcripts go is up to you.

#### `--auto` and non-interactive contexts

`drev share` and `drev init` detect non-TTY stdin (Claude's Bash tool, scripts, CI) automatically and skip prompts that would hang. Pass `--auto` to `drev share` to force this behavior even on a real TTY, useful in shell scripts that wrap drev. The first-share redaction summary still prints as info so you see what was scrubbed.

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

## <img src="./assets/icons/license.png" alt="" width="40" align="absmiddle"> License

MIT.
