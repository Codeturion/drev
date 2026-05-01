import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionError } from '../../lib/errors.js';
import { encodedCwd } from '../../core/claude-paths.js';
import type { SessionMeta } from '../../core/metadata.js';

// --- Mocks --------------------------------------------------------------

vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
  };
});

vi.mock('../../core/git-ops.js', () => {
  return {
    pullRebase: vi.fn(async () => {}),
    revParse: vi.fn(async () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    showTopLevel: vi.fn(async () => null),
    isAvailable: vi.fn(async () => true),
    isClean: vi.fn(async () => true),
    stashPush: vi.fn(async () => {}),
    checkout: vi.fn(async () => {}),
  };
});

vi.mock('../../core/repo.js', () => {
  return {
    listMetaFiles: vi.fn(async () => ['/repo/users/alice/2026-04-30-auth/meta.yaml']),
  };
});

vi.mock('../../core/name-resolver.js', () => {
  return {
    resolve: vi.fn(),
  };
});

vi.mock('../../core/path-rewriter.js', () => {
  return {
    rewritePaths: vi.fn((jsonl: string, src: string, dst: string) =>
      jsonl.split(src).join(dst),
    ),
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

vi.mock('node:fs/promises', async (orig) => {
  const real = (await orig()) as typeof import('node:fs/promises');
  return {
    ...real,
    readFile: vi.fn(),
    readdir: vi.fn(async () => []),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    // Default: target path does not exist; tests opt in by overriding.
    stat: vi.fn(async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }),
  };
});

vi.mock('../ui.js', () => {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    errorOut: vi.fn(),
    confirm: vi.fn(async () => false),
    isInteractive: vi.fn(() => true),
  };
});

// --- Imports under test (after mocks) -----------------------------------

import { runResume } from './resume.js';
import * as gitOps from '../../core/git-ops.js';
import * as nameResolver from '../../core/name-resolver.js';
import * as pathRewriter from '../../core/path-rewriter.js';
import * as fsPromises from 'node:fs/promises';
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

function makeFakeChild(): EventEmitter & { kill: () => void } {
  const ee = new EventEmitter() as EventEmitter & { kill: () => void };
  ee.kill = (): void => {};
  return ee;
}

function captureStdout(): { restore: () => void; output: () => string } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((data: unknown) => {
    chunks.push(typeof data === 'string' ? data : String(data));
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = original;
    },
    output: () => chunks.join(''),
  };
}

// --- Tests --------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default mock behaviors.
  vi.mocked(gitOps.pullRebase).mockResolvedValue(undefined);
  vi.mocked(gitOps.revParse).mockResolvedValue(
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );
  vi.mocked(gitOps.showTopLevel).mockResolvedValue(null);
  vi.mocked(gitOps.isAvailable).mockResolvedValue(true);
  vi.mocked(gitOps.isClean).mockResolvedValue(true);
  vi.mocked(gitOps.stashPush).mockResolvedValue(undefined);
  vi.mocked(gitOps.checkout).mockResolvedValue(undefined);

  vi.mocked(nameResolver.resolve).mockResolvedValue({
    metaPath: '/repo/users/alice/2026-04-30-auth/meta.yaml',
    meta: buildMeta(),
  });

  vi.mocked(pathRewriter.rewritePaths).mockImplementation(
    (jsonl: string, src: string, dst: string) => jsonl.split(src).join(dst),
  );

  vi.mocked(fsPromises.readFile).mockImplementation(async (p: unknown) => {
    const path = String(p);
    if (path.endsWith('session.jsonl')) {
      return '{"type":"user","cwd":"/Users/alice/work/proj"}\n';
    }
    return '';
  });
  vi.mocked(fsPromises.readdir).mockResolvedValue([] as never);
  vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined as never);
  vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined as never);
  // Default: target path does not exist (ENOENT). Tests can override.
  vi.mocked(fsPromises.stat).mockImplementation(async () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });

  vi.mocked(ui.confirm).mockResolvedValue(false);
  vi.mocked(ui.isInteractive).mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runResume — happy path with --no-launch', () => {
  it('prepares the session and prints fallback when --no-launch is set', async () => {
    const cap = captureStdout();
    try {
      await runResume('auth', { into: '/Users/bob/work/proj', launch: false });
    } finally {
      cap.restore();
    }

    // pullRebase called on the configured repo
    expect(gitOps.pullRebase).toHaveBeenCalledWith('/repo');

    // resolve called with query and meta files
    expect(nameResolver.resolve).toHaveBeenCalledWith('auth', [
      '/repo/users/alice/2026-04-30-auth/meta.yaml',
    ]);

    // path rewriter applied to parent jsonl
    expect(pathRewriter.rewritePaths).toHaveBeenCalledWith(
      expect.any(String),
      '/Users/alice/work/proj',
      '/Users/bob/work/proj',
    );

    // mkdir called on encoded-cwd target dir
    const expectedDir = join(
      homedir(),
      '.claude',
      'projects',
      encodedCwd('/Users/bob/work/proj'),
    );
    expect(fsPromises.mkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });

    // writeFile called for the parent jsonl at <dir>/<id>.jsonl
    const expectedParent = join(
      expectedDir,
      '7f3a2b1c-1234-5678-90ab-cdef01234567.jsonl',
    );
    expect(fsPromises.writeFile).toHaveBeenCalledWith(
      expectedParent,
      expect.stringContaining('/Users/bob/work/proj'),
      'utf8',
    );

    // info called with "Resuming '<name>'..."
    expect(ui.info).toHaveBeenCalledWith(
      "Resuming 'auth-refactor' in /Users/bob/work/proj...",
    );

    // Spawn was NOT called (we used --no-launch)
    expect(childProcess.spawn).not.toHaveBeenCalled();

    // Fallback printed
    const out = cap.output();
    expect(out).toContain('Session prepared but Claude Code was not launched automatically.');
    expect(out).toContain('Run this command from /Users/bob/work/proj:');
    expect(out).toContain('claude --resume 7f3a2b1c-1234-5678-90ab-cdef01234567');
  });
});

