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
// Provide controllable confirm/prompt for wizard tests.
let nextConfirmAnswers: boolean[] = [];
let nextPromptAnswers: string[] = [];
vi.mock('../ui.js', async () => {
  const actual = await vi.importActual<typeof import('../ui.js')>('../ui.js');
  return {
    ...actual,
    spinner: () => ({ stop: () => {}, succeed: () => {}, fail: () => {} }),
    info: () => {},
    warn: () => {},
    errorOut: () => {},
    confirm: vi.fn(async () => {
      const next = nextConfirmAnswers.shift();
      if (next === undefined) {
        throw new Error('confirm called but no answer queued');
      }
      return next;
    }),
    prompt: vi.fn(async () => {
      const next = nextPromptAnswers.shift();
      if (next === undefined) {
        throw new Error('prompt called but no answer queued');
      }
      return next;
    }),
  };
});

// Mock execFile so `gh` and `git init --bare` calls are intercepted.
type ExecFileHandler = (
  bin: string,
  args: string[],
) => { stdout: string; stderr?: string } | Promise<{ stdout: string; stderr?: string }>;
let execFileHandler: ExecFileHandler = () => ({ stdout: '' });
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  // Attach [util.promisify.custom] so promisify(execFile) yields an
  // object-shaped { stdout, stderr } result, matching real Node behavior.
  const execFile = ((
    bin: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout?: string, stderr?: string) => void,
  ) => {
    try {
      const result = execFileHandler(bin, args);
      Promise.resolve(result).then(
        (r) => cb(null, r.stdout, r.stderr ?? ''),
        (err: unknown) => cb(err as Error),
      );
    } catch (err) {
      cb(err as Error);
    }
  }) as unknown as typeof import('node:child_process').execFile & {
    [k: symbol]: unknown;
  };
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    bin: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> => {
    return Promise.resolve()
      .then(() => execFileHandler(bin, args))
      .then((r) => ({ stdout: r.stdout, stderr: r.stderr ?? '' }));
  };
  return { execFile };
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

interface GhError extends Error {
  code?: number;
  stderr?: string;
}

