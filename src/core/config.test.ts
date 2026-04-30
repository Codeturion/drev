import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { ConfigError } from '../lib/errors.js';
import {
  defaultRepoConfig,
  defaultUserConfig,
  readRepoConfig,
  readUserConfig,
  writeRepoConfig,
  writeUserConfig,
} from './config.js';
import type { RepoConfig, UserConfig } from './config.js';

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (!d) continue;
    await rm(d, { recursive: true, force: true });
  }
});

describe('defaultUserConfig', () => {
  it('returns the documented defaults', () => {
    expect(defaultUserConfig()).toEqual({
      schema_version: 1,
      default_repo: null,
      auto_share: 'manual',
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
    });
  });

  it('returns a fresh object each call (no shared mutation)', () => {
    const a = defaultUserConfig();
    const b = defaultUserConfig();
    a.ignore_patterns.push('x');
    expect(b.ignore_patterns).toEqual([]);
  });
});

describe('defaultRepoConfig', () => {
  it('returns the documented defaults with the given team name', () => {
    expect(defaultRepoConfig('forever-town-team')).toEqual({
      schema_version: 1,
      team_name: 'forever-town-team',
      default_visibility: 'team',
      retention_days: 365,
      redaction_extensions: [],
    });
  });
});

describe('readUserConfig', () => {
  it('creates the file with defaults when missing and returns the defaults', async () => {
    const dir = await makeTmp('drev-user-');
    const cfg = await readUserConfig({ dir });
    expect(cfg).toEqual(defaultUserConfig());
    const onDisk = await readFile(join(dir, 'config.yaml'), 'utf8');
    const parsed = yaml.load(onDisk);
    expect(parsed).toEqual(defaultUserConfig());
  });

  it('also creates parent directories when the dir does not yet exist', async () => {
    const base = await makeTmp('drev-user-');
    const nested = join(base, 'nested', 'home', '.drev');
    const cfg = await readUserConfig({ dir: nested });
    expect(cfg).toEqual(defaultUserConfig());
    const onDisk = await readFile(join(nested, 'config.yaml'), 'utf8');
    expect(onDisk).toContain('schema_version: 1');
  });

  it('parses a fully populated existing config', async () => {
    const dir = await makeTmp('drev-user-');
    const value: UserConfig = {
      schema_version: 1,
      default_repo: '/home/me/.drev/repos/team',
      auto_share: 'auto-team',
      auto_share_idle_threshold_seconds: 120,
      auto_summarize: true,
      ignore_patterns: ['SECRET_[A-Z]+'],
      ignore_paths: ['secrets/', '.env'],
    };
    await writeFile(join(dir, 'config.yaml'), yaml.dump(value), 'utf8');
    const cfg = await readUserConfig({ dir });
    expect(cfg).toEqual(value);
  });

  it('fills missing optional fields from defaults on partial files', async () => {
    const dir = await makeTmp('drev-user-');
    await writeFile(
      join(dir, 'config.yaml'),
      'schema_version: 1\nauto_share: auto-private\n',
      'utf8',
    );
    const cfg = await readUserConfig({ dir });
    expect(cfg.schema_version).toBe(1);
    expect(cfg.auto_share).toBe('auto-private');
    expect(cfg.default_repo).toBeNull();
    expect(cfg.auto_summarize).toBe(false);
    expect(cfg.ignore_patterns).toEqual([]);
    expect(cfg.ignore_paths).toEqual([]);
    expect(cfg.auto_share_idle_threshold_seconds).toBe(60);
  });

  it('treats an empty file as a fully-default config (with schema check failure)', async () => {
    const dir = await makeTmp('drev-user-');
    await writeFile(join(dir, 'config.yaml'), '', 'utf8');
    await expect(readUserConfig({ dir })).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError on schema version mismatch with an upgrade message', async () => {
    const dir = await makeTmp('drev-user-');
    await writeFile(
      join(dir, 'config.yaml'),
      'schema_version: 2\n',
      'utf8',
    );
    const err = await readUserConfig({ dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/schema_version 2/);
    expect((err as Error).message).toMatch(/Upgrade Drev/i);
  });

  it('throws ConfigError on malformed YAML', async () => {
    const dir = await makeTmp('drev-user-');
    await writeFile(
      join(dir, 'config.yaml'),
      'schema_version: 1\nignore_patterns: [unterminated',
      'utf8',
    );
    await expect(readUserConfig({ dir })).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when top-level is not a mapping', async () => {
    const dir = await makeTmp('drev-user-');
    await writeFile(join(dir, 'config.yaml'), '- a\n- b\n', 'utf8');
    await expect(readUserConfig({ dir })).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when auto_share is an unknown value', async () => {
    const dir = await makeTmp('drev-user-');
    await writeFile(
      join(dir, 'config.yaml'),
      'schema_version: 1\nauto_share: chaos\n',
      'utf8',
    );
    await expect(readUserConfig({ dir })).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when types are wrong', async () => {
    const dir = await makeTmp('drev-user-');
    await writeFile(
      join(dir, 'config.yaml'),
      'schema_version: 1\nauto_summarize: "yes"\n',
      'utf8',
    );
    await expect(readUserConfig({ dir })).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when default_repo is wrong type', async () => {
    const dir = await makeTmp('drev-user-');
    await writeFile(
      join(dir, 'config.yaml'),
      'schema_version: 1\ndefault_repo: 42\n',
      'utf8',
    );
    await expect(readUserConfig({ dir })).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when threshold is not a finite number', async () => {
    const dir = await makeTmp('drev-user-');
    await writeFile(
      join(dir, 'config.yaml'),
      'schema_version: 1\nauto_share_idle_threshold_seconds: .nan\n',
      'utf8',
    );
    await expect(readUserConfig({ dir })).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when ignore_patterns is not an array', async () => {
    const dir = await makeTmp('drev-user-');
    await writeFile(
      join(dir, 'config.yaml'),
      'schema_version: 1\nignore_patterns: "not-an-array"\n',
      'utf8',
    );
    await expect(readUserConfig({ dir })).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when ignore_patterns has a non-string item', async () => {
    const dir = await makeTmp('drev-user-');
    await writeFile(
      join(dir, 'config.yaml'),
      'schema_version: 1\nignore_patterns:\n  - 42\n',
      'utf8',
    );
    await expect(readUserConfig({ dir })).rejects.toBeInstanceOf(ConfigError);
  });

  it('preserves unknown extra fields on read', async () => {
    const dir = await makeTmp('drev-user-');
    await writeFile(
      join(dir, 'config.yaml'),
      'schema_version: 1\nfuture_field: hello\n',
      'utf8',
    );
    const cfg = await readUserConfig({ dir });
    expect(cfg['future_field']).toBe('hello');
  });
});

describe('writeUserConfig', () => {
  it('writes the file as YAML and round-trips with read', async () => {
    const dir = await makeTmp('drev-user-');
    const value: UserConfig = {
      ...defaultUserConfig(),
      auto_share: 'auto-team',
      ignore_patterns: ['XYZ'],
    };
    await writeUserConfig(value, { dir });
    const reread = await readUserConfig({ dir });
    expect(reread).toEqual(value);
  });

  it('preserves unknown extra fields through write+read', async () => {
    const dir = await makeTmp('drev-user-');
    const value: UserConfig = {
      ...defaultUserConfig(),
      future_field: { nested: ['a', 'b'] },
    };
    await writeUserConfig(value, { dir });
    const reread = await readUserConfig({ dir });
    expect(reread['future_field']).toEqual({ nested: ['a', 'b'] });
  });

  it('creates the directory if missing', async () => {
    const base = await makeTmp('drev-user-');
    const nested = join(base, 'a', 'b', 'c');
    await writeUserConfig(defaultUserConfig(), { dir: nested });
    const onDisk = await readFile(join(nested, 'config.yaml'), 'utf8');
    expect(onDisk).toContain('schema_version: 1');
  });
});

describe('readRepoConfig', () => {
  async function writeRepoFile(repoDir: string, body: string): Promise<void> {
    await mkdir(join(repoDir, '.drev'), { recursive: true });
    await writeFile(join(repoDir, '.drev', 'config.yaml'), body, 'utf8');
  }

  it('parses a fully populated config', async () => {
    const repo = await makeTmp('drev-repo-');
    const value: RepoConfig = {
      schema_version: 1,
      team_name: 'forever-town-team',
      default_visibility: 'private',
      retention_days: 90,
      redaction_extensions: ['ACME_INTERNAL_[A-Z0-9]+'],
    };
    await writeRepoFile(repo, yaml.dump(value));
    const cfg = await readRepoConfig(repo);
    expect(cfg).toEqual(value);
  });

  it('throws ConfigError when the file is missing', async () => {
    const repo = await makeTmp('drev-repo-');
    await expect(readRepoConfig(repo)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when team_name is missing', async () => {
    const repo = await makeTmp('drev-repo-');
    await writeRepoFile(repo, 'schema_version: 1\n');
    await expect(readRepoConfig(repo)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when team_name is not a string', async () => {
    const repo = await makeTmp('drev-repo-');
    await writeRepoFile(repo, 'schema_version: 1\nteam_name: 42\n');
    await expect(readRepoConfig(repo)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError on schema mismatch with upgrade message', async () => {
    const repo = await makeTmp('drev-repo-');
    await writeRepoFile(repo, 'schema_version: 99\nteam_name: t\n');
    const err = await readRepoConfig(repo).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/Upgrade Drev/i);
  });

  it('fills missing optional fields with defaults', async () => {
    const repo = await makeTmp('drev-repo-');
    await writeRepoFile(repo, 'schema_version: 1\nteam_name: my-team\n');
    const cfg = await readRepoConfig(repo);
    expect(cfg).toEqual({
      schema_version: 1,
      team_name: 'my-team',
      default_visibility: 'team',
      retention_days: 365,
      redaction_extensions: [],
    });
  });

  it('throws ConfigError on invalid default_visibility', async () => {
    const repo = await makeTmp('drev-repo-');
    await writeRepoFile(
      repo,
      'schema_version: 1\nteam_name: t\ndefault_visibility: public\n',
    );
    await expect(readRepoConfig(repo)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError on invalid redaction_extensions item', async () => {
    const repo = await makeTmp('drev-repo-');
    await writeRepoFile(
      repo,
      'schema_version: 1\nteam_name: t\nredaction_extensions:\n  - 1\n',
    );
    await expect(readRepoConfig(repo)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError on invalid retention_days', async () => {
    const repo = await makeTmp('drev-repo-');
    await writeRepoFile(
      repo,
      'schema_version: 1\nteam_name: t\nretention_days: forever\n',
    );
    await expect(readRepoConfig(repo)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError on malformed YAML', async () => {
    const repo = await makeTmp('drev-repo-');
    await writeRepoFile(repo, 'schema_version: [::\n');
    await expect(readRepoConfig(repo)).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when the document is not a mapping', async () => {
    const repo = await makeTmp('drev-repo-');
    await writeRepoFile(repo, '"just a string"\n');
    await expect(readRepoConfig(repo)).rejects.toBeInstanceOf(ConfigError);
  });

  it('preserves unknown extra fields on read', async () => {
    const repo = await makeTmp('drev-repo-');
    await writeRepoFile(
      repo,
      'schema_version: 1\nteam_name: t\nexperimental_flag: true\n',
    );
    const cfg = await readRepoConfig(repo);
    expect(cfg['experimental_flag']).toBe(true);
  });
});

describe('writeRepoConfig', () => {
  it('writes the file under <repo>/.drev/config.yaml and round-trips', async () => {
    const repo = await makeTmp('drev-repo-');
    const value: RepoConfig = {
      ...defaultRepoConfig('writer-team'),
      default_visibility: 'private',
      retention_days: 30,
      redaction_extensions: ['SECRET_[A-Z]+'],
    };
    await writeRepoConfig(repo, value);
    const reread = await readRepoConfig(repo);
    expect(reread).toEqual(value);
    const onDisk = await readFile(join(repo, '.drev', 'config.yaml'), 'utf8');
    expect(onDisk).toContain('team_name: writer-team');
  });

  it('preserves unknown extras through write+read', async () => {
    const repo = await makeTmp('drev-repo-');
    const value: RepoConfig = {
      ...defaultRepoConfig('extras-team'),
      future_field: 'present',
    };
    await writeRepoConfig(repo, value);
    const reread = await readRepoConfig(repo);
    expect(reread['future_field']).toBe('present');
  });

  it('creates the .drev directory if missing', async () => {
    const repo = await makeTmp('drev-repo-');
    await writeRepoConfig(repo, defaultRepoConfig('fresh-team'));
    const onDisk = await readFile(join(repo, '.drev', 'config.yaml'), 'utf8');
    expect(onDisk).toContain('schema_version: 1');
  });
});
