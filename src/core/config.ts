import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { ConfigError } from '../lib/errors.js';
import { drevHome } from './claude-paths.js';

const SCHEMA_VERSION = 1;

export type AutoShareMode = 'manual' | 'auto-private' | 'auto-team';
export type Visibility = 'team' | 'private';

export interface UserConfig {
  schema_version: 1;
  default_repo: string | null;
  auto_share: AutoShareMode;
  auto_share_idle_threshold_seconds: number;
  auto_summarize: boolean;
  ignore_patterns: string[];
  ignore_paths: string[];
  [extra: string]: unknown;
}

export interface RepoConfig {
  schema_version: 1;
  team_name: string;
  default_visibility: Visibility;
  retention_days: number;
  redaction_extensions: string[];
  [extra: string]: unknown;
}

export function defaultUserConfig(): UserConfig {
  return {
    schema_version: 1,
    default_repo: null,
    auto_share: 'manual',
    auto_share_idle_threshold_seconds: 60,
    auto_summarize: false,
    ignore_patterns: [],
    ignore_paths: [],
  };
}

export function defaultRepoConfig(teamName: string): RepoConfig {
  return {
    schema_version: 1,
    team_name: teamName,
    default_visibility: 'team',
    retention_days: 365,
    redaction_extensions: [],
  };
}

function userConfigPath(dir?: string): string {
  return join(dir ?? drevHome(), 'config.yaml');
}

function repoConfigPath(repoDir: string): string {
  return join(repoDir, '.drev', 'config.yaml');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseYaml(raw: string, file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (cause) {
    throw new ConfigError(`Failed to parse YAML in ${file}.`, { cause });
  }
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError(
      `Config at ${file} is not a YAML mapping.`,
    );
  }
  return parsed;
}

function checkSchemaVersion(value: unknown, file: string): void {
  if (value === undefined) {
    throw new ConfigError(
      `Config at ${file} is missing required field 'schema_version'.`,
    );
  }
  if (value !== SCHEMA_VERSION) {
    throw new ConfigError(
      `Config at ${file} has schema_version ${String(value)} but this Drev expects ${SCHEMA_VERSION}. Upgrade Drev to read this file.`,
    );
  }
}

function expectString(
  value: unknown,
  field: string,
  file: string,
): string {
  if (typeof value !== 'string') {
    throw new ConfigError(
      `Config at ${file} field '${field}' must be a string.`,
    );
  }
  return value;
}

function expectStringOrNull(
  value: unknown,
  field: string,
  file: string,
): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new ConfigError(
    `Config at ${file} field '${field}' must be a string or null.`,
  );
}

function expectBoolean(
  value: unknown,
  field: string,
  file: string,
): boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigError(
      `Config at ${file} field '${field}' must be a boolean.`,
    );
  }
  return value;
}

function expectNumber(
  value: unknown,
  field: string,
  file: string,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(
      `Config at ${file} field '${field}' must be a finite number.`,
    );
  }
  return value;
}

function expectStringArray(
  value: unknown,
  field: string,
  file: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `Config at ${file} field '${field}' must be an array of strings.`,
    );
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new ConfigError(
        `Config at ${file} field '${field}' must contain only strings.`,
      );
    }
  }
  return value as string[];
}

function expectAutoShare(
  value: unknown,
  field: string,
  file: string,
): AutoShareMode {
  if (
    value !== 'manual' &&
    value !== 'auto-private' &&
    value !== 'auto-team'
  ) {
    throw new ConfigError(
      `Config at ${file} field '${field}' must be 'manual', 'auto-private', or 'auto-team'.`,
    );
  }
  return value;
}

function expectVisibility(
  value: unknown,
  field: string,
  file: string,
): Visibility {
  if (value !== 'team' && value !== 'private') {
    throw new ConfigError(
      `Config at ${file} field '${field}' must be 'team' or 'private'.`,
    );
  }
  return value;
}

const USER_KNOWN_KEYS = new Set([
  'schema_version',
  'default_repo',
  'auto_share',
  'auto_share_idle_threshold_seconds',
  'auto_summarize',
  'ignore_patterns',
  'ignore_paths',
]);

const REPO_KNOWN_KEYS = new Set([
  'schema_version',
  'team_name',
  'default_visibility',
  'retention_days',
  'redaction_extensions',
]);

