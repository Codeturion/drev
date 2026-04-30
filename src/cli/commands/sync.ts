import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import * as gitOps from '../../core/git-ops.js';
import * as outbox from '../../core/outbox.js';
import { dateAndNamePrefix, sessionDir } from '../../core/repo.js';
import { parseMeta } from '../../core/metadata.js';
import { currentUserEmail, shortUsername } from '../../core/identity.js';
import { readUserConfig } from '../../core/config.js';
import { ConfigError } from '../../lib/errors.js';
import { info, warn } from '../ui.js';

export function register(program: Command): void {
  program
    .command('sync')
    .description('Pull from the remote and drain queued shares from the outbox.')
    .action(async () => {
      await runSync();
    });
}

export async function runSync(): Promise<void> {
  const cfg = await readUserConfig();
  if (!cfg.default_repo) {
    throw new ConfigError(
      "default_repo is not set in user config; run 'drev init <repo-url>' first",
    );
  }
  const repoDir = cfg.default_repo;

  await gitOps.pullRebase(repoDir);

  const ids = await outbox.listQueued();
  if (ids.length === 0) {
    info('outbox is empty');
    return;
  }

  const email = await currentUserEmail();
  const self = shortUsername(email);

  let drained = 0;
  let kept = 0;

  // Each item is processed independently so a single failure (e.g. corrupt meta,
  // push rejected) cannot block subsequent items in the queue.
  for (const id of ids) {
    try {
      await drainOne(repoDir, self, id);
      await outbox.dequeue(id);
      drained += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`outbox item ${id} kept queued: ${msg}`);
      kept += 1;
    }
  }

  info(`pulled ${ids.length} new, drained ${drained}, kept ${kept} queued`);
}

async function drainOne(
  repoDir: string,
  self: string,
  id: string,
): Promise<void> {
  const { session, meta: metaText } = await outbox.readQueued(id);
  const meta = parseMeta(metaText);

  const sharedAt = new Date(meta.shared_at);
  const dirName = dateAndNamePrefix(
    sharedAt,
    meta.name ?? null,
    meta.id.slice(0, 8),
  );

  const target = sessionDir(repoDir, self, dirName);
  await mkdir(target, { recursive: true });

  const sessionPath = join(target, 'session.jsonl');
  const metaPath = join(target, 'meta.yaml');
  await writeFile(sessionPath, session, 'utf8');
  await writeFile(metaPath, metaText, 'utf8');

  await gitOps.add(repoDir, [sessionPath, metaPath]);
  const commitMessage = `share: ${meta.name ?? meta.id.slice(0, 8)}`;
  await gitOps.commit(repoDir, commitMessage);
  await gitOps.push(repoDir);
}
