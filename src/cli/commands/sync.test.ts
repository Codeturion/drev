import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { ConfigError, RepoError } from '../../lib/errors.js';

vi.mock('../../core/git-ops.js', () => {
  return {
    clone: vi.fn(async () => {}),
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

vi.mock('../../core/outbox.js', () => {
  return {
    listQueued: vi.fn(async () => [] as string[]),
    readQueued: vi.fn(async () => ({ session: '', meta: '' })),
    dequeue: vi.fn(async () => {}),
    enqueue: vi.fn(async () => {}),
    isQueued: vi.fn(async () => false),
  };
});

vi.mock('../../core/identity.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../core/identity.js')>(
      '../../core/identity.js',
    );
  return {
    ...actual,
    currentUserEmail: vi.fn(async () => 'fuat@example.com'),
  };
});

vi.mock('../../core/config.js', () => {
  return {
    readUserConfig: vi.fn(async () => ({
      schema_version: 1 as const,
      default_repo: '/fake/repo',
      auto_share: 'manual' as const,
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
      auto_share_projects: [],
    })),
  };
});

const uiMessages: { info: string[]; warn: string[]; error: string[] } = {
  info: [],
  warn: [],
  error: [],
};

vi.mock('../ui.js', async () => {
  const actual = await vi.importActual<typeof import('../ui.js')>('../ui.js');
  return {
    ...actual,
    info: (m: string) => {
      uiMessages.info.push(m);
    },
    warn: (m: string) => {
      uiMessages.warn.push(m);
    },
    errorOut: (m: string) => {
      uiMessages.error.push(m);
    },
    spinner: () => ({ stop: () => {}, succeed: () => {}, fail: () => {} }),
  };
});

import * as gitOps from '../../core/git-ops.js';
import * as outbox from '../../core/outbox.js';
import * as config from '../../core/config.js';
import { runSync } from './sync.js';

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

interface FakeItem {
  id: string;
  uuid: string;
  name: string | null;
  sharedAt: string;
}

function metaYamlFor(item: FakeItem): string {
  return yaml.dump({
    schema_version: 1,
    id: item.uuid,
    ...(item.name !== null ? { name: item.name } : {}),
    purpose: 'share',
    user: 'fuat',
    user_email: 'fuat@example.com',
    project_root: '/Users/fuat/work/proj',
    created_at: '2026-04-30T14:00:00Z',
    shared_at: item.sharedAt,
    visibility: 'team',
    turns: 1,
    size_bytes: 10,
    redactions: [],
  });
}

function setupQueue(items: FakeItem[]): void {
  vi.mocked(outbox.listQueued).mockResolvedValue(items.map((i) => i.id));
  vi.mocked(outbox.readQueued).mockImplementation(async (id: string) => {
    const found = items.find((i) => i.id === id);
    if (!found) throw new RepoError(`unexpected id ${id}`);
    return { session: `session-${id}\n`, meta: metaYamlFor(found) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  uiMessages.info.length = 0;
  uiMessages.warn.length = 0;
  uiMessages.error.length = 0;

  vi.mocked(config.readUserConfig).mockResolvedValue({
    schema_version: 1,
    default_repo: '/fake/repo',
    auto_share: 'manual',
    auto_share_idle_threshold_seconds: 60,
    auto_summarize: false,
    ignore_patterns: [],
    ignore_paths: [],
    auto_share_projects: [],
  });
  vi.mocked(gitOps.pullRebase).mockResolvedValue(undefined);
  vi.mocked(gitOps.add).mockResolvedValue(undefined);
  vi.mocked(gitOps.commit).mockResolvedValue(undefined);
  vi.mocked(gitOps.push).mockResolvedValue(undefined);
  vi.mocked(outbox.listQueued).mockResolvedValue([]);
  vi.mocked(outbox.dequeue).mockResolvedValue(undefined);
});

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (!d) continue;
    await rm(d, { recursive: true, force: true });
  }
});

