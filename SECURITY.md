# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

If you find a vulnerability in drev, email `fuatcankoseoglu@gmail.com` with:

- A description of the issue
- Steps to reproduce, ideally with a minimal proof-of-concept
- The version of drev (`drev --version`) and your OS/Node version
- Whether you've disclosed this to anyone else

You'll get an acknowledgement within a few days. Once the issue is confirmed and a fix is in flight, we'll coordinate a disclosure timeline with you.

## Scope

drev moves Claude Code session JSONLs through a Git repo. The pieces with the highest blast radius are:

- **`core/redaction.ts`** — secret-pattern scanning. A miss here means a credential lands in your team's Git repo. Reports about new secret patterns, false negatives on existing patterns, or evasion techniques are especially welcome.
- **`core/path-rewriter.ts`** — rewrites absolute paths in JSONLs. A bug that fails to rewrite (or rewrites something it shouldn't) could leak machine-specific info or write to the wrong place on the receiving machine.
- **`drev resume`** — spawns `claude` as a subprocess and writes a JSONL to `~/.claude/projects/`. Anything that lets a malicious session influence the spawn or the destination path is in scope.
- **GitHub Actions publish workflow** — uses npm Trusted Publishing (OIDC) with no long-lived secrets, but the workflow file itself defines what gets published.

Out of scope: vulnerabilities in upstream dependencies (report to the upstream project), and issues caused by writing to a Git repo you don't trust (drev assumes the configured repo is yours/your team's).

## Redaction caveat

drev redacts known secret patterns before pushing, but **redaction is best-effort**. It is not a substitute for keeping secrets out of your shell history and your Claude Code conversations in the first place. If you accidentally push a session that contains a real secret, rotate the credential immediately and use `drev scrub <name> --confirm` to rewrite repo history.

The current pattern list is in [`docs/REDACTION.md`](./docs/REDACTION.md).
