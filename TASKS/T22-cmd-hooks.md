# T22: drev hooks

**Phase:** C · **Depends on:** T07, T12
**Architecture refs:** §9.11 (full), §3.9 (opt-in)

## Scope

Implement `drev hooks <subcommand>` per §9.11 — manage the Claude Code hooks that trigger auto-share.

### Subcommands

- `install` — add Drev's `SessionEnd` and `SessionStart` hooks to `~/.claude/settings.json`. Tag entries with a marker (e.g., `_drev: true` or a magic comment) for clean uninstall. Preserve all other settings.
- `uninstall` — remove only Drev-tagged hook entries
- `status` — print whether hooks are installed, current `auto_share` mode, and last sweep time (from `~/.drev/logs/autoshare.log`)

### Hook entries to install

Each hook calls `drev autoshare-sweep` (T23) silently. Per §10:
- `SessionEnd` — runs after a session ends
- `SessionStart` — runs when a new session starts (catches sessions that didn't end cleanly)

## Files

- `src/cli/commands/hooks.ts`
- `src/cli/commands/hooks.test.ts`

## Acceptance

- Install on a settings.json with existing hooks does not lose them
- Uninstall removes only Drev-tagged entries; other entries remain
- Reinstall is idempotent (no duplicates)
- Status accurately reflects install state
- Tests use a temp settings.json fixture; do not touch the user's real `~/.claude/settings.json`

## Out of scope

- Auto-install on `drev init` — explicitly opt-in per §3.9
- Hooks for events beyond SessionEnd / SessionStart — out of v0
- Cross-tool hooks (Cursor, etc.) — v1.0
