# T25: README quickstart

**Phase:** D · **Depends on:** all of Phase C
**Architecture refs:** §16 DoD ("README explains: install, init, first share, first resume in <50 lines")

## Scope

Replace the current pre-v0 README with a v0 quickstart. Constraint: under 50 lines.

### Required sections

1. **What it is**, one paragraph
2. **Install**, `npm install -g drev`
3. **First setup**, `drev init <repo-url>`
4. **Share**, `drev share` (and what gets shared)
5. **Resume**, `drev resume <name>` (and what happens next)
6. **Auto-share (opt-in)**, `drev hooks install`, mention §3.9
7. **License + contributing**, one line each, link to ARCHITECTURE.md

### Tone

Power-user friendly. No marketing fluff. Show actual command output where relevant. Link out for details (ARCHITECTURE.md, docs/CORRECTIONS.md).

## Files

- `README.md` (replace existing)
- Update `experiment/README.md` if anything changed
- Add `docs/REDACTION.md` and `docs/MANUAL_TESTS.md` per §16 DoD if not yet created

## Acceptance

- ≤50 lines (count via `wc -l README.md`)
- Every command shown actually works on a fresh install
- Demo video link placeholder reserved (filled in T28)
- `docs/REDACTION.md` lists every default pattern from §8.1 and explains user extensions
- `docs/MANUAL_TESTS.md` has the §13.3 / §14.1 procedure documented

## Out of scope

- Tutorial-style docs ("getting started in 30 minutes"), defer to v0.1 if user feedback wants it
- API reference docs, Drev is a CLI, not a library
