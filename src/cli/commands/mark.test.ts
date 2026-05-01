import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { SessionMeta } from '../../core/metadata.js';
import { ConfigError, OwnershipError } from '../../lib/errors.js';

// Track which messages were warned/info'd so we can assert behavior without
// dumping output to the test runner's TTY.
const warnSpy = vi.fn<(msg: string) => void>();
const infoSpy = vi.fn<(msg: string) => void>();

vi.mock('../ui.js', async () => {
  const actual = await vi.importActual<typeof import('../ui.js')>('../ui.js');
  return {
    ...actual,
    info: (msg: string) => infoSpy(msg),
    warn: (msg: string) => warnSpy(msg),
    errorOut: () => {},
    spinner: () => ({ stop: () => {}, succeed: () => {}, fail: () => {} }),
  };
});

vi.mock('../../core/git-ops.js', () => ({
  pullRebase: vi.fn(async () => {}),
  add: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
  commit: vi.fn(async () => {}),
  push: vi.fn(async () => {}),
  // Unused-by-mark exports kept for type-compat with the real module.
  clone: vi.fn(async () => {}),
  remoteShowDefaultBranch: vi.fn(async () => 'main'),
  mv: vi.fn(async () => {}),
  revParse: vi.fn(async () => 'sha'),
  showTopLevel: vi.fn(async () => null),
  configGet: vi.fn(async () => null),
  filterRepo: vi.fn(async () => {}),
  isAvailable: vi.fn(async () => true),
}));

vi.mock('../../core/repo.js', () => ({
  listMetaFiles: vi.fn(async () => [] as string[]),
}));

vi.mock('../../core/metadata.js', () => ({
  readMeta: vi.fn(),
  writeMeta: vi.fn(async () => {}),
}));

vi.mock('../../core/name-resolver.js', () => ({
  resolve: vi.fn(),
}));

vi.mock('../../core/identity.js', () => ({
  currentUserEmail: vi.fn(async () => 'fuat@example.com'),
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
    auto_share_projects: [],
  })),
}));

import * as gitOps from '../../core/git-ops.js';
import * as repo from '../../core/repo.js';
import * as metadata from '../../core/metadata.js';
import * as nameResolver from '../../core/name-resolver.js';
import * as identity from '../../core/identity.js';
import * as config from '../../core/config.js';
import { runMark } from './mark.js';

const REPO = '/repo';
const META_PATH = join(REPO, 'users', 'fuat', '2026-04-30-auth-refactor', 'meta.yaml');
// Posix-form relative path that mark.ts produces for git.
const SESSION_DIR_REL = 'users/fuat/2026-04-30-auth-refactor';

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    schema_version: 1,
    id: '7f3a2b1c-1234-5678-90ab-cdef01234567',
    name: 'auth-refactor',
    purpose: 'share',
    user: 'fuat',
    user_email: 'fuat@example.com',
    project_root: '/Users/fuat/work/forever-town',
    created_at: '2026-04-30T14:32:00Z',
    shared_at: '2026-04-30T18:15:00Z',
    visibility: 'team',
    turns: 47,
    size_bytes: 312584,
    redactions: [],
    ...overrides,
  };
}

function setupResolved(meta: SessionMeta): void {
  vi.mocked(repo.listMetaFiles).mockResolvedValue([META_PATH]);
  vi.mocked(nameResolver.resolve).mockResolvedValue({
    metaPath: META_PATH,
    meta,
  });
  // readMeta is called for visibility flips; return a fresh copy each time.
  vi.mocked(metadata.readMeta).mockImplementation(async () => ({ ...meta }));
}

