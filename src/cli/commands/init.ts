import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import * as gitOps from '../../core/git-ops.js';
import { ensureScaffold } from '../../core/repo.js';
import { readUserConfig, writeUserConfig } from '../../core/config.js';
import { RepoError } from '../../lib/errors.js';
import { info, spinner, warn } from '../ui.js';

const HTTP_RE = /^https?:\/\/[^\s]+$/;
const SSH_URL_RE = /^(?:ssh|git|git\+ssh):\/\/[^\s]+$/;
const SCP_RE = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[A-Za-z0-9_./~-]+$/;

export function register(program: Command): void {
  program
    .command('init <repo-url>')
    .description('Initialize Drev with a Git remote (clones into ~/.drev/repos/<name>).')
    .option('--name <local-name>', 'local clone directory name')
    .action(async (repoUrl: string, opts: { name?: string }) => {
      await runInit(repoUrl, opts);
    });
}

export async function runInit(
  repoUrl: string,
  opts: { name?: string },
): Promise<void> {
  validateUrl(repoUrl);

  const segment = lastUrlSegment(repoUrl);
  const name = opts.name ?? segment;
  if (!name) {
    throw new RepoError(
      `Could not derive a local clone name from URL '${repoUrl}'. Pass --name explicitly.`,
    );
  }

  const clonePath = join(homedir(), '.drev', 'repos', name);

  if (await pathExists(clonePath)) {
    throw new RepoError(
      `drev is already initialized at ${clonePath}; use a different --name or remove that directory.`,
    );
  }

  const sp = spinner(`Cloning ${repoUrl} into ${clonePath}...`);
  try {
    await gitOps.clone(repoUrl, clonePath);
    sp.succeed(`Cloned ${repoUrl}`);
  } catch (err) {
    sp.fail(`Clone failed`);
    throw err;
  }

  // Detect default branch (informational; ensures the remote is reachable and HEAD is set).
  // Failure here is non-fatal for scaffolding but indicates the remote isn't usable.
  try {
    await gitOps.remoteShowDefaultBranch(clonePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`Could not detect default branch: ${msg}`);
  }

  const teamName = segment ?? name;
  const hadDrev = await pathExists(join(clonePath, '.drev'));

  // ensureScaffold both creates a fresh scaffold and validates an existing one's schema.
  const result = await ensureScaffold(clonePath, teamName);

  if (!hadDrev && result.created) {
    try {
      await gitOps.add(clonePath, ['.drev', 'users', 'README.md']);
      await gitOps.commit(clonePath, 'init drev');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RepoError(`Failed to commit Drev scaffold: ${msg}`, { cause: err });
    }
    try {
      await gitOps.push(clonePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`Push of scaffold failed: ${msg}`);
      warn(`Local clone is ready at ${clonePath}. Run 'drev sync' to retry the push.`);
    }
  }

  const cfg = await readUserConfig();
  cfg.default_repo = clonePath;
  await writeUserConfig(cfg);

  info(`Drev initialized at ${clonePath}.`);
  info(`Run 'drev share' to share your first session.`);
}

function validateUrl(url: string): void {
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw badUrl(url);
  }
  const trimmed = url.trim();
  if (HTTP_RE.test(trimmed)) return;
  if (SSH_URL_RE.test(trimmed)) return;
  if (SCP_RE.test(trimmed)) return;
  throw badUrl(url);
}

function badUrl(url: string): RepoError {
  return new RepoError(
    `Invalid Git URL '${url}'. Expected https://, ssh://, git://, or user@host:path (e.g. https://github.com/org/repo.git).`,
  );
}

function lastUrlSegment(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  // For scp form `user@host:path/repo.git`, split on the rightmost `:` boundary first.
  const colonIdx = trimmed.lastIndexOf(':');
  const slashIdx = trimmed.lastIndexOf('/');
  const cut = Math.max(colonIdx, slashIdx);
  const tail = cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
  if (tail.endsWith('.git')) return tail.slice(0, -4);
  return tail;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    // Surface unexpected stat errors instead of silently swallowing.
    throw new RepoError(`Failed to stat ${p}.`, { cause: err });
  }
}

