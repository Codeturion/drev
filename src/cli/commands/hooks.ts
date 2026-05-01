import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { readUserConfig } from '../../core/config.js';
import type { AutoShareMode } from '../../core/config.js';
import { drevHome } from '../../core/claude-paths.js';
import { ConfigError } from '../../lib/errors.js';
import { info, warn } from '../ui.js';

const HOOK_COMMAND = 'drev autoshare-sweep';
const HOOK_EVENTS = ['SessionStart', 'SessionEnd'] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

export const DREV_SKILL_CONTENT = `---
name: drev
description: Share, list, search, rename, mark, or back up Claude Code sessions through Drev. Use when the user wants to save, share, hand off, or manage the current session, or to find someone else's shared session. Resume is excluded; that command spawns a fresh \`claude --resume\` subprocess and must be run in a separate terminal, not from inside an active session.
---

# Drev: Claude Code session sharing

Drev shares Claude Code session JSONLs through a Git repo. Commands run via the Bash tool. Drev must be on PATH; if not, suggest \`npm install -g drev\`.

## Commands you can run from inside a session

**Share this session.** User says "save this", "share this", "hand it off", or names a target.
- Run \`drev share --name <slug>\` via Bash. Derive the slug from session topic: short, descriptive, lowercase, dashes (drev sanitizes anyway).
- Confirm the slug with the user if ambiguous.
- For private/personal: \`drev backup --name <slug>\`.

**List what's available.** User asks what sessions exist.
- \`drev list\` (or with filters: \`--mine\`, \`--team\`, \`--days 7\`, \`--user alice\`).

**Search.** User asks "find sessions about X" or similar.
- \`drev search "<query>"\`.

**Rename / mark / scrub / sync.** Use the matching subcommand on a session the user owns. Run \`drev <cmd> --help\` first if uncertain.

## Resume: tell the user to run it themselves

If the user asks to resume a session ("resume <name>", "pick up <name>", "load <name>"):

1. Optionally run \`drev list\` first to confirm the name and show the user what's available.
2. Tell the user this exact instruction (substitute the right name): "Open a new terminal in your destination project and run \`drev resume <name>\`. I can't run resume from inside this session because it has to launch a fresh Claude Code, which needs its own terminal."
3. If the user wants the file prepared in advance, you can run \`drev resume <name> --no-launch\` from inside the session. Drev will write the JSONL to the right path and print the manual \`claude --resume <id>\` command. Pass that command back to the user.

Do NOT run \`drev resume\` without \`--no-launch\` from inside an active session: it will fail or hang because the spawned \`claude\` cannot acquire a TTY.

## Common errors

- "No default repo configured": run \`drev init\` (a wizard walks the user through GitHub setup, or \`drev init --local\` for offline).
- "drev: command not found": suggest \`npm install -g drev\`.

## Scope

Don't auto-share without explicit user intent. Auto-share is handled separately by hooks; this skill is for explicit user-driven actions during a session.

## Auto-share follow-up

After running \`drev share\` for a project for the first time, the output may print "This project is not on the auto-share list." If the user reasonably wants future sessions from this project to auto-share, ask: "Want me to also auto-share future sessions from this project?" If yes, run \`drev autoshare add\` via Bash.
`;

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

async function installHooks(): Promise<void> {
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
}

async function uninstallHooks(): Promise<{ existed: boolean }> {
  const { settings, existed } = await readSettings();
  if (!existed || !isPlainObject(settings.hooks)) {
    return { existed: false };
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
        // Group with empty hooks: drop.
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
  return { existed: true };
}

function defaultSkillsRoot(): string {
  return join(homedir(), '.claude', 'skills');
}

function skillFilePath(skillsRoot?: string): { dir: string; file: string } {
  const root = skillsRoot ?? defaultSkillsRoot();
  const dir = join(root, 'drev');
  return { dir, file: join(dir, 'SKILL.md') };
}

export async function installSkill(opts?: { skillsRoot?: string }): Promise<void> {
  const { dir, file } = skillFilePath(opts?.skillsRoot);
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, DREV_SKILL_CONTENT, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    try {
      await rm(tmp, { force: true });
    } catch {
      // ignore
    }
    throw new ConfigError(`Failed to write Drev skill at ${file}.`, { cause: err });
  }
}

export async function uninstallSkill(opts?: { skillsRoot?: string }): Promise<void> {
  const { dir, file } = skillFilePath(opts?.skillsRoot);
  try {
    await rm(file, { force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new ConfigError(`Failed to remove Drev skill at ${file}.`, { cause: err });
    }
  }
  // Remove drev/ directory if empty.
  try {
    const entries = await readdir(dir);
    if (entries.length === 0) {
      await rmdir(dir);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Non-fatal: leave directory in place.
    }
  }
}

export interface SkillStatus {
  installed: boolean;
  path: string;
}

export async function detectSkillInstalled(opts?: {
  skillsRoot?: string;
}): Promise<SkillStatus> {
  const { file } = skillFilePath(opts?.skillsRoot);
  try {
    await readFile(file, 'utf8');
    return { installed: true, path: file };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { installed: false, path: file };
    return { installed: false, path: file };
  }
}

export async function runInstall(): Promise<void> {
  let hookErr: unknown = null;
  try {
    await installHooks();
    info(`Drev hooks installed in ${settingsPath()}.`);
  } catch (err) {
    hookErr = err;
    const msg = err instanceof Error ? err.message : String(err);
    warn(`Hook install failed: ${msg}`);
  }

  try {
    await installSkill();
    const { file } = skillFilePath();
    info(`Drev skill installed at ${file}.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`Skill install failed: ${msg}`);
  }

  if (hookErr !== null) {
    throw hookErr;
  }
}

export async function runUninstall(): Promise<void> {
  let any = false;
  try {
    const result = await uninstallHooks();
    if (result.existed) {
      info('Drev hooks uninstalled.');
      any = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`Hook uninstall failed: ${msg}`);
  }

  const before = await detectSkillInstalled();
  try {
    await uninstallSkill();
    if (before.installed) {
      info(`Drev skill removed from ${before.path}.`);
      any = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`Skill uninstall failed: ${msg}`);
  }

  if (!any) {
    info('No Drev hooks or skill to uninstall.');
  }
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

  const skill = await detectSkillInstalled();
  const lastLine = await lastSweepLine();

  process.stdout.write(`hooks (${settingsPath()}):\n`);
  process.stdout.write(`  SessionStart: ${installed.SessionStart ? 'installed' : 'not installed'}\n`);
  process.stdout.write(`  SessionEnd:   ${installed.SessionEnd ? 'installed' : 'not installed'}\n`);
  process.stdout.write(`skill (${skill.path}):\n`);
  process.stdout.write(`  drev:         ${skill.installed ? 'installed' : 'not installed'}\n`);
  process.stdout.write(`auto_share:    ${mode}\n`);
  process.stdout.write(`last sweep:    ${lastLine ?? 'never run'}\n`);
}