describe('runResume — --into override', () => {
  it('uses --into over showTopLevel when both are available', async () => {
    vi.mocked(gitOps.showTopLevel).mockResolvedValue('/Users/bob/auto-detected');

    await runResume('auth', { into: '/explicit/dest', launch: false });

    // path rewriter should have been called with the --into value, not the auto-detected one.
    expect(pathRewriter.rewritePaths).toHaveBeenCalledWith(
      expect.any(String),
      '/Users/alice/work/proj',
      '/explicit/dest',
    );
  });

  it('falls back to process.cwd() when neither --into nor showTopLevel yields a destination', async () => {
    vi.mocked(gitOps.showTopLevel).mockResolvedValue(null);

    const cap = captureStdout();
    try {
      await runResume('auth', { launch: false });
    } finally {
      cap.restore();
    }

    // path-rewriter should have been called with cwd as the destination root.
    const calls = vi.mocked(pathRewriter.rewritePaths).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const destArg = calls[0]?.[2];
    expect(destArg).toBe(process.cwd());
    // user is informed of the auto-picked destination.
    const infoCalls = vi.mocked(ui.info).mock.calls.map((c) => c[0]);
    expect(infoCalls.some((m) => m.includes('destination not specified'))).toBe(true);
  });
});

describe('runResume — missing claude binary', () => {
  it('falls back to manual instructions when claude is not on PATH', async () => {
    vi.mocked(gitOps.isAvailable).mockResolvedValue(false);

    const cap = captureStdout();
    try {
      await runResume('auth', { into: '/dest', launch: true });
    } finally {
      cap.restore();
    }

    // spawn was never invoked because availability check failed
    expect(childProcess.spawn).not.toHaveBeenCalled();

    const out = cap.output();
    expect(out).toContain('Session prepared but Claude Code was not launched automatically.');
    expect(out).toContain('claude --resume 7f3a2b1c-1234-5678-90ab-cdef01234567');
  });
});

