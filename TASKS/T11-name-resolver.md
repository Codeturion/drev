# T11: core/name-resolver.ts

**Phase:** B · **Depends on:** T06 · **Blocks:** T14, T15, T18, T20, T24
**Architecture refs:** §9.5 step 2 (resolution rules)

## Scope

Resolve a user-provided argument (a name substring or an ID prefix) to a unique session.

### Contract

```ts
type ResolvedSession = { metaPath: string; meta: SessionMeta };

async function resolve(
  query: string,
  metaFiles: string[],
): Promise<ResolvedSession>; // throws on zero or multiple matches

function isIdPrefix(query: string): boolean;
// True if query looks like 8+ hex chars (per §9.5)

function matchById(query: string, meta: SessionMeta): boolean;
function matchByName(query: string, meta: SessionMeta): boolean;
```

### Algorithm (§9.5 step 2)

1. If `isIdPrefix(query)`, match by `meta.id` having `query` as a case-insensitive prefix
2. Else, match by `meta.name` containing `query` as a case-insensitive substring
3. If 0 matches: throw with "no session matches" message
4. If >1 matches: throw with a list of matches (id-prefix, name, user)
5. If 1 match: return it

## Files

- `src/core/name-resolver.ts`
- `src/core/name-resolver.test.ts`

## Acceptance

- `isIdPrefix` correctly identifies `7f3a2b1c` (yes), `7f3a` (no, too short), `auth-refactor` (no)
- Tests cover: 0 matches, 1 match, 2+ matches each for ID and name paths
- Ambiguity error message lists candidates with id-prefix, name, user (per §9.5)
- ≥90% line coverage

## Out of scope

- Fuzzy matching, substring is enough
- Auto-completion, T16 list helps with that
