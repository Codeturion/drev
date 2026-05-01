# T30: Drev commands must be non-interactive when invoked from the skill

**Phase:** post-v0.1 backlog · **Severity:** high (the skill flow hangs if a prompt fires)
**Architecture refs:** §8.4 (first-share confirmation), §9.1 / wizard prompts, §9.5 destination prompt

## Symptom

When Claude (inside a Claude Code session) invokes a `drev` command via Bash per the bundled skill, any interactive prompt blocks forever. Claude's Bash tool doesn't have a TTY-attached stdin; the `readline.question(...)` call hangs because no human is there to answer it.

Currently affected paths (anything that calls `ui.confirm` or `ui.prompt`):
- `drev share` first-share confirmation (§8.4): "Continue? [Y/n]"
- `drev init` wizard: "Got a Drev repo URL? …" / "Create private repo at <X>? [Y/n]" / "Enter '<owner>/<name>'"
- `drev resume` destination prompt — currently silent-defaulted, OK
- Any future prompts

## Required behavior

When stdin is **not a TTY** (`process.stdin.isTTY !== true`):
- `ui.confirm(prompt)` → return a sensible default without blocking. Default to `false` (safer: don't proceed with a destructive op without explicit consent), unless the caller passes `defaultIfNonInteractive: true`.
- `ui.prompt(message)` → return empty string immediately, OR throw a `RepoError` with a hint to pass the equivalent CLI flag.
- `drev share`: skip the first-share confirmation, just share. Print the redaction summary as info, not a prompt.
- `drev init` wizard: detect non-TTY at the top, refuse to enter wizard mode with a clear error: "drev init wizard requires an interactive terminal. Pass a URL, an owner/name shorthand, or --local."

## Implementation sketch

1. Add `isInteractive(): boolean` helper to `cli/ui.ts` — returns `process.stdin.isTTY === true && process.stdout.isTTY === true`.
2. Modify `ui.confirm` and `ui.prompt` to short-circuit when `!isInteractive()`.
3. In `executeShare`, gate the first-share confirmation on `isInteractive()`. When non-interactive AND it would have prompted, log the redaction summary as info and proceed (or honor a future `--no-confirm` flag).
4. In `init.ts` wizard, fail fast with a clear error at the top of `runWizard()` if `!isInteractive()`.
5. Add an `--auto` flag to `drev share` (and equivalents) for explicit non-interactive consent — useful in scripts even when stdin IS a TTY.

## Acceptance

- A session that does `echo '' | drev share` succeeds without hanging.
- A session that does `drev init` with stdin redirected fails immediately with a clear error mentioning the alternative arg forms.
- The bundled skill flow (Claude → Bash → `drev share`) completes without blocking, regardless of whether it's a first-share to that repo.
- Tests added for: `confirm` non-TTY default, `prompt` non-TTY behavior, share's non-interactive first-share path, init wizard's non-TTY refusal.

## Out of scope

- Making the auto-share-sweep handle prompts — sweep is already non-interactive by design (§10 silent operation guarantee).
- Detecting "is this Claude's Bash tool" specifically — TTY detection is the right abstraction.

## Related

- T29 (SessionEnd reliability) — independent issue but both are about the auto-share/skill UX surface.
