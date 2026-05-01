import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import * as gitOps from '../../core/git-ops.js';
import { ensureScaffold } from '../../core/repo.js';
import { readUserConfig, writeUserConfig } from '../../core/config.js';
import { RepoError } from '../../lib/errors.js';
import { confirm, info, prompt, spinner, warn } from '../ui.js';
import { runInstall as runHooksInstall } from './hooks.js';

const execFileAsync = promisify(execFile);

const HTTP_RE = /^https?:\/\/[^\s]+$/;
const SSH_URL_RE = /^(?:ssh|git|git\+ssh):\/\/[^\s]+$/;
const SCP_RE = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[A-Za-z0-9_./~-]+$/;
const SHORTHAND_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const GH_TIMEOUT_MS = 30_000;

interface InitOptions {
  name?: string;
  local?: boolean;
  at?: string;
  reinit?: boolean;
  autoShare?: boolean;
}

interface ExecChildError extends Error {
  code?: string | number | null;
  killed?: boolean;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

export function register(program: Command): void {
  program
    .command('init [target]')
    .description(
      "Initialize Drev. Run with no args for the wizard, or pass a Git URL, an 'owner/name' shorthand, or --local.",
    )
    .option('--name <local-name>', 'local clone directory name')
    .option('--local', 'create a local-only bare repo (no GitHub)')
    .option('--at <path>', 'path for the local bare repo (use with --local)')
    .option('--reinit', 'replace an existing default repo binding')
    .option('--no-auto-share', 'skip auto-installing Claude Code hooks and the drev skill')
    .action(async (target: string | undefined, opts: InitOptions) => {
      await runInit(target, opts);
    });
}

export async function runInit(
  target: string | undefined,
  opts: InitOptions,
): Promise<void> {
  const cfg = await readUserConfig();
  const existing = cfg.default_repo;
  if (existing && existing.length > 0 && !opts.reinit) {
    info(
      `Already initialized at ${existing}. Use --reinit to point at a different repo.`,
    );
    return;
  }

  const mode = parseMode(target, opts);
  switch (mode.kind) {
    case 'wizard':
      await runWizard(opts);
      break;
    case 'url':
      await executeUrlFlow(mode.url, { name: opts.name });
      break;
    case 'shorthand':
      await executeShorthandFlow(mode.shorthand, opts);
      break;
    case 'local':
      await executeLocalFlow(opts);
      break;
  }

  await maybeAutoInstall(opts);
}

async function maybeAutoInstall(opts: InitOptions): Promise<void> {
  if (opts.autoShare === false) {
    info('Auto-share skipped. Run `drev hooks install` to enable later.');
    return;
  }
  try {
    await runHooksInstall();
    info('Auto-share enabled. Hooks + skill installed. Run `drev hooks uninstall` to disable.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`Auto-install of hooks/skill failed: ${msg}. Run \`drev hooks install\` to retry.`);
  }
}

type Mode =
  | { kind: 'wizard' }
  | { kind: 'url'; url: string }
  | { kind: 'shorthand'; shorthand: string }
  | { kind: 'local' };

function parseMode(target: string | undefined, opts: InitOptions): Mode {
  const trimmed = typeof target === 'string' ? target.trim() : '';

  if (trimmed.length === 0) {
    if (opts.local) return { kind: 'local' };
    return { kind: 'wizard' };
  }

  // Power-URL form: anything containing :// or matching scp form.
  if (
    HTTP_RE.test(trimmed) ||
    SSH_URL_RE.test(trimmed) ||
    SCP_RE.test(trimmed)
  ) {
    return { kind: 'url', url: trimmed };
  }

  if (SHORTHAND_RE.test(trimmed)) {
    return { kind: 'shorthand', shorthand: trimmed };
  }

  throw new RepoError(
    `Could not parse '${target ?? ''}'. Pass a Git URL, a 'owner/name' shorthand, or use --local.`,
  );
}

async function runWizard(opts: InitOptions): Promise<void> {
  if (!(await gitOps.isAvailable('gh'))) {
    throw new RepoError(
      "Drev's setup wizard needs the GitHub CLI ('gh'). Install: https://cli.github.com — or run 'drev init <url>' / 'drev init --local'.",
    );
  }

  let user: string;
  try {
    user = (await runGh(['api', 'user', '-q', '.login'])).trim();
  } catch (err) {
    throw new RepoError(
      "Couldn't read your GitHub username (gh auth status?). Try 'gh auth login'.",
      { cause: err },
    );
  }
  if (user.length === 0) {
    throw new RepoError(
      "Couldn't read your GitHub username (gh auth status?). Try 'gh auth login'.",
    );
  }

  const pasted = await prompt(
    'Got a Drev repo URL from your team? (paste it, or leave empty to create new): ',
  );
  if (pasted.length > 0) {
    await executeUrlFlow(pasted, { name: opts.name });
    return;
  }

  const defaultTarget = `${user}/drev-sessions`;
  const ok = await confirm(`Create private repo at ${defaultTarget}?`);
  let shorthand: string;
  if (ok) {
    shorthand = defaultTarget;
  } else {
    const answer = await prompt("Enter '<owner>/<name>': ");
    if (!SHORTHAND_RE.test(answer)) {
      throw new RepoError(
        `Invalid '<owner>/<name>': '${answer}'. Use letters, digits, dot, dash, or underscore on both sides of '/'.`,
      );
    }
    shorthand = answer;
  }

  await executeShorthandFlow(shorthand, opts);
}

async function executeShorthandFlow(
  shorthand: string,
  opts: InitOptions,
): Promise<void> {
  if (!(await gitOps.isAvailable('gh'))) {
    throw new RepoError(
      `Drev needs the GitHub CLI ('gh') to resolve '${shorthand}'. Install: https://cli.github.com — or run 'drev init <full-url>' / 'drev init --local'.`,
    );
  }

  let viewStdout: string | null = null;
  try {
    viewStdout = await runGh(['repo', 'view', shorthand, '--json', 'url']);
  } catch (err) {
    if (isGhNotFound(err)) {
      // Fall through to create.
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RepoError(
        `Could not check if '${shorthand}' exists on GitHub: ${msg}`,
        { cause: err },
      );
    }
  }

  let url: string;
  if (viewStdout !== null) {
    url = parseRepoUrl(viewStdout, shorthand);
  } else {
    try {
      await runGh([
        'repo',
        'create',
        shorthand,
        '--private',
        '--description',
        'Drev sessions repo',
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RepoError(
        `Failed to create '${shorthand}' on GitHub: ${msg}`,
        { cause: err },
      );
    }
    url = `https://github.com/${shorthand}.git`;
  }

  await executeUrlFlow(url, { name: opts.name });
}

async function executeLocalFlow(opts: InitOptions): Promise<void> {
  const barePath =
    typeof opts.at === 'string' && opts.at.length > 0
      ? opts.at
      : join(homedir(), '.drev', 'local-sessions.git');

  if (await pathExists(barePath)) {
    throw new RepoError(
      `local repo already exists at ${barePath}; remove it or pass --at <other>`,
    );
  }

  try {
    await execFileAsync('git', ['init', '--bare', barePath], {
      timeout: GH_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RepoError(
      `Failed to create local bare repo at ${barePath}: ${msg}`,
      { cause: err },
    );
  }

  const baseName = basename(barePath).replace(/\.git$/, '');
  const cloneName = opts.name ?? (baseName.length > 0 ? baseName : 'local-sessions');
  const clonePath = join(homedir(), '.drev', 'repos', cloneName);

  if (await pathExists(clonePath)) {
    throw new RepoError(
      `drev is already initialized at ${clonePath}; use a different --name or remove that directory.`,
    );
  }

  await cloneScaffoldAndPush(barePath, clonePath, baseName);
  await writeDefaultRepo(clonePath);
  printSuccess(clonePath);
}

async function executeUrlFlow(
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

  await cloneScaffoldAndPush(repoUrl, clonePath, segment ?? name);
  await writeDefaultRepo(clonePath);
  printSuccess(clonePath);
}

async function cloneScaffoldAndPush(
  source: string,
  clonePath: string,
  teamName: string,
): Promise<void> {
  const sp = spinner(`Cloning ${source} into ${clonePath}...`);
  try {
    await gitOps.clone(source, clonePath);
    sp.succeed(`Cloned ${source}`);
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

  const hadDrev = await pathExists(join(clonePath, '.drev'));
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
}

async function writeDefaultRepo(clonePath: string): Promise<void> {
  const cfg = await readUserConfig();
  cfg.default_repo = clonePath;
  await writeUserConfig(cfg);
}

function printSuccess(clonePath: string): void {
  info(`Drev initialized at ${clonePath}.`);
  info(`Run 'drev share' to share your first session.`);
}

async function runGh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      timeout: GH_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.toString();
  } catch (err) {
    throw err;
  }
}

function isGhNotFound(err: unknown): boolean {
  const e = err as ExecChildError;
  const stderr = (e?.stderr ?? '').toString().toLowerCase();
  if (
    stderr.includes('could not resolve') ||
    stderr.includes('not found') ||
    stderr.includes('no such repository') ||
    stderr.includes('http 404')
  ) {
    return true;
  }
  // gh exits 1 for "not found" on `gh repo view`.
  return false;
}

function parseRepoUrl(stdout: string, shorthand: string): string {
  try {
    const obj = JSON.parse(stdout) as { url?: unknown };
    if (typeof obj.url === 'string' && obj.url.length > 0) {
      const url = obj.url;
      // gh returns the web URL; ensure it ends with .git for git clone friendliness.
      if (/^https?:\/\//.test(url) && !url.endsWith('.git')) {
        return `${url}.git`;
      }
      return url;
    }
  } catch {
    // fall through
  }
  return `https://github.com/${shorthand}.git`;
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
