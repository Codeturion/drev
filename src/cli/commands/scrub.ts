import { execFile } from 'node:child_process';
import { dirname, relative } from 'node:path';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import * as gitOps from '../../core/git-ops.js';
import { listMetaFiles } from '../../core/repo.js';
import { resolve as resolveSession } from '../../core/name-resolver.js';
import { currentUserEmail } from '../../core/identity.js';
import { readUserConfig } from '../../core/config.js';
import { ConfigError, OwnershipError, RepoError } from '../../lib/errors.js';
import { info, warn } from '../ui.js';

const execFileAsync = promisify(execFile);

const FORCE_PUSH_TIMEOUT_MS = 60_000;

export interface ScrubOptions {
  confirm?: boolean;
}

export function register(program: Command): void {
  program
    .command('scrub <name-or-id>')
    .description(
      'Permanently remove a session from Git history (rewrites + force-pushes). Requires --confirm.',
    )
    .option('--confirm', 'actually perform the scrub (rewrites history and force-pushes)')
    .action(async (query: string, opts: ScrubOptions) => {
      await runScrub(query, opts);
    });
}

export async function runScrub(query: string, opts: ScrubOptions): Promise<void> {
  const cfg = await readUserConfig();
  const repoDir = cfg.default_repo;
  if (repoDir === null || repoDir.length === 0) {
    throw new ConfigError(
      'No default repo configured. Run `drev init <repo-url>` first.',
    );
  }

  // Best-effort pull. If the remote is unreachable we still let the user proceed:
  // scrub is an emergency operation and a failed pull is just a stale base.
  // We surface the failure as a warning so the user can decide whether to abort.
  try {
    await gitOps.pullRebase(repoDir);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`pull --rebase failed; continuing with local state (${reason}).`);
  }

  const metaFiles = await listMetaFiles(repoDir);
  const resolved = await resolveSession(query, metaFiles);

  const myEmail = await currentUserEmail();
  if (resolved.meta.user_email.toLowerCase() !== myEmail.toLowerCase()) {
    throw new OwnershipError(
      `session '${resolved.meta.name ?? resolved.meta.id.slice(0, 8)}' is owned by ${resolved.meta.user_email}; you are ${myEmail}`,
    );
  }

  const sessionDirAbs = dirname(resolved.metaPath);
  // git accepts forward slashes universally; normalize for cross-platform safety.
  const sessionDirRel = relative(repoDir, sessionDirAbs).split('\\').join('/');
  const displayName = resolved.meta.name ?? resolved.meta.id.slice(0, 8);

  if (opts.confirm !== true) {
    info(`scrub: '${displayName}' (${sessionDirRel})`);
    info('This is a dry run. To actually scrub, re-run with --confirm.');
    info('What --confirm will do:');
    info('  - Rewrite Git history to remove the session directory entirely.');
    info('  - Force-push the rewritten history to the remote.');
    info('  - Other engineers must re-clone the repository afterward;');
    info('    their existing clones still contain the scrubbed data.');
    return;
  }

  if (!(await gitOps.isAvailable('git-filter-repo'))) {
    throw new RepoError(
      'git-filter-repo not found on PATH. Install: pip install git-filter-repo  (or)  brew install git-filter-repo',
    );
  }

  await gitOps.filterRepo(repoDir, ['--path', sessionDirRel, '--invert-paths']);

  await forcePush(repoDir);

  info(`scrubbed '${displayName}' from history.`);
  warn(
    'Other engineers must re-clone the repository to discard their copies of the scrubbed history.',
  );
}

async function forcePush(repoDir: string): Promise<void> {
  try {
    await execFileAsync('git', ['push', '--force'], {
      cwd: repoDir,
      timeout: FORCE_PUSH_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      // shell defaults to false; do not override.
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr = (e.stderr ?? '').toString().trim();
    const message = stderr
      ? `git push --force failed: ${stderr}`
      : 'git push --force failed';
    throw new RepoError(message, { cause: err });
  }
}
