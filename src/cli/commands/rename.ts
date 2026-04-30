import { basename, dirname, join, posix, relative } from 'node:path';
import type { Command } from 'commander';
import * as gitOps from '../../core/git-ops.js';
import { listMetaFiles, sanitizeName } from '../../core/repo.js';
import { readMeta, writeMeta } from '../../core/metadata.js';
import { resolve as resolveSession } from '../../core/name-resolver.js';
import { currentUserEmail } from '../../core/identity.js';
import { readUserConfig } from '../../core/config.js';
import { OwnershipError, RepoError } from '../../lib/errors.js';
import { info } from '../ui.js';

const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})-/;

export function register(program: Command): void {
  program
    .command('rename <name-or-id> <new-name>')
    .description('Rename a session you own (preserves the original date prefix).')
    .action(async (query: string, newName: string) => {
      await runRename(query, newName);
    });
}

export async function runRename(query: string, newName: string): Promise<void> {
  const userCfg = await readUserConfig();
  const repoDir = userCfg.default_repo;
  if (repoDir === null || repoDir.length === 0) {
    throw new RepoError(
      "no default repo configured; run 'drev init <repo-url>' first.",
    );
  }

  await gitOps.pullRebase(repoDir);

  const metaFiles = await listMetaFiles(repoDir);
  const resolved = await resolveSession(query, metaFiles);
  const meta = resolved.meta;

  const ownerEmail = await currentUserEmail();
  if (meta.user_email !== ownerEmail) {
    throw new OwnershipError(
      `cannot rename session owned by ${meta.user_email} (you are ${ownerEmail}).`,
    );
  }

  const oldDirAbs = dirname(resolved.metaPath);
  const oldDirName = basename(oldDirAbs);
  const userDirAbs = dirname(oldDirAbs);
  const userName = basename(userDirAbs);

  const dateMatch = DATE_PREFIX_RE.exec(oldDirName);
  if (dateMatch === null) {
    throw new RepoError(
      `session directory '${oldDirName}' is missing the YYYY-MM-DD- prefix; cannot rename.`,
    );
  }
  const datePrefix = dateMatch[1]!;

  const sanitized = sanitizeName(newName);
  const newDirName = `${datePrefix}-${sanitized}`;

  if (newDirName === oldDirName) {
    throw new RepoError(`new name resolves to the same directory '${oldDirName}'.`);
  }

  // Build POSIX-style relative paths; git mv accepts forward slashes on every platform.
  const oldRelPath = toPosixRel(repoDir, oldDirAbs);
  const newRelPath = posix.join(posix.dirname(oldRelPath), newDirName);

  // Collision check: another session already uses the target directory under this user.
  for (const other of metaFiles) {
    if (other === resolved.metaPath) continue;
    const otherDir = dirname(other);
    const otherUser = basename(dirname(otherDir));
    const otherDirName = basename(otherDir);
    if (otherUser === userName && otherDirName === newDirName) {
      throw new RepoError(
        `target directory '${newRelPath}' already exists; pick a different name.`,
      );
    }
  }

  await gitOps.mv(repoDir, oldRelPath, newRelPath);

  // git mv has relocated meta.yaml; read it from the new path, update name, write back.
  const newMetaPath = join(userDirAbs, newDirName, 'meta.yaml');
  const movedMeta = await readMeta(newMetaPath);
  movedMeta.name = sanitized;
  await writeMeta(newMetaPath, movedMeta);

  await gitOps.add(repoDir, [newRelPath, oldRelPath]);
  await gitOps.commit(repoDir, `rename: ${oldDirName} -> ${newDirName}`);
  await gitOps.push(repoDir);

  info(`renamed ${oldDirName} -> ${newDirName}`);
}

function toPosixRel(repoDir: string, abs: string): string {
  const rel = relative(repoDir, abs);
  return rel.split(/[\\/]/).join('/');
}
