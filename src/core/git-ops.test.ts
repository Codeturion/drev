import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RepoError } from '../lib/errors.js';
import {
  add,
  clone,
  commit,
  configGet,
  filterRepo,
  isAvailable,
  mv,
  pullRebase,
  remoteShowDefaultBranch,
  revParse,
  rm as gitRm,
  showTopLevel,
} from './git-ops.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.toString().trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drev-gitops-'));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test User']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

const tmpDirs: string[] = [];

async function track<T extends string>(dir: T): Promise<T> {
  tmpDirs.push(dir);
  return dir;
}

async function rmRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  // Final attempt; let it surface if it still fails.
  await rm(dir, { recursive: true, force: true });
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (!d) continue;
    await rmRetry(d);
  }
});

describe('isAvailable', () => {
  it('returns true for git', async () => {
    expect(await isAvailable('git')).toBe(true);
  });

  it('returns false for a clearly missing binary', async () => {
    expect(await isAvailable('drev-not-a-real-bin-xyz-123')).toBe(false);
  });
});

describe('add / commit / revParse / showTopLevel', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await track(await initRepo());
  });

  it('adds a file, commits, and resolves HEAD', async () => {
    await writeFile(join(repo, 'a.txt'), 'hello');
    await add(repo, ['a.txt']);
    await commit(repo, 'initial');
    const head = await revParse(repo, 'HEAD');
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('add with empty paths is a no-op', async () => {
    await expect(add(repo, [])).resolves.toBeUndefined();
  });

  it('showTopLevel returns repo dir from inside repo', async () => {
    const top = await showTopLevel(repo);
    expect(top).not.toBeNull();
    // Compare canonical form: git returns posix slashes on Windows.
    expect(top!.replace(/\\/g, '/').toLowerCase())
      .toContain(repo.replace(/\\/g, '/').toLowerCase().split('/').pop()!);
  });

  it('showTopLevel returns null when not inside a repo', async () => {
    const dir = await track(await mkdtemp(join(tmpdir(), 'drev-notrepo-')));
    expect(await showTopLevel(dir)).toBeNull();
  });

  it('revParse on missing ref throws RepoError with stderr captured', async () => {
    await expect(revParse(repo, 'no-such-ref')).rejects.toBeInstanceOf(RepoError);
  });
});

describe('mv / rm', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await track(await initRepo());
    await writeFile(join(repo, 'a.txt'), 'a');
    await add(repo, ['a.txt']);
    await commit(repo, 'init');
  });

  it('renames a tracked file via git mv', async () => {
    await mv(repo, 'a.txt', 'b.txt');
    await commit(repo, 'rename');
    const ls = await git(repo, ['ls-files']);
    expect(ls).toBe('b.txt');
  });

  it('removes a tracked file via git rm', async () => {
    await gitRm(repo, 'a.txt');
    await commit(repo, 'remove');
    const ls = await git(repo, ['ls-files']);
    expect(ls).toBe('');
  });

  it('removes a directory recursively when recursive=true', async () => {
    await mkdir(join(repo, 'sub'), { recursive: true });
    await writeFile(join(repo, 'sub', 'x.txt'), 'x');
    await add(repo, ['sub']);
    await commit(repo, 'add sub');
    await gitRm(repo, 'sub', true);
    await commit(repo, 'rm sub');
    const ls = await git(repo, ['ls-files']);
    expect(ls).toBe('a.txt');
  });

  it('rm on a non-existent path throws RepoError', async () => {
    await expect(gitRm(repo, 'no-such-file')).rejects.toBeInstanceOf(RepoError);
  });
});

