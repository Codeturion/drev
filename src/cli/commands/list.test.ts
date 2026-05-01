import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '../../core/metadata.js';

vi.mock('../../core/git-ops.js', () => ({
  pullRebase: vi.fn(async () => {}),
}));

vi.mock('../../core/repo.js', () => ({
  listMetaFiles: vi.fn(async () => [] as string[]),
}));

vi.mock('../../core/metadata.js', () => ({
  readMeta: vi.fn(async () => ({}) as SessionMeta),
}));

vi.mock('../../core/identity.js', () => ({
  currentUserEmail: vi.fn(async () => 'me@example.com'),
}));

vi.mock('../../core/config.js', () => ({
  readUserConfig: vi.fn(async () => ({
    schema_version: 1,
    default_repo: '/tmp/drev-repo',
    auto_share: 'manual',
    auto_share_idle_threshold_seconds: 60,
    auto_summarize: false,
    ignore_patterns: [],
    ignore_paths: [],
    auto_share_projects: [],
  })),
}));

const infoMock = vi.fn();
const warnMock = vi.fn();
const tableMock = vi.fn(
  (rows: Array<Record<string, string>>, columns: string[]) =>
    `${columns.join('|')}\n${rows.map((r) => columns.map((c) => r[c] ?? '').join('|')).join('\n')}`,
);

vi.mock('../ui.js', () => ({
  info: (msg: string) => infoMock(msg),
  warn: (msg: string) => warnMock(msg),
  table: (rows: Array<Record<string, string>>, columns: string[]) => tableMock(rows, columns),
}));

import * as gitOps from '../../core/git-ops.js';
import * as repoMod from '../../core/repo.js';
import * as metadataMod from '../../core/metadata.js';
import * as identityMod from '../../core/identity.js';
import {
  buildRow,
  filterBackups,
  filterDays,
  filterMine,
  filterProject,
  filterTeam,
  filterUser,
  humanAge,
  runList,
} from './list.js';

const NOW = Date.parse('2026-05-01T12:00:00Z');

function meta(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    schema_version: 1,
    id: '11111111-2222-3333-4444-555555555555',
    name: 'session',
    purpose: 'share',
    user: 'alice',
    user_email: 'alice@example.com',
    project: 'web',
    project_root: '/repo',
    created_at: '2026-04-01T00:00:00Z',
    shared_at: '2026-04-30T12:00:00Z',
    title: 'a title',
    visibility: 'team',
    turns: 1,
    size_bytes: 100,
    redactions: [],
    ...overrides,
  };
}

// Five fixtures with varied fields.
const FIXTURES: SessionMeta[] = [
  meta({
    id: 'aaaaaaaa-1111-1111-1111-111111111111',
    name: 'mine-share',
    user: 'me',
    user_email: 'me@example.com',
    project: 'web-app',
    title: 'fix login',
    purpose: 'share',
    visibility: 'team',
    shared_at: '2026-05-01T11:00:00Z', // 1h ago
  }),
  meta({
    id: 'bbbbbbbb-2222-2222-2222-222222222222',
    name: 'mine-backup',
    user: 'me',
    user_email: 'me@example.com',
    project: 'web-app',
    title: 'backup before refactor',
    purpose: 'backup',
    visibility: 'private',
    shared_at: '2026-04-30T12:00:00Z', // 1d ago
  }),
  meta({
    id: 'cccccccc-3333-3333-3333-333333333333',
    name: 'alice-team',
    user: 'alice',
    user_email: 'alice@example.com',
    project: 'mobile',
    title: 'add ios push',
    purpose: 'share',
    visibility: 'team',
    shared_at: '2026-04-25T12:00:00Z', // ~6d ago
  }),
  meta({
    id: 'dddddddd-4444-4444-4444-444444444444',
    name: 'mine-private',
    user: 'me',
    user_email: 'me@example.com',
    project: 'mobile',
    title: 'wip experiment',
    purpose: 'share',
    visibility: 'private',
    shared_at: '2026-04-15T12:00:00Z', // ~16d ago (2w)
  }),
  meta({
    id: 'eeeeeeee-5555-5555-5555-555555555555',
    name: 'bob-team-old',
    user: 'bob',
    user_email: 'bob@example.com',
    project: 'web-app',
    title: 'old refactor',
    purpose: 'share',
    visibility: 'team',
    shared_at: '2026-03-15T12:00:00Z', // ~6.5w ago
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));

  vi.mocked(gitOps.pullRebase).mockResolvedValue(undefined);
  vi.mocked(identityMod.currentUserEmail).mockResolvedValue('me@example.com');
  vi.mocked(repoMod.listMetaFiles).mockResolvedValue(
    FIXTURES.map((m) => `/tmp/drev-repo/users/${m.user}/${m.id}/meta.yaml`),
  );
  vi.mocked(metadataMod.readMeta).mockImplementation(async (path: string) => {
    const id = path.split('/').slice(-2, -1)[0];
    const found = FIXTURES.find((m) => m.id === id);
    if (!found) throw new Error(`unknown fixture path ${path}`);
    return found;
  });
});

