# T28: npm publish to npm

**Phase:** D · **Depends on:** T25, T26 (T27 ideally complete)
**Architecture refs:** §12.1, §16 DoD

## Scope

Publish `drev` to npm under the MIT license, version `0.1.0` (first user-facing release).

### Pre-flight

- Bump `package.json` version to `0.1.0`
- Verify `files` array in package.json includes `dist`, `README.md`, `LICENSE` only (no source, no tests, no node_modules)
- Verify `bin` map points to built files in `dist/`
- Run `npm run build` clean — verify dist contents
- Run `npm pack --dry-run` and inspect the file list — confirm nothing leaks
- Tag the commit: `git tag v0.1.0 && git push --tags`
- Record demo video (per §16 DoD); upload + link in README

### Publish

```
npm login
npm publish --access public
```

### Post-flight

- Verify global install: `npm install -g drev` on a fresh machine; run `drev --version`
- Verify `drev init` works against a fresh test repo
- Open public-launch announcement (if/when ready) — timing user's call

## Files

- Update `package.json` (version)
- Update `README.md` (replace install line if needed; add demo video link)
- Tag in git

## Acceptance

- `npm install -g drev` succeeds and produces a working binary
- Published package size <2MB
- Tag `v0.1.0` exists on GitHub
- Demo video linked in README

## Out of scope

- Automated publishing via GitHub Actions — set up in v0.1
- Deprecating prior versions — there are none
- Claude Code plugin marketplace package — that's v0.1 per §14.3
