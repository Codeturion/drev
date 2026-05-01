import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

vi.mock('../ui.js', async () => {
  const actual = await vi.importActual<typeof import('../ui.js')>('../ui.js');
  return {
    ...actual,
    spinner: () => ({ stop: () => {}, succeed: () => {}, fail: () => {} }),
    info: () => {},
    warn: () => {},
    errorOut: () => {},
  };
});

import {
  detectSkillInstalled,
  DREV_SKILL_CONTENT,
  installSkill,
  runInstall,
  runStatus,
  runUninstall,
  uninstallSkill,
} from './hooks.js';
import { stat } from 'node:fs/promises';

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const ORIGINAL_HOME = process.env['HOME'];
const ORIGINAL_USERPROFILE = process.env['USERPROFILE'];

async function withFakeHome(): Promise<string> {
  const home = await makeTmp('drev-hooks-home-');
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  return home;
}

function settingsPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

async function readSettings(home: string): Promise<Record<string, unknown>> {
  const raw = await readFile(settingsPath(home), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

async function writeSettings(home: string, value: unknown): Promise<void> {
  const path = settingsPath(home);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (!d) continue;
    await rm(d, { recursive: true, force: true });
  }
  if (ORIGINAL_HOME === undefined) delete process.env['HOME'];
  else process.env['HOME'] = ORIGINAL_HOME;
  if (ORIGINAL_USERPROFILE === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = ORIGINAL_USERPROFILE;
});

interface HookEntry {
  type: string;
  command: string;
  _drev?: boolean;
}
interface HookGroup {
  hooks: HookEntry[];
  matcher?: string;
}

function expectDrevGroup(groups: unknown): void {
  expect(Array.isArray(groups)).toBe(true);
  const arr = groups as HookGroup[];
  const drev = arr.filter((g) => g.hooks.some((h) => h._drev === true));
  expect(drev).toHaveLength(1);
  const entry = drev[0]!.hooks.find((h) => h._drev === true)!;
  expect(entry.type).toBe('command');
  expect(entry.command).toBe('drev autoshare-sweep');
}

describe('hooks install', () => {
  it('installs both events on missing settings.json', async () => {
    const home = await withFakeHome();
    await runInstall();

    const s = await readSettings(home);
    const hooks = s['hooks'] as Record<string, unknown>;
    expectDrevGroup(hooks['SessionStart']);
    expectDrevGroup(hooks['SessionEnd']);
  });

  it('installs both events on empty {} settings', async () => {
    const home = await withFakeHome();
    await writeSettings(home, {});
    await runInstall();

    const s = await readSettings(home);
    const hooks = s['hooks'] as Record<string, unknown>;
    expectDrevGroup(hooks['SessionStart']);
    expectDrevGroup(hooks['SessionEnd']);
  });

  it('preserves unrelated hook entries and top-level keys', async () => {
    const home = await withFakeHome();
    const original = {
      model: 'opus',
      hooks: {
        SessionStart: [
          { matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] },
        ],
        PostToolUse: [
          { hooks: [{ type: 'command', command: 'log-tools' }] },
        ],
      },
      env: { FOO: 'BAR' },
    };
    await writeSettings(home, original);
    await runInstall();

    const s = await readSettings(home);
    expect(s['model']).toBe('opus');
    expect(s['env']).toEqual({ FOO: 'BAR' });

    const hooks = s['hooks'] as Record<string, unknown>;
    const ss = hooks['SessionStart'] as HookGroup[];
    // Unrelated entry preserved.
    expect(ss.some((g) => g.hooks.some((h) => h.command === 'echo hi'))).toBe(true);
    expectDrevGroup(ss);

    // SessionEnd added even though originally absent.
    expectDrevGroup(hooks['SessionEnd']);

    // Other event preserved untouched.
    const post = hooks['PostToolUse'] as HookGroup[];
    expect(post).toHaveLength(1);
    expect(post[0]!.hooks[0]!.command).toBe('log-tools');
  });

  it('is idempotent — second install does not duplicate', async () => {
    const home = await withFakeHome();
    await runInstall();
    await runInstall();

    const s = await readSettings(home);
    const hooks = s['hooks'] as Record<string, unknown>;
    const ss = hooks['SessionStart'] as HookGroup[];
    const se = hooks['SessionEnd'] as HookGroup[];
    expect(ss.filter((g) => g.hooks.some((h) => h._drev === true))).toHaveLength(1);
    expect(se.filter((g) => g.hooks.some((h) => h._drev === true))).toHaveLength(1);
  });
});

