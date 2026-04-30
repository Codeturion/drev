import type { Command } from 'commander';
import * as gitOps from '../../core/git-ops.js';
import { listMetaFiles } from '../../core/repo.js';
import { readMeta, type SessionMeta } from '../../core/metadata.js';
import { readUserConfig } from '../../core/config.js';
import { RepoError } from '../../lib/errors.js';
import { info, table, warn } from '../ui.js';

export function register(program: Command): void {
  program
    .command('search <query>')
    .description('Search session metadata (name, title, summary, files_touched).')
    .action(async (query: string) => {
      await runSearch(query);
    });
}

export async function runSearch(query: string): Promise<void> {
  const cfg = await readUserConfig();
  if (!cfg.default_repo) {
    throw new RepoError(
      "No default repo configured. Run 'drev init <repo-url>' first.",
    );
  }
  const repoDir = cfg.default_repo;

  try {
    await gitOps.pullRebase(repoDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`pull --rebase failed, using local state: ${msg}`);
  }

  const metaPaths = await listMetaFiles(repoDir);
  const metas: SessionMeta[] = [];
  for (const p of metaPaths) {
    try {
      metas.push(await readMeta(p));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`skipping ${p}: ${msg}`);
    }
  }

  const matches = metas.filter((m) => matchesQuery(m, query));
  matches.sort((a, b) => b.shared_at.localeCompare(a.shared_at));

  if (matches.length === 0) {
    info(`no sessions match '${query}'`);
    return;
  }

  const now = new Date();
  const rows = matches.map((m) => ({
    id: m.id.slice(0, 8),
    name: m.name ?? '',
    user: m.user,
    project: m.project ?? '',
    age: humanAge(m.shared_at, now),
    title: m.title ?? '',
  }));
  const out = table(rows, ['id', 'name', 'user', 'project', 'age', 'title']);
  process.stdout.write(`${out}\n`);
}

function matchesQuery(meta: SessionMeta, query: string): boolean {
  const q = query.toLowerCase();
  if (q.length === 0) return true;
  const fields: string[] = [];
  if (meta.name) fields.push(meta.name);
  if (meta.title) fields.push(meta.title);
  if (meta.summary) fields.push(meta.summary);
  for (const f of fields) {
    if (f.toLowerCase().includes(q)) return true;
  }
  if (meta.files_touched) {
    for (const f of meta.files_touched) {
      if (f.toLowerCase().includes(q)) return true;
    }
  }
  return false;
}

export function humanAge(sharedAt: string, now: Date = new Date()): string {
  const ts = Date.parse(sharedAt);
  if (!Number.isFinite(ts)) return '?';
  const diffMs = now.getTime() - ts;
  if (diffMs < 0) return '0m ago';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}
