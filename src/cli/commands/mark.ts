import { dirname, relative } from 'node:path';
import type { Command } from 'commander';
import * as gitOps from '../../core/git-ops.js';
import { listMetaFiles } from '../../core/repo.js';
import { readMeta, writeMeta } from '../../core/metadata.js';
import { resolve as resolveSession } from '../../core/name-resolver.js';
import { currentUserEmail } from '../../core/identity.js';
import { readUserConfig } from '../../core/config.js';
import { ConfigError, OwnershipError } from '../../lib/errors.js';
import { info, warn } from '../ui.js';

export interface MarkOptions {
  public?: boolean;
  team?: boolean;
  private?: boolean;
  delete?: boolean;
}

export function register(program: Command): void {
  program
    .command('mark <name-or-id>')
    .description('Change visibility (--public/--team or --private) or delete (--delete) a session you own.')
    .option('--public', 'set visibility=team (alias of --team)')
    .option('--team', 'set visibility=team')
    .option('--private', 'set visibility=private')
    .option('--delete', 'remove the session directory from the repo (history retained)')
    .action(async (query: string, opts: MarkOptions) => {
      await runMark(query, opts);
    });
}

type Action =
  | { kind: 'visibility'; value: 'team' | 'private' }
  | { kind: 'delete' };

function resolveAction(opts: MarkOptions): Action {
  const team = opts.public === true || opts.team === true;
  const priv = opts.private === true;
  const del = opts.delete === true;

  const count = (team ? 1 : 0) + (priv ? 1 : 0) + (del ? 1 : 0);
  if (count === 0) {
    throw new ConfigError(
      'drev mark requires exactly one of --public/--team, --private, or --delete.',
    );
  }
  if (count > 1) {
    throw new ConfigError(
      'drev mark flags --public/--team, --private, and --delete are mutually exclusive; pass exactly one.',
    );
  }

  if (del) return { kind: 'delete' };
  if (priv) return { kind: 'visibility', value: 'private' };
  return { kind: 'visibility', value: 'team' };
}

export async function runMark(query: string, opts: MarkOptions): Promise<void> {
  const action = resolveAction(opts);

  const cfg = await readUserConfig();
  const repoDir = cfg.default_repo;
  if (repoDir === null || repoDir.length === 0) {
    throw new ConfigError(
      'No default repo configured. Run `drev init <repo-url>` first.',
    );
  }

  await gitOps.pullRebase(repoDir);

  const metaFiles = await listMetaFiles(repoDir);
  const resolved = await resolveSession(query, metaFiles);

  const myEmail = await currentUserEmail();
  if (resolved.meta.user_email.toLowerCase() !== myEmail.toLowerCase()) {
    throw new OwnershipError(
      `session '${resolved.meta.name ?? resolved.meta.id.slice(0, 8)}' is owned by ${resolved.meta.user_email}; you are ${myEmail}`,
    );
  }

  const sessionDirAbs = dirname(resolved.metaPath);
  // Use posix separators in the relative path passed to git so the command line
  // is portable on Windows (git accepts forward slashes universally).
  const sessionDirRel = relative(repoDir, sessionDirAbs).split('\\').join('/');
  const displayName = resolved.meta.name ?? resolved.meta.id.slice(0, 8);

  if (action.kind === 'delete') {
    await gitOps.rm(repoDir, sessionDirRel, true);
    await gitOps.commit(repoDir, `delete: ${displayName}`);
    await gitOps.push(repoDir);
    warn(
      `session '${displayName}' removed from the working tree, but Git history retains the data.`,
    );
    warn(
      `For true removal (history rewrite + force-push), run: drev scrub ${resolved.meta.id.slice(0, 8)} --confirm`,
    );
    info(`marked '${displayName}' deleted`);
    return;
  }

  // Visibility change: re-read meta from the resolved path (no-op normally,
  // but keeps the mutation explicit and isolates serialization here).
  const meta = await readMeta(resolved.metaPath);
  if (meta.visibility === action.value) {
    info(`session '${displayName}' is already ${action.value}; nothing to do`);
    return;
  }
  meta.visibility = action.value;
  await writeMeta(resolved.metaPath, meta);

  await gitOps.add(repoDir, [sessionDirRel]);
  await gitOps.commit(repoDir, `mark: ${displayName} ${action.value}`);
  await gitOps.push(repoDir);
  info(`marked '${displayName}' ${action.value}`);
}
