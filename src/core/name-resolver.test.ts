import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionError } from '../lib/errors.js';
import { serializeMeta, type SessionMeta } from './metadata.js';
import {
  isIdPrefix,
  matchById,
  matchByName,
  resolve,
} from './name-resolver.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (!d) continue;
    await rm(d, { recursive: true, force: true });
  }
});

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drev-resolver-'));
  tmpDirs.push(dir);
  return dir;
}

function buildMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    schema_version: 1,
    id: '7f3a2b1c-1234-5678-90ab-cdef01234567',
    name: 'auth-refactor',
    purpose: 'share',
    user: 'fuat',
    user_email: 'fuat@example.com',
    project: 'forever-town',
    project_root: '/Users/fuat/work/forever-town',
    created_at: '2026-04-30T14:32:00Z',
    shared_at: '2026-04-30T18:15:00Z',
    visibility: 'team',
    turns: 1,
    size_bytes: 100,
    redactions: [],
    ...overrides,
  };
}

async function writeFixture(dir: string, file: string, meta: SessionMeta): Promise<string> {
  const p = join(dir, file);
  await writeFile(p, serializeMeta(meta), 'utf8');
  return p;
}

describe('isIdPrefix', () => {
  it('accepts 8 hex chars', () => {
    expect(isIdPrefix('7f3a2b1c')).toBe(true);
  });

  it('accepts longer hex', () => {
    expect(isIdPrefix('7f3a2b1c1234')).toBe(true);
  });

  it('accepts uppercase hex', () => {
    expect(isIdPrefix('7F3A2B1C')).toBe(true);
  });

  it('rejects 7 chars', () => {
    expect(isIdPrefix('7f3a2b1')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isIdPrefix('')).toBe(false);
  });

  it('rejects names with non-hex chars', () => {
    expect(isIdPrefix('auth-refactor')).toBe(false);
  });

  it('rejects 8 mixed alphanum with non-hex char', () => {
    expect(isIdPrefix('7f3a2b1z')).toBe(false);
  });
});

describe('matchById', () => {
  it('matches case-insensitive prefix', () => {
    const m = buildMeta();
    expect(matchById('7F3A2B1C', m)).toBe(true);
  });

  it('matches lowercase prefix', () => {
    const m = buildMeta();
    expect(matchById('7f3a2b1c', m)).toBe(true);
  });

  it('rejects non-prefix', () => {
    const m = buildMeta();
    expect(matchById('aaaaaaaa', m)).toBe(false);
  });
});

describe('matchByName', () => {
  it('matches case-insensitive substring', () => {
    const m = buildMeta({ name: 'auth-refactor' });
    expect(matchByName('REFACTOR', m)).toBe(true);
  });

  it('matches partial substring', () => {
    const m = buildMeta({ name: 'auth-refactor' });
    expect(matchByName('auth', m)).toBe(true);
  });

  it('returns false when name is unset', () => {
    const m = buildMeta({ name: undefined });
    expect(matchByName('anything', m)).toBe(false);
  });

  it('returns false when no substring match', () => {
    const m = buildMeta({ name: 'auth-refactor' });
    expect(matchByName('inventory', m)).toBe(false);
  });
});

