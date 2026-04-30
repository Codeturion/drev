import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { RepoError } from '../../lib/errors.js';

// Mock git-ops exhaustively so no real git is invoked.
vi.mock('../../core/git-ops.js', () => {
  return {
    clone: vi.fn(async (_url: string, dest: string) => {
      // Real git clone creates the destination directory; mimic that so existence
      // checks and scaffold writes behave realistically.
      await mkdir(dest, { recursive: true });
    }),
    remoteShowDefaultBranch: vi.fn(async () => 'main'),
    add: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    push: vi.fn(async () => {}),
    pullRebase: vi.fn(async () => {}),
    mv: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    revParse: vi.fn(async () => 'sha'),
    showTopLevel: vi.fn(async () => null),
    configGet: vi.fn(async () => null),
    filterRepo: vi.fn(async () => {}),
    isAvailable: vi.fn(async () => true),
  };
});

// Suppress ora/spinner side effects (it writes to the TTY).
vi.mock('../ui.js', async () => {
  const actual = await vi.importActual<typeof import('../ui.js')>('../ui.js');
  return {
    ...actual,
    spinner: () => ({ stop: () => {}, succeed: () => {}, fail: () => {} }),
    info: () => {},
    warn: () => {},
    errorOut: () => {},
  };
});

import * as gitOps from '../../core/git-ops.js';
import { runInit } from './init.js';

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const ORIGINAL_HOME = process.env['HOME'];
const ORIGINAL_USERPROFILE = process.env['USERPROFILE'];

async function withFakeHome(): Promise<string> {
  const home = await makeTmp('drev-home-');
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  return home;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Ensure clone() default mimics directory creation between tests.
  vi.mocked(gitOps.clone).mockImplementation(async (_url, dest) => {
    await mkdir(dest, { recursive: true });
  });
  vi.mocked(gitOps.remoteShowDefaultBranch).mockResolvedValue('main');
  vi.mocked(gitOps.add).mockResolvedValue(undefined);
  vi.mocked(gitOps.commit).mockResolvedValue(undefined);
  vi.mocked(gitOps.push).mockResolvedValue(undefined);
});

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (!d) continue;
    await rm(d, { recursive: true, force: true });
  }
  if (ORIGINAL_HOME === undefined) delete process.env['HOME'];
  else process.env['HOME'] = ORIGINAL_HOME;
  if (ORIGINAL_USERPROFILE === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = ORIGINAL_USERPROFILE;
});

describe('runInit URL validation', () => {
  it('rejects an empty URL', async () => {
    await withFakeHome();
    await expect(runInit('', {})).rejects.toBeInstanceOf(RepoError);
  });

  it('rejects a URL without a known protocol', async () => {
    await withFakeHome();
    await expect(runInit('not-a-url', {})).rejects.toBeInstanceOf(RepoError);
  });

  it('rejects a file path', async () => {
    await withFakeHome();
    await expect(runInit('/some/local/path', {})).rejects.toBeInstanceOf(RepoError);
  });

  it('accepts https URLs', async () => {
    await withFakeHome();
    await expect(
      runInit('https://github.com/org/repo.git', {}),
    ).resolves.toBeUndefined();
  });

  it('accepts ssh URLs', async () => {
    await withFakeHome();
    await expect(
      runInit('ssh://git@github.com/org/repo.git', {}),
    ).resolves.toBeUndefined();
  });

  it('accepts scp-style URLs', async () => {
    await withFakeHome();
    await expect(
      runInit('git@github.com:org/repo.git', {}),
    ).resolves.toBeUndefined();
  });

  it('accepts git protocol URLs', async () => {
    await withFakeHome();
    await expect(
      runInit('git://example.com/foo.git', {}),
    ).resolves.toBeUndefined();
  });
});

describe('runInit clone-path collision', () => {
  it('errors when ~/.drev/repos/<name> already exists', async () => {
    const home = await withFakeHome();
    const existing = join(home, '.drev', 'repos', 'repo');
    await mkdir(existing, { recursive: true });

    await expect(
      runInit('https://github.com/org/repo.git', {}),
    ).rejects.toMatchObject({
      name: 'RepoError',
      message: expect.stringContaining('already initialized'),
    });
    expect(gitOps.clone).not.toHaveBeenCalled();
  });

  it('honors --name when computing the clone path', async () => {
    const home = await withFakeHome();
    await runInit('https://github.com/org/repo.git', { name: 'custom-dir' });
    const expected = join(home, '.drev', 'repos', 'custom-dir');
    expect(gitOps.clone).toHaveBeenCalledWith(
      'https://github.com/org/repo.git',
      expected,
    );
  });
});