describe('hooks uninstall', () => {
  it('removes only drev entries; unrelated preserved', async () => {
    const home = await withFakeHome();
    const original = {
      model: 'opus',
      hooks: {
        SessionStart: [
          { matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] },
        ],
      },
    };
    await writeSettings(home, original);
    await runInstall();
    await runUninstall();

    const s = await readSettings(home);
    expect(s['model']).toBe('opus');
    const hooks = s['hooks'] as Record<string, unknown>;
    // SessionStart had an unrelated entry — it stays, drev removed.
    const ss = hooks['SessionStart'] as HookGroup[];
    expect(ss).toHaveLength(1);
    expect(ss[0]!.hooks[0]!.command).toBe('echo hi');
    // SessionEnd had nothing originally — key removed entirely after drev removal.
    expect(hooks['SessionEnd']).toBeUndefined();
  });

  it('removes the hooks key entirely when only drev entries existed', async () => {
    const home = await withFakeHome();
    await runInstall();
    await runUninstall();

    const s = await readSettings(home);
    expect(s['hooks']).toBeUndefined();
  });

  it('is a no-op on missing settings.json', async () => {
    await withFakeHome();
    await expect(runUninstall()).resolves.toBeUndefined();
  });

  it('is a no-op when not installed', async () => {
    const home = await withFakeHome();
    const original = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'echo hi' }] },
        ],
      },
    };
    await writeSettings(home, original);
    await runUninstall();

    const s = await readSettings(home);
    const hooks = s['hooks'] as Record<string, unknown>;
    const ss = hooks['SessionStart'] as HookGroup[];
    expect(ss).toHaveLength(1);
    expect(ss[0]!.hooks[0]!.command).toBe('echo hi');
  });
});

describe('hooks status', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let captured: string;

  beforeEach(() => {
    captured = '';
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      captured += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  async function writeUserCfg(home: string, mode: string): Promise<void> {
    const dir = join(home, '.drev');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'config.yaml'),
      yaml.dump({
        schema_version: 1,
        default_repo: null,
        auto_share: mode,
        auto_share_idle_threshold_seconds: 60,
        auto_summarize: false,
        ignore_patterns: [],
        ignore_paths: [],
      }),
      'utf8',
    );
  }

  it('reports not-installed when no settings.json exists', async () => {
    const home = await withFakeHome();
    await writeUserCfg(home, 'manual');
    await runStatus();

    expect(captured).toContain('SessionStart: not installed');
    expect(captured).toContain('SessionEnd:   not installed');
    expect(captured).toContain('auto_share:    manual');
    expect(captured).toContain('last sweep:    never run');
  });

  it('reports installed when both events have drev entries', async () => {
    const home = await withFakeHome();
    await writeUserCfg(home, 'auto-private');
    await runInstall();
    await runStatus();

    expect(captured).toContain('SessionStart: installed');
    expect(captured).toContain('SessionEnd:   installed');
    expect(captured).toContain('auto_share:    auto-private');
  });

  it('reports mixed state correctly', async () => {
    const home = await withFakeHome();
    await writeUserCfg(home, 'auto-team');
    await writeSettings(home, {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'drev autoshare-sweep', _drev: true }] },
        ],
      },
    });

    await runStatus();

    expect(captured).toContain('SessionStart: installed');
    expect(captured).toContain('SessionEnd:   not installed');
    expect(captured).toContain('auto_share:    auto-team');
  });

  it('reads last sweep from today\'s log file', async () => {
    const home = await withFakeHome();
    await writeUserCfg(home, 'manual');

    const logsDir = join(home, '.drev', 'logs');
    await mkdir(logsDir, { recursive: true });
    const today = new Date();
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await writeFile(
      join(logsDir, `autoshare-sweep-${stamp}.log`),
      'old line\n2026-05-01T10:00:00Z swept 3 sessions\n',
      'utf8',
    );

    await runStatus();

    expect(captured).toContain('last sweep:    2026-05-01T10:00:00Z swept 3 sessions');
  });

  it('falls back to most recent log file when today\'s is missing', async () => {
    const home = await withFakeHome();
    await writeUserCfg(home, 'manual');

    const logsDir = join(home, '.drev', 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, 'autoshare-sweep-2025-01-01.log'),
      'older entry\n',
      'utf8',
    );
    await writeFile(
      join(logsDir, 'autoshare-sweep-2025-06-15.log'),
      'mid entry\nnewer entry\n',
      'utf8',
    );

    await runStatus();

    expect(captured).toContain('last sweep:    newer entry');
  });
});