describe('resolve', () => {
  it('resolves a single ID-prefix match', async () => {
    const dir = await makeTmpDir();
    const a = await writeFixture(dir, 'a.yaml', buildMeta({
      id: '7f3a2b1c-1234-5678-90ab-cdef01234567',
      name: 'alpha',
    }));
    const b = await writeFixture(dir, 'b.yaml', buildMeta({
      id: 'aaaaaaaa-1234-5678-90ab-cdef01234567',
      name: 'beta',
    }));

    const result = await resolve('7f3a2b1c', [a, b]);
    expect(result.metaPath).toBe(a);
    expect(result.meta.name).toBe('alpha');
  });

  it('resolves a single name substring match', async () => {
    const dir = await makeTmpDir();
    const a = await writeFixture(dir, 'a.yaml', buildMeta({
      id: '7f3a2b1c-1234-5678-90ab-cdef01234567',
      name: 'auth-refactor',
    }));
    const b = await writeFixture(dir, 'b.yaml', buildMeta({
      id: 'aaaaaaaa-1234-5678-90ab-cdef01234567',
      name: 'inventory-fix',
    }));

    const result = await resolve('auth', [a, b]);
    expect(result.metaPath).toBe(a);
    expect(result.meta.name).toBe('auth-refactor');
  });

  it('throws SessionError when zero matches via name', async () => {
    const dir = await makeTmpDir();
    const a = await writeFixture(dir, 'a.yaml', buildMeta({ name: 'alpha' }));

    await expect(resolve('nope', [a])).rejects.toMatchObject({
      name: 'SessionError',
      code: 'SESSION_ERROR',
      message: expect.stringContaining("no session matches 'nope'"),
    });
  });

  it('throws SessionError when zero matches via id', async () => {
    const dir = await makeTmpDir();
    const a = await writeFixture(dir, 'a.yaml', buildMeta({
      id: '7f3a2b1c-1234-5678-90ab-cdef01234567',
    }));

    await expect(resolve('deadbeef', [a])).rejects.toBeInstanceOf(SessionError);
  });

  it('throws SessionError when multiple matches via id prefix', async () => {
    const dir = await makeTmpDir();
    const a = await writeFixture(dir, 'a.yaml', buildMeta({
      id: '7f3a2b1c-1111-1111-1111-111111111111',
      name: 'alpha',
      user: 'fuat',
    }));
    const b = await writeFixture(dir, 'b.yaml', buildMeta({
      id: '7f3a2b1c-2222-2222-2222-222222222222',
      name: 'beta',
      user: 'jules',
    }));

    let caught: unknown;
    try {
      await resolve('7f3a2b1c', [a, b]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SessionError);
    const err = caught as SessionError;
    expect(err.message).toContain("multiple sessions match '7f3a2b1c'");
    expect(err.message).toContain('7f3a2b1c');
    expect(err.message).toContain('alpha');
    expect(err.message).toContain('beta');
    expect(err.message).toContain('fuat');
    expect(err.message).toContain('jules');
  });

  it('throws SessionError when multiple matches via name substring', async () => {
    const dir = await makeTmpDir();
    const a = await writeFixture(dir, 'a.yaml', buildMeta({
      id: '7f3a2b1c-1111-1111-1111-111111111111',
      name: 'auth-refactor',
      user: 'fuat',
    }));
    const b = await writeFixture(dir, 'b.yaml', buildMeta({
      id: 'aaaaaaaa-2222-2222-2222-222222222222',
      name: 'auth-tests',
      user: 'jules',
    }));

    await expect(resolve('auth', [a, b])).rejects.toMatchObject({
      name: 'SessionError',
      code: 'SESSION_ERROR',
    });
  });

  it('returns "(unnamed)" placeholder when listing candidates without names', async () => {
    const dir = await makeTmpDir();
    const a = await writeFixture(dir, 'a.yaml', buildMeta({
      id: '7f3a2b1c-1111-1111-1111-111111111111',
      name: undefined,
      user: 'fuat',
    }));
    const b = await writeFixture(dir, 'b.yaml', buildMeta({
      id: '7f3a2b1c-2222-2222-2222-222222222222',
      name: undefined,
      user: 'jules',
    }));

    let caught: unknown;
    try {
      await resolve('7f3a2b1c', [a, b]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SessionError);
    expect((caught as Error).message).toContain('(unnamed)');
  });

  it('handles empty meta list with zero-match error', async () => {
    await expect(resolve('anything', [])).rejects.toBeInstanceOf(SessionError);
  });

  it('uses name match when query has 8 chars but contains non-hex', async () => {
    const dir = await makeTmpDir();
    const a = await writeFixture(dir, 'a.yaml', buildMeta({
      id: '7f3a2b1c-1234-5678-90ab-cdef01234567',
      name: 'session-zz',
    }));
    const result = await resolve('session-', [a]);
    expect(result.metaPath).toBe(a);
  });
});
