import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

vi.mock('../../core/git-ops.js', () => ({
  showTopLevel: vi.fn(async () => null),
}));

vi.mock('../ui.js', async () => {
  const actual = await vi.importActual<typeof import('../ui.js')>('../ui.js');
  return {
    ...actual,
    info: vi.fn(),
    errorOut: vi.fn(),
  };
});

import * as gitOps from '../../core/git-ops.js';
import * as ui from '../ui.js';
import { Command } from 'commander';
import { register } from './autoshare.js';

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const ORIGINAL_HOME = process.env['HOME'];
const ORIGINAL_USERPROFILE = process.env['USERPROFILE'];

async function withFakeHome(): Promise<string> {
  const home = await makeTmp('drev-autoshare-home-');
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  return home;
}

async function readCfg(home: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(home, '.drev', 'config.yaml'), 'utf8');
  return yaml.load(raw) as Record<string, unknown>;
}

async function writeCfg(home: string, cfg: Record<string, unknown>): Promise<void> {
  await mkdir(join(home, '.drev'), { recursive: true });
  await writeFile(join(home, '.drev', 'config.yaml'), yaml.dump(cfg), 'utf8');
}

function defaultCfgFor(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    default_repo: null,
    auto_share: 'auto-team',
    auto_share_idle_threshold_seconds: 60,
    auto_summarize: false,
    ignore_patterns: [],
    ignore_paths: [],
    auto_share_projects: [],
    ...extra,
  };
}

function buildProgram(): Command {
  const program = new Command();
  // Tests dispatch via parseAsync; they should not exit on unknown args.
  program.exitOverride();
  register(program);
  return program;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitOps.showTopLevel).mockResolvedValue(null);
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

describe('autoshare add', () => {
  it('adds an explicit path', async () => {
    const home = await withFakeHome();
    await writeCfg(home, defaultCfgFor());

    const program = buildProgram();
    await program.parseAsync(['node', 'drev', 'autoshare', 'add', '/explicit/proj']);

    const cfg = await readCfg(home);
    expect(cfg['auto_share_projects']).toEqual(['/explicit/proj']);
  });

  it('defaults to git toplevel when no path is given', async () => {
    const home = await withFakeHome();
    await writeCfg(home, defaultCfgFor());
    const project = await makeTmp('drev-toplevel-');
    vi.mocked(gitOps.showTopLevel).mockResolvedValue(project);

    const program = buildProgram();
    await program.parseAsync(['node', 'drev', 'autoshare', 'add']);

    const cfg = await readCfg(home);
    expect(cfg['auto_share_projects']).toEqual([project]);
  });

  it('falls back to cwd when not in a git repo', async () => {
    const home = await withFakeHome();
    await writeCfg(home, defaultCfgFor());
    vi.mocked(gitOps.showTopLevel).mockResolvedValue(null);

    const program = buildProgram();
    await program.parseAsync(['node', 'drev', 'autoshare', 'add']);

    const cfg = await readCfg(home);
    expect(cfg['auto_share_projects']).toEqual([process.cwd()]);
  });

  it('is idempotent — adding the same path twice does not duplicate', async () => {
    const home = await withFakeHome();
    await writeCfg(home, defaultCfgFor({ auto_share_projects: ['/foo'] }));

    const program = buildProgram();
    await program.parseAsync(['node', 'drev', 'autoshare', 'add', '/foo']);

    const cfg = await readCfg(home);
    expect(cfg['auto_share_projects']).toEqual(['/foo']);
  });
});

