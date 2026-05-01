import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks. We mock the exact modules autoshare-sweep imports so its
// behaviour is observable without touching the real filesystem outside HOME
// and without spawning git.
// ---------------------------------------------------------------------------

vi.mock('../../core/git-ops.js', () => ({
  pullRebase: vi.fn(),
}));

vi.mock('../../core/identity.js', () => ({
  currentUserEmail: vi.fn(async () => 'alice@example.com'),
  shortUsername: (email: string) => {
    const at = email.indexOf('@');
    return at === -1 ? email : email.slice(0, at);
  },
}));

vi.mock('./share.js', () => ({
  executeShare: vi.fn(),
}));

import * as gitOps from '../../core/git-ops.js';
import * as identity from '../../core/identity.js';
import { executeShare } from './share.js';
import { runSweep } from './autoshare-sweep.js';
import type { Logger } from '../../lib/logger.js';

// ---------------------------------------------------------------------------
// HOME redirection. Several modules under test compute paths from os.homedir()
// at call-time, so flipping HOME/USERPROFILE before each test is enough.
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const ORIGINAL_HOME = process.env['HOME'];
const ORIGINAL_USERPROFILE = process.env['USERPROFILE'];

async function withFakeHome(): Promise<string> {
  const home = await makeTmp('drev-sweep-home-');
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  return home;
}