describe('skill install/uninstall', () => {
  it('installSkill writes SKILL.md with the documented content', async () => {
    const home = await withFakeHome();
    const skillsRoot = join(home, '.claude', 'skills');
    await installSkill({ skillsRoot });

    const file = join(skillsRoot, 'drev', 'SKILL.md');
    const content = await readFile(file, 'utf8');
    expect(content).toBe(DREV_SKILL_CONTENT);
    expect(content).toMatch(/^---\nname: drev/);
    expect(content).toContain('Drev — Claude Code session sharing');
  });

  it('SKILL.md content includes the Auto-share follow-up section', () => {
    expect(DREV_SKILL_CONTENT).toContain('## Auto-share follow-up');
    expect(DREV_SKILL_CONTENT).toContain('drev autoshare add');
    expect(DREV_SKILL_CONTENT).toContain(
      'Want me to also auto-share future sessions from this project?',
    );
  });

  it('installSkill is idempotent (overwrites existing file at our path)', async () => {
    const home = await withFakeHome();
    const skillsRoot = join(home, '.claude', 'skills');
    const drevDir = join(skillsRoot, 'drev');
    await mkdir(drevDir, { recursive: true });
    await writeFile(join(drevDir, 'SKILL.md'), 'stale content', 'utf8');

    await installSkill({ skillsRoot });

    const content = await readFile(join(drevDir, 'SKILL.md'), 'utf8');
    expect(content).toBe(DREV_SKILL_CONTENT);
  });

  it('uninstallSkill removes the file and the empty drev/ dir', async () => {
    const home = await withFakeHome();
    const skillsRoot = join(home, '.claude', 'skills');
    await installSkill({ skillsRoot });
    await uninstallSkill({ skillsRoot });

    await expect(stat(join(skillsRoot, 'drev', 'SKILL.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(join(skillsRoot, 'drev'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('uninstallSkill is a no-op when absent', async () => {
    const home = await withFakeHome();
    const skillsRoot = join(home, '.claude', 'skills');
    await expect(uninstallSkill({ skillsRoot })).resolves.toBeUndefined();
  });

  it('uninstallSkill leaves drev/ dir if it has other files', async () => {
    const home = await withFakeHome();
    const skillsRoot = join(home, '.claude', 'skills');
    const drevDir = join(skillsRoot, 'drev');
    await mkdir(drevDir, { recursive: true });
    await writeFile(join(drevDir, 'SKILL.md'), DREV_SKILL_CONTENT, 'utf8');
    await writeFile(join(drevDir, 'extra.md'), 'unrelated', 'utf8');

    await uninstallSkill({ skillsRoot });

    await expect(stat(join(drevDir, 'SKILL.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // drev/ still present because extra.md remains
    const s = await stat(drevDir);
    expect(s.isDirectory()).toBe(true);
  });

  it('detectSkillInstalled reports installed/not-installed correctly', async () => {
    const home = await withFakeHome();
    const skillsRoot = join(home, '.claude', 'skills');

    const before = await detectSkillInstalled({ skillsRoot });
    expect(before.installed).toBe(false);
    expect(before.path).toBe(join(skillsRoot, 'drev', 'SKILL.md'));

    await installSkill({ skillsRoot });
    const after = await detectSkillInstalled({ skillsRoot });
    expect(after.installed).toBe(true);
    expect(after.path).toBe(join(skillsRoot, 'drev', 'SKILL.md'));
  });
});

describe('runInstall installs both hooks AND skill', () => {
  it('writes hook entries to settings.json and skill file under ~/.claude/skills/drev/', async () => {
    const home = await withFakeHome();
    await runInstall();

    // Hooks present
    const s = await readSettings(home);
    const hooks = s['hooks'] as Record<string, unknown>;
    expectDrevGroup(hooks['SessionStart']);
    expectDrevGroup(hooks['SessionEnd']);

    // Skill present
    const skillFile = join(home, '.claude', 'skills', 'drev', 'SKILL.md');
    const content = await readFile(skillFile, 'utf8');
    expect(content).toBe(DREV_SKILL_CONTENT);
  });
});

describe('runUninstall removes both hooks AND skill', () => {
  it('removes hook entries and the skill file', async () => {
    const home = await withFakeHome();
    await runInstall();
    await runUninstall();

    const s = await readSettings(home);
    expect(s['hooks']).toBeUndefined();
    await expect(
      stat(join(home, '.claude', 'skills', 'drev', 'SKILL.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('runStatus reports skill state', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let captured: string;

  beforeEach(() => {
    captured = '';
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      captured += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('reports skill: not installed when absent', async () => {
    await withFakeHome();
    await runStatus();
    expect(captured).toContain('drev:         not installed');
  });

  it('reports skill: installed when present', async () => {
    const home = await withFakeHome();
    await installSkill({ skillsRoot: join(home, '.claude', 'skills') });
    await runStatus();
    expect(captured).toContain('drev:         installed');
  });
});
