# T27: Manual cross-machine resume test

**Phase:** D · **Depends on:** T26
**Architecture refs:** §13.3, §14.1, §16 DoD

## Scope

The manual test that the §14.1 experiment proved is possible. Now we do it through the real `drev share` and `drev resume` CLI on two separate machines (or two separate user accounts on one machine, second-best, but acceptable).

### Procedure

1. **Machine A:**
   a. Have a real Claude Code session of ≥30 turns and ≥5 tool calls available
   b. `drev init <private-repo>`
   c. `drev share --name xmachine-test --session-id <id>`
2. **Machine B:**
   a. `drev init <same-private-repo>`
   b. `drev list` → confirm session appears
   c. `drev resume xmachine-test`
   d. In the resumed Claude Code session, ask a recall question only the original session would know
   e. Verify Claude answers correctly with details from the original session

### What success looks like

- Resume command spawns Claude Code without error
- Resumed Claude Code has full context, answers recall questions accurately
- File paths in tool calls work on Machine B's filesystem
- Subagent transcripts (if any) are present

### Documentation

Document the test outcome in `docs/MANUAL_TESTS.md`:
- Date run
- Source machine OS and Claude Code version
- Destination machine OS and Claude Code version
- Session size (turns, tool calls, JSONL bytes)
- Recall question asked + answer received
- Pass / fail / caveat

## Files

- Update `docs/MANUAL_TESTS.md` with the procedure and the most-recent run record

## Acceptance

- Procedure documented and executable cold by another engineer
- At least one successful run recorded with date + verifying recall question
- Any failures or partial results documented honestly (not glossed over)

## Out of scope

- Automating this, `claude --resume` is interactive; full automation would require driving the resumed Claude programmatically, which is a v0.1+ project
- Cross-OS (Windows producer → POSIX consumer), flagged in CORRECTIONS, deferred unless required