describe('autoshare remove', () => {
  it('removes an explicit path', async () => {
    const home = await withFakeHome();
    await writeCfg(home, defaultCfgFor({ auto_share_projects: ['/a', '/b'] }));

    const program = buildProgram();
    await program.parseAsync(['node', 'drev', 'autoshare', 'remove', '/a']);

    const cfg = await readCfg(home);
    expect(cfg['auto_share_projects']).toEqual(['/b']);
  });

  it('is a no-op when the path is not present', async () => {
    const home = await withFakeHome();
    await writeCfg(home, defaultCfgFor({ auto_share_projects: ['/a'] }));

    const program = buildProgram();
    await program.parseAsync(['node', 'drev', 'autoshare', 'remove', '/x']);

    const cfg = await readCfg(home);
    expect(cfg['auto_share_projects']).toEqual(['/a']);
  });
});

describe('autoshare list', () => {
  it('prints (none) when whitelist is empty', async () => {
    const home = await withFakeHome();
    await writeCfg(home, defaultCfgFor());

    const program = buildProgram();
    await program.parseAsync(['node', 'drev', 'autoshare', 'list']);

    const calls = vi.mocked(ui.info).mock.calls.map((c) => c[0]);
    expect(calls).toContain('auto_share_projects: (none)');
    expect(calls.some((m) => m.startsWith('auto_share: '))).toBe(true);
  });

  it('prints each whitelisted project on its own line', async () => {
    const home = await withFakeHome();
    await writeCfg(home, defaultCfgFor({ auto_share_projects: ['/p1', '/p2'] }));

    let captured = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      captured += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
      return true;
    });
    try {
      const program = buildProgram();
      await program.parseAsync(['node', 'drev', 'autoshare', 'list']);
    } finally {
      spy.mockRestore();
    }
    expect(captured).toContain('/p1');
    expect(captured).toContain('/p2');
  });
});

describe('autoshare on / private / off', () => {
  it("'on' sets auto_share to 'auto-team'", async () => {
    const home = await withFakeHome();
    await writeCfg(home, defaultCfgFor({ auto_share: 'manual' }));

    const program = buildProgram();
    await program.parseAsync(['node', 'drev', 'autoshare', 'on']);

    const cfg = await readCfg(home);
    expect(cfg['auto_share']).toBe('auto-team');
  });

  it("'private' sets auto_share to 'auto-private'", async () => {
    const home = await withFakeHome();
    await writeCfg(home, defaultCfgFor());

    const program = buildProgram();
    await program.parseAsync(['node', 'drev', 'autoshare', 'private']);

    const cfg = await readCfg(home);
    expect(cfg['auto_share']).toBe('auto-private');
  });

  it("'off' sets auto_share to 'manual'", async () => {
    const home = await withFakeHome();
    await writeCfg(home, defaultCfgFor());

    const program = buildProgram();
    await program.parseAsync(['node', 'drev', 'autoshare', 'off']);

    const cfg = await readCfg(home);
    expect(cfg['auto_share']).toBe('manual');
  });
});

describe('autoshare status', () => {
  it('prints mode, whitelist, and hook/skill states', async () => {
    const home = await withFakeHome();
    await writeCfg(
      home,
      defaultCfgFor({ auto_share: 'auto-private', auto_share_projects: ['/a', '/b'] }),
    );

    let captured = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      captured += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
      return true;
    });
    try {
      const program = buildProgram();
      await program.parseAsync(['node', 'drev', 'autoshare', 'status']);
    } finally {
      spy.mockRestore();
    }
    expect(captured).toContain('auto_share:    auto-private');
    expect(captured).toContain('/a');
    expect(captured).toContain('/b');
    expect(captured).toContain('SessionStart:');
    expect(captured).toContain('SessionEnd:');
    expect(captured).toContain('drev:');
    expect(captured).toContain('last sweep:');
  });

  it('whitelist line is "(none)" when empty', async () => {
    const home = await withFakeHome();
    await writeCfg(home, defaultCfgFor());

    let captured = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      captured += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
      return true;
    });
    try {
      const program = buildProgram();
      await program.parseAsync(['node', 'drev', 'autoshare', 'status']);
    } finally {
      spy.mockRestore();
    }
    expect(captured).toContain('whitelist:     (none)');
  });
});
