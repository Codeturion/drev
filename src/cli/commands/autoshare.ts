import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';
import type { Command } from 'commander';
import { readUserConfig, writeUserConfig } from '../../core/config.js';
import type { AutoShareMode } from '../../core/config.js';
import { drevHome } from '../../core/claude-paths.js';
import * as gitOps from '../../core/git-ops.js';
import { detectInstalled, detectSkillInstalled } from './hooks.js';
import { errorOut, info } from '../ui.js';

export function register(program: Command): void {
  const cmd = program
    .command('autoshare')
    .description(
      'Manage the auto-share whitelist (per-project scoping) and mode.',
    );

  cmd
    .command('list')
    .description('List whitelisted projects and current auto-share mode.')
    .action(async () => {
      await runList();
    });

  cmd
    .command('add [path]')
    .description(
      'Add a project to the auto-share whitelist. Defaults to the current git toplevel (or cwd).',
    )
    .action(async (path?: string) => {
      await runAdd(path);
    });

  cmd
    .command('remove [path]')
    .description(
      'Remove a project from the auto-share whitelist. Defaults to the current git toplevel (or cwd).',
    )
    .action(async (path?: string) => {
      await runRemove(path);
    });

  cmd
    .command('status')
    .description(
      'Show hook + skill install state, current mode, whitelist, and last sweep info.',
    )
    .action(async () => {
      await runStatus();
    });

  cmd
    .command('on')
    .description("Set auto_share = 'auto-team' (share to team).")
    .action(async () => {
      await runSetMode('auto-team');
    });

  cmd
    .command('private')
    .description("Set auto_share = 'auto-private' (share as private).")
    .action(async () => {
      await runSetMode('auto-private');
    });

  cmd
    .command('off')
    .description("Set auto_share = 'manual' (disable auto-share).")
    .action(async () => {
      await runSetMode('manual');
    });
}

async function runList(): Promise<void> {
  const cfg = await readUserConfig();
  info(`auto_share: ${cfg.auto_share}`);
  if (cfg.auto_share_projects.length === 0) {
    info('auto_share_projects: (none)');
    return;
  }
  info('auto_share_projects:');
  for (const p of cfg.auto_share_projects) {
    process.stdout.write(`  ${p}\n`);
  }
}

async function runAdd(explicit?: string): Promise<void> {
  const target = await resolveTargetPath(explicit);
  if (target === null) {
    errorOut('Could not determine a project path. Pass an explicit <path>.');
    process.exitCode = 1;
    return;
  }
  const cfg = await readUserConfig();
  const stored = normalize(target);
  const targetNorm = normalizeForCompare(stored);
  if (cfg.auto_share_projects.some((p) => normalizeForCompare(p) === targetNorm)) {
    info(`${stored} is already on the auto-share whitelist.`);
    return;
  }
  // Persist all entries in canonical separator form so the file stays
  // consistent regardless of whether earlier adds came from bash-style
  // (forward-slash) or native (backslash) cwds.
  cfg.auto_share_projects = [...cfg.auto_share_projects.map(normalize), stored];
  await writeUserConfig(cfg);
  info(`Added ${stored} to auto-share whitelist.`);
}

async function runRemove(explicit?: string): Promise<void> {
  const target = await resolveTargetPath(explicit);
  if (target === null) {
    errorOut('Could not determine a project path. Pass an explicit <path>.');
    process.exitCode = 1;
    return;
  }
  const cfg = await readUserConfig();
  const targetNorm = normalizeForCompare(target);
  const before = cfg.auto_share_projects.length;
  cfg.auto_share_projects = cfg.auto_share_projects
    .map(normalize)
    .filter((p) => normalizeForCompare(p) !== targetNorm);
  if (cfg.auto_share_projects.length === before) {
    info(`${target} was not on the auto-share whitelist.`);
    return;
  }
  await writeUserConfig(cfg);
  info(`Removed ${target} from auto-share whitelist.`);
}

async function runStatus(): Promise<void> {
  const cfg = await readUserConfig().catch(() => null);
  const mode: AutoShareMode = cfg?.auto_share ?? 'manual';
  const whitelist = cfg?.auto_share_projects ?? [];

  const settings = await readClaudeSettings();
  const installed = detectInstalled(settings);
  const skill = await detectSkillInstalled();
  const lastSweep = await readLastSweepLine();

  process.stdout.write('hooks:\n');
  process.stdout.write(`  SessionStart: ${installed.SessionStart ? 'installed' : 'not installed'}\n`);
  process.stdout.write(`  SessionEnd:   ${installed.SessionEnd ? 'installed' : 'not installed'}\n`);
  process.stdout.write(`skill:\n`);
  process.stdout.write(`  drev:         ${skill.installed ? 'installed' : 'not installed'}\n`);
  process.stdout.write(`auto_share:    ${mode}\n`);
  if (whitelist.length === 0) {
    process.stdout.write('whitelist:     (none)\n');
  } else {
    process.stdout.write('whitelist:\n');
    for (const p of whitelist) {
      process.stdout.write(`  ${p}\n`);
    }
  }
  process.stdout.write(`last sweep:    ${lastSweep ?? 'never run'}\n`);
}

async function runSetMode(mode: AutoShareMode): Promise<void> {
  const cfg = await readUserConfig();
  cfg.auto_share = mode;
  await writeUserConfig(cfg);
  info(`auto_share set to '${mode}'.`);
}

async function resolveTargetPath(explicit: string | undefined): Promise<string | null> {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return explicit.trim();
  }
  const cwd = process.cwd();
  const top = await gitOps.showTopLevel(cwd).catch(() => null);
  if (top !== null && top !== '') return top;
  if (cwd !== '') return cwd;
  return null;
}

function normalizeForCompare(p: string): string {
  const n = normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

// Reads ~/.claude/settings.json and returns its parsed contents, or {}.
async function readClaudeSettings(): Promise<Record<string, unknown>> {
  const path = join(homedir(), '.claude', 'settings.json');
  try {
    const raw = await readFile(path, 'utf8');
    if (raw.trim() === '') return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

async function readLastSweepLine(): Promise<string | null> {
  const logsDir = join(drevHome(), 'logs');
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((f) => f.startsWith('autoshare-sweep-') && f.endsWith('.log'))
    .sort();
  if (candidates.length === 0) return null;
  const latest = join(logsDir, candidates[candidates.length - 1]!);
  try {
    const raw = await readFile(latest, 'utf8');
    const trimmed = raw.replace(/\s+$/, '');
    if (trimmed.length === 0) return null;
    const idx = trimmed.lastIndexOf('\n');
    return idx === -1 ? trimmed : trimmed.slice(idx + 1);
  } catch {
    return null;
  }
}