describe('runSync config gate', () => {
  it('errors when default_repo is not set', async () => {
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
    await expect(runSync()).rejects.toBeInstanceOf(ConfigError);
    expect(gitOps.pullRebase).not.toHaveBeenCalled();
  });
});

describe('runSync empty outbox', () => {
  it('pulls then prints "outbox is empty" without touching git further', async () => {
    const repoDir = await makeTmp('drev-sync-empty-');
    vi.mocked(config.readUserConfig).mockResolvedValueOnce({
      schema_version: 1,
      default_repo: repoDir,
      auto_share: 'manual',
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
      auto_share_projects: [],
    });
    vi.mocked(outbox.listQueued).mockResolvedValueOnce([]);

    await runSync();

    expect(gitOps.pullRebase).toHaveBeenCalledWith(repoDir);
    expect(gitOps.add).not.toHaveBeenCalled();
    expect(gitOps.commit).not.toHaveBeenCalled();
    expect(gitOps.push).not.toHaveBeenCalled();
    expect(outbox.dequeue).not.toHaveBeenCalled();
    expect(uiMessages.info).toContain('outbox is empty');
  });
});

describe('runSync all drain', () => {
  it('writes each item to <repo>/users/<self>/<dated-dir>/, commits, pushes, dequeues', async () => {
    const repoDir = await makeTmp('drev-sync-all-');
    vi.mocked(config.readUserConfig).mockResolvedValueOnce({
      schema_version: 1,
      default_repo: repoDir,
      auto_share: 'manual',
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
      auto_share_projects: [],
    });

    const items: FakeItem[] = [
      {
        id: 'item-a',
        uuid: '7f3a2b1c-1234-5678-90ab-cdef01234567',
        name: 'auth-refactor',
        sharedAt: '2026-04-30T18:15:00Z',
      },
      {
        id: 'item-b',
        uuid: 'aabbccdd-1111-2222-3333-444455556666',
        name: null,
        sharedAt: '2026-05-01T10:00:00Z',
      },
    ];
    setupQueue(items);

    await runSync();

    // Files written for both items at the right path.
    const aDir = join(repoDir, 'users', 'fuat', '2026-04-30-auth-refactor');
    const bDir = join(repoDir, 'users', 'fuat', '2026-05-01-aabbccdd');
    expect(await readFile(join(aDir, 'session.jsonl'), 'utf8')).toBe(
      'session-item-a\n',
    );
    expect(await readFile(join(aDir, 'meta.yaml'), 'utf8')).toBe(
      metaYamlFor(items[0]!),
    );
    expect(await readFile(join(bDir, 'session.jsonl'), 'utf8')).toBe(
      'session-item-b\n',
    );

    // Add/commit/push called per item.
    expect(gitOps.add).toHaveBeenCalledTimes(2);
    expect(gitOps.commit).toHaveBeenCalledTimes(2);
    expect(gitOps.commit).toHaveBeenCalledWith(repoDir, 'share: auth-refactor');
    expect(gitOps.commit).toHaveBeenCalledWith(repoDir, 'share: aabbccdd');
    expect(gitOps.push).toHaveBeenCalledTimes(2);

    // Dequeue called for each successful item.
    expect(outbox.dequeue).toHaveBeenCalledTimes(2);
    expect(outbox.dequeue).toHaveBeenCalledWith('item-a');
    expect(outbox.dequeue).toHaveBeenCalledWith('item-b');

    // Summary line reflects 2 drained, 0 kept.
    const summary = uiMessages.info.find((m) => m.includes('drained'));
    expect(summary).toBeDefined();
    expect(summary).toContain('drained 2');
    expect(summary).toContain('kept 0');
  });
});

