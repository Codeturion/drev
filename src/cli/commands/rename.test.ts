import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { OwnershipError, RepoError } from '../../lib/errors.js';
import type { SessionMeta } from '../../core/metadata.js';

// Mock all core/ modules so the command exercises pure orchestration logic.
vi.mock('../../core/git-ops.js', () => ({
  pullRebase: vi.fn(async () => {}),
  mv: vi.fn(async () => {}),
  add: vi.fn(async () => {}),
  commit: vi.fn(async () => {}),
  push: vi.fn(async () => {}),
}));

vi.mock('../../core/repo.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/repo.js')>(
    '../../core/repo.js',
  );
  return {
    ...actual,
    listMetaFiles: vi.fn(async () => [] as string[]),
    // Use the real sanitizeName so tests prove date-prefix preservation against real sanitization.
    sanitizeName: actual.sanitizeName,
  };
});

vi.mock('../../core/metadata.js', () => ({
  readMeta: vi.fn(),
  writeMeta: vi.fn(async () => {}),
}));

vi.mock('../../core/name-resolver.js', () => ({
  resolve: vi.fn(),
}));

vi.mock('../../core/identity.js', () => ({
  currentUserEmail: vi.fn(async () => 'me@example.com'),
}));

vi.mock('../../core/config.js', () => ({
  readUserConfig: vi.fn(async () => ({
    schema_version: 1,
    default_repo: '/repo',
    auto_share: 'manual',
    auto_share_idle_threshold_seconds: 60,
    auto_summarize: false,
    ignore_patterns: [],
    ignore_paths: [],
  })),
}));

vi.mock('../ui.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  errorOut: vi.fn(),
  spinner: () => ({ stop: () => {}, succeed: () => {}, fail: () => {} }),
}));

import * as gitOps from '../../core/git-ops.js';
import * as repo from '../../core/repo.js';
import * as metadata from '../../core/metadata.js';
import * as nameResolver from '../../core/name-resolver.js';
import * as identity from '../../core/identity.js';
import * as config from '../../core/config.js';
import { runRename } from './rename.js';

const REPO = '/repo';
const USER_DIR = join(REPO, 'users', 'me');

function metaSample(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    schema_version: 1,
    id: '7f3a2b1c-1234-5678-90ab-cdef01234567',
    name: 'old-name',
    purpose: 'share',
    user: 'me',
    user_email: 'me@example.com',
    project_root: '/Users/me/work/proj',
    created_at: '2026-04-30T14:32:00Z',
    shared_at: '2026-04-30T14:32:00Z',
    visibility: 'team',
    turns: 0,
    size_bytes: 0,
    redactions: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(config.readUserConfig).mockResolvedValue({
    schema_version: 1,
    default_repo: REPO,
    auto_share: 'manual',
    auto_share_idle_threshold_seconds: 60,
    auto_summarize: false,
    ignore_patterns: [],
    ignore_paths: [],
  });
  vi.mocked(identity.currentUserEmail).mockResolvedValue('me@example.com');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runRename ownership check', () => {
  it('throws OwnershipError when meta.user_email does not match git user.email', async () => {
    const oldDir = '2026-04-30-old-name';
    const metaPath = join(USER_DIR, oldDir, 'meta.yaml');
    const meta = metaSample({ user_email: 'someone-else@example.com' });
    vi.mocked(repo.listMetaFiles).mockResolvedValue([metaPath]);
    vi.mocked(nameResolver.resolve).mockResolvedValue({ metaPath, meta });

    await expect(runRename('old-name', 'new-name')).rejects.toBeInstanceOf(
      OwnershipError,
    );

    expect(gitOps.mv).not.toHaveBeenCalled();
    expect(gitOps.commit).not.toHaveBeenCalled();
    expect(gitOps.push).not.toHaveBeenCalled();
    expect(metadata.writeMeta).not.toHaveBeenCalled();
  });
});

