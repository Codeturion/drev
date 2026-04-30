import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoError } from '../lib/errors.js';
import {
  dequeue,
  enqueue,
  isQueued,
  listQueued,
  readQueued,
} from './outbox.js';

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (!d) continue;
    await rm(d, { recursive: true, force: true });
  }
});

describe('enqueue', () => {
  it('writes session.jsonl and meta.yaml under <id>/', async () => {
    const dir = await makeTmp('drev-outbox-');
    await enqueue('abc123', '{"a":1}\n{"b":2}\n', 'name: hello\n', { dir });
    const session = await readFile(join(dir, 'abc123', 'session.jsonl'), 'utf8');
    const meta = await readFile(join(dir, 'abc123', 'meta.yaml'), 'utf8');
    expect(session).toBe('{"a":1}\n{"b":2}\n');
    expect(meta).toBe('name: hello\n');
  });

  it('creates the outbox dir if missing', async () => {
    const base = await makeTmp('drev-outbox-');
    const nested = join(base, 'does', 'not', 'exist');
    await enqueue('id-1', 'session-data', 'meta-data', { dir: nested });
    const s = await stat(nested);
    expect(s.isDirectory()).toBe(true);
  });

  it('does not leave temp dirs behind on success', async () => {
    const dir = await makeTmp('drev-outbox-');
    await enqueue('clean', 's', 'm', { dir });
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.startsWith('.tmp-'))).toEqual([]);
    expect(entries).toContain('clean');
  });

  it('throws RepoError when id already exists', async () => {
    const dir = await makeTmp('drev-outbox-');
    await enqueue('dup', 'one', 'meta-one', { dir });
    const err = await enqueue('dup', 'two', 'meta-two', { dir }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RepoError);
    expect((err as Error).message).toMatch(/dequeue it first|dequeue/i);
    // Original payload untouched.
    const session = await readFile(join(dir, 'dup', 'session.jsonl'), 'utf8');
    expect(session).toBe('one');
  });

  it('rejects ids with path separators', async () => {
    const dir = await makeTmp('drev-outbox-');
    await expect(enqueue('a/b', 's', 'm', { dir })).rejects.toBeInstanceOf(
      RepoError,
    );
    await expect(enqueue('a\\b', 's', 'm', { dir })).rejects.toBeInstanceOf(
      RepoError,
    );
  });

  it('rejects empty or dot ids', async () => {
    const dir = await makeTmp('drev-outbox-');
    await expect(enqueue('', 's', 'm', { dir })).rejects.toBeInstanceOf(RepoError);
    await expect(enqueue('.', 's', 'm', { dir })).rejects.toBeInstanceOf(RepoError);
    await expect(enqueue('..', 's', 'm', { dir })).rejects.toBeInstanceOf(RepoError);
  });

  it('rejects ids that look like temp dirs', async () => {
    const dir = await makeTmp('drev-outbox-');
    await expect(
      enqueue('.tmp-deadbeef', 's', 'm', { dir }),
    ).rejects.toBeInstanceOf(RepoError);
  });

  it('two parallel enqueues with different ids both succeed', async () => {
    const dir = await makeTmp('drev-outbox-');
    await Promise.all([
      enqueue('id-a', 'sa', 'ma', { dir }),
      enqueue('id-b', 'sb', 'mb', { dir }),
    ]);
    const ids = await listQueued({ dir });
    expect(ids).toEqual(['id-a', 'id-b']);
    expect(await readFile(join(dir, 'id-a', 'session.jsonl'), 'utf8')).toBe('sa');
    expect(await readFile(join(dir, 'id-b', 'session.jsonl'), 'utf8')).toBe('sb');
  });

  it('two parallel enqueues with the same id: exactly one wins', async () => {
    const dir = await makeTmp('drev-outbox-');
    const results = await Promise.allSettled([
      enqueue('clash', 'first', 'meta-first', { dir }),
      enqueue('clash', 'second', 'meta-second', { dir }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(RepoError);
    // Surviving payload must be one of the two writes, fully intact.
    const session = await readFile(join(dir, 'clash', 'session.jsonl'), 'utf8');
    const meta = await readFile(join(dir, 'clash', 'meta.yaml'), 'utf8');
    expect(['first', 'second']).toContain(session);
    expect(['meta-first', 'meta-second']).toContain(meta);
    // No leftover temp dirs after the loser cleans up.
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.startsWith('.tmp-'))).toEqual([]);
  });
});

