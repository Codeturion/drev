# T04: core/redaction.ts ← LOAD-BEARING

**Phase:** A · **Depends on:** T01 · **Blocks:** T14, T23
**Architecture refs:** §8 (full)

## Scope

Implement secret-redaction over JSONL content per §8.

### Contract

```ts
type RedactionPattern = { type: string; regex: RegExp };

function redact(
  jsonl: string,
  patterns: RedactionPattern[],
): { output: string; counts: Record<string, number> };
```

- Apply each pattern in order
- Replace matches with `<REDACTED:<type>>`
- Count matches per type
- Return rewritten JSONL + count object for `meta.yaml.redactions`

### Default patterns (per §8.1)

All twelve from §8.1 must be implemented exactly. Re-list here for reviewer convenience:
- `anthropic_key`, `openai_key`, `aws_access_key`, `aws_secret_key`, `github_pat`, `github_oauth`, `github_app`, `slack_token`, `private_key`, `jwt`, `google_api_key`, `stripe_key`

### Configuration assembly

Patterns used = `DEFAULT_PATTERNS` ++ `repo.config.redaction_extensions` ++ `user.config.ignore_patterns`. Repo and user extensions are user-supplied regex strings, compiled at runtime via `new RegExp(str, 'g')`. If compilation fails, throw `ValidationError` with the pattern name.

## Files

- `src/core/redaction.ts`
- `src/core/redaction.test.ts`

## Acceptance

- Every default pattern has at least one **positive** and one **negative** test (a string that should match, a string that should not)
- Counts in the output object are accurate (single source of truth for `meta.yaml.redactions`)
- The aggressive `aws_secret_key` pattern is documented in code as known false-positive-prone
- User-extension scenario tested: invalid regex throws, valid regex applied after defaults
- ≥90% line coverage

## Out of scope

- First-share confirmation prompt (§8.4) — that's a CLI concern, lives in `cmd/share` (T14)
- `drev scrub` history rewrite — separate command (T24), shells `git filter-repo`
- Pattern auto-discovery (e.g., entropy-based) — not in v0
