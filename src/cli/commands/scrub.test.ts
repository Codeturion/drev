import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnershipError, RepoError } from '../../lib/errors.js';
import type { SessionMeta } from '../../core/metadata.js';

// --- Mocks --------------------------------------------------------------

// execFile is what runScrub uses for the force-push. We intercept it so no
// real `git` is ever spawned during tests.
vi.mock('node:child_process', () => {
  return {
    execFile: vi.fn(),
  };
});

vi.mock('../../core/git-ops.js', () => {
  return {
    pullRebase: vi.fn(async () => {}),
    isAvailable: vi.fn(async () => true),
    filterRepo: vi.fn(async () => {}),
  };
});

vi.mock('../../core/repo.js', () => {
  return {
    listMetaFiles: vi.fn(async () => [
      '/repo/users/alice/2026-04-30-auth/meta.yaml',
    ]),
  };
});

vi.mock('../../core/name-resolver.js', () => {
  return {
    resolve: vi.fn(),
  };
});

vi.mock('../../core/identity.js', () => {
  return {
    currentUserEmail: vi.fn(async () => 'alice@example.com'),
  };
});

vi.mock('../../core/config.js', () => {
  return {
    readUserConfig: vi.fn(async () => ({
      schema_version: 1,
      default_repo: '/repo',
      auto_share: 'manual',
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
      auto_share_projects: [],
    })),
  };
});

vi.mock('../ui.js', () => {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    errorOut: vi.fn(),
  };
});

// --- Imports under test (after mocks) -----------------------------------

import { runScrub } from './scrub.js';
import * as gitOps from '../../core/git-ops.js';
import * as nameResolver from '../../core/name-resolver.js';
import * as identity from '../../core/identity.js';
import * as childProcess from 'node:child_process';
import * as ui from '../ui.js';

// --- Helpers ------------------------------------------------------------

function buildMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    schema_version: 1,
    id: '7f3a2b1c-1234-5678-90ab-cdef01234567',
    name: 'auth-refactor',
    purpose: 'share',
    user: 'alice',
    user_email: 'alice@example.com',
    project_root: '/Users/alice/work/proj',
    created_at: '2026-04-30T14:32:00Z',
    shared_at: '2026-04-30T18:15:00Z',
    visibility: 'team',
    turns: 1,
    size_bytes: 100,
    redactions: [],
    ...overrides,
  };
}

function setResolvedSession(meta: SessionMeta): void {
  vi.mocked(nameResolver.resolve).mockResolvedValue({
    metaPath: '/repo/users/alice/2026-04-30-auth/meta.yaml',
    meta,
  });
}

// execFile is invoked through util.promisify, which calls execFile with a
// trailing callback. We accept any signature and complete the callback so
// promisify resolves.
type ExecFileCb = (
  err: Error | null,
  stdout?: string | Buffer,
  stderr?: string | Buffer,
) => void;

function mockExecFileSuccess(): void {
  vi.mocked(childProcess.execFile).mockImplementation(
    ((_bin: string, _args: readonly string[], _opts: unknown, cb?: ExecFileCb) => {
      // promisify always passes the callback last; node accepts (cmd, args, opts, cb)
      // or (cmd, args, cb). When opts is the function, swap.
      const callback: ExecFileCb | undefined =
        typeof _opts === 'function' ? (_opts as ExecFileCb) : cb;
      if (callback) callback(null, '', '');
      return {} as ReturnType<typeof childProcess.execFile>;
    }) as unknown as typeof childProcess.execFile,
  );
}

function mockExecFileFailure(stderr: string): void {
  vi.mocked(childProcess.execFile).mockImplementation(
    ((_bin: string, _args: readonly string[], _opts: unknown, cb?: ExecFileCb) => {
      const callback: ExecFileCb | undefined =
        typeof _opts === 'function' ? (_opts as ExecFileCb) : cb;
      if (callback) {
        const err = new Error('Command failed') as Error & { stderr?: string };
        err.stderr = stderr;
        callback(err, '', stderr);
      }
      return {} as ReturnType<typeof childProcess.execFile>;
    }) as unknown as typeof childProcess.execFile,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitOps.pullRebase).mockResolvedValue(undefined);
  vi.mocked(gitOps.isAvailable).mockResolvedValue(true);
  vi.mocked(gitOps.filterRepo).mockResolvedValue(undefined);
  vi.mocked(identity.currentUserEmail).mockResolvedValue('alice@example.com');
  setResolvedSession(buildMeta());
  mockExecFileSuccess();
});

afterEach(() => {
  vi.clearAllMocks();
});

// --- Tests --------------------------------------------------------------

