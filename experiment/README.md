# §14.1 Experiment Receipt

This directory holds the manual proof that the load-bearing assumption in `ARCHITECTURE.md` works: `claude --resume` accepts a session JSONL whose paths have been rewritten and placed at a different encoded-cwd.

`rewrite.mjs` mirrors the §7.3 algorithm (with the §7.4 case 3 correction documented in `docs/CORRECTIONS.md` — no separator normalization on Windows). Run on a real 157-line session with 31 tool calls; rewrote 134 path occurrences; `claude --resume` from the destination directory recalled session details correctly.

Excluded from the build (`tsconfig.json` excludes `experiment/`). Kept in the repo as a permanent reference for the path-rewriter implementation in `src/core/path-rewriter.ts` and as evidence that the architecture is sound.
