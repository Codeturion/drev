import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, ValidationError } from '../../lib/errors.js';
import type { SessionMeta } from '../../core/metadata.js';

vi.mock('../../core/config.js', () => ({
  readUserConfig: vi.fn(),
}));

vi.mock('../../core/repo.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/repo.js')>(
    '../../core/repo.js',
  );
  return {
    ...actual,
    listMetaFiles: vi.fn(async () => []),
  };
});

vi.mock('../../core/name-resolver.js', () => ({
  resolve: vi.fn(),
}));

vi.mock('../ui.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  errorOut: vi.fn(),
}));

import * as config from '../../core/config.js';
import * as nameResolver from '../../core/name-resolver.js';
import * as repo from '../../core/repo.js';
import * as ui from '../ui.js';
import { runExport } from './export.js';

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function buildMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    schema_version: 1,
    id: '7f3a2b1c-1234-5678-90ab-cdef01234567',
    name: 'auth-fix',
    purpose: 'share',
    user: 'alice',
    user_email: 'alice@example.com',
    project_root: '/Users/alice/work/proj',
    created_at: '2026-04-30T14:00:00Z',
    shared_at: '2026-04-30T18:00:00Z',
    visibility: 'team',
    turns: 1,
    size_bytes: 100,
    redactions: [],
    ...overrides,
  };
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (!d) continue;
    await rm(d, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.mocked(config.readUserConfig).mockResolvedValue({
    schema_version: 1,
    default_repo: '',
    auto_share: 'manual',
    auto_share_idle_threshold_seconds: 60,
    auto_summarize: false,
    ignore_patterns: [],
    ignore_paths: [],
    auto_share_projects: [],
  });
});

describe('runExport — config / format', () => {
  it('throws ConfigError when default_repo is unset', async () => {
    await expect(runExport('auth', {})).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ValidationError on an unsupported format', async () => {
    const repoDir = await makeTmp('drev-export-');
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

    await expect(runExport('auth', { format: 'pdf' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('runExport — happy path', () => {
  it('writes an HTML file under <repo>/transcripts/<name>.html by default', async () => {
    const repoDir = await makeTmp('drev-export-');
    const sessionDir = join(repoDir, 'users', 'alice', '2026-04-30-auth');
    await mkdir(sessionDir, { recursive: true });
    const jsonlPath = join(sessionDir, 'session.jsonl');
    await writeFile(
      jsonlPath,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello world' },
      }) + '\n',
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
    vi.mocked(repo.listMetaFiles).mockResolvedValue([
      join(sessionDir, 'meta.yaml'),
    ]);
    vi.mocked(nameResolver.resolve).mockResolvedValue({
      metaPath: join(sessionDir, 'meta.yaml'),
      meta: buildMeta(),
    });

    await runExport('auth', {});

    const expectedOut = join(repoDir, 'transcripts', 'auth-fix.html');
    const html = await readFile(expectedOut, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('hello world');
    expect(vi.mocked(ui.info)).toHaveBeenCalledWith(
      expect.stringContaining(expectedOut),
    );
  });

  it('honors --out for a custom output path', async () => {
    const repoDir = await makeTmp('drev-export-');
    const sessionDir = join(repoDir, 'users', 'alice', '2026-04-30-auth');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'session.jsonl'), '', 'utf8');
    const customOut = join(await makeTmp('drev-out-'), 'sub', 'custom.html');

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
    vi.mocked(repo.listMetaFiles).mockResolvedValue([
      join(sessionDir, 'meta.yaml'),
    ]);
    vi.mocked(nameResolver.resolve).mockResolvedValue({
      metaPath: join(sessionDir, 'meta.yaml'),
      meta: buildMeta(),
    });

    await runExport('auth', { out: customOut });

    const html = await readFile(customOut, 'utf8');
    expect(html).toContain('<!doctype html>');
  });

  it('falls back to short-id slug when meta has no name', async () => {
    const repoDir = await makeTmp('drev-export-');
    const sessionDir = join(repoDir, 'users', 'alice', '2026-04-30-anon');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'session.jsonl'), '', 'utf8');

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
    vi.mocked(repo.listMetaFiles).mockResolvedValue([
      join(sessionDir, 'meta.yaml'),
    ]);
    vi.mocked(nameResolver.resolve).mockResolvedValue({
      metaPath: join(sessionDir, 'meta.yaml'),
      meta: buildMeta({ name: undefined }),
    });

    await runExport('anon', {});

    const expectedOut = join(repoDir, 'transcripts', '7f3a2b1c.html');
    const html = await readFile(expectedOut, 'utf8');
    expect(html).toContain('<!doctype html>');
  });
});