describe('runScrub without --confirm', () => {
  it('prints explanation and performs no mutations', async () => {
    await runScrub('auth-refactor', {});

    expect(gitOps.filterRepo).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(gitOps.isAvailable).not.toHaveBeenCalled();

    // Explanation must mention history rewrite, force-push, re-clone, and --confirm.
    const infoCalls = vi.mocked(ui.info).mock.calls.map((c) => String(c[0]));
    const joined = infoCalls.join('\n').toLowerCase();
    expect(joined).toContain('rewrite');
    expect(joined).toContain('force-push');
    expect(joined).toContain('re-clone');
    expect(joined).toContain('--confirm');
  });

  it('still resolves the session and verifies ownership', async () => {
    await runScrub('auth-refactor', {});
    expect(nameResolver.resolve).toHaveBeenCalled();
    expect(identity.currentUserEmail).toHaveBeenCalled();
  });
});

describe('runScrub ownership', () => {
  it('rejects when the session belongs to someone else', async () => {
    setResolvedSession(buildMeta({ user_email: 'bob@example.com' }));

    await expect(runScrub('auth-refactor', { confirm: true })).rejects.toBeInstanceOf(
      OwnershipError,
    );
    expect(gitOps.filterRepo).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it('rejects ownership even without --confirm (no exit before ownership check)', async () => {
    setResolvedSession(buildMeta({ user_email: 'bob@example.com' }));
    await expect(runScrub('auth-refactor', {})).rejects.toBeInstanceOf(
      OwnershipError,
    );
  });
});

describe('runScrub with --confirm', () => {
  it('throws RepoError with install hint when git-filter-repo is missing', async () => {
    vi.mocked(gitOps.isAvailable).mockResolvedValue(false);

    await expect(
      runScrub('auth-refactor', { confirm: true }),
    ).rejects.toMatchObject({
      name: 'RepoError',
      message: expect.stringContaining('git-filter-repo not found'),
    });
    const err = await runScrub('auth-refactor', { confirm: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RepoError);
    expect((err as RepoError).message).toContain('pip install git-filter-repo');
    expect((err as RepoError).message).toContain('brew install git-filter-repo');

    expect(gitOps.filterRepo).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it('happy path: filterRepo with correct args, force-push attempted, warning printed', async () => {
    await runScrub('auth-refactor', { confirm: true });

    // git-filter-repo invocation
    expect(gitOps.filterRepo).toHaveBeenCalledTimes(1);
    expect(gitOps.filterRepo).toHaveBeenCalledWith(
      '/repo',
      ['--path', 'users/alice/2026-04-30-auth', '--invert-paths'],
    );

    // Force-push: execFile called with ['git', 'push', '--force'], shell never enabled.
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);
    const call = vi.mocked(childProcess.execFile).mock.calls[0]!;
    expect(call[0]).toBe('git');
    expect(call[1]).toEqual(['push', '--force']);
    const optsArg = call[2];
    expect(optsArg).toBeDefined();
    // Must run in the repo dir, must NOT enable shell.
    if (optsArg && typeof optsArg === 'object' && !Array.isArray(optsArg)) {
      const opts = optsArg as { cwd?: string; shell?: unknown };
      expect(opts.cwd).toBe('/repo');
      expect(opts.shell).toBeUndefined();
    }

    // Final warning about re-cloning.
    const warnCalls = vi.mocked(ui.warn).mock.calls.map((c) => String(c[0]));
    const joinedWarns = warnCalls.join('\n');
    expect(joinedWarns).toContain('re-clone');
  });

  it('wraps force-push failure as RepoError', async () => {
    mockExecFileFailure('remote rejected');

    await expect(
      runScrub('auth-refactor', { confirm: true }),
    ).rejects.toMatchObject({
      name: 'RepoError',
      message: expect.stringContaining('git push --force failed'),
    });

    // filterRepo did run before the failed push.
    expect(gitOps.filterRepo).toHaveBeenCalledTimes(1);
  });
});

describe('runScrub pull failure handling', () => {
  // Choice: a failing `git pull --rebase` is logged via ui.warn and execution
  // continues. Scrub is an emergency hatch; an unreachable remote should not
  // block the local rewrite. The user still has to pass --confirm before any
  // mutation occurs, so the pull failure is informational only.
  it('warns and continues when pull --rebase fails (without --confirm)', async () => {
    vi.mocked(gitOps.pullRebase).mockRejectedValueOnce(
      new RepoError('pull failed: connection refused'),
    );

    await runScrub('auth-refactor', {});

    const warnCalls = vi.mocked(ui.warn).mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes('pull --rebase failed'))).toBe(true);
    // Still ran resolution after the warned-about pull failure.
    expect(nameResolver.resolve).toHaveBeenCalled();
  });

  it('warns and continues when pull --rebase fails (with --confirm)', async () => {
    vi.mocked(gitOps.pullRebase).mockRejectedValueOnce(
      new RepoError('pull failed: connection refused'),
    );

    await runScrub('auth-refactor', { confirm: true });

    expect(gitOps.filterRepo).toHaveBeenCalledTimes(1);
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);
  });
});
