import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RepoError } from '../lib/errors.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;

interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
}

interface ExecChildError extends Error {
  code?: string | number | null;
  killed?: boolean;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

async function run(bin: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const { stdout } = await execFileAsync(bin, args, {
      cwd: opts.cwd,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      // shell defaults to false; never override.
    });
    return stdout.toString().trim();
  } catch (err) {
    const e = err as ExecChildError;
    const stderr = (e.stderr ?? '').toString().trim();
    const reason = e.killed && e.signal === 'SIGTERM'
      ? `${bin} timed out after ${timeout}ms`
      : `${bin} ${args.join(' ')} failed`;
    const message = stderr ? `${reason}: ${stderr}` : reason;
    throw new RepoError(message, { cause: err });
  }
}

export async function clone(url: string, dest: string, timeoutMs?: number): Promise<void> {
  await run('git', ['clone', '--', url, dest], { timeoutMs });
}

export async function pullRebase(repoDir: string, timeoutMs?: number): Promise<void> {
  await run('git', ['pull', '--rebase'], { cwd: repoDir, timeoutMs });
}

export async function add(repoDir: string, paths: string[], timeoutMs?: number): Promise<void> {
  if (paths.length === 0) return;
  await run('git', ['add', '--', ...paths], { cwd: repoDir, timeoutMs });
}

export async function commit(repoDir: string, message: string, timeoutMs?: number): Promise<void> {
  await run('git', ['commit', '-m', message], { cwd: repoDir, timeoutMs });
}

export async function push(repoDir: string, timeoutMs?: number): Promise<void> {
  await run('git', ['push'], { cwd: repoDir, timeoutMs });
}

export async function mv(repoDir: string, from: string, to: string, timeoutMs?: number): Promise<void> {
  await run('git', ['mv', '--', from, to], { cwd: repoDir, timeoutMs });
}

export async function rm(
  repoDir: string,
  path: string,
  recursive = false,
  timeoutMs?: number,
): Promise<void> {
  const args = ['rm'];
  if (recursive) args.push('-r');
  args.push('--', path);
  await run('git', args, { cwd: repoDir, timeoutMs });
}

export async function revParse(repoDir: string, ref: string, timeoutMs?: number): Promise<string> {
  return run('git', ['rev-parse', ref], { cwd: repoDir, timeoutMs });
}

export async function showTopLevel(cwd: string, timeoutMs?: number): Promise<string | null> {
  try {
    return await run('git', ['rev-parse', '--show-toplevel'], { cwd, timeoutMs });
  } catch {
    return null;
  }
}

export async function configGet(key: string, timeoutMs?: number): Promise<string | null> {
  try {
    const value = await run('git', ['config', '--global', '--get', key], { timeoutMs });
    return value === '' ? null : value;
  } catch (err) {
    // `git config --get` exits 1 when the key is unset. Distinguish from real failures
    // by inspecting the wrapped child_process error: exit-1 with empty stderr means unset.
    const cause = (err as RepoError).cause as ExecChildError | undefined;
    if (cause && cause.code === 1 && (!cause.stderr || cause.stderr.toString().trim() === '')) {
      return null;
    }
    throw err;
  }
}

export async function remoteShowDefaultBranch(repoDir: string, timeoutMs?: number): Promise<string> {
  const out = await run('git', ['remote', 'show', 'origin'], { cwd: repoDir, timeoutMs });
  for (const line of out.split('\n')) {
    const match = line.match(/^\s*HEAD branch:\s*(\S+)\s*$/);
    if (match && match[1]) return match[1];
  }
  throw new RepoError('could not determine default branch from `git remote show origin`');
}

export async function filterRepo(repoDir: string, args: string[], timeoutMs?: number): Promise<void> {
  if (!(await isAvailable('git-filter-repo'))) {
    throw new RepoError(
      '`git filter-repo` is not on PATH. Install from https://github.com/newren/git-filter-repo',
    );
  }
  await run('git', ['filter-repo', ...args], { cwd: repoDir, timeoutMs });
}

export async function isAvailable(binName: string, timeoutMs = 5_000): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    await run(probe, [binName], { timeoutMs });
    return true;
  } catch {
    return false;
  }
}