function parseUserConfig(
  obj: Record<string, unknown>,
  file: string,
): UserConfig {
  checkSchemaVersion(obj['schema_version'], file);
  const defaults = defaultUserConfig();
  const result: UserConfig = {
    schema_version: 1,
    default_repo:
      obj['default_repo'] === undefined
        ? defaults.default_repo
        : expectStringOrNull(obj['default_repo'], 'default_repo', file),
    auto_share:
      obj['auto_share'] === undefined
        ? defaults.auto_share
        : expectAutoShare(obj['auto_share'], 'auto_share', file),
    auto_share_idle_threshold_seconds:
      obj['auto_share_idle_threshold_seconds'] === undefined
        ? defaults.auto_share_idle_threshold_seconds
        : expectNumber(
            obj['auto_share_idle_threshold_seconds'],
            'auto_share_idle_threshold_seconds',
            file,
          ),
    auto_summarize:
      obj['auto_summarize'] === undefined
        ? defaults.auto_summarize
        : expectBoolean(obj['auto_summarize'], 'auto_summarize', file),
    ignore_patterns:
      obj['ignore_patterns'] === undefined
        ? defaults.ignore_patterns
        : expectStringArray(obj['ignore_patterns'], 'ignore_patterns', file),
    ignore_paths:
      obj['ignore_paths'] === undefined
        ? defaults.ignore_paths
        : expectStringArray(obj['ignore_paths'], 'ignore_paths', file),
  };
  for (const [key, value] of Object.entries(obj)) {
    if (!USER_KNOWN_KEYS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

function parseRepoConfig(
  obj: Record<string, unknown>,
  file: string,
): RepoConfig {
  checkSchemaVersion(obj['schema_version'], file);
  if (obj['team_name'] === undefined) {
    throw new ConfigError(
      `Config at ${file} is missing required field 'team_name'.`,
    );
  }
  const defaults = defaultRepoConfig(
    expectString(obj['team_name'], 'team_name', file),
  );
  const result: RepoConfig = {
    schema_version: 1,
    team_name: defaults.team_name,
    default_visibility:
      obj['default_visibility'] === undefined
        ? defaults.default_visibility
        : expectVisibility(
            obj['default_visibility'],
            'default_visibility',
            file,
          ),
    retention_days:
      obj['retention_days'] === undefined
        ? defaults.retention_days
        : expectNumber(obj['retention_days'], 'retention_days', file),
    redaction_extensions:
      obj['redaction_extensions'] === undefined
        ? defaults.redaction_extensions
        : expectStringArray(
            obj['redaction_extensions'],
            'redaction_extensions',
            file,
          ),
  };
  for (const [key, value] of Object.entries(obj)) {
    if (!REPO_KNOWN_KEYS.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new ConfigError(`Failed to read config at ${path}.`, { cause: err });
  }
}

async function writeYaml(path: string, value: unknown): Promise<void> {
  const dir = join(path, '..');
  try {
    await mkdir(dir, { recursive: true });
  } catch (cause) {
    throw new ConfigError(
      `Failed to create config directory ${dir}.`,
      { cause },
    );
  }
  let serialized: string;
  try {
    serialized = yaml.dump(value, { lineWidth: -1, noRefs: true });
  } catch (cause) {
    throw new ConfigError(
      `Failed to serialize config for ${path}.`,
      { cause },
    );
  }
  try {
    await writeFile(path, serialized, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Failed to write config at ${path}.`, { cause });
  }
}

export async function readUserConfig(opts?: {
  dir?: string;
}): Promise<UserConfig> {
  const path = userConfigPath(opts?.dir);
  const raw = await readFileIfExists(path);
  if (raw === null) {
    const defaults = defaultUserConfig();
    await writeYaml(path, defaults);
    return defaults;
  }
  const parsed = parseYaml(raw, path);
  return parseUserConfig(parsed, path);
}

export async function writeUserConfig(
  c: UserConfig,
  opts?: { dir?: string },
): Promise<void> {
  const path = userConfigPath(opts?.dir);
  await writeYaml(path, c);
}

export async function readRepoConfig(repoDir: string): Promise<RepoConfig> {
  const path = repoConfigPath(repoDir);
  const raw = await readFileIfExists(path);
  if (raw === null) {
    throw new ConfigError(`Repo config not found at ${path}.`);
  }
  const parsed = parseYaml(raw, path);
  return parseRepoConfig(parsed, path);
}

export async function writeRepoConfig(
  repoDir: string,
  c: RepoConfig,
): Promise<void> {
  const path = repoConfigPath(repoDir);
  await writeYaml(path, c);
}
