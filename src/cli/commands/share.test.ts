import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks. vi.mock is hoisted, so factories cannot close over outer state;
// we reach back into the live mocks via vi.mocked() inside each test.
// ---------------------------------------------------------------------------

vi.mock('../../core/config.js', () => ({
  readUserConfig: vi.fn(),
  readRepoConfig: vi.fn(),
}));

vi.mock('../../core/identity.js', () => ({
  currentUserEmail: vi.fn(),
  shortUsername: (email: string) => {
    const at = email.indexOf('@');
    return at === -1 ? email : email.slice(0, at);
  },
}));

vi.mock('../../core/git-ops.js', () => ({
  pullRebase: vi.fn(),
  add: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  showTopLevel: vi.fn(),
  revParse: vi.fn(),
}));

vi.mock('../../core/session.js', () => ({
  findSessionFiles: vi.fn(),
  findMostRecentSession: vi.fn(),
  readSessionStats: vi.fn(),
}));

vi.mock('../../core/redaction.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../core/redaction.js')>(
      '../../core/redaction.js',
    );
  return {
    ...actual,
    redact: vi.fn(),
  };
});

vi.mock('../../core/repo.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../core/repo.js')>(
      '../../core/repo.js',
    );
  return {
    ...actual,
    listMetaFiles: vi.fn(),
  };
});

vi.mock('../../core/outbox.js', () => ({
  enqueue: vi.fn(),
}));

vi.mock('../../core/metadata.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../core/metadata.js')>(
      '../../core/metadata.js',
    );
  return {
    ...actual,
    writeMeta: vi.fn(async (path: string, meta: unknown) => {
      await writeFile(path, actual.serializeMeta(meta as never), 'utf8');
    }),
  };
});

vi.mock('../ui.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  errorOut: vi.fn(),
  spinner: () => ({ stop: () => {}, succeed: () => {}, fail: () => {} }),
  confirm: vi.fn(),
}));

