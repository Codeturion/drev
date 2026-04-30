import type { Command } from 'commander';
import * as gitOps from '../../core/git-ops.js';
import { listMetaFiles } from '../../core/repo.js';
import { readMeta } from '../../core/metadata.js';
import type { SessionMeta } from '../../core/metadata.js';
import { currentUserEmail } from '../../core/identity.js';
import { readUserConfig } from '../../core/config.js';
import { ConfigError } from '../../lib/errors.js';
import { info, warn, table } from '../ui.js';

const PULL_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 20;

export interface ListOptions {
  mine?: boolean;
  team?: boolean;
  backups?: boolean;
  project?: string;
  user?: string;
  days?: string;
  limit?: string;
}

export function register(program: Command): void {
  program
    .command('list')
    .description('List available sessions in the configured Drev repo.')
    .option('--mine', 'only your sessions')
    .option('--team', 'only team-visible sessions (excludes your private/backups)')
    .option('--backups', 'only your backups')
    .option('--project <name>', 'substring match on meta.project')
    .option('--user <username>', 'exact match on meta.user')
    .option('--days <n>', 'within last N days (by shared_at)')
    .option('--limit <n>', `cap output (default ${DEFAULT_LIMIT})`)
    .action(async (opts: ListOptions) => {
      await runList(opts);
    });
}

export async function runList(opts: ListOptions): Promise<void> {
  const cfg = await readUserConfig();
  const repoDir = cfg.default_repo;
  if (repoDir === null || repoDir.length === 0) {
    throw new ConfigError(
      'No default repo configured. Run `drev init <repo-url>` first.',
    );
  }

  try {
    await gitOps.pullRebase(repoDir, PULL_TIMEOUT_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`pull failed (${msg}); falling back to local state`);
  }

  const metaPaths = await listMetaFiles(repoDir);
  const metas: SessionMeta[] = [];
  for (const path of metaPaths) {
    try {
      metas.push(await readMeta(path));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`skipping ${path}: ${msg}`);
    }
  }

  const myEmail = await currentUserEmail();

  let filtered = metas;
  if (opts.mine === true) filtered = filtered.filter((m) => filterMine(m, myEmail));
  if (opts.team === true) filtered = filtered.filter((m) => filterTeam(m, myEmail));
  if (opts.backups === true) filtered = filtered.filter((m) => filterBackups(m, myEmail));
  if (typeof opts.project === 'string' && opts.project.length > 0) {
    const needle = opts.project;
    filtered = filtered.filter((m) => filterProject(m, needle));
  }
  if (typeof opts.user === 'string' && opts.user.length > 0) {
    const needle = opts.user;
    filtered = filtered.filter((m) => filterUser(m, needle));
  }
  if (typeof opts.days === 'string' && opts.days.length > 0) {
    const days = Number.parseInt(opts.days, 10);
    if (!Number.isFinite(days) || days < 0) {
      throw new ConfigError(`--days must be a non-negative integer, got '${opts.days}'`);
    }
    const now = Date.now();
    filtered = filtered.filter((m) => filterDays(m, days, now));
  }

  filtered.sort((a, b) => compareSharedAtDesc(a, b));

  const limit = resolveLimit(opts.limit);
  const limited = filtered.slice(0, limit);

  if (limited.length === 0) {
    info('no sessions match filters');
    return;
  }

  const now = Date.now();
  const rows = limited.map((m) => buildRow(m, now));
  process.stdout.write(`${table(rows, ['id', 'name', 'user', 'project', 'age', 'title'])}\n`);
}

function resolveLimit(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`--limit must be a positive integer, got '${raw}'`);
  }
  return n;
}

function compareSharedAtDesc(a: SessionMeta, b: SessionMeta): number {
  const ta = Date.parse(a.shared_at);
  const tb = Date.parse(b.shared_at);
  const aValid = Number.isFinite(ta);
  const bValid = Number.isFinite(tb);
  if (!aValid && !bValid) return 0;
  if (!aValid) return 1;
  if (!bValid) return -1;
  return tb - ta;
}

export function buildRow(m: SessionMeta, now: number): Record<string, string> {
  return {
    id: m.id.slice(0, 8),
    name: m.name ?? '',
    user: m.user,
    project: m.project ?? '',
    age: humanAge(m.shared_at, now),
    title: m.title ?? '',
  };
}

export function humanAge(sharedAt: string, now: number = Date.now()): string {
  const t = Date.parse(sharedAt);
  if (!Number.isFinite(t)) return '';
  const diffMs = Math.max(0, now - t);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (diffMs < minute) return 'just now';
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs < week) return `${Math.floor(diffMs / day)}d ago`;
  return `${Math.floor(diffMs / week)}w ago`;
}

export function filterMine(m: SessionMeta, myEmail: string): boolean {
  return m.user_email.toLowerCase() === myEmail.toLowerCase();
}

export function filterTeam(m: SessionMeta, myEmail: string): boolean {
  // Team-visible: shares with team visibility. Excludes backups (personal artifacts)
  // and excludes own private items per §9.4. Other users' items in the repo are
  // by definition team-visible (they wouldn't have been pushed otherwise).
  const isMine = m.user_email.toLowerCase() === myEmail.toLowerCase();
  if (isMine && m.purpose === 'backup') return false;
  if (isMine && m.visibility === 'private') return false;
  return m.purpose === 'share' && m.visibility === 'team';
}

export function filterBackups(m: SessionMeta, myEmail: string): boolean {
  return m.purpose === 'backup'
    && m.user_email.toLowerCase() === myEmail.toLowerCase();
}

export function filterProject(m: SessionMeta, needle: string): boolean {
  if (typeof m.project !== 'string') return false;
  return m.project.toLowerCase().includes(needle.toLowerCase());
}

export function filterUser(m: SessionMeta, username: string): boolean {
  return m.user === username;
}

export function filterDays(m: SessionMeta, days: number, now: number): boolean {
  const t = Date.parse(m.shared_at);
  if (!Number.isFinite(t)) return false;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return t >= cutoff;
}
