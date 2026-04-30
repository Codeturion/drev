import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('../../core/config.js', () => ({
  readUserConfig: vi.fn(async () => ({
    schema_version: 1 as const,
    default_repo: '/fake/repo',
    auto_share: 'manual' as const,
    auto_share_idle_threshold_seconds: 60,
    auto_summarize: false,
    ignore_patterns: [] as string[],
    ignore_paths: [] as string[],
  })),
}));

vi.mock('../ui.js', async () => {
  const actual = await vi.importActual<typeof import('../ui.js')>('../ui.js');
  return {
    ...actual,
    info: vi.fn(),
    warn: vi.fn(),
    table: vi.fn((rows: Array<Record<string, string>>, cols: string[]) => {
      // Render as JSON-ish so tests can inspect order and content trivially.
      return rows
        .map((r) => cols.map((c) => `${c}=${r[c] ?? ''}`).join('|'))
        .join('\n');
    }),
  };
});

import * as gitOps from '../../core/git-ops.js';
import * as repo from '../../core/repo.js';
import * as metadata from '../../core/metadata.js';
import * as config from '../../core/config.js';
import * as ui from '../ui.js';
import { humanAge, runSearch } from './search.js';

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    schema_version: 1,
    id: '00000000-0000-0000-0000-000000000000',
    purpose: 'share',
    user: 'alice',
    user_email: 'alice@example.com',
    project_root: '/work/proj',
    created_at: '2026-04-01T00:00:00Z',
    shared_at: '2026-04-01T00:00:00Z',
    visibility: 'team',
    turns: 0,
    size_bytes: 0,
    redactions: [],
    ...over,
  } as SessionMeta;
}

const FIXTURES: SessionMeta[] = [
  meta({
    id: 'aaaaaaaa-1111-1111-1111-111111111111',
    name: 'auth-refactor',
    user: 'alice',
    project: 'forever-town',
    title: 'Refactoring authentication',
    summary: 'Untangled session middleware and JWT handling.',
    shared_at: '2026-04-30T10:00:00Z',
    files_touched: ['Assets/Scripts/Auth.cs'],
  }),
  meta({
    id: 'bbbbbbbb-2222-2222-2222-222222222222',
    name: 'inventory-fix',
    user: 'bob',
    project: 'forever-town',
    title: 'Fix inventory desync',
    summary: 'Investigated MergeHandler race condition.',
    shared_at: '2026-04-29T10:00:00Z',
    files_touched: ['Assets/Scripts/Inventory.cs', 'Assets/Scripts/Merge/MergeHandler.cs'],
  }),
  meta({
    id: 'cccccccc-3333-3333-3333-333333333333',
    name: 'ui-polish',
    user: 'carol',
    project: 'storefront',
    title: 'Polish checkout flow',
    summary: 'Tightened spacing on the cart drawer.',
    shared_at: '2026-04-28T10:00:00Z',
    files_touched: ['src/components/Cart.tsx'],
  }),
  meta({
    id: 'dddddddd-4444-4444-4444-444444444444',
    name: 'db-migration',
    user: 'dave',
    project: 'backend',
    title: 'Migrate users table',
    summary: 'Adds index for AUTH lookups.',
    shared_at: '2026-04-27T10:00:00Z',
    files_touched: ['migrations/0001_users.sql'],
  }),
  meta({
    id: 'eeeeeeee-5555-5555-5555-555555555555',
    name: 'docs-update',
    user: 'erin',
    project: 'docs',
    title: 'Update README',
    summary: 'No code touched.',
    shared_at: '2026-04-26T10:00:00Z',
    files_touched: [],
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitOps.pullRebase).mockResolvedValue(undefined);
  const paths = FIXTURES.map((m) => `/fake/repo/users/${m.user}/2026-04-01-${m.name}/meta.yaml`);
  vi.mocked(repo.listMetaFiles).mockResolvedValue(paths);
  vi.mocked(metadata.readMeta).mockImplementation(async (p: string) => {
    const idx = paths.indexOf(p);
    return FIXTURES[idx]!;
  });
  vi.mocked(config.readUserConfig).mockResolvedValue({
    schema_version: 1,
    default_repo: '/fake/repo',
    auto_share: 'manual',
    auto_share_idle_threshold_seconds: 60,
    auto_summarize: false,
    ignore_patterns: [],
    ignore_paths: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runSearch field matching', () => {
  it('matches on name', async () => {
    await runSearch('inventory-fix');
    const call = vi.mocked(ui.table).mock.calls[0];
    expect(call).toBeDefined();
    const rows = call![0] as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!['name']).toBe('inventory-fix');
  });

  it('matches on title', async () => {
    await runSearch('checkout flow');
    const rows = vi.mocked(ui.table).mock.calls[0]![0] as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!['name']).toBe('ui-polish');
  });

  it('matches on summary', async () => {
    await runSearch('MergeHandler');
    const rows = vi.mocked(ui.table).mock.calls[0]![0] as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!['name']).toBe('inventory-fix');
  });

  it('matches on files_touched', async () => {
    await runSearch('Cart.tsx');
    const rows = vi.mocked(ui.table).mock.calls[0]![0] as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!['name']).toBe('ui-polish');
  });
});