describe('runResume — spawn error', () => {
  it('falls back when spawn emits an error event', async () => {
    const fake = makeFakeChild();
    vi.mocked(childProcess.spawn).mockReturnValue(
      fake as unknown as ReturnType<typeof childProcess.spawn>,
    );

    const cap = captureStdout();
    const promise = runResume('auth', { into: '/dest', launch: true });

    // Wait a tick for spawn to be called and listeners attached, then emit error.
    await new Promise((r) => setImmediate(r));
    fake.emit('error', new Error('ENOENT'));

    await promise;
    cap.restore();

    expect(childProcess.spawn).toHaveBeenCalledWith(
      'claude',
      ['--resume', '7f3a2b1c-1234-5678-90ab-cdef01234567'],
      { cwd: '/dest', stdio: 'inherit', shell: false },
    );

    const out = cap.output();
    expect(out).toContain('Session prepared but Claude Code was not launched automatically.');
  });

  it('falls back when spawn() itself throws synchronously', async () => {
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      throw new Error('synchronous spawn failure');
    });

    const cap = captureStdout();
    try {
      await runResume('auth', { into: '/dest', launch: true });
    } finally {
      cap.restore();
    }

    const out = cap.output();
    expect(out).toContain('Session prepared but Claude Code was not launched automatically.');
  });
});

describe('runResume — ambiguous session', () => {
  it('rethrows the SessionError from the resolver', async () => {
    vi.mocked(nameResolver.resolve).mockRejectedValue(
      new SessionError("multiple sessions match 'auth':\n  7f3a2b1c  alpha  alice"),
    );

    await expect(runResume('auth', { into: '/dest', launch: false })).rejects.toMatchObject({
      code: 'SESSION_ERROR',
      message: expect.stringContaining('multiple sessions match'),
    });

    // Spawn never reached
    expect(childProcess.spawn).not.toHaveBeenCalled();
    // No JSONL written
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });
});

describe('runResume — subagent JSONLs', () => {
  it('rewrites and writes each subagent JSONL under the destination encoded-cwd', async () => {
    vi.mocked(nameResolver.resolve).mockResolvedValue({
      metaPath: '/repo/users/alice/2026-04-30-auth/meta.yaml',
      meta: buildMeta(),
    });

    // Fake readdir to return one subagent file dirent.
    const fakeDirent = {
      name: 'agent-1.jsonl',
      isFile: () => true,
      isDirectory: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isSymbolicLink: () => false,
    };
    vi.mocked(fsPromises.readdir).mockResolvedValue([fakeDirent] as never);

    vi.mocked(fsPromises.readFile).mockImplementation((async (p: unknown) => {
      const path = String(p);
      if (path.endsWith('session.jsonl')) {
        return '{"cwd":"/Users/alice/work/proj"}\n';
      }
      if (path.endsWith('agent-1.jsonl')) {
        return '{"cwd":"/Users/alice/work/proj"}\n';
      }
      return '';
    }) as never);

    await runResume('auth', { into: '/Users/bob/work/proj', launch: false });

    // rewritePaths called twice: once for parent, once for agent-1.
    expect(pathRewriter.rewritePaths).toHaveBeenCalledTimes(2);

    const expectedSubDir = join(
      homedir(),
      '.claude',
      'projects',
      encodedCwd('/Users/bob/work/proj'),
      '7f3a2b1c-1234-5678-90ab-cdef01234567',
      'subagents',
    );
    expect(fsPromises.mkdir).toHaveBeenCalledWith(expectedSubDir, { recursive: true });
    expect(fsPromises.writeFile).toHaveBeenCalledWith(
      join(expectedSubDir, 'agent-1.jsonl'),
      expect.stringContaining('/Users/bob/work/proj'),
      'utf8',
    );
  });
});

