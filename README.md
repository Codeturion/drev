# Drev

Share Claude Code sessions through a Git repo. Producer runs `drev share`, consumer runs `drev resume <name>`, native `claude --resume` continues with full transcript fidelity. v0. See [ARCHITECTURE.md](./ARCHITECTURE.md) and [docs/CORRECTIONS.md](./docs/CORRECTIONS.md).

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

```
$ drev init
Got a Drev repo URL from your team? (paste, or leave empty to create new):
Create private repo at fuat/drev-sessions? [Y/n] Y
✓ Drev initialized at /home/fuat/.drev/repos/drev-sessions
✓ Auto-share enabled. Hooks + skill installed.
```

Two questions:
1. *Got a Drev repo URL?* Paste (joining a teammate's repo) or hit Enter (creating your own).
2. If creating: *Create private repo at `<your-gh-user>/drev-sessions`?* `Y` accepts, `n` lets you pick a different `<owner>/<name>`.

### What `drev init` installs by default

- Claude Code hooks (`SessionStart`, `SessionEnd`) that trigger auto-share when sessions end
- A `drev` skill at `~/.claude/skills/drev/SKILL.md` so you can say *"save this session as foo"* inside Claude Code
- The current project on the auto-share whitelist (scope is per-project, not global)

```
drev init --no-auto-share                  # skip the install entirely
drev autoshare add /path/to/another/proj   # whitelist another project later
drev autoshare list                        # see what's whitelisted
drev hooks uninstall                       # remove hooks + skill any time
```

### Non-GitHub hosts (GitLab, Bitbucket, self-hosted)

Auto-create only knows GitHub. For other hosts, pre-create the repo on your host then init with the URL:

```
# GitLab
glab repo create team/drev-sessions --private
drev init https://gitlab.com/team/drev-sessions.git

# Bitbucket
drev init https://bitbucket.org/team/drev-sessions.git

# Self-hosted (Gitea / Forgejo / GitLab CE / etc.)
drev init https://git.company.internal/team/drev-sessions.git

# SSH form works too
drev init git@gitlab.com:team/drev-sessions.git
```

Everything after init (`share`, `resume`, `list`, `sync`, `autoshare-sweep`, …) is pure `git` and works against any remote.

## Share

```
drev share                          # most-recent session
drev share --name auth-refactor     # named
drev backup --name nightly          # private, purpose=backup
```
Drev redacts common secrets before pushing. Full list in [docs/REDACTION.md](./docs/REDACTION.md).

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

```
drev rename old-name new-name              # rename your share, preserves date prefix
drev mark <name-or-id> --private           # change visibility (--team / --private / --delete)
drev search "auth bug"                     # substring across name / title / summary / files
drev sync                                  # pull + drain offline outbox
drev scrub <name-or-id> --confirm          # rewrite history to remove a leak (force-pushes)
drev backup --name nightly                 # private backup of current session
```

All have `--help` for full options.

## License

MIT.
