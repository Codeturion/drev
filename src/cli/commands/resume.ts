import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Command } from 'commander';
import * as gitOps from '../../core/git-ops.js';
import { listMetaFiles } from '../../core/repo.js';
import { resolve as resolveSession } from '../../core/name-resolver.js';
import {
  claudeProjectsDir,
  encodedCwd,
  sessionPath,
  subagentDir,
} from '../../core/claude-paths.js';
import { rewritePaths } from '../../core/path-rewriter.js';
import { stripThinkingSignatures } from '../../core/session.js';
import { readUserConfig } from '../../core/config.js';
import { ConfigError, RepoError } from '../../lib/errors.js';
import { confirm, info, isInteractive, warn } from '../ui.js';

export interface ResumeOptions {
  into?: string;
  launch?: boolean;
  force?: boolean;
  checkout?: boolean;
}

export function register(program: Command): void {
  program
    .command('resume <name-or-id>')
    .description('Resume a session by name or ID; launches Claude Code by default.')
    .option('--into <path>', 'destination project root (overrides auto-detection)')
    .option('--no-launch', 'prepare the session but do not spawn Claude Code')
    .option('--force', 'overwrite an existing local session file without prompting')
    .option('--checkout', 'on drift, git checkout the recorded commit_sha (auto-stashes if dirty)')
    .action(async (query: string, opts: ResumeOptions) => {
      await runResume(query, opts);
    });
}

export async function runResume(query: string, opts: ResumeOptions): Promise<void> {
  const cfg = await readUserConfig();
  if (!cfg.default_repo) {
    throw new ConfigError(
      "default_repo is not set in user config; run 'drev init <repo-url>' first",
    );
  }
  const repoDir = cfg.default_repo;

  await gitOps.pullRebase(repoDir);

  const metaFiles = await listMetaFiles(repoDir);
  const resolved = await resolveSession(query, metaFiles);
  const sessionDirOnDisk = dirname(resolved.metaPath);

  const parentJsonlPath = join(sessionDirOnDisk, 'session.jsonl');
  const parentJsonl = await readFile(parentJsonlPath, 'utf8');

  const subagentSourceDir = join(sessionDirOnDisk, 'subagents');
  const subagentEntries = await listSubagentFiles(subagentSourceDir);

  const destRoot = await determineDestRoot(opts.into);
  const id = resolved.meta.id;
  const displayName = resolved.meta.name ?? id.slice(0, 8);

  // Drift detection: compare meta.commit_sha to local HEAD. The result drives
  // both the warning and --checkout below.
  let driftSha: string | null = null;
  let isGitRepo = false;
  if (resolved.meta.commit_sha) {
    try {
      const localHead = await gitOps.revParse(destRoot, 'HEAD');
      isGitRepo = true;
      if (localHead !== resolved.meta.commit_sha) {
        driftSha = resolved.meta.commit_sha;
        if (!opts.checkout) {
          warn(
            `working tree HEAD (${localHead.slice(0, 8)}) differs from session commit_sha (${resolved.meta.commit_sha.slice(0, 8)}); files may have moved since the session was captured`,
          );
        }
      }
    } catch {
      // destRoot may not be a git repo; drift check is best-effort.
    }
  }

  // --checkout: pin the working tree to the recorded commit so paths and line
  // numbers in the transcript still resolve. Auto-stashes a dirty tree.
  if (opts.checkout) {
    if (!resolved.meta.commit_sha) {
      throw new RepoError(
        '--checkout requires a session with a recorded commit_sha; this one has none.',
      );
    }
    if (!isGitRepo) {
      throw new RepoError(
        `--checkout requires the destination to be a git repo (got ${destRoot}).`,
      );
    }
    if (driftSha !== null) {
      const clean = await gitOps.isClean(destRoot);
      let stashed = false;
      if (!clean) {
        await gitOps.stashPush(destRoot, `drev resume ${displayName}`);
        stashed = true;
      }
      await gitOps.checkout(destRoot, driftSha);
      const recovery = stashed
        ? 'Recover with: git checkout - && git stash pop'
        : 'Recover with: git checkout -';
      info(`Checked out ${driftSha.slice(0, 8)}. ${recovery}.`);
    } else {
      info('--checkout: working tree already matches session commit_sha, no-op.');
    }
  }

  const sourceRoot = resolved.meta.project_root;
  const rewrittenParent = stripThinkingSignatures(rewritePaths(parentJsonl, sourceRoot, destRoot));

  const targetDir = join(claudeProjectsDir(), encodedCwd(destRoot));
  const targetParentPath = sessionPath(destRoot, id);

  // Overwrite protection: refuse to clobber an existing local session unless
  // the caller has explicitly opted in (--force) or confirms interactively.
  if (await fileExists(targetParentPath)) {
    const allowed = await confirmOverwrite(targetParentPath, id, opts.force);
    if (!allowed) {
      info('Resume cancelled (existing local session preserved).');
      return;
    }
  }

  await mkdir(targetDir, { recursive: true });
  await writeFile(targetParentPath, rewrittenParent, 'utf8');

  if (subagentEntries.length > 0) {
    const targetSubagentDir = subagentDir(destRoot, id);
    await mkdir(targetSubagentDir, { recursive: true });
    for (const sub of subagentEntries) {
      const raw = await readFile(sub, 'utf8');
      const rewritten = stripThinkingSignatures(rewritePaths(raw, sourceRoot, destRoot));
      const out = join(targetSubagentDir, basename(sub));
      await writeFile(out, rewritten, 'utf8');
    }
  }

  info(`Resuming '${displayName}' in ${destRoot}...`);

  if (opts.launch === false) {
    printFallback(destRoot, id);
    return;
  }

  const available = await gitOps.isAvailable('claude');
  if (!available) {
    printFallback(destRoot, id);
    return;
  }

  await launchClaude(destRoot, id);
}