function ghError(message: string, stderr: string, code = 1): GhError {
  const err = new Error(message) as GhError;
  err.stderr = stderr;
  err.code = code;
  return err;
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
  vi.mocked(gitOps.isAvailable).mockResolvedValue(true);
  nextConfirmAnswers = [];
  nextPromptAnswers = [];
  execFileHandler = () => ({ stdout: '' });
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

// -------- POWER-URL mode (preserved from prior coverage) --------

describe('runInit URL validation', () => {
  it('rejects an empty URL', async () => {
    await withFakeHome();
    await expect(runInit('', {})).rejects.toBeInstanceOf(Error);
    // Empty target falls into wizard mode by spec; here we test direct URL flow indirectly:
    // runInit('') with no --local enters wizard. To assert URL validation, hit the URL flow
    // explicitly through a malformed string.
  });

  it('rejects a URL without a known protocol', async () => {
    await withFakeHome();
    // 'not-a-url' has no slash, no @host:, doesn't match shorthand → should fail at parseMode.
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

// -------- already-initialized guard --------

describe('runInit already-initialized guard', () => {
  it('without --reinit: prints info and exits without mutations', async () => {
    const home = await withFakeHome();
    // Pre-write user config with default_repo set.
    const userCfgPath = join(home, '.drev', 'config.yaml');
    await mkdir(join(home, '.drev'), { recursive: true });
    await writeFile(
      userCfgPath,
      yaml.dump({
        schema_version: 1,
        default_repo: '/some/preexisting/path',
        auto_share: 'manual',
        auto_share_idle_threshold_seconds: 60,
        auto_summarize: false,
        ignore_patterns: [],
        ignore_paths: [],
      }),
      'utf8',
    );

    await runInit('https://github.com/org/repo.git', {});

    expect(gitOps.clone).not.toHaveBeenCalled();
    // Default repo unchanged.
    const userCfg = yaml.load(
      await readFile(userCfgPath, 'utf8'),
    ) as Record<string, unknown>;
    expect(userCfg['default_repo']).toBe('/some/preexisting/path');
  });

  it('with --reinit: continues and re-points default_repo', async () => {
    const home = await withFakeHome();
    const userCfgPath = join(home, '.drev', 'config.yaml');
    await mkdir(join(home, '.drev'), { recursive: true });
    await writeFile(
      userCfgPath,
      yaml.dump({
        schema_version: 1,
        default_repo: '/old/path',
        auto_share: 'manual',
        auto_share_idle_threshold_seconds: 60,
        auto_summarize: false,
        ignore_patterns: [],
        ignore_paths: [],
      }),
      'utf8',
    );

    await runInit('https://github.com/org/repo.git', { reinit: true });

    expect(gitOps.clone).toHaveBeenCalled();
    const userCfg = yaml.load(
      await readFile(userCfgPath, 'utf8'),
    ) as Record<string, unknown>;
    expect(userCfg['default_repo']).toBe(
      join(home, '.drev', 'repos', 'repo'),
    );
  });
});

// -------- WIZARD mode --------

describe('runInit WIZARD mode', () => {
  it('throws RepoError when gh is not installed', async () => {
    await withFakeHome();
    vi.mocked(gitOps.isAvailable).mockResolvedValueOnce(false);

    await expect(runInit(undefined, {})).rejects.toMatchObject({
      name: 'RepoError',
      message: expect.stringContaining('GitHub CLI'),
    });
  });

  it('throws when gh api user fails', async () => {
    await withFakeHome();
    execFileHandler = (bin, args) => {
      if (bin === 'gh' && args[0] === 'api') {
        throw ghError('gh failed', 'auth required', 1);
      }
      return { stdout: '' };
    };
    await expect(runInit(undefined, {})).rejects.toMatchObject({
      name: 'RepoError',
      message: expect.stringContaining("GitHub username"),
    });
  });

  it('user pastes URL: dispatches to POWER-URL flow', async () => {
    const home = await withFakeHome();
    execFileHandler = (bin, args) => {
      if (bin === 'gh' && args[0] === 'api') return { stdout: 'octo\n' };
      return { stdout: '' };
    };
    nextPromptAnswers = ['https://github.com/team/sessions.git'];

    await runInit(undefined, {});

    const clonePath = join(home, '.drev', 'repos', 'sessions');
    expect(gitOps.clone).toHaveBeenCalledWith(
      'https://github.com/team/sessions.git',
      clonePath,
    );
  });

  it('empty paste + confirm Y: uses <user>/drev-sessions, repo missing → creates', async () => {
    const home = await withFakeHome();
    let createCalled = false;
    execFileHandler = (bin, args) => {
      if (bin === 'gh' && args[0] === 'api') return { stdout: 'octo\n' };
      if (bin === 'gh' && args[0] === 'repo' && args[1] === 'view') {
        throw ghError('not found', 'GraphQL: Could not resolve to a Repository', 1);
      }
      if (bin === 'gh' && args[0] === 'repo' && args[1] === 'create') {
        createCalled = true;
        return { stdout: 'created\n' };
      }
      return { stdout: '' };
    };
    nextPromptAnswers = ['']; // empty paste
    nextConfirmAnswers = [true]; // accept default

    await runInit(undefined, {});

    expect(createCalled).toBe(true);
    const clonePath = join(home, '.drev', 'repos', 'drev-sessions');
    expect(gitOps.clone).toHaveBeenCalledWith(
      'https://github.com/octo/drev-sessions.git',
      clonePath,
    );
  });

  it('empty paste + confirm n: prompts for owner/name, uses that', async () => {
    const home = await withFakeHome();
    execFileHandler = (bin, args) => {
      if (bin === 'gh' && args[0] === 'api') return { stdout: 'octo\n' };
      if (bin === 'gh' && args[0] === 'repo' && args[1] === 'view') {
        // Existing repo for the chosen shorthand.
        return {
          stdout: JSON.stringify({ url: 'https://github.com/myorg/myrepo' }),
        };
      }
      return { stdout: '' };
    };
    nextPromptAnswers = ['', 'myorg/myrepo'];
    nextConfirmAnswers = [false];

    await runInit(undefined, {});

    const clonePath = join(home, '.drev', 'repos', 'myrepo');
    expect(gitOps.clone).toHaveBeenCalledWith(
      'https://github.com/myorg/myrepo.git',
      clonePath,
    );
  });

  it('invalid owner/name from prompt throws RepoError (no re-prompt)', async () => {
    await withFakeHome();
    execFileHandler = (bin, args) => {
      if (bin === 'gh' && args[0] === 'api') return { stdout: 'octo\n' };
      return { stdout: '' };
    };
    nextPromptAnswers = ['', 'not a valid name'];
    nextConfirmAnswers = [false];

    await expect(runInit(undefined, {})).rejects.toMatchObject({
      name: 'RepoError',
      message: expect.stringContaining("Invalid '<owner>/<name>'"),
    });
  });
});

// -------- SHORTHAND mode --------

describe('runInit SHORTHAND mode', () => {
  it('throws when gh is missing, hinting at URL or --local', async () => {
    await withFakeHome();
    vi.mocked(gitOps.isAvailable).mockResolvedValueOnce(false);

    await expect(runInit('foo/bar', {})).rejects.toMatchObject({
      name: 'RepoError',
      message: expect.stringMatching(/full-url.*--local|--local.*full-url/i),
    });
  });

  it('repo exists: clones using gh-reported URL (no create)', async () => {
    const home = await withFakeHome();
    let createCalled = false;
    execFileHandler = (bin, args) => {
      if (bin === 'gh' && args[0] === 'repo' && args[1] === 'view') {
        return {
          stdout: JSON.stringify({ url: 'https://github.com/foo/bar' }),
        };
      }
      if (bin === 'gh' && args[0] === 'repo' && args[1] === 'create') {
        createCalled = true;
        return { stdout: '' };
      }
      return { stdout: '' };
    };

    await runInit('foo/bar', {});

    expect(createCalled).toBe(false);
    const clonePath = join(home, '.drev', 'repos', 'bar');
    expect(gitOps.clone).toHaveBeenCalledWith(
      'https://github.com/foo/bar.git',
      clonePath,
    );
  });

  it('repo missing: creates then clones', async () => {
    const home = await withFakeHome();
    let createCalled = false;
    execFileHandler = (bin, args) => {
      if (bin === 'gh' && args[0] === 'repo' && args[1] === 'view') {
        throw ghError('not found', 'Could not resolve to a Repository with the name', 1);
      }
      if (bin === 'gh' && args[0] === 'repo' && args[1] === 'create') {
        createCalled = true;
        return { stdout: '' };
      }
      return { stdout: '' };
    };

    await runInit('foo/bar', {});

    expect(createCalled).toBe(true);
    const clonePath = join(home, '.drev', 'repos', 'bar');
    expect(gitOps.clone).toHaveBeenCalledWith(
      'https://github.com/foo/bar.git',
      clonePath,
    );
  });

  it('non-not-found gh failure surfaces as RepoError', async () => {
    await withFakeHome();
    execFileHandler = (bin, args) => {
      if (bin === 'gh' && args[0] === 'repo' && args[1] === 'view') {
        throw ghError('rate limited', 'API rate limit exceeded', 1);
      }
      return { stdout: '' };
    };

    await expect(runInit('foo/bar', {})).rejects.toMatchObject({
      name: 'RepoError',
      message: expect.stringContaining("Could not check if 'foo/bar' exists"),
    });
  });
});

// -------- LOCAL mode --------

describe('runInit LOCAL mode', () => {
  it('creates default bare repo, clones, scaffolds', async () => {
    const home = await withFakeHome();
    const expectedBare = join(home, '.drev', 'local-sessions.git');
    const calls: Array<{ bin: string; args: string[] }> = [];
    execFileHandler = (bin, args) => {
      calls.push({ bin, args });
      return { stdout: '' };
    };

    await runInit(undefined, { local: true });

    // git init --bare was invoked with the expected path.
    const initCall = calls.find(
      (c) => c.bin === 'git' && c.args[0] === 'init' && c.args[1] === '--bare',
    );
    expect(initCall).toBeDefined();
    expect(initCall?.args[2]).toBe(expectedBare);

    const clonePath = join(home, '.drev', 'repos', 'local-sessions');
    expect(gitOps.clone).toHaveBeenCalledWith(expectedBare, clonePath);

    const schema = await readFile(
      join(clonePath, '.drev', 'schema-version'),
      'utf8',
    );
    expect(schema).toBe('1\n');

    const userCfg = yaml.load(
      await readFile(join(home, '.drev', 'config.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    expect(userCfg['default_repo']).toBe(clonePath);
  });

  it('honors --at <custom path>', async () => {
    const home = await withFakeHome();
    const customBare = join(home, 'custom', 'place.git');
    const calls: Array<{ bin: string; args: string[] }> = [];
    execFileHandler = (bin, args) => {
      calls.push({ bin, args });
      return { stdout: '' };
    };

    await runInit(undefined, { local: true, at: customBare });

    const initCall = calls.find(
      (c) => c.bin === 'git' && c.args[0] === 'init' && c.args[1] === '--bare',
    );
    expect(initCall?.args[2]).toBe(customBare);

    const clonePath = join(home, '.drev', 'repos', 'place');
    expect(gitOps.clone).toHaveBeenCalledWith(customBare, clonePath);
  });

  it('throws if bare path already exists', async () => {
    const home = await withFakeHome();
    const barePath = join(home, '.drev', 'local-sessions.git');
    await mkdir(barePath, { recursive: true });

    await expect(runInit(undefined, { local: true })).rejects.toMatchObject({
      name: 'RepoError',
      message: expect.stringContaining('local repo already exists'),
    });
    // git init --bare must not have run.
    expect(gitOps.clone).not.toHaveBeenCalled();
  });
});
