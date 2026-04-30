import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { RepoError } from '../lib/errors.js';
import { drevHome } from './claude-paths.js';

export interface OutboxItem {
  id: string;
  session: string;
  meta: string;
}

const SESSION_FILE = 'session.jsonl';
const META_FILE = 'meta.yaml';

function outboxRoot(dir?: string): string {
  return dir ?? join(drevHome(), 'outbox');
}

function itemDir(root: string, id: string): string {
  return join(root, id);
}

function isInvalidId(id: string): boolean {
  if (id.length === 0) return true;
  if (id === '.' || id === '..') return true;
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) return true;
  if (id.startsWith('.tmp-')) return true;
  return false;
}

function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export async function enqueue(
  id: string,
  sessionJsonl: string,
  metaYaml: string,
  opts?: { dir?: string },
): Promise<void> {
  if (isInvalidId(id)) {
    throw new RepoError(`Invalid outbox id: ${JSON.stringify(id)}.`);
  }
  const root = outboxRoot(opts?.dir);
  try {
    await mkdir(root, { recursive: true });
  } catch (cause) {
    throw new RepoError(`Failed to create outbox dir ${root}.`, { cause });
  }

  const target = itemDir(root, id);
  try {
    await stat(target);
    throw new RepoError(
      `Outbox already has item ${id}; dequeue it before re-enqueueing.`,
    );
  } catch (err) {
    if (err instanceof RepoError) throw err;
    if (errnoCode(err) !== 'ENOENT') {
      throw new RepoError(`Failed to stat outbox item ${target}.`, { cause: err });
    }
  }

  const tmpName = `.tmp-${randomBytes(8).toString('hex')}`;
  const tmpDir = join(root, tmpName);
  try {
    await mkdir(tmpDir, { recursive: false });
  } catch (cause) {
    throw new RepoError(`Failed to create outbox temp dir ${tmpDir}.`, { cause });
  }

  try {
    await writeFile(join(tmpDir, SESSION_FILE), sessionJsonl, 'utf8');
    await writeFile(join(tmpDir, META_FILE), metaYaml, 'utf8');
  } catch (cause) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    throw new RepoError(`Failed to write outbox payload for ${id}.`, { cause });
  }

  try {
    await rename(tmpDir, target);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    const code = errnoCode(err);
    // ENOTEMPTY / EEXIST / EPERM (Windows): another writer won the race.
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM') {
      throw new RepoError(
        `Outbox already has item ${id}; dequeue it before re-enqueueing.`,
        { cause: err },
      );
    }
    throw new RepoError(`Failed to commit outbox item ${id}.`, { cause: err });
  }
}

export async function listQueued(opts?: { dir?: string }): Promise<string[]> {
  const root = outboxRoot(opts?.dir);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return [];
    throw new RepoError(`Failed to read outbox dir ${root}.`, { cause: err });
  }
  const ids: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.tmp-')) continue;
    if (name.startsWith('.')) continue;
    ids.push(name);
  }
  ids.sort();
  return ids;
}

export async function readQueued(
  id: string,
  opts?: { dir?: string },
): Promise<{ session: string; meta: string }> {
  if (isInvalidId(id)) {
    throw new RepoError(`Invalid outbox id: ${JSON.stringify(id)}.`);
  }
  const root = outboxRoot(opts?.dir);
  const dir = itemDir(root, id);
  let session: string;
  let meta: string;
  try {
    session = await readFile(join(dir, SESSION_FILE), 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') {
      throw new RepoError(`Outbox item ${id} is missing or corrupt.`, { cause: err });
    }
    throw new RepoError(`Failed to read outbox session for ${id}.`, { cause: err });
  }
  try {
    meta = await readFile(join(dir, META_FILE), 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') {
      throw new RepoError(`Outbox item ${id} is missing or corrupt.`, { cause: err });
    }
    throw new RepoError(`Failed to read outbox meta for ${id}.`, { cause: err });
  }
  return { session, meta };
}

export async function dequeue(id: string, opts?: { dir?: string }): Promise<void> {
  if (isInvalidId(id)) {
    throw new RepoError(`Invalid outbox id: ${JSON.stringify(id)}.`);
  }
  const root = outboxRoot(opts?.dir);
  const dir = itemDir(root, id);
  // `force: true` swallows ENOENT; `maxRetries` handles transient EPERM/EBUSY
  // races on Windows when a sibling process is mid-removal of the same path.
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  } catch (err) {
    throw new RepoError(`Failed to remove outbox item ${id}.`, { cause: err });
  }
}

export async function isQueued(
  id: string,
  opts?: { dir?: string },
): Promise<boolean> {
  if (isInvalidId(id)) return false;
  const root = outboxRoot(opts?.dir);
  try {
    const s = await stat(itemDir(root, id));
    return s.isDirectory();
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw new RepoError(`Failed to stat outbox item ${id}.`, { cause: err });
  }
}