// Imports must come AFTER vi.mock calls so the mocked modules are bound.
import * as config from '../../core/config.js';
import * as identity from '../../core/identity.js';
import * as gitOps from '../../core/git-ops.js';
import * as session from '../../core/session.js';
import * as redaction from '../../core/redaction.js';
import * as repo from '../../core/repo.js';
import * as outbox from '../../core/outbox.js';
import * as ui from '../ui.js';
import { ConfigError, SessionError } from '../../lib/errors.js';
import { executeShare } from './share.js';

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (!d) continue;
    await rm(d, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

interface SetupOpts {
  repoDir: string;
  cwd: string;
  parentJsonl?: string;
  subagents?: Record<string, string>; // basename → contents
  redactionCounts?: Record<string, number>;
  metaFiles?: string[];
  pushFails?: boolean;
}

async function setupHappyMocks(opts: SetupOpts): Promise<{ parentPath: string }> {
  const projectsRoot = join(opts.repoDir, 'fake-claude-projects');
  await mkdir(projectsRoot, { recursive: true });
  const parentPath = join(projectsRoot, 'session-id.jsonl');
  await writeFile(parentPath, opts.parentJsonl ?? '{"type":"user","cwd":"' + opts.cwd.replace(/\\/g, '\\\\') + '"}\n', 'utf8');

  const subagents: string[] = [];
  if (opts.subagents) {
    const subDir = join(projectsRoot, 'session-id', 'subagents');
    await mkdir(subDir, { recursive: true });
    for (const [name, content] of Object.entries(opts.subagents)) {
      const p = join(subDir, name);
      await writeFile(p, content, 'utf8');
      subagents.push(p);
    }
  }

  vi.mocked(config.readUserConfig).mockResolvedValue({
    schema_version: 1,
    default_repo: opts.repoDir,
    auto_share: 'manual',
    auto_share_idle_threshold_seconds: 60,
    auto_summarize: false,
    ignore_patterns: [],
    ignore_paths: [],
    auto_share_projects: [],
  });

  vi.mocked(config.readRepoConfig).mockResolvedValue({
    schema_version: 1,
    team_name: 'team',
    default_visibility: 'team',
    retention_days: 365,
    redaction_extensions: [],
  });

  vi.mocked(identity.currentUserEmail).mockResolvedValue('alice@example.com');

  vi.mocked(session.findMostRecentSession).mockResolvedValue({
    parent: parentPath,
    subagents,
  });
  vi.mocked(session.findSessionFiles).mockResolvedValue({
    parent: parentPath,
    subagents,
  });
  vi.mocked(session.readSessionStats).mockResolvedValue({
    id: '7f3a2b1c-1234-5678-90ab-cdef01234567',
    cwd: opts.cwd,
    turns: 47,
    toolCalls: 5,
    filesTouched: ['src/a.ts', 'src/b.ts'],
    createdAt: '2026-04-30T10:00:00Z',
    modifiedAt: '2026-04-30T11:00:00Z',
    sizeBytes: 1234,
  });

  vi.mocked(gitOps.showTopLevel).mockResolvedValue(opts.cwd);
  vi.mocked(gitOps.revParse).mockImplementation(async (_dir, ref) => {
    if (ref === 'HEAD') return 'a1b2c3d4e5f6';
    if (ref === '--abbrev-ref HEAD') return 'main';
    return 'unknown';
  });
  vi.mocked(gitOps.pullRebase).mockResolvedValue(undefined);
  vi.mocked(gitOps.add).mockResolvedValue(undefined);
  vi.mocked(gitOps.commit).mockResolvedValue(undefined);
  if (opts.pushFails) {
    vi.mocked(gitOps.push).mockRejectedValue(new Error('network down'));
  } else {
    vi.mocked(gitOps.push).mockResolvedValue(undefined);
  }

  // The redact() mock returns the input unchanged with the configured counts.
  vi.mocked(redaction.redact).mockImplementation((jsonl: string) => ({
    output: jsonl,
    counts: opts.redactionCounts ?? {},
  }));

  vi.mocked(repo.listMetaFiles).mockResolvedValue(opts.metaFiles ?? []);
  vi.mocked(outbox.enqueue).mockResolvedValue(undefined);
  vi.mocked(ui.confirm).mockResolvedValue(true);

  return { parentPath };
}

describe('executeShare — happy path', () => {
  it('writes session.jsonl + meta.yaml, commits, and pushes', async () => {
    const repoDir = await makeTmp('drev-share-');
    const cwd = '/Users/alice/work/proj';
    await setupHappyMocks({
      repoDir,
      cwd,
      // listMetaFiles returns one prior session by alice -> not first share
      metaFiles: [
        join(repoDir, 'users', 'alice', '2026-04-29-prev', 'meta.yaml'),
      ],
    });

    const result = await executeShare({
      name: 'auth-refactor',
      purpose: 'share',
      interactive: true,
    });

    expect(result.pushed).toBe(true);
    expect(result.id).toBe('7f3a2b1c-1234-5678-90ab-cdef01234567');
    expect(result.name).toBe('auth-refactor');

    expect(gitOps.pullRebase).toHaveBeenCalledWith(repoDir);
    expect(gitOps.add).toHaveBeenCalledTimes(1);
    expect(gitOps.commit).toHaveBeenCalledTimes(1);
    expect(gitOps.push).toHaveBeenCalledTimes(1);

    // Assert the on-disk artefacts exist under <repoDir>/users/alice/<date>-auth-refactor/.
    const addArgs = vi.mocked(gitOps.add).mock.calls[0]!;
    const targetDir = (addArgs[1] as string[])[0]!;
    const sessionContent = await readFile(join(targetDir, 'session.jsonl'), 'utf8');
    expect(sessionContent.length).toBeGreaterThan(0);
    const metaContent = await readFile(join(targetDir, 'meta.yaml'), 'utf8');
    expect(metaContent).toContain('id: 7f3a2b1c-1234-5678-90ab-cdef01234567');
    expect(metaContent).toContain('name: auth-refactor');
    expect(metaContent).toContain('user: alice');
    expect(metaContent).toContain('visibility: team');
    expect(metaContent).toContain('branch: main');
    expect(metaContent).toContain('commit_sha: a1b2c3d4e5f6');

    // First-share confirm should not be triggered (metaFiles for alice present).
    expect(ui.confirm).not.toHaveBeenCalled();
  });
});

describe('executeShare — sessionId override', () => {
  it('uses findSessionFiles after recovering project root from JSONL cwd', async () => {
    const repoDir = await makeTmp('drev-share-');
    const cwd = '/srv/work/sample';
    // Build a fake claude-projects layout under HOME so readFirstEventCwd hits it.
    const home = await makeTmp('drev-home-');
    const prevHome = process.env['HOME'];
    const prevUser = process.env['USERPROFILE'];
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
    try {
      const projectsDir = join(home, '.claude', 'projects', '-srv-work-sample');
      await mkdir(projectsDir, { recursive: true });
      const parentPath = join(projectsDir, 'session-xyz.jsonl');
      await writeFile(
        parentPath,
        JSON.stringify({ type: 'user', cwd, message: { content: 'hello' } }) + '\n',
        'utf8',
      );

      vi.mocked(config.readUserConfig).mockResolvedValue({
        schema_version: 1,
        default_repo: repoDir,
        auto_share: 'manual',
        auto_share_idle_threshold_seconds: 60,
        auto_summarize: false,
        ignore_patterns: [],
        ignore_paths: [],
        auto_share_projects: [],
      });
      vi.mocked(config.readRepoConfig).mockResolvedValue({
        schema_version: 1,
        team_name: 't',
        default_visibility: 'team',
        retention_days: 365,
        redaction_extensions: [],
      });
      vi.mocked(identity.currentUserEmail).mockResolvedValue('alice@example.com');
      vi.mocked(session.findSessionFiles).mockResolvedValue({
        parent: parentPath,
        subagents: [],
      });
      vi.mocked(session.readSessionStats).mockResolvedValue({
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        cwd,
        turns: 1,
        toolCalls: 0,
        filesTouched: [],
        createdAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-01T00:00:00Z',
        sizeBytes: 10,
      });
      vi.mocked(gitOps.showTopLevel).mockResolvedValue(null);
      vi.mocked(gitOps.pullRebase).mockResolvedValue(undefined);
      vi.mocked(gitOps.add).mockResolvedValue(undefined);
      vi.mocked(gitOps.commit).mockResolvedValue(undefined);
      vi.mocked(gitOps.push).mockResolvedValue(undefined);
      vi.mocked(redaction.redact).mockImplementation((jsonl: string) => ({
        output: jsonl,
        counts: {},
      }));
      vi.mocked(repo.listMetaFiles).mockResolvedValue([
        join(repoDir, 'users', 'alice', '2026-01-01-prev', 'meta.yaml'),
      ]);

      const result = await executeShare({
        sessionId: 'session-xyz',
        name: 'thing',
        interactive: false,
      });

      expect(result.pushed).toBe(true);
      expect(session.findMostRecentSession).not.toHaveBeenCalled();
      expect(session.findSessionFiles).toHaveBeenCalledWith(cwd, 'session-xyz');
    } finally {
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
      if (prevUser === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = prevUser;
    }
  });
});

describe('executeShare — push failure', () => {
  it('enqueues to outbox and marks pushed=false', async () => {
    const repoDir = await makeTmp('drev-share-');
    await setupHappyMocks({
      repoDir,
      cwd: '/x/y',
      pushFails: true,
      metaFiles: [
        join(repoDir, 'users', 'alice', '2026-04-29-prev', 'meta.yaml'),
      ],
    });

    const result = await executeShare({
      name: 'thing',
      interactive: false,
    });

    expect(result.pushed).toBe(false);
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    const [id, body, meta] = vi.mocked(outbox.enqueue).mock.calls[0]!;
    expect(id).toBe('7f3a2b1c-1234-5678-90ab-cdef01234567');
    expect(typeof body).toBe('string');
    expect(typeof meta).toBe('string');
    expect(ui.warn).toHaveBeenCalled();
  });
});

describe('executeShare — no session found', () => {
  it('throws SessionError when findMostRecentSession returns null', async () => {
    const repoDir = await makeTmp('drev-share-');
    vi.mocked(config.readUserConfig).mockResolvedValue({
      schema_version: 1,
      default_repo: repoDir,
      auto_share: 'manual',
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
      auto_share_projects: [],
    });
    vi.mocked(config.readRepoConfig).mockResolvedValue({
      schema_version: 1,
      team_name: 't',
      default_visibility: 'team',
      retention_days: 365,
      redaction_extensions: [],
    });
    vi.mocked(session.findMostRecentSession).mockResolvedValue(null);

    await expect(executeShare({ interactive: false })).rejects.toBeInstanceOf(
      SessionError,
    );
  });

  it('throws ConfigError when default_repo is null', async () => {
    vi.mocked(config.readUserConfig).mockResolvedValue({
      schema_version: 1,
      default_repo: null,
      auto_share: 'manual',
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
      auto_share_projects: [],
    });
    await expect(executeShare({ interactive: false })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

describe('executeShare — first-share confirmation', () => {
  it('shows confirm and aborts when user declines', async () => {
    const repoDir = await makeTmp('drev-share-');
    await setupHappyMocks({
      repoDir,
      cwd: '/p/q',
      metaFiles: [], // empty -> first share
      redactionCounts: { github_pat: 1 },
    });
    vi.mocked(ui.confirm).mockResolvedValue(false);

    const result = await executeShare({
      name: 'first-time',
      interactive: true,
    });

    expect(ui.confirm).toHaveBeenCalledTimes(1);
    expect(result.pushed).toBe(false);
    // Aborted before any git work.
    expect(gitOps.pullRebase).not.toHaveBeenCalled();
    expect(gitOps.commit).not.toHaveBeenCalled();
    expect(gitOps.push).not.toHaveBeenCalled();
  });

  it('shows confirm and proceeds when user accepts', async () => {
    const repoDir = await makeTmp('drev-share-');
    await setupHappyMocks({
      repoDir,
      cwd: '/p/q',
      metaFiles: [],
      redactionCounts: { github_pat: 2 },
    });
    vi.mocked(ui.confirm).mockResolvedValue(true);

    const result = await executeShare({
      name: 'first-time',
      interactive: true,
    });

    expect(ui.confirm).toHaveBeenCalledTimes(1);
    expect(result.pushed).toBe(true);
    expect(gitOps.push).toHaveBeenCalledTimes(1);
  });

  it('does NOT prompt when interactive is false even if first share', async () => {
    const repoDir = await makeTmp('drev-share-');
    await setupHappyMocks({
      repoDir,
      cwd: '/p/q',
      metaFiles: [],
    });
    const result = await executeShare({ name: 'auto', interactive: false });
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(result.pushed).toBe(true);
  });

  // Item 3: entropy safety net. After regex redaction, suspicious high-entropy
  // tokens trigger a warn() so the operator can review before pushing.
  it('warns when the redacted payload still contains a high-entropy token', async () => {
    const repoDir = await makeTmp('drev-share-');
    // Put a realistic-shaped vendor key in the redacted output. The regex
    // layer won't catch it (it's not a known prefix), so the entropy pass
    // should flag it.
    // High-entropy mixed-class token, length >= 32, not pure-hex.
    const suspicious = 'vendor_live_Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Lm2N';
    await setupHappyMocks({
      repoDir,
      cwd: '/p/q',
      metaFiles: ['/repo/users/whoever/2026-04-30-x/meta.yaml'],
      // This goes into the redacted output via the `redact` mock setup.
    });
    // Override the redact mock to return our suspicious payload as the output.
    vi.mocked(redaction.redact).mockReturnValueOnce({
      output: `prefix ${suspicious} suffix`,
      counts: {},
    });

    await executeShare({ name: 'has-leak', interactive: false });

    const warnCalls = vi.mocked(ui.warn).mock.calls.map((c) => c[0]);
    expect(warnCalls.some((m) => m.includes('high-entropy'))).toBe(true);
    expect(warnCalls.some((m) => m.includes(suspicious))).toBe(true);
  });

  it('does not warn about high-entropy tokens when none remain', async () => {
    const repoDir = await makeTmp('drev-share-');
    await setupHappyMocks({
      repoDir,
      cwd: '/p/q',
      metaFiles: ['/repo/users/whoever/2026-04-30-x/meta.yaml'],
    });
    // Default redact mock returns plain text with no suspicious tokens.

    await executeShare({ name: 'clean', interactive: false });

    const warnCalls = vi.mocked(ui.warn).mock.calls.map((c) => c[0]);
    expect(warnCalls.some((m) => m.includes('high-entropy'))).toBe(false);
  });

  // T30: when invoked from a non-TTY context (Claude's Bash tool, scripts, --auto),
  // the first-share path must still surface the redaction summary as info so the
  // caller knows what was scrubbed, even though it can't prompt.
  it('logs the redaction summary as info when interactive is false on first share', async () => {
    const repoDir = await makeTmp('drev-share-');
    await setupHappyMocks({
      repoDir,
      cwd: '/p/q',
      metaFiles: [],
      redactionCounts: { github_pat: 3 },
    });

    const result = await executeShare({ name: 'auto', interactive: false });

    expect(ui.confirm).not.toHaveBeenCalled();
    expect(result.pushed).toBe(true);
    const infoCalls = vi.mocked(ui.info).mock.calls.map((c) => c[0]);
    expect(infoCalls.some((m) => m.startsWith('First share to '))).toBe(true);
    expect(infoCalls.some((m) => m.includes('3 github_pat'))).toBe(true);
  });
});

describe('executeShare — subagent JSONLs', () => {
  it('writes subagent files under <target>/subagents/', async () => {
    const repoDir = await makeTmp('drev-share-');
    const setup = await setupHappyMocks({
      repoDir,
      cwd: '/proj',
      subagents: {
        'agent-0.jsonl': '{"type":"user"}\n',
        'agent-1.jsonl': '{"type":"assistant"}\n',
      },
      metaFiles: [
        join(repoDir, 'users', 'alice', '2026-04-29-prev', 'meta.yaml'),
      ],
    });
    expect(setup.parentPath).toBeTruthy();

    const result = await executeShare({ name: 'with-subs', interactive: false });
    expect(result.pushed).toBe(true);

    const targetDir = (vi.mocked(gitOps.add).mock.calls[0]![1] as string[])[0]!;
    const sub0 = await readFile(join(targetDir, 'subagents', 'agent-0.jsonl'), 'utf8');
    const sub1 = await readFile(join(targetDir, 'subagents', 'agent-1.jsonl'), 'utf8');
    expect(sub0).toContain('user');
    expect(sub1).toContain('assistant');

    // redact() should have been called for parent + each subagent (3 total).
    expect(redaction.redact).toHaveBeenCalledTimes(3);
  });
});

describe('executeShare — Layer-3 auto-share nudge', () => {
  it('prints the nudge when pushed, interactive, and project is NOT whitelisted', async () => {
    const repoDir = await makeTmp('drev-share-');
    const cwd = '/Users/alice/work/proj';
    await setupHappyMocks({
      repoDir,
      cwd,
      metaFiles: [
        join(repoDir, 'users', 'alice', '2026-04-29-prev', 'meta.yaml'),
      ],
    });
    // No auto-share-projects entries -> not whitelisted.
    vi.mocked(config.readUserConfig).mockResolvedValue({
      schema_version: 1,
      default_repo: repoDir,
      auto_share: 'auto-team',
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
      auto_share_projects: [],
    });

    await executeShare({ name: 'thing', interactive: true });

    const messages = vi.mocked(ui.info).mock.calls.map((c) => c[0]);
    expect(
      messages.some((m) => m.includes('not on the auto-share list')),
    ).toBe(true);
    expect(
      messages.some((m) => m.includes('drev autoshare add')),
    ).toBe(true);
  });

  it('does NOT print the nudge when project IS under a whitelisted entry', async () => {
    const repoDir = await makeTmp('drev-share-');
    const cwd = '/Users/alice/work/proj';
    await setupHappyMocks({
      repoDir,
      cwd,
      metaFiles: [
        join(repoDir, 'users', 'alice', '2026-04-29-prev', 'meta.yaml'),
      ],
    });
    vi.mocked(config.readUserConfig).mockResolvedValue({
      schema_version: 1,
      default_repo: repoDir,
      auto_share: 'auto-team',
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
      auto_share_projects: ['/Users/alice/work'],
    });

    await executeShare({ name: 'thing', interactive: true });

    const messages = vi.mocked(ui.info).mock.calls.map((c) => c[0]);
    expect(
      messages.some((m) => m.includes('not on the auto-share list')),
    ).toBe(false);
  });

  it('does NOT print the nudge when interactive=false (sweep caller)', async () => {
    const repoDir = await makeTmp('drev-share-');
    const cwd = '/Users/alice/work/proj';
    await setupHappyMocks({
      repoDir,
      cwd,
      metaFiles: [
        join(repoDir, 'users', 'alice', '2026-04-29-prev', 'meta.yaml'),
      ],
    });
    vi.mocked(config.readUserConfig).mockResolvedValue({
      schema_version: 1,
      default_repo: repoDir,
      auto_share: 'auto-team',
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
      auto_share_projects: [],
    });

    await executeShare({ name: 'thing', interactive: false });

    const messages = vi.mocked(ui.info).mock.calls.map((c) => c[0]);
    expect(
      messages.some((m) => m.includes('not on the auto-share list')),
    ).toBe(false);
  });

  it('does NOT print the nudge when push failed (queued to outbox)', async () => {
    const repoDir = await makeTmp('drev-share-');
    const cwd = '/Users/alice/work/proj';
    await setupHappyMocks({
      repoDir,
      cwd,
      pushFails: true,
      metaFiles: [
        join(repoDir, 'users', 'alice', '2026-04-29-prev', 'meta.yaml'),
      ],
    });
    vi.mocked(config.readUserConfig).mockResolvedValue({
      schema_version: 1,
      default_repo: repoDir,
      auto_share: 'auto-team',
      auto_share_idle_threshold_seconds: 60,
      auto_summarize: false,
      ignore_patterns: [],
      ignore_paths: [],
      auto_share_projects: [],
    });

    const result = await executeShare({ name: 'thing', interactive: true });
    expect(result.pushed).toBe(false);

    const messages = vi.mocked(ui.info).mock.calls.map((c) => c[0]);
    expect(
      messages.some((m) => m.includes('not on the auto-share list')),
    ).toBe(false);
  });
});

describe('executeShare — visibility handling', () => {
  it('honors --private override', async () => {
    const repoDir = await makeTmp('drev-share-');
    await setupHappyMocks({
      repoDir,
      cwd: '/x',
      metaFiles: [
        join(repoDir, 'users', 'alice', '2026-04-29-prev', 'meta.yaml'),
      ],
    });

    await executeShare({
      name: 'priv',
      visibility: 'private',
      interactive: false,
    });

    const targetDir = (vi.mocked(gitOps.add).mock.calls[0]![1] as string[])[0]!;
    const meta = await readFile(join(targetDir, 'meta.yaml'), 'utf8');
    expect(meta).toContain('visibility: private');
  });
});

// Suppress unused-import warning for beforeEach.
beforeEach(() => undefined);

// Also touch dirname so tsc's verbatimModuleSyntax check doesn't complain about
// an unused namespace import — these are used inside paths above.
void dirname;