describe('runRename sanitization preserves date prefix', () => {
  it('keeps the original YYYY-MM-DD- prefix and applies sanitizeName to the suffix', async () => {
    const oldDir = '2026-04-30-old-name';
    const metaPath = join(USER_DIR, oldDir, 'meta.yaml');
    const meta = metaSample();
    vi.mocked(repo.listMetaFiles).mockResolvedValue([metaPath]);
    vi.mocked(nameResolver.resolve).mockResolvedValue({ metaPath, meta });
    vi.mocked(metadata.readMeta).mockResolvedValue(metaSample());

    await runRename('old-name', '  Fancy Name!! ');

    // sanitizeName('  Fancy Name!! ') === 'fancy-name'; date prefix preserved.
    const expectedNewDir = '2026-04-30-fancy-name';
    expect(gitOps.mv).toHaveBeenCalledWith(
      REPO,
      'users/me/2026-04-30-old-name',
      `users/me/${expectedNewDir}`,
    );

    // meta was rewritten with sanitized name in the new location.
    const newMetaPath = join(USER_DIR, expectedNewDir, 'meta.yaml');
    expect(metadata.writeMeta).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenMeta] = vi.mocked(metadata.writeMeta).mock.calls[0]!;
    expect(writtenPath).toBe(newMetaPath);
    expect((writtenMeta as SessionMeta).name).toBe('fancy-name');

    expect(gitOps.add).toHaveBeenCalledWith(
      REPO,
      [`users/me/${expectedNewDir}`, 'users/me/2026-04-30-old-name'],
    );
    expect(gitOps.commit).toHaveBeenCalledWith(
      REPO,
      `rename: 2026-04-30-old-name -> ${expectedNewDir}`,
    );
    expect(gitOps.push).toHaveBeenCalledWith(REPO);
  });
});

describe('runRename name collision', () => {
  it('throws RepoError when the target directory already exists for this user', async () => {
    const oldDir = '2026-04-30-old-name';
    const collidingDir = '2026-04-30-new-name';
    const metaPath = join(USER_DIR, oldDir, 'meta.yaml');
    const collidingMetaPath = join(USER_DIR, collidingDir, 'meta.yaml');

    vi.mocked(repo.listMetaFiles).mockResolvedValue([metaPath, collidingMetaPath]);
    vi.mocked(nameResolver.resolve).mockResolvedValue({
      metaPath,
      meta: metaSample(),
    });

    await expect(runRename('old-name', 'new-name')).rejects.toBeInstanceOf(
      RepoError,
    );

    expect(gitOps.mv).not.toHaveBeenCalled();
    expect(gitOps.commit).not.toHaveBeenCalled();
    expect(metadata.writeMeta).not.toHaveBeenCalled();
  });
});

describe('runRename happy path', () => {
  it('pulls, moves, updates meta, commits, pushes in order', async () => {
    const oldDir = '2026-04-30-old-name';
    const metaPath = join(USER_DIR, oldDir, 'meta.yaml');
    const originalMeta = metaSample();
    vi.mocked(repo.listMetaFiles).mockResolvedValue([metaPath]);
    vi.mocked(nameResolver.resolve).mockResolvedValue({
      metaPath,
      meta: originalMeta,
    });
    vi.mocked(metadata.readMeta).mockResolvedValue(metaSample());

    const callOrder: string[] = [];
    vi.mocked(gitOps.pullRebase).mockImplementation(async () => {
      callOrder.push('pullRebase');
    });
    vi.mocked(gitOps.mv).mockImplementation(async () => {
      callOrder.push('mv');
    });
    vi.mocked(metadata.writeMeta).mockImplementation(async () => {
      callOrder.push('writeMeta');
    });
    vi.mocked(gitOps.add).mockImplementation(async () => {
      callOrder.push('add');
    });
    vi.mocked(gitOps.commit).mockImplementation(async () => {
      callOrder.push('commit');
    });
    vi.mocked(gitOps.push).mockImplementation(async () => {
      callOrder.push('push');
    });

    await runRename('old-name', 'new-name');

    expect(callOrder).toEqual([
      'pullRebase',
      'mv',
      'writeMeta',
      'add',
      'commit',
      'push',
    ]);
    expect(gitOps.pullRebase).toHaveBeenCalledWith(REPO);
    expect(gitOps.mv).toHaveBeenCalledWith(
      REPO,
      'users/me/2026-04-30-old-name',
      'users/me/2026-04-30-new-name',
    );
  });

  it('throws RepoError when no default repo is configured', async () => {
    vi.mocked(config.readUserConfig).mockResolvedValueOnce({
      schema_version: 1,
      default_repo: null,
      auto_share: 'manual',
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
    });

    await expect(runRename('whatever', 'new-name')).rejects.toBeInstanceOf(
      RepoError,
    );
    expect(gitOps.pullRebase).not.toHaveBeenCalled();
  });

  it('throws RepoError when the old dir lacks a YYYY-MM-DD- prefix', async () => {
    const oldDir = 'no-date-here';
    const metaPath = join(USER_DIR, oldDir, 'meta.yaml');
    vi.mocked(repo.listMetaFiles).mockResolvedValue([metaPath]);
    vi.mocked(nameResolver.resolve).mockResolvedValue({
      metaPath,
      meta: metaSample(),
    });

    await expect(runRename('old-name', 'new-name')).rejects.toBeInstanceOf(
      RepoError,
    );
    expect(gitOps.mv).not.toHaveBeenCalled();
  });
});
