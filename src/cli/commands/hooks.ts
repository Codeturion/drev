import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { readUserConfig } from '../../core/config.js';
import type { AutoShareMode } from '../../core/config.js';
import { drevHome } from '../../core/claude-paths.js';
import { ConfigError } from '../../lib/errors.js';
import { info } from '../ui.js';

const HOOK_COMMAND = 'drev autoshare-sweep';
const HOOK_EVENTS = ['SessionStart', 'SessionEnd'] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

interface HookEntry {
  type: string;
  command: string;
  _drev?: boolean;
  [extra: string]: unknown;
}

interface HookGroup {
  hooks: HookEntry[];
  [extra: string]: unknown;
}

interface ClaudeSettings {
  hooks?: Partial<Record<HookEvent | string, HookGroup[]>>;
  [extra: string]: unknown;
}

export function register(program: Command): void {
  const cmd = program
    .command('hooks')
    .description('Manage Claude Code hooks for Drev auto-share.');

  cmd
    .command('install')
    .description("Install Drev's SessionStart/SessionEnd hooks into ~/.claude/settings.json.")
    .action(async () => {
      await runInstall();
    });

  cmd
    .command('uninstall')
    .description("Remove Drev's hooks from ~/.claude/settings.json.")
    .action(async () => {
      await runUninstall();
    });

  cmd
    .command('status')
    .description('Show whether Drev hooks are installed and the current auto-share mode.')
    .action(async () => {
      await runStatus();
    });
}

function settingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readSettings(): Promise<{ settings: ClaudeSettings; existed: boolean }> {
  const path = settingsPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { settings: {}, existed: false };
    }
    throw new ConfigError(`Failed to read ${path}.`, { cause: err });
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { settings: {}, existed: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(`Failed to parse JSON in ${path}.`, { cause });
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`Settings at ${path} is not a JSON object.`);
  }
  return { settings: parsed as ClaudeSettings, existed: true };
}

async function writeSettingsAtomic(settings: ClaudeSettings): Promise<void> {
  const path = settingsPath();
  const dir = join(path, '..');
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const serialized = `${JSON.stringify(settings, null, 2)}\n`;
  try {
    await writeFile(tmp, serialized, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure.
    try {
      await rm(tmp, { force: true });
    } catch {
      // ignore
    }
    throw new ConfigError(`Failed to write ${path}.`, { cause: err });
  }
}

function groupHasDrevEntry(group: HookGroup): boolean {
  if (!Array.isArray(group.hooks)) return false;
  return group.hooks.some((h) => h !== null && typeof h === 'object' && (h as HookEntry)._drev === true);
}

function makeDrevGroup(): HookGroup {
  return {
    hooks: [{ type: 'command', command: HOOK_COMMAND, _drev: true }],
  };
}

function ensureGroupsArray(value: unknown): HookGroup[] {
  if (!Array.isArray(value)) return [];
  // Filter to plain-object groups; preserve as-is.
  return value.filter((g): g is HookGroup => isPlainObject(g)) as HookGroup[];
}

export async function runInstall(): Promise<void> {
  const { settings } = await readSettings();
  if (settings.hooks === undefined || !isPlainObject(settings.hooks)) {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, HookGroup[]>;

  for (const event of HOOK_EVENTS) {
    const existing = ensureGroupsArray(hooks[event]);
    const alreadyInstalled = existing.some(groupHasDrevEntry);
    if (alreadyInstalled) {
      hooks[event] = existing;
      continue;
    }
    hooks[event] = [...existing, makeDrevGroup()];
  }

  await writeSettingsAtomic(settings);
  info(`Drev hooks installed in ${settingsPath()}.`);
}

export async function runUninstall(): Promise<void> {
  const { settings, existed } = await readSettings();
  if (!existed || !isPlainObject(settings.hooks)) {
    info('No Drev hooks to uninstall.');
    return;
  }
  const hooks = settings.hooks as Record<string, HookGroup[]>;

  for (const event of HOOK_EVENTS) {
    const existing = ensureGroupsArray(hooks[event]);
    if (existing.length === 0) {
      delete hooks[event];
      continue;
    }
    const filtered: HookGroup[] = [];
    for (const group of existing) {
      if (groupHasDrevEntry(group)) {
        // Drop the whole group: per spec, if hooks array contains any _drev entry,
        // filter the group out. (It only ever contains the drev entry in practice.)
        continue;
      }
      if (Array.isArray(group.hooks) && group.hooks.length === 0) {
        // Group with empty hooks — drop.
        continue;
      }
      filtered.push(group);
    }
    if (filtered.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = filtered;
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }

  await writeSettingsAtomic(settings);
  info('Drev hooks uninstalled.');
}

interface InstallStatus {
  SessionStart: boolean;
  SessionEnd: boolean;
}

export function detectInstalled(settings: ClaudeSettings): InstallStatus {
  const result: InstallStatus = { SessionStart: false, SessionEnd: false };
  if (!isPlainObject(settings.hooks)) return result;
  const hooks = settings.hooks as Record<string, unknown>;
  for (const event of HOOK_EVENTS) {
    const groups = ensureGroupsArray(hooks[event]);
    result[event] = groups.some(groupHasDrevEntry);
  }
  return result;
}

function todayStamp(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function lastSweepLine(): Promise<string | null> {
  const logsDir = join(drevHome(), 'logs');
  const todayFile = join(logsDir, `autoshare-sweep-${todayStamp()}.log`);
  let target: string | null = null;
  try {
    const raw = await readFile(todayFile, 'utf8');
    const trimmed = raw.replace(/\s+$/, '');
    if (trimmed.length > 0) {
      const idx = trimmed.lastIndexOf('\n');
      return idx === -1 ? trimmed : trimmed.slice(idx + 1);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Fall through to glob fallback on other errors as well.
    }
  }
  // Fallback: most recent autoshare-sweep-*.log in the logs dir.
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
  target = join(logsDir, candidates[candidates.length - 1]!);
  try {
    const raw = await readFile(target, 'utf8');
    const trimmed = raw.replace(/\s+$/, '');
    if (trimmed.length === 0) return null;
    const idx = trimmed.lastIndexOf('\n');
    return idx === -1 ? trimmed : trimmed.slice(idx + 1);
  } catch {
    return null;
  }
}

export async function runStatus(): Promise<void> {
  const { settings, existed } = await readSettings();
  const installed = existed ? detectInstalled(settings) : { SessionStart: false, SessionEnd: false };

  let mode: AutoShareMode;
  try {
    const cfg = await readUserConfig();
    mode = cfg.auto_share;
  } catch {
    mode = 'manual';
  }

  const lastLine = await lastSweepLine();

  process.stdout.write(`hooks (${settingsPath()}):\n`);
  process.stdout.write(`  SessionStart: ${installed.SessionStart ? 'installed' : 'not installed'}\n`);
  process.stdout.write(`  SessionEnd:   ${installed.SessionEnd ? 'installed' : 'not installed'}\n`);
  process.stdout.write(`auto_share:    ${mode}\n`);
  process.stdout.write(`last sweep:    ${lastLine ?? 'never run'}\n`);
}
