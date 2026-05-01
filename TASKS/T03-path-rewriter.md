# T03: core/path-rewriter.ts ← LOAD-BEARING

**Phase:** A · **Depends on:** T01 · **Blocks:** T14, T15, T23, T26, T27
**Architecture refs:** §7 (full)
**Corrections:** [`docs/CORRECTIONS.md`](../docs/CORRECTIONS.md) §1
**Reference impl:** [`experiment/rewrite.mjs`](../experiment/rewrite.mjs)

## Scope

Implement the path-rewrite function per §7.3, with the §7.4 case 3 correction: **do NOT normalize separators**. On Windows, Claude Code stores backslashes; if we normalize to forward slashes, replacement misses every path.

### Contract

```ts
function rewritePaths(jsonl: string, sourceRoot: string, destRoot: string): string;
```

- Input: full JSONL content as a single string
- Input: `sourceRoot`, `destRoot`: both in their native separator form
- Output: JSONL with all path references rewritten
- Behavior: split/join replacement (no regex), JSON-escaped form first, then raw form, line-by-line
- Early return: if `sourceRoot === destRoot`, return input unchanged

### Edge cases (every one needs a test: see §7.4)

1. **Substring collision** (`/Users/fu` ⊄ `/Users/fuat`), boundary-aware: only replace when followed by `/`, `\`, `"`, end-of-line, or whitespace
2. **Regex special chars in paths** (`+`, `(`, `)`, `[`), split/join is regex-free, but test it
3. **Windows backslashes**, preserve, do not normalize (CORRECTIONS §1)
4. **Trailing slash inconsistency** (`/foo/` vs `/foo`), strip trailing separator on inputs uniformly
5. **Case sensitivity**, case-sensitive replacement; document for macOS users
6. **Source equals destination**, no-op early return
7. **Source not in JSONL**, return input unchanged
8. **Path in assistant text** (not just tool calls), caught by line-level pass
9. **Path in stderr embedded in tool result**, caught by line-level pass
10. **Multi-byte chars in paths**, Unicode-correct (Node strings handle this)

## Files

- `src/core/path-rewriter.ts`
- `src/core/path-rewriter.test.ts`

## Acceptance

- All 10 edge cases above have at least one explicit test
- Property-based test: 100 random source/dest pairs (using `fast-check` if added, else hand-rolled fuzzer with `Math.random`-based generator), output never contains `sourceRoot`, output count of `destRoot` matches input count of `sourceRoot`
- **Reproducibility test:** running `core/path-rewriter.rewritePaths` over the same input as `experiment/rewrite.mjs` produces byte-identical output
- ≥95% line coverage
- `npm test`, `npm run typecheck` green

## Out of scope

- Subagent JSONL discovery, T09
- Cross-platform separator translation (Windows producer → POSIX consumer), flagged in CORRECTIONS, deferred to v0.1 unless required by integration test
- Sub-line context (e.g., paths spanning JSON escapes weirdly), current algorithm is line-level

## Why this is load-bearing

If this is wrong, every shared session is broken. Without correct rewriting, Claude can't reconcile the JSONL's absolute paths with the receiver's filesystem. The §14.1 experiment proved the algorithm works on real data, this task is to enshrine it in tested production code.