describe('runSearch no matches', () => {
  it('prints info and does not render a table', async () => {
    await runSearch('xyzzy-nope');
    expect(ui.info).toHaveBeenCalledWith("no sessions match 'xyzzy-nope'");
    expect(ui.table).not.toHaveBeenCalled();
  });
});

describe('runSearch ordering', () => {
  it('sorts results by shared_at desc', async () => {
    // 'auth' appears in: auth-refactor (name+title), db-migration (summary "AUTH lookups")
    await runSearch('auth');
    const rows = vi.mocked(ui.table).mock.calls[0]![0] as Array<Record<string, string>>;
    expect(rows.map((r) => r['name'])).toEqual(['auth-refactor', 'db-migration']);
  });
});

describe('runSearch case-insensitive', () => {
  it('matches regardless of query casing', async () => {
    await runSearch('AUTH-REFACTOR');
    const rows = vi.mocked(ui.table).mock.calls[0]![0] as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!['name']).toBe('auth-refactor');
  });

  it('matches regardless of field casing', async () => {
    await runSearch('mergehandler');
    const rows = vi.mocked(ui.table).mock.calls[0]![0] as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!['name']).toBe('inventory-fix');
  });
});

describe('runSearch pullRebase failure', () => {
  it('warns and continues using local state', async () => {
    vi.mocked(gitOps.pullRebase).mockRejectedValueOnce(new Error('network down'));
    await runSearch('inventory-fix');
    expect(ui.warn).toHaveBeenCalled();
    const rows = vi.mocked(ui.table).mock.calls[0]![0] as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
  });
});

describe('runSearch table columns', () => {
  it('uses 8-char id, name, user, project, age, title', async () => {
    await runSearch('inventory-fix');
    const call = vi.mocked(ui.table).mock.calls[0];
    expect(call).toBeDefined();
    const cols = call![1] as string[];
    expect(cols).toEqual(['id', 'name', 'user', 'project', 'age', 'title']);
    const rows = call![0] as Array<Record<string, string>>;
    expect(rows[0]!['id']).toBe('bbbbbbbb');
    expect(rows[0]!['user']).toBe('bob');
    expect(rows[0]!['project']).toBe('forever-town');
    expect(rows[0]!['title']).toBe('Fix inventory desync');
    expect(typeof rows[0]!['age']).toBe('string');
  });
});

describe('humanAge', () => {
  const ref = new Date('2026-05-01T00:00:00Z');

  it('returns seconds for very recent', () => {
    expect(humanAge('2026-04-30T23:59:30Z', ref)).toBe('30s ago');
  });

  it('returns minutes', () => {
    expect(humanAge('2026-04-30T23:30:00Z', ref)).toBe('30m ago');
  });

  it('returns hours', () => {
    expect(humanAge('2026-04-30T20:00:00Z', ref)).toBe('4h ago');
  });

  it('returns days', () => {
    expect(humanAge('2026-04-25T00:00:00Z', ref)).toBe('6d ago');
  });

  it('returns months', () => {
    expect(humanAge('2026-01-01T00:00:00Z', ref)).toBe('4mo ago');
  });

  it('returns 0m for future timestamps', () => {
    expect(humanAge('2026-06-01T00:00:00Z', ref)).toBe('0m ago');
  });

  it('returns ? for invalid input', () => {
    expect(humanAge('not-a-date', ref)).toBe('?');
  });
});
