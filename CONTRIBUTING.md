# Contributing to drev

Thanks for the interest. drev is small and intentionally so, but bug reports, edge-case fixes, and platform parity work are all welcome.

## Reporting bugs

Open an issue at https://github.com/Codeturion/drev/issues with:

- What you ran (`drev <command>` exact invocation)
- What you expected
- What happened
- OS + Node version (`node --version`, `drev --version`)
- Relevant snippets from `~/.drev/logs/` if the failure was non-obvious

For path-rewriting or session-resume issues, the receiving machine's logs are usually the interesting ones, not the producer's.

## Security issues

Don't open a public issue. See [SECURITY.md](./SECURITY.md).

## Local development

```
git clone https://github.com/Codeturion/drev.git
cd drev
npm install        # also runs the build via 'prepare'
npm test           # full vitest suite (28 files, 572+ tests)
npm run typecheck  # tsc --noEmit
```

The `prepare` script builds `dist/` so the linked `drev` binary works locally. After `git pull` you may need `npm install` again to rebuild.

To smoke-test the CLI against your dev tree:

```
npm link            # makes 'drev' on PATH point at your working copy
drev --version
drev --help
```

## Code conventions

- TypeScript strict + `noUncheckedIndexedAccess`. No `any` without comment.
- Tests live next to logic in `src/core/*.test.ts`. Aim ≥80% coverage on `core/`; ≥90% on the load-bearing pieces (`path-rewriter.ts`, `redaction.ts`).
- The structural rule: `core/` modules don't import from `cli/`. The CLI is a thin wrapper.
- Match the existing voice in user-facing strings (terse, action-oriented, no exclamation marks).
- See `ARCHITECTURE.md` §3 for locked design decisions; don't relitigate those without an issue first.

## Pull requests

- One concern per PR. Refactors separate from features.
- Run `npm test` and `npm run typecheck` before pushing.
- Reference the issue number in the PR description if there is one.
- Squash messy WIP commits before requesting review.

## Releases (maintainers)

```
npm version patch          # or minor / major
git push --follow-tags     # CI publishes via Trusted Publishing
```

The GitHub Actions workflow at `.github/workflows/publish.yml` handles the npm publish on tag push.