async function launchClaude(destRoot: string, id: string): Promise<void> {
  await new Promise<void>((resolveExit) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolveExit();
    };

    let child;
    try {
      child = spawn('claude', ['--resume', id], {
        cwd: destRoot,
        stdio: 'inherit',
        shell: false,
      });
    } catch {
      printFallback(destRoot, id);
      finish();
      return;
    }

    child.on('error', () => {
      printFallback(destRoot, id);
      finish();
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      // Drev exits with the subprocess's exit code on close (§9.5 step 11).
      process.exit(typeof code === 'number' ? code : 0);
    });
  });
}

function printFallback(destRoot: string, id: string): void {
  const lines = [
    'Session prepared but Claude Code was not launched automatically.',
    `Run this command from ${destRoot}:`,
    '',
    `    claude --resume ${id}`,
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function determineDestRoot(intoFlag: string | undefined): Promise<string> {
  if (typeof intoFlag === 'string' && intoFlag.length > 0) {
    return intoFlag;
  }
  const top = await gitOps.showTopLevel(process.cwd());
  if (top) return top;
  // No --into and cwd is not inside a git repo: fall back to cwd. Spec §9.5 step 4
  // says prompt the user, but for v0 we silently default and log so the command
  // never fails just because the destination isn't a git repo.
  const cwd = process.cwd();
  info(`destination not specified; using ${cwd} (override with --into <path>)`);
  return cwd;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function confirmOverwrite(
  targetPath: string,
  id: string,
  force: boolean | undefined,
): Promise<boolean> {
  if (force) return true;
  if (!isInteractive()) {
    throw new RepoError(
      `local session already exists at ${targetPath}; pass --force to overwrite.`,
    );
  }
  return await confirm(`Overwrite existing local session for ${id.slice(0, 8)}?`);
}

async function listSubagentFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(join(dir, entry.name));
    }
  }
  out.sort();
  return out;
}
