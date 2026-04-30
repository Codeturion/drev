# Drev

Share Claude Code sessions through a Git repo.

When an engineer hands off work, the receiving engineer rebuilds context from Slack threads and ticket comments. The actual debugging session — the JSONL with every read, edit, and decision — never reaches them. Drev moves the JSONL itself: producer runs `drev share`, consumer runs `drev resume <name>`, native `claude --resume` continues the session with full transcript fidelity.

**Status: pre-v0.** See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and [docs/CORRECTIONS.md](./docs/CORRECTIONS.md) for in-flight corrections to it.

## Install

Not yet published.

## License

MIT
