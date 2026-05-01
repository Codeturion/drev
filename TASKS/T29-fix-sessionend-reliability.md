# T29: SessionEnd hook doesn't reliably fire

**Phase:** post-v0.1 backlog · **Severity:** high (auto-share is the headline UX, hooks are how it works)
**Architecture refs:** §10 (sweep called by hooks), §9.11 (hooks install)

## Symptom

After `drev hooks install`, the `~/.claude/settings.json` `SessionEnd` entry sometimes does not result in `drev autoshare-sweep` running. Sessions end (terminal closes, Claude Code exits) but no share happens, verified by checking that the session ID is not in `users/<self>/<date>-*` directories afterward.

`SessionStart` may also be unreliable; needs verification.

## Why this matters

If hooks don't fire, the entire auto-share UX is broken. The user thinks drev is enabled (they ran `drev init`) but nothing happens. Worse than opt-in because the failure is silent.

## Investigation

1. **What triggers `SessionEnd` in Claude Code?** Check Claude Code source / docs:
   - Does it fire when the terminal closes (SIGHUP)?
   - When the user runs `/exit`?
   - When the process exits normally?
   - When the IDE window closes?
2. **Does the hook reach execution?** Add instrumentation:
   - Have `drev autoshare-sweep` log a single "invoked at <timestamp>" entry on every call (regardless of mode/lock)
   - Compare invocations vs actual session-end events
3. **Are errors swallowed?** Sweep is intentionally silent (per §10). But if the hook command itself fails to launch (e.g., `drev` not on PATH at hook-time, shebang issues, npm-link symlink resolution), that error has nowhere to go. Capture stderr to a separate `~/.drev/logs/sweep-launch-errors.log` if possible.
4. **Permissions / approval gating?** Claude Code may require user approval for new hook commands the first time they run. Verify by inspecting `~/.claude/settings.json` for a `permissions.hooks` section or similar.

## Possible fixes (depending on root cause)

- **Hook command path:** ensure `drev` resolves at hook-time. Use absolute path in the hook entry instead of bare `drev`. The install routine could record the result of `which drev` / `where drev` and embed that absolute path.
- **Add `SessionStart` as belt-and-braces:** §10 already calls `SessionStart` "catches sessions that didn't end cleanly", if `SessionEnd` is unreliable on some platforms, `SessionStart` of the *next* session sweeps the previous one. Verify this works as designed.
- **Add a `SessionEnd`-equivalent fallback:** if Claude Code provides another lifecycle event (`Stop`, `OnExit`, etc.), wire that too. Belt-and-braces with `_drev: true` tags so uninstall stays clean.
- **Add an explicit "drev sweep" skill instruction:** the skill could tell Claude to run `drev autoshare-sweep` when the user says "I'm done", "wrapping up", "ending session", software belt for hardware suspenders.

## Acceptance

1. Document the root cause of unreliability (which lifecycle event fires when).
2. Make a hook-fired sweep observable: every hook invocation logs a single line to `~/.drev/logs/sweep-launch.log`, regardless of whether sweep proceeds or short-circuits.
3. After the fix, manual test: a session that ends in three different ways (Ctrl+D / `/exit` / window close) all result in a sweep within 60 seconds, OR are caught by the next SessionStart.

## Out of scope

- Replacing hooks with a daemon, too heavy for v0.x
- Rebuilding the auto-share trigger via filesystem watching of `~/.claude/projects/`: defer to v0.5+ if hooks remain unreliable after fixes
