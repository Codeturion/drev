# Drev

Share Claude Code sessions through a Git repo. Producer runs `drev share`, consumer runs `drev resume <name>`, native `claude --resume` continues with full transcript fidelity. v0 — see [ARCHITECTURE.md](./ARCHITECTURE.md) and [docs/CORRECTIONS.md](./docs/CORRECTIONS.md).

## Install

```
npm install -g drev
```
Requires Node ≥20 and `git`. The wizard uses [`gh` CLI](https://cli.github.com); `--local` skips it.

## First setup

```
drev init                           # wizard: walks you through it
drev init <git-url>                 # bring your own repo
drev init <owner>/<name>            # github shorthand: clone if exists, else create private
drev init --local [--at <path>]    # local bare repo, no GitHub
drev init <anything> --reinit       # repoint an existing setup
```

### Wizard

Two questions:
1. *Got a Drev repo URL from your team?* — paste (joining) or hit Enter (creating).
2. If creating: *Create private repo at `<your-gh-user>/drev-sessions`?* — `Y` accepts, `n` picks a different `<owner>/<name>`.

### What `drev init` installs by default

- Claude Code hooks (`SessionStart`, `SessionEnd`) — trigger auto-share when sessions end
- A `drev` skill at `~/.claude/skills/drev/SKILL.md` — lets you say *"save this session as foo"* inside Claude Code
- The current project on the auto-share whitelist — scope is per-project, not global

Skip the install with `drev init --no-auto-share`. Add other projects later with `drev autoshare add`.

### Non-GitHub hosts (GitLab, Bitbucket, self-hosted)

Auto-create only knows GitHub (via `gh`). For other hosts: pre-create the repo on your host's UI/CLI, then `drev init <full-git-url>`. Every other command (`share`, `resume`, `list`, `sync`, `autoshare-sweep`, …) is pure `git` and works against any remote.

## Share

```
drev share                          # most-recent session
drev share --name auth-refactor     # named
drev backup --name nightly          # private, purpose=backup
```
Drev redacts common secrets before pushing — full list in [docs/REDACTION.md](./docs/REDACTION.md).

## Resume

```
drev list                           # what's available
drev resume <name-or-id>            # rewrites paths, places file, spawns Claude Code
drev resume <name> --into /path     # explicit destination
drev resume <name> --no-launch      # prepare without spawning
```

## Auto-share

```
drev autoshare add | remove [path]   # toggle a project on/off the whitelist
drev autoshare on | private | off    # mode: auto-team / auto-private / manual
drev autoshare list | status         # what's enabled
drev hooks install | uninstall       # arm or remove the Claude Code triggers
```

Inside Claude Code, the bundled skill routes "save this session as foo" to `drev share` automatically.

## Other commands

`drev rename`, `drev mark`, `drev search`, `drev sync`, `drev scrub`. All have `--help`.

## License

MIT.
