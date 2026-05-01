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
Wizard: paste a teammate's URL (joiner) or hit Enter to create your own. Confirm `<your-gh-user>/drev-sessions` private with Y, or `n` to pick a different `<owner>/<name>`.

By default `drev init` installs Claude Code hooks + a `drev` skill and whitelists the current project for auto-share. Only whitelisted projects auto-share — scope is per-project, not global. `--no-auto-share` skips it entirely.

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

## Developing on drev itself

After `git pull`, run `npm install` so the `prepare` script rebuilds `dist/`. Without that, `npm link`'d `drev` stays on stale compiled code.

## License

MIT.