describe('humanAge', () => {
  it('renders minutes', () => {
    expect(humanAge('2026-05-01T11:55:00Z', NOW)).toBe('5m ago');
  });
  it('renders hours', () => {
    expect(humanAge('2026-05-01T09:00:00Z', NOW)).toBe('3h ago');
  });
  it('renders days', () => {
    expect(humanAge('2026-04-26T12:00:00Z', NOW)).toBe('5d ago');
  });
  it('renders weeks', () => {
    expect(humanAge('2026-04-10T12:00:00Z', NOW)).toBe('3w ago');
  });
  it('renders just now for sub-minute', () => {
    expect(humanAge('2026-05-01T11:59:30Z', NOW)).toBe('just now');
  });
  it('returns empty for invalid date', () => {
    expect(humanAge('not-a-date', NOW)).toBe('');
  });
});

describe('filter functions', () => {
  const myEmail = 'me@example.com';

  it('filterMine matches own email case-insensitively', () => {
    expect(filterMine(FIXTURES[0]!, myEmail)).toBe(true);
    expect(filterMine(FIXTURES[2]!, myEmail)).toBe(false);
    expect(filterMine(meta({ user_email: 'ME@example.com' }), myEmail)).toBe(true);
  });

  it('filterTeam excludes own backups and own private, includes own team-shares and others team-shares', () => {
    expect(filterTeam(FIXTURES[0]!, myEmail)).toBe(true); // mine team-share
    expect(filterTeam(FIXTURES[1]!, myEmail)).toBe(false); // mine backup
    expect(filterTeam(FIXTURES[2]!, myEmail)).toBe(true); // alice team-share
    expect(filterTeam(FIXTURES[3]!, myEmail)).toBe(false); // mine private
    expect(filterTeam(FIXTURES[4]!, myEmail)).toBe(true); // bob team-share
  });

  it('filterBackups matches only own backups', () => {
    expect(filterBackups(FIXTURES[0]!, myEmail)).toBe(false);
    expect(filterBackups(FIXTURES[1]!, myEmail)).toBe(true);
    // someone else's backup (not mine):
    expect(filterBackups(meta({ purpose: 'backup', user_email: 'x@example.com' }), myEmail)).toBe(false);
  });

  it('filterProject is substring and case-insensitive', () => {
    expect(filterProject(FIXTURES[0]!, 'web')).toBe(true);
    expect(filterProject(FIXTURES[0]!, 'WEB')).toBe(true);
    expect(filterProject(FIXTURES[2]!, 'web')).toBe(false);
    expect(filterProject(meta({ project: undefined }), 'web')).toBe(false);
  });

  it('filterUser is exact match on user', () => {
    expect(filterUser(FIXTURES[2]!, 'alice')).toBe(true);
    expect(filterUser(FIXTURES[2]!, 'Alice')).toBe(false);
    expect(filterUser(FIXTURES[2]!, 'ali')).toBe(false);
  });

  it('filterDays uses shared_at within window', () => {
    expect(filterDays(FIXTURES[0]!, 1, NOW)).toBe(true); // 1h ago
    expect(filterDays(FIXTURES[2]!, 7, NOW)).toBe(true); // 6d ago
    expect(filterDays(FIXTURES[2]!, 5, NOW)).toBe(false); // 6d ago
    expect(filterDays(FIXTURES[4]!, 30, NOW)).toBe(false); // ~6w ago
  });
});