describe('runResume — drift warning', () => {
  it('warns when meta.commit_sha differs from local HEAD', async () => {
    vi.mocked(nameResolver.resolve).mockResolvedValue({
      metaPath: '/repo/users/alice/2026-04-30-auth/meta.yaml',
      meta: buildMeta({ commit_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
    });
    vi.mocked(gitOps.revParse).mockResolvedValue(
      'cafef00dcafef00dcafef00dcafef00dcafef00d',
    );

    await runResume('auth', { into: '/dest', launch: false });

    expect(ui.warn).toHaveBeenCalledWith(
      expect.stringContaining('differs from session commit_sha'),
    );
  });

  it('does not warn when commit_sha matches local HEAD', async () => {
    vi.mocked(nameResolver.resolve).mockResolvedValue({
      metaPath: '/repo/users/alice/2026-04-30-auth/meta.yaml',
      meta: buildMeta({ commit_sha: 'cafef00dcafef00dcafef00dcafef00dcafef00d' }),
    });
    vi.mocked(gitOps.revParse).mockResolvedValue(
      'cafef00dcafef00dcafef00dcafef00dcafef00d',
    );

    await runResume('auth', { into: '/dest', launch: false });

    expect(ui.warn).not.toHaveBeenCalled();
  });
});

// Item 2: refuse to clobber an existing local session unless --force or
// interactive confirmation. In non-TTY contexts (Claude's Bash, scripts)
// we surface a hard error pointing at --force rather than silent overwrite.
describe('runResume — overwrite protection', () => {
  function existingTargetExists(): void {
    vi.mocked(fsPromises.stat).mockImplementation(async (p: unknown) => {
      const path = String(p);
      // Pretend ONLY the target parent JSONL exists (existence is what we gate on).
      if (path.endsWith(`${'7f3a2b1c-1234-5678-90ab-cdef01234567'}.jsonl`)) {
        return { isFile: () => true } as never;
      }
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
  }

  it('refuses with error when non-interactive and no --force', async () => {
    existingTargetExists();
    vi.mocked(ui.isInteractive).mockReturnValue(false);

    await expect(
      runResume('auth', { into: '/dest', launch: false }),
    ).rejects.toMatchObject({
      name: 'RepoError',
      message: expect.stringContaining('--force'),
    });
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('overwrites silently when --force is set', async () => {
    existingTargetExists();
    vi.mocked(ui.isInteractive).mockReturnValue(false);

    await runResume('auth', { into: '/dest', launch: false, force: true });

    expect(ui.confirm).not.toHaveBeenCalled();
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
  });

  it('prompts in interactive mode and aborts when user declines', async () => {
    existingTargetExists();
    vi.mocked(ui.isInteractive).mockReturnValue(true);
    vi.mocked(ui.confirm).mockResolvedValue(false);

    await runResume('auth', { into: '/dest', launch: false });

    expect(ui.confirm).toHaveBeenCalledTimes(1);
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
    const infoCalls = vi.mocked(ui.info).mock.calls.map((c) => c[0]);
    expect(infoCalls.some((m) => m.includes('cancelled'))).toBe(true);
  });

  it('proceeds in interactive mode when user confirms', async () => {
    existingTargetExists();
    vi.mocked(ui.isInteractive).mockReturnValue(true);
    vi.mocked(ui.confirm).mockResolvedValue(true);

    await runResume('auth', { into: '/dest', launch: false });

    expect(ui.confirm).toHaveBeenCalledTimes(1);
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
  });

  it('writes normally when target does not exist (default)', async () => {
    // Default stat mock throws ENOENT.
    await runResume('auth', { into: '/dest', launch: false });
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
  });
});

// Item 2: --checkout pins the working tree to the recorded commit_sha so
// transcript paths and line numbers still resolve. Auto-stashes a dirty tree.
describe('runResume — --checkout', () => {
  function withDrift(): void {
    vi.mocked(nameResolver.resolve).mockResolvedValue({
      metaPath: '/repo/users/alice/2026-04-30-auth/meta.yaml',
      meta: buildMeta({ commit_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
    });
    vi.mocked(gitOps.revParse).mockResolvedValue(
      'cafef00dcafef00dcafef00dcafef00dcafef00d',
    );
  }

  it('checks out the recorded commit_sha when drift is detected and tree is clean', async () => {
    withDrift();
    vi.mocked(gitOps.isClean).mockResolvedValue(true);

    await runResume('auth', { into: '/dest', launch: false, checkout: true });

    expect(gitOps.stashPush).not.toHaveBeenCalled();
    expect(gitOps.checkout).toHaveBeenCalledWith(
      '/dest',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    );
    const infoCalls = vi.mocked(ui.info).mock.calls.map((c) => c[0]);
    expect(infoCalls.some((m) => m.startsWith('Checked out deadbeef.'))).toBe(true);
    expect(infoCalls.some((m) => m.includes('git checkout -') && !m.includes('stash pop'))).toBe(
      true,
    );
  });

  it('stashes first when drift is detected and tree is dirty', async () => {
    withDrift();
    vi.mocked(gitOps.isClean).mockResolvedValue(false);

    await runResume('auth', { into: '/dest', launch: false, checkout: true });

    expect(gitOps.stashPush).toHaveBeenCalledWith(
      '/dest',
      expect.stringContaining('drev resume'),
    );
    expect(gitOps.checkout).toHaveBeenCalledWith(
      '/dest',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    );
    const infoCalls = vi.mocked(ui.info).mock.calls.map((c) => c[0]);
    expect(infoCalls.some((m) => m.includes('git stash pop'))).toBe(true);
  });

  it('suppresses the drift warning when --checkout is going to act', async () => {
    withDrift();
    vi.mocked(gitOps.isClean).mockResolvedValue(true);

    await runResume('auth', { into: '/dest', launch: false, checkout: true });

    expect(ui.warn).not.toHaveBeenCalled();
  });

  it('is a no-op (info only) when --checkout is set but there is no drift', async () => {
    vi.mocked(nameResolver.resolve).mockResolvedValue({
      metaPath: '/repo/users/alice/2026-04-30-auth/meta.yaml',
      meta: buildMeta({ commit_sha: 'cafef00dcafef00dcafef00dcafef00dcafef00d' }),
    });
    vi.mocked(gitOps.revParse).mockResolvedValue(
      'cafef00dcafef00dcafef00dcafef00dcafef00d',
    );

    await runResume('auth', { into: '/dest', launch: false, checkout: true });

    expect(gitOps.checkout).not.toHaveBeenCalled();
    const infoCalls = vi.mocked(ui.info).mock.calls.map((c) => c[0]);
    expect(infoCalls.some((m) => m.includes('no-op'))).toBe(true);
  });

  it('errors when --checkout is set but the meta has no commit_sha', async () => {
    // buildMeta default has no commit_sha.
    await expect(
      runResume('auth', { into: '/dest', launch: false, checkout: true }),
    ).rejects.toMatchObject({
      name: 'RepoError',
      message: expect.stringContaining('commit_sha'),
    });
    expect(gitOps.checkout).not.toHaveBeenCalled();
  });

  it('errors when --checkout is set but destination is not a git repo', async () => {
    vi.mocked(nameResolver.resolve).mockResolvedValue({
      metaPath: '/repo/users/alice/2026-04-30-auth/meta.yaml',
      meta: buildMeta({ commit_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
    });
    vi.mocked(gitOps.revParse).mockRejectedValue(new Error('not a git repository'));

    await expect(
      runResume('auth', { into: '/dest', launch: false, checkout: true }),
    ).rejects.toMatchObject({
      name: 'RepoError',
      message: expect.stringContaining('git repo'),
    });
    expect(gitOps.checkout).not.toHaveBeenCalled();
  });
});