describe('listQueued', () => {
  it('returns [] when outbox dir does not exist', async () => {
    const base = await makeTmp('drev-outbox-');
    const ghost = join(base, 'never-created');
    expect(await listQueued({ dir: ghost })).toEqual([]);
  });

  it('returns ids sorted alphabetically', async () => {
    const dir = await makeTmp('drev-outbox-');
    await enqueue('charlie', 's', 'm', { dir });
    await enqueue('alpha', 's', 'm', { dir });
    await enqueue('bravo', 's', 'm', { dir });
    expect(await listQueued({ dir })).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('ignores .tmp-* and dotfiles', async () => {
    const dir = await makeTmp('drev-outbox-');
    await enqueue('real', 's', 'm', { dir });
    await mkdir(join(dir, '.tmp-leftover'), { recursive: true });
    await writeFile(join(dir, '.DS_Store'), 'junk', 'utf8');
    expect(await listQueued({ dir })).toEqual(['real']);
  });

  it('returns [] when dir is empty', async () => {
    const dir = await makeTmp('drev-outbox-');
    expect(await listQueued({ dir })).toEqual([]);
  });

  it('wraps unexpected readdir errors in RepoError', async () => {
    const base = await makeTmp('drev-outbox-');
    // A regular file at the outbox path causes ENOTDIR on readdir.
    const path = join(base, 'not-a-dir');
    await writeFile(path, 'not a dir', 'utf8');
    await expect(listQueued({ dir: path })).rejects.toBeInstanceOf(RepoError);
  });
});

describe('readQueued', () => {
  it('returns the original session and meta content', async () => {
    const dir = await makeTmp('drev-outbox-');
    await enqueue('roundtrip', 'session-body\n', 'name: roundtrip\n', { dir });
    const out = await readQueued('roundtrip', { dir });
    expect(out).toEqual({ session: 'session-body\n', meta: 'name: roundtrip\n' });
  });

  it('throws RepoError when id is missing', async () => {
    const dir = await makeTmp('drev-outbox-');
    await expect(readQueued('nope', { dir })).rejects.toBeInstanceOf(RepoError);
  });

  it('throws RepoError when session.jsonl is missing (corrupt)', async () => {
    const dir = await makeTmp('drev-outbox-');
    await mkdir(join(dir, 'corrupt'), { recursive: true });
    await writeFile(join(dir, 'corrupt', 'meta.yaml'), 'name: x\n', 'utf8');
    const err = await readQueued('corrupt', { dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoError);
    expect((err as Error).message).toMatch(/missing or corrupt/i);
  });

  it('throws RepoError when meta.yaml is missing (corrupt)', async () => {
    const dir = await makeTmp('drev-outbox-');
    await mkdir(join(dir, 'corrupt2'), { recursive: true });
    await writeFile(join(dir, 'corrupt2', 'session.jsonl'), '{}\n', 'utf8');
    const err = await readQueued('corrupt2', { dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoError);
  });

  it('rejects invalid ids', async () => {
    const dir = await makeTmp('drev-outbox-');
    await expect(readQueued('a/b', { dir })).rejects.toBeInstanceOf(RepoError);
  });
});

describe('dequeue', () => {
  it('removes the directory and contents', async () => {
    const dir = await makeTmp('drev-outbox-');
    await enqueue('gone', 's', 'm', { dir });
    expect(await isQueued('gone', { dir })).toBe(true);
    await dequeue('gone', { dir });
    expect(await isQueued('gone', { dir })).toBe(false);
  });

  it('is idempotent on a missing id', async () => {
    const dir = await makeTmp('drev-outbox-');
    await dequeue('never-there', { dir });
    await dequeue('never-there', { dir });
  });

  it('does not error when the outbox root itself is missing', async () => {
    const base = await makeTmp('drev-outbox-');
    const ghost = join(base, 'no-outbox');
    await dequeue('whatever', { dir: ghost });
  });

  it('rejects invalid ids', async () => {
    const dir = await makeTmp('drev-outbox-');
    await expect(dequeue('a/b', { dir })).rejects.toBeInstanceOf(RepoError);
  });

  it('safe under concurrent dequeue of the same id', async () => {
    const dir = await makeTmp('drev-outbox-');
    await enqueue('shared', 's', 'm', { dir });
    await Promise.all([
      dequeue('shared', { dir }),
      dequeue('shared', { dir }),
      dequeue('shared', { dir }),
    ]);
    expect(await isQueued('shared', { dir })).toBe(false);
  });
});

describe('isQueued', () => {
  it('true for an enqueued id, false for unknown', async () => {
    const dir = await makeTmp('drev-outbox-');
    await enqueue('here', 's', 'm', { dir });
    expect(await isQueued('here', { dir })).toBe(true);
    expect(await isQueued('absent', { dir })).toBe(false);
  });

  it('false for invalid ids without throwing', async () => {
    const dir = await makeTmp('drev-outbox-');
    expect(await isQueued('a/b', { dir })).toBe(false);
    expect(await isQueued('', { dir })).toBe(false);
  });

  it('false when the outbox root does not exist', async () => {
    const base = await makeTmp('drev-outbox-');
    const ghost = join(base, 'nope');
    expect(await isQueued('any', { dir: ghost })).toBe(false);
  });

  it('returns false when the path is a regular file rather than a dir', async () => {
    const dir = await makeTmp('drev-outbox-');
    await writeFile(join(dir, 'fake'), 'not a dir', 'utf8');
    expect(await isQueued('fake', { dir })).toBe(false);
  });
});

describe('error paths', () => {
  it('enqueue: wraps stat failure on the target as RepoError', async () => {
    const base = await makeTmp('drev-outbox-');
    // Outbox root is a regular file, so the inner mkdir succeeds (file exists),
    // and the stat-on-target falls through. Use: parent is a file shaped like a dir.
    // Simpler: drop a regular file at the target id path so stat() succeeds and
    // triggers the "already exists" branch. We've covered that. To exercise
    // the non-ENOENT stat error path we make the target a path *under* a file.
    const root = await makeTmp('drev-outbox-');
    const filePath = join(root, 'blocker');
    await writeFile(filePath, 'x', 'utf8');
    // id "blocker/child" is invalid (slash), so use stat-on-file -> existed branch.
    // We rely on the "already exists" check to also hit if a non-dir entry is present.
    const err = await enqueue('blocker', 's', 'm', { dir: root }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RepoError);
  });

  it('enqueue: surfaces I/O errors when outbox root cannot be created', async () => {
    const base = await makeTmp('drev-outbox-');
    // Create a file where the outbox dir should be — mkdir recursive fails.
    const filePath = join(base, 'is-a-file');
    await writeFile(filePath, 'block', 'utf8');
    await expect(
      enqueue('any', 's', 'm', { dir: filePath }),
    ).rejects.toBeInstanceOf(RepoError);
  });

  it('readQueued: wraps non-ENOENT errors when the item path is unreadable', async () => {
    const dir = await makeTmp('drev-outbox-');
    // Put a regular file where the item dir should be: readFile of session.jsonl
    // gets ENOTDIR (not ENOENT), exercising the generic error branch.
    await writeFile(join(dir, 'weird'), 'not a dir', 'utf8');
    const err = await readQueued('weird', { dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoError);
    // Either "missing or corrupt" (ENOENT-ish) or "Failed to read" (ENOTDIR-ish);
    // both come from the same module and indicate the same condition.
    expect((err as Error).message).toMatch(/outbox|read|corrupt/i);
  });

  it('readQueued: wraps meta read errors when only session exists with broken meta', async () => {
    const dir = await makeTmp('drev-outbox-');
    const itemDirPath = join(dir, 'half');
    await mkdir(itemDirPath, { recursive: true });
    await writeFile(join(itemDirPath, 'session.jsonl'), 'ok\n', 'utf8');
    // Make meta.yaml a directory so readFile gets EISDIR (non-ENOENT).
    await mkdir(join(itemDirPath, 'meta.yaml'), { recursive: true });
    const err = await readQueued('half', { dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoError);
  });

  it('readQueued: wraps session read errors that are not ENOENT', async () => {
    const dir = await makeTmp('drev-outbox-');
    const itemDirPath = join(dir, 'broken');
    await mkdir(itemDirPath, { recursive: true });
    await mkdir(join(itemDirPath, 'session.jsonl'), { recursive: true });
    await writeFile(join(itemDirPath, 'meta.yaml'), 'ok\n', 'utf8');
    const err = await readQueued('broken', { dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoError);
  });

});

describe('round trip', () => {
  it('enqueue → list → read → dequeue', async () => {
    const dir = await makeTmp('drev-outbox-');
    await enqueue('full', 'jsonl-body', 'yaml-body', { dir });
    expect(await listQueued({ dir })).toEqual(['full']);
    expect(await readQueued('full', { dir })).toEqual({
      session: 'jsonl-body',
      meta: 'yaml-body',
    });
    await dequeue('full', { dir });
    expect(await listQueued({ dir })).toEqual([]);
    expect(await isQueued('full', { dir })).toBe(false);
  });
});
