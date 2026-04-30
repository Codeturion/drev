import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
import { readUserConfig } from '../../core/config.js';
import { ConfigError, RepoError } from '../../lib/errors.js';
import { info, warn } from '../ui.js';

export interface ResumeOptions {
  into?: string;
  launch?: boolean;
}

export function register(program: Command): void {
  program
    .command('resume <name-or-id>')
    .description('Resume a session by name or ID; launches Claude Code by default.')
    .option('--into <path>', 'destination project root (overrides auto-detection)')
    .option('--no-launch', 'prepare the session but do not spawn Claude Code')
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

  // Drift warning: compare meta.commit_sha to local HEAD; warn (don't block) if different.
  if (resolved.meta.commit_sha) {
    try {
      const localHead = await gitOps.revParse(destRoot, 'HEAD');
      if (localHead !== resolved.meta.commit_sha) {
        warn(
          `working tree HEAD (${localHead.slice(0, 8)}) differs from session commit_sha (${resolved.meta.commit_sha.slice(0, 8)}); files may have moved since the session was captured`,
        );
      }
    } catch {
      // destRoot may not be a git repo; drift check is best-effort.
    }
  }

  const sourceRoot = resolved.meta.project_root;
  const rewrittenParent = rewritePaths(parentJsonl, sourceRoot, destRoot);

  const id = resolved.meta.id;
  const targetDir = join(claudeProjectsDir(), encodedCwd(destRoot));
  await mkdir(targetDir, { recursive: true });
  const targetParentPath = sessionPath(destRoot, id);
  await writeFile(targetParentPath, rewrittenParent, 'utf8');

  if (subagentEntries.length > 0) {
    const targetSubagentDir = subagentDir(destRoot, id);
    await mkdir(targetSubagentDir, { recursive: true });
    for (const sub of subagentEntries) {
      const raw = await readFile(sub, 'utf8');
      const rewritten = rewritePaths(raw, sourceRoot, destRoot);
      const out = join(targetSubagentDir, basename(sub));
      await writeFile(out, rewritten, 'utf8');
    }
  }

  const displayName = resolved.meta.name ?? id.slice(0, 8);
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
  throw new RepoError(
    'could not determine destination project root; pass --into <path> to specify it',
  );
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