beforeEach(() => {
  vi.clearAllMocks();
  warnSpy.mockClear();
  infoSpy.mockClear();
  vi.mocked(identity.currentUserEmail).mockResolvedValue('fuat@example.com');
  vi.mocked(config.readUserConfig).mockResolvedValue({
    schema_version: 1,
    default_repo: REPO,
    auto_share: 'manual',
    auto_share_idle_threshold_seconds: 60,
    auto_summarize: false,
    ignore_patterns: [],
    ignore_paths: [],
    auto_share_projects: [],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runMark flag validation', () => {
  it('rejects when no flag is set', async () => {
    setupResolved(makeMeta());
    await expect(runMark('auth-refactor', {})).rejects.toBeInstanceOf(ConfigError);
    expect(gitOps.pullRebase).not.toHaveBeenCalled();
  });

  it('rejects when multiple flags are set (--team + --private)', async () => {
    setupResolved(makeMeta());
    await expect(
      runMark('auth-refactor', { team: true, private: true }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(gitOps.pullRebase).not.toHaveBeenCalled();
  });

  it('rejects when --public and --delete are combined', async () => {
    setupResolved(makeMeta());
    await expect(
      runMark('auth-refactor', { public: true, delete: true }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects when all three flags are set', async () => {
    setupResolved(makeMeta());
    await expect(
      runMark('auth-refactor', { team: true, private: true, delete: true }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('runMark ownership', () => {
  it('rejects when caller is not the session owner', async () => {
    setupResolved(makeMeta({ user_email: 'someone-else@example.com' }));
    await expect(
      runMark('auth-refactor', { team: true }),
    ).rejects.toBeInstanceOf(OwnershipError);
    expect(gitOps.add).not.toHaveBeenCalled();
    expect(gitOps.commit).not.toHaveBeenCalled();
    expect(gitOps.push).not.toHaveBeenCalled();
    expect(gitOps.rm).not.toHaveBeenCalled();
    expect(metadata.writeMeta).not.toHaveBeenCalled();
  });

  it('also enforces ownership for --delete', async () => {
    setupResolved(makeMeta({ user_email: 'attacker@example.com' }));
    await expect(
      runMark('auth-refactor', { delete: true }),
    ).rejects.toBeInstanceOf(OwnershipError);
    expect(gitOps.rm).not.toHaveBeenCalled();
  });
});

describe('runMark --team / --public', () => {
  it('flips a private session to team, writes meta, commits and pushes', async () => {
    setupResolved(makeMeta({ visibility: 'private' }));

    await runMark('auth-refactor', { team: true });

    expect(gitOps.pullRebase).toHaveBeenCalledWith(REPO);
    expect(metadata.writeMeta).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenMeta] = vi.mocked(metadata.writeMeta).mock.calls[0]!;
    expect(writtenPath).toBe(META_PATH);
    expect((writtenMeta as SessionMeta).visibility).toBe('team');

    expect(gitOps.add).toHaveBeenCalledWith(REPO, [SESSION_DIR_REL]);
    expect(gitOps.commit).toHaveBeenCalledWith(REPO, 'mark: auth-refactor team');
    expect(gitOps.push).toHaveBeenCalledWith(REPO);
    expect(gitOps.rm).not.toHaveBeenCalled();
  });

  it('treats --public the same as --team', async () => {
    setupResolved(makeMeta({ visibility: 'private' }));
    await runMark('auth-refactor', { public: true });
    expect(gitOps.commit).toHaveBeenCalledWith(REPO, 'mark: auth-refactor team');
  });

  it('is a no-op when visibility is already team', async () => {
    setupResolved(makeMeta({ visibility: 'team' }));
    await runMark('auth-refactor', { team: true });
    expect(metadata.writeMeta).not.toHaveBeenCalled();
    expect(gitOps.add).not.toHaveBeenCalled();
    expect(gitOps.commit).not.toHaveBeenCalled();
    expect(gitOps.push).not.toHaveBeenCalled();
  });
});

describe('runMark --private', () => {
  it('flips a team session to private, writes meta, commits and pushes', async () => {
    setupResolved(makeMeta({ visibility: 'team' }));

    await runMark('auth-refactor', { private: true });

    expect(metadata.writeMeta).toHaveBeenCalledTimes(1);
    const [, writtenMeta] = vi.mocked(metadata.writeMeta).mock.calls[0]!;
    expect((writtenMeta as SessionMeta).visibility).toBe('private');

    expect(gitOps.add).toHaveBeenCalledWith(REPO, [SESSION_DIR_REL]);
    expect(gitOps.commit).toHaveBeenCalledWith(REPO, 'mark: auth-refactor private');
    expect(gitOps.push).toHaveBeenCalledWith(REPO);
    expect(gitOps.rm).not.toHaveBeenCalled();
  });

  it('is a no-op when visibility is already private', async () => {
    setupResolved(makeMeta({ visibility: 'private' }));
    await runMark('auth-refactor', { private: true });
    expect(metadata.writeMeta).not.toHaveBeenCalled();
    expect(gitOps.commit).not.toHaveBeenCalled();
  });
});

describe('runMark --delete', () => {
  it('git rm -r the session dir, commits, pushes, and warns about history', async () => {
    setupResolved(makeMeta());

    await runMark('auth-refactor', { delete: true });

    expect(gitOps.rm).toHaveBeenCalledWith(REPO, SESSION_DIR_REL, true);
    expect(gitOps.commit).toHaveBeenCalledWith(REPO, 'delete: auth-refactor');
    expect(gitOps.push).toHaveBeenCalledWith(REPO);

    // History-retention warning is required by §9.8.
    const warnings = warnSpy.mock.calls.map((c) => c[0]);
    expect(warnings.some((w) => /history/i.test(w))).toBe(true);
    expect(warnings.some((w) => /scrub/i.test(w))).toBe(true);

    // No visibility mutation occurs on delete.
    expect(metadata.writeMeta).not.toHaveBeenCalled();
    expect(gitOps.add).not.toHaveBeenCalled();
  });

  it('uses the short ID in the commit message when meta has no name', async () => {
    setupResolved(makeMeta({ name: undefined }));
    await runMark('7f3a2b1c', { delete: true });
    expect(gitOps.commit).toHaveBeenCalledWith(REPO, 'delete: 7f3a2b1c');
  });
});

describe('runMark config preconditions', () => {
  it('errors when default_repo is not configured', async () => {
    vi.mocked(config.readUserConfig).mockResolvedValueOnce({
      schema_version: 1,
      default_repo: null,
      auto_share: 'manual',
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
      auto_share_projects: [],
    });
    await expect(
      runMark('auth-refactor', { team: true }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(gitOps.pullRebase).not.toHaveBeenCalled();
  });
});