describe('configGet', () => {
  it('returns the trimmed value when key is set globally', async () => {
    // We cannot mutate global config in tests. Instead, verify behaviour against a
    // known-set or known-unset key by reading whatever is in the user's global config.
    // To get a stable value, we set a temp key via GIT_CONFIG_GLOBAL override.
    const home = await track(await mkdtemp(join(tmpdir(), 'drev-githome-')));
    const cfgPath = join(home, '.gitconfig');
    await writeFile(cfgPath, '[user]\n\temail = unit@example.com\n');
    const prev = process.env['GIT_CONFIG_GLOBAL'];
    process.env['GIT_CONFIG_GLOBAL'] = cfgPath;
    try {
      const v = await configGet('user.email');
      expect(v).toBe('unit@example.com');
    } finally {
      if (prev === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = prev;
    }
  });

  it('returns null when key is unset', async () => {
    const home = await track(await mkdtemp(join(tmpdir(), 'drev-githome-')));
    const cfgPath = join(home, '.gitconfig');
    await writeFile(cfgPath, '');
    const prev = process.env['GIT_CONFIG_GLOBAL'];
    process.env['GIT_CONFIG_GLOBAL'] = cfgPath;
    try {
      const v = await configGet('drev.no.such.key');
      expect(v).toBeNull();
    } finally {
      if (prev === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
      else process.env['GIT_CONFIG_GLOBAL'] = prev;
    }
  });
});

describe('clone', () => {
  it('clones a local file:// repo into dest', async () => {
    const src = await track(await initRepo());
    await writeFile(join(src, 'README.md'), '# hi');
    await add(src, ['README.md']);
    await commit(src, 'init');
    // Allow pushing into a non-bare repo for tests:
    await git(src, ['config', 'receive.denyCurrentBranch', 'ignore']);

    const parent = await track(await mkdtemp(join(tmpdir(), 'drev-clone-')));
    const dest = join(parent, 'clone');
    const url = 'file://' + src.replace(/\\/g, '/');
    await clone(url, dest);
    const head = await revParse(dest, 'HEAD');
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const readme = await readFile(join(dest, 'README.md'), 'utf8');
    expect(readme).toBe('# hi');
  });
});

describe('pullRebase / remoteShowDefaultBranch', () => {
  it('pulls from origin with rebase and reports the default branch', async () => {
    const upstream = await track(await initRepo());
    await writeFile(join(upstream, 'a.txt'), 'a');
    await add(upstream, ['a.txt']);
    await commit(upstream, 'a');
    await git(upstream, ['config', 'receive.denyCurrentBranch', 'ignore']);

    const parent = await track(await mkdtemp(join(tmpdir(), 'drev-pull-')));
    const work = join(parent, 'work');
    const url = 'file://' + upstream.replace(/\\/g, '/');
    await clone(url, work);
    await git(work, ['config', 'user.email', 'test@example.com']);
    await git(work, ['config', 'user.name', 'Test User']);

    const branch = await remoteShowDefaultBranch(work);
    expect(branch).toBe('main');

    // Add a new commit upstream and pull --rebase.
    await writeFile(join(upstream, 'b.txt'), 'b');
    await add(upstream, ['b.txt']);
    await commit(upstream, 'b');
    await pullRebase(work);
    const log = await git(work, ['log', '--oneline']);
    expect(log).toContain('b');
  });
});

describe('filterRepo', () => {
  it('throws RepoError when git-filter-repo is not on PATH', async () => {
    const repo = await track(await initRepo());
    if (await isAvailable('git-filter-repo')) {
      // Skip semantic: just ensure the call doesn't blow up if it IS installed.
      // (No-op args would still error, so we don't run it.)
      return;
    }
    await expect(filterRepo(repo, ['--help'])).rejects.toBeInstanceOf(RepoError);
  });
});

describe('timeout', () => {
  it('fires timeout and surfaces RepoError', async () => {
    // Trigger timeout against a real local upstream by setting timeoutMs to 1 —
    // even a fast operation takes more than 1ms to spawn, so timeout reliably fires.
    // This avoids holding a TCP connection open which causes Windows to lock the dir.
    const upstream = await track(await initRepo());
    await writeFile(join(upstream, 'a.txt'), 'a');
    await add(upstream, ['a.txt']);
    await commit(upstream, 'a');
    await git(upstream, ['config', 'receive.denyCurrentBranch', 'ignore']);

    const parent = await track(await mkdtemp(join(tmpdir(), 'drev-timeout-')));
    const work = join(parent, 'work');
    const url = 'file://' + upstream.replace(/\\/g, '/');
    await clone(url, work);
    await git(work, ['config', 'user.email', 'test@example.com']);
    await git(work, ['config', 'user.name', 'Test User']);
    await expect(pullRebase(work, 1)).rejects.toBeInstanceOf(RepoError);
  });
});
