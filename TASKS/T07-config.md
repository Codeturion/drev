# T07: core/config.ts

**Phase:** B · **Depends on:** T01 · **Blocks:** T08, T13, T22, T23
**Architecture refs:** §5.2 (repo config), §5.3 (user config)

## Scope

Load and save the two YAML config files: user (`~/.drev/config.yaml`) and repo (`<clone>/.drev/config.yaml`).

### Contracts

```ts
interface UserConfig {
  schema_version: 1;
  default_repo: string | null;
  auto_share: 'manual' | 'auto-private' | 'auto-team';
  auto_share_idle_threshold_seconds: number;
  auto_summarize: boolean;
  ignore_patterns: string[];   // user-defined regex strings
  ignore_paths: string[];      // substring matches against JSONL paths
}

interface RepoConfig {
  schema_version: 1;
  team_name: string;
  default_visibility: 'team' | 'private';
  retention_days: number;       // informational
  redaction_extensions: string[];
}

async function readUserConfig(): Promise<UserConfig>;       // creates default if missing
async function writeUserConfig(c: UserConfig): Promise<void>;
async function readRepoConfig(repoDir: string): Promise<RepoConfig>;
async function writeRepoConfig(repoDir: string, c: RepoConfig): Promise<void>;
function defaultUserConfig(): UserConfig;
function defaultRepoConfig(teamName: string): RepoConfig;
```

### Defaults

User config defaults:
- `default_repo: null`
- `auto_share: 'manual'`
- `auto_share_idle_threshold_seconds: 60`
- `auto_summarize: false`
- `ignore_patterns: []`, `ignore_paths: []`

Repo config defaults:
- `default_visibility: 'team'`
- `retention_days: 365`
- `redaction_extensions: []`

## Files

- `src/core/config.ts`
- `src/core/config.test.ts`

## Acceptance

- First read of `~/.drev/config.yaml` when missing creates the file with defaults
- Schema version mismatch on either file throws `ConfigError` (code `SCHEMA_VERSION_MISMATCH`)
- Round-trip parse/serialize preserves all fields
- Tests cover: missing file → default, partial file → fills defaults, malformed yaml → throws
- ≥85% line coverage

## Out of scope

- Multi-repo config (§14.4 v0.5)
- Encrypted secrets in config, out of v0
