# Hero demo: resume a Claude Code session — same conversation, different machine.
#
# Build with:
#   vhs demo/hero.tape
# Output: demo.gif (committed to repo root, referenced by README).
#
# Prerequisites for a real recording:
#   - vhs installed (https://github.com/charmbracelet/vhs)
#   - drev installed: `npm install -g @codeturion/drev`
#   - drev init done with shared sessions visible to `drev list`
#   - The session named in the Resume step below exists in your drev-sessions repo

Output demo.gif

# --- Visual config ----------------------------------------------------------

Set FontSize 16
Set Width 1200
Set Height 720
Set Theme "Tokyo Night"
Set TypingSpeed 55ms
Set PlaybackSpeed 1.0
Set Padding 24
Set BorderRadius 10
Set FontFamily "JetBrains Mono"

# --- Setup (hidden from the gif) --------------------------------------------

Hide
# Clean prompt so viewers focus on commands, not your local PS1.
Type "PS1='$ '"
Enter
Type "clear"
Enter
Show

# --- Scene ------------------------------------------------------------------

Sleep 800ms

# One-line context. Doubles as a YouTube-style hook.
Type "# Resume a Claude Code session, same conversation, different machine:"
Sleep 1.6s
Enter
Sleep 500ms

# 1. See what's available (pulls latest from the repo, lists sessions).
Type "drev list --days 7"
Sleep 400ms
Enter
Sleep 3.5s

# 2. The magic command. drev pulls latest, rewrites every path from the
#    sender's machine to this one (Mac->Windows or vice versa), places the
#    JSONL into ~/.claude/projects/<encoded>/<id>.jsonl, then spawns
#    `claude --resume <id>` so Claude Code opens with the full transcript.
Type "drev resume xos-fix"
Sleep 400ms
Enter

# Let drev print its progress lines and spawn Claude Code.
Sleep 7s

# Claude Code TUI is now visible with the resumed session loaded — every
# tool call, every read, every "ah, that's why" — intact on a fresh machine.
Sleep 4s
