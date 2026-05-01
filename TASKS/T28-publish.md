# T28: npm publish to npm

**Phase:** D · **Depends on:** T25, T26 (T27 ideally complete)
**Architecture refs:** §11.1, §16 DoD
**Status:** ✅ Done — published as `@codeturion/drev@0.1.2` on 2026-05-01.

## Outcome

The unscoped `drev` name is held by `arunoda/drev` (a dormant Distributed Redis EventEmitter). `drev-cli` was rejected by npm's similarity check ("too similar to existing package del-cli"). Settled on the scoped name `@codeturion/drev`. Bin name remains `drev` so users still type `drev share`, only the install line changes.

```
npm install -g @codeturion/drev
```

Published versions: only `0.1.2` (0.1.0 and 0.1.1 were burned during the renaming dance and never made it to npm). Future versions: bump `package.json`, tag `vX.Y.Z`, push the tag, GitHub Actions does the rest (see `.github/workflows/publish.yml`).

## Pre-flight (kept for reference)

- ✅ Bump `package.json` version
- ✅ Verify `files` array includes `dist`, `README.md`, `LICENSE` only
- ✅ Verify `bin` map points to built files in `dist/`
- ✅ `npm run build` clean
- ✅ `npm publish --dry-run` inspected, no leaks
- ✅ Tag pushed to GitHub
- ⏳ Demo video (deferred; not blocking)

## Automated publishing (GitHub Actions + npm Trusted Publishing)

`.github/workflows/publish.yml` runs on tag pushes matching `v*` (and via manual `workflow_dispatch`). It checks out, installs, typechecks, tests, verifies the tag version matches `package.json`, then publishes with `npm publish --access public`.

Authentication uses npm **Trusted Publishing** (OIDC), not a long-lived access token. Each workflow run exchanges its short-lived GitHub OIDC token for a one-shot npm token cryptographically tied to this repo + workflow file. No secrets to rotate, no token to leak.

### One-time setup on npmjs.com

1. Go to https://www.npmjs.com/package/@codeturion/drev → **Settings** → **Trusted Publishers**
2. Click **Add Trusted Publisher**
3. Fill in:
   - **Publisher:** GitHub Actions
   - **Repository owner:** `Codeturion`
   - **Repository name:** `drev`
   - **Workflow filename:** `publish.yml`
   - **Environment name:** (leave empty)
4. Save

That's it. No NPM_TOKEN repo secret needed; in fact, having one would be wasted attack surface.

After setup, future releases are: bump version → commit → `git tag vX.Y.Z` → `git push --follow-tags`. The workflow handles the rest.

### Why this beats access tokens

- No token rotation calendar reminders
- Compromised CI logs can't leak a reusable secret (OIDC tokens are scoped to a single workflow run, expire in minutes)
- npm prints a "Verified Publisher" badge on the package page
- npm explicitly recommends this over granular tokens for CI/CD

### Provenance

`--provenance` is skipped while the repo is private (npm requires public repos for provenance attestation). When the repo is opened up, add `--provenance` to the publish command. The workflow already has the `id-token: write` permission for it.

## Acceptance

- ✅ `npm install -g @codeturion/drev` succeeds and produces a working binary
- ✅ Published package size <2MB (actual: 37.6 kB / 145.7 kB unpacked)
- ✅ Tag `v0.1.2` exists on GitHub
- ⏳ Demo video linked in README (deferred)
- ✅ GitHub Actions workflow in place for future releases

## Out of scope

- Deprecating prior versions, there are none on npm (the 0.1.0 and 0.1.1 git tags are pre-publish snapshots only)
- Claude Code plugin marketplace package, that's v0.1 per §14.3