describe('runList behavior', () => {
  it('renders table with id, name, user, project, age, title for all fixtures by default', async () => {
    await runList({});
    expect(tableMock).toHaveBeenCalledTimes(1);
    const [rows, columns] = tableMock.mock.calls[0]!;
    expect(columns).toEqual(['id', 'name', 'user', 'project', 'age', 'title']);
    expect(rows.length).toBe(FIXTURES.length);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ['age', 'id', 'name', 'project', 'title', 'user'],
      );
      expect(row.id!.length).toBe(8);
    }
  });

  it('sorts by shared_at descending', async () => {
    await runList({});
    const [rows] = tableMock.mock.calls[0]!;
    const ids = rows.map((r: Record<string, string>) => r.id);
    expect(ids).toEqual([
      'aaaaaaaa', // 1h
      'bbbbbbbb', // 1d
      'cccccccc', // 6d
      'dddddddd', // 16d
      'eeeeeeee', // 6w
    ]);
  });

  it('--mine filters to own sessions only', async () => {
    await runList({ mine: true });
    const [rows] = tableMock.mock.calls[0]!;
    const ids = rows.map((r: Record<string, string>) => r.id).sort();
    expect(ids).toEqual(['aaaaaaaa', 'bbbbbbbb', 'dddddddd']);
  });

  it('--team excludes own private and own backups', async () => {
    await runList({ team: true });
    const [rows] = tableMock.mock.calls[0]!;
    const ids = rows.map((r: Record<string, string>) => r.id).sort();
    expect(ids).toEqual(['aaaaaaaa', 'cccccccc', 'eeeeeeee']);
  });

  it('--backups returns only own backups', async () => {
    await runList({ backups: true });
    const [rows] = tableMock.mock.calls[0]!;
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe('bbbbbbbb');
  });

  it('--project does substring match', async () => {
    await runList({ project: 'web' });
    const [rows] = tableMock.mock.calls[0]!;
    const ids = rows.map((r: Record<string, string>) => r.id).sort();
    expect(ids).toEqual(['aaaaaaaa', 'bbbbbbbb', 'eeeeeeee']);
  });

  it('--user does exact match on username', async () => {
    await runList({ user: 'alice' });
    const [rows] = tableMock.mock.calls[0]!;
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe('cccccccc');
  });

  it('--days drops older items', async () => {
    await runList({ days: '7' });
    const [rows] = tableMock.mock.calls[0]!;
    const ids = rows.map((r: Record<string, string>) => r.id).sort();
    // Within 7 days: 1h (a), 1d (b), 6d (c). 16d (d) and 6w (e) excluded.
    expect(ids).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
  });

  it('combines filters with AND semantics', async () => {
    await runList({ mine: true, project: 'web' });
    const [rows] = tableMock.mock.calls[0]!;
    const ids = rows.map((r: Record<string, string>) => r.id).sort();
    // mine AND project~web → a (web-app), b (web-app)
    expect(ids).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });

  it('--limit caps the result count after sort', async () => {
    await runList({ limit: '2' });
    const [rows] = tableMock.mock.calls[0]!;
    expect(rows.length).toBe(2);
    expect(rows[0]!.id).toBe('aaaaaaaa');
    expect(rows[1]!.id).toBe('bbbbbbbb');
  });

  it('prints "no sessions match filters" when filter result is empty', async () => {
    await runList({ user: 'nobody' });
    expect(tableMock).not.toHaveBeenCalled();
    expect(infoMock).toHaveBeenCalledWith('no sessions match filters');
  });

  it('warns and continues when pullRebase fails', async () => {
    vi.mocked(gitOps.pullRebase).mockRejectedValueOnce(new Error('network down'));
    await runList({});
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0]![0]).toContain('falling back to local state');
    expect(tableMock).toHaveBeenCalledTimes(1);
  });

  it('passes the configured timeout to pullRebase', async () => {
    await runList({});
    expect(gitOps.pullRebase).toHaveBeenCalledWith('/tmp/drev-repo', 10_000);
  });
});

describe('buildRow', () => {
  it('produces the exact row shape with 8-char id and human age', () => {
    const row = buildRow(FIXTURES[0]!, NOW);
    expect(row).toEqual({
      id: 'aaaaaaaa',
      name: 'mine-share',
      user: 'me',
      project: 'web-app',
      age: '1h ago',
      title: 'fix login',
    });
  });

  it('renders missing optional fields as empty strings', () => {
    const m = meta({
      id: 'ffffffff-9999-9999-9999-999999999999',
      name: undefined,
      project: undefined,
      title: undefined,
    });
    const row = buildRow(m, NOW);
    expect(row.name).toBe('');
    expect(row.project).toBe('');
    expect(row.title).toBe('');
    expect(row.id).toBe('ffffffff');
  });
});
