# Corrections to ARCHITECTURE.md

Findings discovered during the §14.1 mandatory experiment (2026-05-01) that override or extend the architecture document. Apply these when implementing the affected modules.

## 1. §7.4 case 3 is wrong on Windows

**ARCHITECTURE.md says:** "Claude Code uses forward slashes internally even on Windows. Normalize all paths to forward slashes before rewriting."

**This is false.** Verified on Claude Code v2.1.104 / Windows 11 against a real session JSONL:

| Path form | Occurrences in source JSONL |
|---|---|
| JSON-escaped backslash (`F:\\Unity Projects\\...`) | **134** |
| Forward-slash (`F:/Unity Projects/...`) | **0** |

The `cwd` field, every `file_path` in tool calls, and embedded paths in tool results all use **native backslashes**, encoded as `\\` in JSON.

**Implication for `core/path-rewriter.ts`:** the rewriter must NOT normalize separators. If it converts source to `/` before substring matching, no replacement happens and the resumed session is broken.

**Rule:** preserve the source path's native separator style. For cross-platform sharing (Windows producer → POSIX consumer or vice versa), separator translation is a separate, explicit pass — not bundled into normalization.

**Reference:** `experiment/rewrite.mjs` is the working implementation that proved this. The `claude --resume` test passed end-to-end with native separators preserved.

**Update (v0.1.x):** Cross-OS separator translation is now implemented in `core/path-rewriter.ts`. When source and destination separator styles differ, the rewriter translates mid-path separators after replacing the prefix. Same-OS rewrites are unaffected.

## 2. Subagent JSONLs are unhandled by ARCHITECTURE.md

Many session directories contain sibling files at `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-*.jsonl`. These are real work product (delegated tasks, parallel agents). The architecture document treats `<session-id>.jsonl` as the only artifact, but that loses subagent transcripts on resume — which contradicts the §1.2 "full transcript fidelity" promise.

**Implication for v0:**

- `core/session.ts` reading: glob both `<encoded-cwd>/<id>.jsonl` AND `<encoded-cwd>/<id>/subagents/*.jsonl`
- `cli/commands/share.ts` packaging: include subagent files in the per-session directory under a `subagents/` subdirectory
- `cli/commands/resume.ts` placement: mirror the structure at the destination's encoded-cwd, applying the same path rewrite to each subagent JSONL

**Rule:** subagent JSONLs are part of the session payload, not a v0.5 enhancement. Track as a v0 implementation requirement.

## 3. §3.9 inverted: auto-share is on by default

**ARCHITECTURE.md §3.9 says:** "Default is manual share. Reason: auto-modifying global Claude Code config without explicit consent erodes trust."

**Decision in v0.1:** flip the default. `drev init` auto-installs hooks + the bundled `drev` skill into `~/.claude/`, and `defaultUserConfig().auto_share` is `'auto-team'` (not `'manual'`).

**Why:** product feedback — the "open a new terminal to run drev share" friction kills adoption. Auto-share captures sessions on end without user effort. The bundled skill makes mid-session "save this" requests work via Bash without the user installing anything.

**Opt-out:** `drev init --no-auto-share` skips the install. `drev hooks uninstall` removes hooks + skill. Edit `~/.drev/config.yaml` to flip `auto_share` to `'manual'` or `'auto-private'`.

**Trust note:** the original "explicit consent" concern is mitigated by (a) `drev init` is itself an explicit consent moment, (b) `--no-auto-share` is a one-flag escape, and (c) the install is reversible.

## 4. Thinking blocks must be dropped on resume

**Discovered during the T27 cross-machine test (2026-05-01).** Sharing a session captured on one Anthropic API account to a recipient on a different account caused `claude --resume` to fail with HTTP 400 `invalid_request_error` from the API. ARCHITECTURE.md is silent on this — it assumed a JSONL is portable as-is, which is false for any session whose recipient uses a different account than the producer.

**Why this happens.** Claude Code records assistant messages including their `thinking` content blocks. Each thinking block carries a cryptographic `signature` field that the Anthropic API validates against the API key that produced it. When the JSONL is replayed under a different API key, signature validation fails on the very first turn that contains a thinking block — the resume can't proceed.

**First fix attempt (commit `7a3775d`):** strip just the `signature` field from thinking blocks before write. **This made it worse.** The API requires `signature` to be *present* whenever a thinking block exists, so removing only the field returned a `Field required` validation error.

**Final fix (commit `e1674a7`):** drop the entire thinking block from `content` arrays during the resume rewrite. The remaining text blocks preserve all conceptual context — Claude on the receiver side has the full transcript of what was discussed, decided, and produced — but the internal "reasoning trail" is lost. Reasoning trails don't carry forward across resumes anyway; they're per-turn artifacts.

**Implementation.** `stripThinkingSignatures` in `src/core/session.ts` (name kept for git history continuity even though the implementation now strips entire blocks, not just signatures — a rename to `dropThinkingBlocks` is a candidate cleanup for v0.2). Called from `cli/commands/resume.ts` on both the parent JSONL and each subagent JSONL after `rewritePaths`.

**Rule:** every JSONL written to the destination's encoded-cwd path must have its thinking blocks removed. Cross-account resume is the common case (different humans use different API keys); same-account resume tolerates the strip as a no-op since the validated signature is also accepted in its absence.

**Scope note:** Drev redacts secrets (§8) and rewrites paths (§7) and now strips thinking blocks. The shared JSONL is increasingly *not* a verbatim copy of the producer's local file — it's a serialization of the session's *content* designed for portability. Document this in v2 of ARCHITECTURE.md so future implementers don't assume byte-fidelity.

## How to update the architecture

These corrections supersede the conflicting passages in `ARCHITECTURE.md`. Rather than editing the architecture document in place (which would lose its design-time integrity), implementers should consult this file alongside it. When v0 ships, fold these into a v2 of the architecture doc.