describe('runInit happy path (fresh remote, no .drev/)', () => {
  it('clones, scaffolds, commits, pushes, updates user config', async () => {
    const home = await withFakeHome();
    await runInit('https://github.com/org/team-sessions.git', {});

    const clonePath = join(home, '.drev', 'repos', 'team-sessions');
    expect(gitOps.clone).toHaveBeenCalledWith(
      'https://github.com/org/team-sessions.git',
      clonePath,
    );
    expect(gitOps.remoteShowDefaultBranch).toHaveBeenCalledWith(clonePath);

    // Scaffold present
    const schema = await readFile(
      join(clonePath, '.drev', 'schema-version'),
      'utf8',
    );
    expect(schema).toBe('1\n');
    const repoCfg = yaml.load(
      await readFile(join(clonePath, '.drev', 'config.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    expect(repoCfg['team_name']).toBe('team-sessions');

    // Commit & push were attempted
    expect(gitOps.add).toHaveBeenCalledTimes(1);
    expect(gitOps.commit).toHaveBeenCalledWith(clonePath, 'init drev');
    expect(gitOps.push).toHaveBeenCalledWith(clonePath);

    // User config updated
    const userCfgRaw = await readFile(join(home, '.drev', 'config.yaml'), 'utf8');
    const userCfg = yaml.load(userCfgRaw) as Record<string, unknown>;
    expect(userCfg['default_repo']).toBe(clonePath);
  });

  it('strips a trailing slash from the URL when deriving the name', async () => {
    const home = await withFakeHome();
    await runInit('https://github.com/org/team-sessions/', {});
    const clonePath = join(home, '.drev', 'repos', 'team-sessions');
    expect(gitOps.clone).toHaveBeenCalledWith(
      'https://github.com/org/team-sessions/',
      clonePath,
    );
  });
});

describe('runInit into a remote that already has .drev/', () => {
  it('skips commit/push and validates schema via ensureScaffold', async () => {
    const home = await withFakeHome();
    const clonePath = join(home, '.drev', 'repos', 'existing');

    // Make clone() pre-populate a valid Drev scaffold to simulate the remote.
    vi.mocked(gitOps.clone).mockImplementationOnce(async (_url, dest) => {
      await mkdir(join(dest, '.drev'), { recursive: true });
      await writeFile(join(dest, '.drev', 'schema-version'), '1\n', 'utf8');
      await writeFile(
        join(dest, '.drev', 'config.yaml'),
        yaml.dump({
          schema_version: 1,
          team_name: 'existing',
          default_visibility: 'team',
          retention_days: 365,
          redaction_extensions: [],
        }),
        'utf8',
      );
      await mkdir(join(dest, 'users'), { recursive: true });
      await writeFile(join(dest, 'users', '.gitkeep'), '', 'utf8');
    });

    await runInit('https://example.com/org/existing.git', {});

    expect(gitOps.clone).toHaveBeenCalledWith(
      'https://example.com/org/existing.git',
      clonePath,
    );
    // No new commit when scaffold already existed.
    expect(gitOps.add).not.toHaveBeenCalled();
    expect(gitOps.commit).not.toHaveBeenCalled();
    expect(gitOps.push).not.toHaveBeenCalled();

    const userCfg = yaml.load(
      await readFile(join(home, '.drev', 'config.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    expect(userCfg['default_repo']).toBe(clonePath);
  });

  it('propagates a schema-version mismatch as RepoError', async () => {
    await withFakeHome();
    vi.mocked(gitOps.clone).mockImplementationOnce(async (_url, dest) => {
      await mkdir(join(dest, '.drev'), { recursive: true });
      await writeFile(join(dest, '.drev', 'schema-version'), '99\n', 'utf8');
    });

    await expect(
      runInit('https://example.com/org/future.git', {}),
    ).rejects.toMatchObject({
      name: 'RepoError',
      message: expect.stringContaining('SCHEMA_VERSION_MISMATCH'),
    });
  });
});

describe('runInit when push of scaffold fails', () => {
  it('warns but still succeeds and updates user config', async () => {
    const home = await withFakeHome();
    vi.mocked(gitOps.push).mockRejectedValueOnce(
      new RepoError('git push failed: remote rejected'),
    );

    await expect(
      runInit('https://github.com/org/repo.git', {}),
    ).resolves.toBeUndefined();

    const clonePath = join(home, '.drev', 'repos', 'repo');
    // Commit was still attempted; only push failed.
    expect(gitOps.commit).toHaveBeenCalledWith(clonePath, 'init drev');
    expect(gitOps.push).toHaveBeenCalledTimes(1);

    const userCfg = yaml.load(
      await readFile(join(home, '.drev', 'config.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    expect(userCfg['default_repo']).toBe(clonePath);
  });
});