function nullLogger(): Logger {
  return {
    info: async () => {},
    warn: async () => {},
    error: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Stream capture. Per the §10 contract, runSweep must never emit to stdout or
// stderr. We patch the write methods to capture and assert.
// ---------------------------------------------------------------------------

interface CapturedStreams {
  stdout: string;
  stderr: string;
  restore: () => void;
}

function captureStreams(): CapturedStreams {
  const captured = { stdout: '', stderr: '' };
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // Cast through unknown so the various write() overloads don't fight us.
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    captured.stdout += String(s);
    return true;
  };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    captured.stderr += String(s);
    return true;
  };
  return {
    get stdout() {
      return captured.stdout;
    },
    get stderr() {
      return captured.stderr;
    },
    restore: () => {
      (process.stdout as unknown as { write: typeof origOut }).write = origOut;
      (process.stderr as unknown as { write: typeof origErr }).write = origErr;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers for building the on-disk fixtures the sweep walks.
// ---------------------------------------------------------------------------

interface UserConfigShape {
  schema_version: 1;
  default_repo: string | null;
  auto_share: 'manual' | 'auto-private' | 'auto-team';
  auto_share_idle_threshold_seconds: number;
  auto_summarize: boolean;
  ignore_patterns: string[];
  ignore_paths: string[];
}

async function writeUserConfig(home: string, cfg: Partial<UserConfigShape>): Promise<void> {
  const path = join(home, '.drev', 'config.yaml');
  await mkdir(join(home, '.drev'), { recursive: true });
  const merged: UserConfigShape = {
    schema_version: 1,
    default_repo: cfg.default_repo ?? null,
    auto_share: cfg.auto_share ?? 'manual',
    auto_share_idle_threshold_seconds: cfg.auto_share_idle_threshold_seconds ?? 60,
    auto_summarize: cfg.auto_summarize ?? false,
    ignore_patterns: cfg.ignore_patterns ?? [],
    ignore_paths: cfg.ignore_paths ?? [],
  };
  // YAML-but-also-valid-JSON. js-yaml parses JSON happily, which keeps the
  // test harness free of yet another dependency.
  await writeFile(path, JSON.stringify(merged, null, 2), 'utf8');
}

async function writeJsonl(
  path: string,
  events: Array<Record<string, unknown>>,
  mtimeMs: number | null = null,
): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(path, body, 'utf8');
  if (mtimeMs !== null) {
    const ts = mtimeMs / 1000;
    await utimes(path, ts, ts);
  }
}

async function writeRepoMeta(
  repoDir: string,
  user: string,
  dir: string,
  meta: { id: string; name?: string },
): Promise<void> {
  const target = join(repoDir, 'users', user, dir, 'meta.yaml');
  await mkdir(join(target, '..'), { recursive: true });
  // Build the smallest valid SessionMeta. parseMeta enforces required fields.
  const full = {
    schema_version: 1,
    id: meta.id,
    purpose: 'share',
    user,
    user_email: 'alice@example.com',
    project_root: '/tmp/proj',
    created_at: '2026-04-30T10:00:00Z',
    shared_at: '2026-04-30T10:00:00Z',
    visibility: 'team',
    turns: 1,
    size_bytes: 10,
    redactions: [],
    ...(meta.name !== undefined ? { name: meta.name } : {}),
  };
  await writeFile(target, JSON.stringify(full, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Test lifecycle.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(identity.currentUserEmail).mockResolvedValue('alice@example.com');
  vi.mocked(gitOps.pullRebase).mockResolvedValue(undefined);
  vi.mocked(executeShare).mockResolvedValue({
    id: 'unused',
    name: 'unused',
    shortId: 'unused',
    redactionCounts: {},
    pushed: true,
  });
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSweep — silent operation', () => {
  it('writes nothing to stdout/stderr in any branch', async () => {
    const home = await withFakeHome();
    await writeUserConfig(home, { auto_share: 'manual' });

    const cap = captureStreams();
    try {
      await runSweep({ logger: nullLogger() });
    } finally {
      cap.restore();
    }

    expect(cap.stdout).toBe('');
    expect(cap.stderr).toBe('');
  });

  it('swallows errors thrown from executeShare without touching streams', async () => {
    const home = await withFakeHome();
    const repoDir = await makeTmp('drev-sweep-repo-');
    await writeUserConfig(home, { auto_share: 'auto-team', default_repo: repoDir });

    const projectDir = await makeTmp('drev-sweep-project-');
    const claudeDir = join(home, '.claude', 'projects', '-tmp-proj');
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await writeJsonl(
      join(claudeDir, `${sessionId}.jsonl`),
      [{ type: 'user', cwd: projectDir }],
      Date.now() - 5 * 60_000, // 5 minutes ago — well past idle threshold
    );

    vi.mocked(executeShare).mockRejectedValueOnce(new Error('boom'));

    const cap = captureStreams();
    try {
      await runSweep({ logger: nullLogger() });
    } finally {
      cap.restore();
    }

    expect(cap.stdout).toBe('');
    expect(cap.stderr).toBe('');
    // Failure counter should have NOT incremented for a per-session error —
    // those are caught and logged, not propagated to the outer try.
    const counterPath = join(home, '.drev', 'logs', 'sweep-failures');
    const counter = await readFile(counterPath, 'utf8').catch(() => '0');
    expect(parseInt(counter.trim(), 10)).toBe(0);
  });
});

describe('runSweep — manual short-circuit', () => {
  it('exits without invoking pullRebase or executeShare when auto_share=manual', async () => {
    const home = await withFakeHome();
    await writeUserConfig(home, { auto_share: 'manual', default_repo: '/anywhere' });

    await runSweep({ logger: nullLogger() });

    expect(gitOps.pullRebase).not.toHaveBeenCalled();
    expect(executeShare).not.toHaveBeenCalled();
    // Lockfile must be released, so a re-run can proceed.
    const lockExists = await readFile(join(home, '.drev', '.sweep.lock'), 'utf8').catch(() => null);
    expect(lockExists).toBeNull();
  });
});

describe('runSweep — lock contention', () => {
  it('a second invocation while the first holds the lock exits silently and immediately', async () => {
    const home = await withFakeHome();
    const repoDir = await makeTmp('drev-sweep-repo-');
    await writeUserConfig(home, { auto_share: 'auto-team', default_repo: repoDir });

    // Pre-create the lockfile to simulate another sweep already running.
    await mkdir(join(home, '.drev'), { recursive: true });
    const lockPath = join(home, '.drev', '.sweep.lock');
    await writeFile(lockPath, '', { flag: 'wx' });

    const cap = captureStreams();
    try {
      await runSweep({ logger: nullLogger() });
    } finally {
      cap.restore();
    }

    expect(cap.stdout).toBe('');
    expect(cap.stderr).toBe('');
    // Critical: the second invocation must NOT touch the existing lock or do work.
    expect(gitOps.pullRebase).not.toHaveBeenCalled();
    expect(executeShare).not.toHaveBeenCalled();
    // Lockfile remains in place because the holder (us, in the test) didn't release.
    const stillThere = await readFile(lockPath, 'utf8').catch(() => null);
    expect(stillThere).not.toBeNull();
  });
});

describe('runSweep — walks JSONLs and applies skip rules', () => {
  it('skips idle-fresh, already-shared, and .drev-disabled sessions; shares the rest', async () => {
    const home = await withFakeHome();
    const repoDir = await makeTmp('drev-sweep-repo-');
    await writeUserConfig(home, {
      auto_share: 'auto-team',
      default_repo: repoDir,
      auto_share_idle_threshold_seconds: 60,
    });

    const claudeRoot = join(home, '.claude', 'projects');
    const fiveMinAgo = Date.now() - 5 * 60_000;
    const tenSecAgo = Date.now() - 10_000;

    // 1. fresh session (within threshold) — must be skipped
    await writeJsonl(
      join(claudeRoot, '-proj-fresh', 'fresh-id.jsonl'),
      [{ type: 'user', cwd: '/tmp/projF' }],
      tenSecAgo,
    );

    // 2. already-shared — meta.yaml under users/alice/ records its id
    const sharedId = 'aaaaaaaa-1111-1111-1111-111111111111';
    await writeJsonl(
      join(claudeRoot, '-proj-shared', `${sharedId}.jsonl`),
      [{ type: 'user', cwd: '/tmp/projS' }],
      fiveMinAgo,
    );
    await writeRepoMeta(repoDir, 'alice', '2026-04-30-prev', { id: sharedId });

    // 3. .drev-disable at the project root — must be skipped
    const disabledRoot = await makeTmp('drev-sweep-disabled-');
    await writeFile(join(disabledRoot, '.drev-disable'), '', 'utf8');
    const disabledId = 'bbbbbbbb-2222-2222-2222-222222222222';
    await writeJsonl(
      join(claudeRoot, '-proj-disabled', `${disabledId}.jsonl`),
      [{ type: 'user', cwd: disabledRoot }],
      fiveMinAgo,
    );

    // 4. eligible — should call executeShare
    const eligibleRoot = await makeTmp('drev-sweep-eligible-');
    const eligibleId = 'cccccccc-3333-3333-3333-333333333333';
    await writeJsonl(
      join(claudeRoot, '-proj-eligible', `${eligibleId}.jsonl`),
      [{ type: 'user', cwd: eligibleRoot }],
      fiveMinAgo,
    );

    await runSweep({ logger: nullLogger() });

    expect(executeShare).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(executeShare).mock.calls[0]![0];
    expect(callArgs.sessionId).toBe(eligibleId);
    expect(callArgs.visibility).toBe('team');
    expect(callArgs.purpose).toBe('share');
    expect(callArgs.interactive).toBe(false);
  });

  it('passes visibility=private when auto_share=auto-private', async () => {
    const home = await withFakeHome();
    const repoDir = await makeTmp('drev-sweep-repo-');
    await writeUserConfig(home, { auto_share: 'auto-private', default_repo: repoDir });

    const claudeRoot = join(home, '.claude', 'projects');
    const eligibleRoot = await makeTmp('drev-sweep-eligible2-');
    const id = 'dddddddd-4444-4444-4444-444444444444';
    await writeJsonl(
      join(claudeRoot, '-proj-x', `${id}.jsonl`),
      [{ type: 'user', cwd: eligibleRoot }],
      Date.now() - 5 * 60_000,
    );

    await runSweep({ logger: nullLogger() });

    expect(executeShare).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executeShare).mock.calls[0]![0].visibility).toBe('private');
  });

  it('continues after pull --rebase fails (proceeds with local state)', async () => {
    const home = await withFakeHome();
    const repoDir = await makeTmp('drev-sweep-repo-');
    await writeUserConfig(home, { auto_share: 'auto-team', default_repo: repoDir });

    vi.mocked(gitOps.pullRebase).mockRejectedValueOnce(new Error('network down'));

    const claudeRoot = join(home, '.claude', 'projects');
    const eligibleRoot = await makeTmp('drev-sweep-pull-');
    const id = 'eeeeeeee-5555-5555-5555-555555555555';
    await writeJsonl(
      join(claudeRoot, '-proj-pull', `${id}.jsonl`),
      [{ type: 'user', cwd: eligibleRoot }],
      Date.now() - 5 * 60_000,
    );

    const cap = captureStreams();
    try {
      await runSweep({ logger: nullLogger() });
    } finally {
      cap.restore();
    }

    expect(cap.stdout).toBe('');
    expect(cap.stderr).toBe('');
    expect(executeShare).toHaveBeenCalledTimes(1);
  });
});

describe('runSweep — failure counter', () => {
  it('resets to 0 on a successful run even if a previous run incremented it', async () => {
    const home = await withFakeHome();
    const repoDir = await makeTmp('drev-sweep-repo-');
    await writeUserConfig(home, { auto_share: 'auto-team', default_repo: repoDir });

    // Pre-seed a non-zero counter (simulating prior failures).
    await mkdir(join(home, '.drev', 'logs'), { recursive: true });
    await writeFile(join(home, '.drev', 'logs', 'sweep-failures'), '5\n', 'utf8');

    await runSweep({ logger: nullLogger() });

    const counter = await readFile(
      join(home, '.drev', 'logs', 'sweep-failures'),
      'utf8',
    );
    expect(parseInt(counter.trim(), 10)).toBe(0);
  });

  it('increments when reading the user config throws', async () => {
    const home = await withFakeHome();
    // Write a malformed config: schema_version mismatch makes readUserConfig throw.
    await mkdir(join(home, '.drev'), { recursive: true });
    await writeFile(
      join(home, '.drev', 'config.yaml'),
      JSON.stringify({ schema_version: 999 }, null, 2),
      'utf8',
    );

    const cap = captureStreams();
    try {
      await runSweep({ logger: nullLogger() });
    } finally {
      cap.restore();
    }

    expect(cap.stdout).toBe('');
    expect(cap.stderr).toBe('');

    const counter = await readFile(
      join(home, '.drev', 'logs', 'sweep-failures'),
      'utf8',
    );
    expect(parseInt(counter.trim(), 10)).toBe(1);
  });

  it('accumulates across multiple consecutive failures', async () => {
    const home = await withFakeHome();
    await mkdir(join(home, '.drev'), { recursive: true });
    await writeFile(
      join(home, '.drev', 'config.yaml'),
      JSON.stringify({ schema_version: 999 }, null, 2),
      'utf8',
    );

    await runSweep({ logger: nullLogger() });
    await runSweep({ logger: nullLogger() });
    await runSweep({ logger: nullLogger() });

    const counter = await readFile(
      join(home, '.drev', 'logs', 'sweep-failures'),
      'utf8',
    );
    expect(parseInt(counter.trim(), 10)).toBe(3);
  });
});