describe('runSync partial drain', () => {
  it('keeps a failing item queued but still drains subsequent items', async () => {
    const repoDir = await makeTmp('drev-sync-partial-');
    vi.mocked(config.readUserConfig).mockResolvedValueOnce({
      schema_version: 1,
      default_repo: repoDir,
      auto_share: 'manual',
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
      auto_share_projects: [],
    });

    const items: FakeItem[] = [
      {
        id: 'first',
        uuid: '11111111-1111-1111-1111-111111111111',
        name: 'one',
        sharedAt: '2026-04-30T10:00:00Z',
      },
      {
        id: 'second',
        uuid: '22222222-2222-2222-2222-222222222222',
        name: 'two',
        sharedAt: '2026-04-30T11:00:00Z',
      },
      {
        id: 'third',
        uuid: '33333333-3333-3333-3333-333333333333',
        name: 'three',
        sharedAt: '2026-04-30T12:00:00Z',
      },
    ];
    setupQueue(items);

    // Make push fail only for the second item.
    vi.mocked(gitOps.push).mockImplementation(async () => {
      const calls = vi.mocked(gitOps.push).mock.calls.length;
      if (calls === 2) {
        throw new RepoError('push rejected');
      }
    });

    await runSync();

    // Three pushes attempted, one failed.
    expect(gitOps.push).toHaveBeenCalledTimes(3);

    // Dequeue must only happen on push success — first and third only.
    expect(outbox.dequeue).toHaveBeenCalledTimes(2);
    expect(outbox.dequeue).toHaveBeenCalledWith('first');
    expect(outbox.dequeue).toHaveBeenCalledWith('third');
    expect(outbox.dequeue).not.toHaveBeenCalledWith('second');

    const summary = uiMessages.info.find((m) => m.includes('drained'));
    expect(summary).toContain('drained 2');
    expect(summary).toContain('kept 1');
  });
});

describe('runSync all fail', () => {
  it('keeps every item queued and never dequeues when push always fails', async () => {
    const repoDir = await makeTmp('drev-sync-allfail-');
    vi.mocked(config.readUserConfig).mockResolvedValueOnce({
      schema_version: 1,
      default_repo: repoDir,
      auto_share: 'manual',
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
      auto_share_projects: [],
    });

    const items: FakeItem[] = [
      {
        id: 'a',
        uuid: '11111111-1111-1111-1111-111111111111',
        name: 'one',
        sharedAt: '2026-04-30T10:00:00Z',
      },
      {
        id: 'b',
        uuid: '22222222-2222-2222-2222-222222222222',
        name: 'two',
        sharedAt: '2026-04-30T11:00:00Z',
      },
    ];
    setupQueue(items);

    vi.mocked(gitOps.push).mockRejectedValue(new RepoError('push rejected'));

    await runSync();

    expect(gitOps.push).toHaveBeenCalledTimes(2);
    expect(outbox.dequeue).not.toHaveBeenCalled();

    const summary = uiMessages.info.find((m) => m.includes('drained'));
    expect(summary).toContain('drained 0');
    expect(summary).toContain('kept 2');
  });

  it('does not dequeue when readQueued itself fails (corrupt item)', async () => {
    const repoDir = await makeTmp('drev-sync-corrupt-');
    vi.mocked(config.readUserConfig).mockResolvedValueOnce({
      schema_version: 1,
      default_repo: repoDir,
      auto_share: 'manual',
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
      auto_share_projects: [],
    });

    vi.mocked(outbox.listQueued).mockResolvedValueOnce(['broken']);
    vi.mocked(outbox.readQueued).mockRejectedValueOnce(
      new RepoError('Outbox item broken is missing or corrupt.'),
    );

    await runSync();

    expect(gitOps.add).not.toHaveBeenCalled();
    expect(gitOps.commit).not.toHaveBeenCalled();
    expect(gitOps.push).not.toHaveBeenCalled();
    expect(outbox.dequeue).not.toHaveBeenCalled();

    const summary = uiMessages.info.find((m) => m.includes('drained'));
    expect(summary).toContain('drained 0');
    expect(summary).toContain('kept 1');
  });
});
