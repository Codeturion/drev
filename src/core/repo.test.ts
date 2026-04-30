import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { RepoError } from '../lib/errors.js';
import {
  dateAndNamePrefix,
  ensureScaffold,
  listMetaFiles,
  sanitizeName,
  sessionDir,
} from './repo.js';

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (!d) continue;
    await rm(d, { recursive: true, force: true });
  }
});

describe('ensureScaffold', () => {
  it('creates schema-version, config, users/.gitkeep, and README on a fresh repo', async () => {
    const dir = await makeTmp('drev-repo-');
    const result = await ensureScaffold(dir, 'forever-town-team');
    expect(result).toEqual({ created: true });

    const schema = await readFile(join(dir, '.drev', 'schema-version'), 'utf8');
    expect(schema).toBe('1\n');

    const cfgRaw = await readFile(join(dir, '.drev', 'config.yaml'), 'utf8');
    const cfg = yaml.load(cfgRaw) as Record<string, unknown>;
    expect(cfg['schema_version']).toBe(1);
    expect(cfg['team_name']).toBe('forever-town-team');
    expect(cfg['default_visibility']).toBe('team');
    expect(cfg['retention_days']).toBe(365);

    const keep = await readFile(join(dir, 'users', '.gitkeep'), 'utf8');
    expect(keep).toBe('');

    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('Drev');
  });

  it('is idempotent and reports created=false on second run', async () => {
    const dir = await makeTmp('drev-repo-');
    const first = await ensureScaffold(dir, 'team-a');
    expect(first.created).toBe(true);

    const second = await ensureScaffold(dir, 'team-a');
    expect(second.created).toBe(false);

    const schema = await readFile(join(dir, '.drev', 'schema-version'), 'utf8');
    expect(schema).toBe('1\n');

    const cfgRaw = await readFile(join(dir, '.drev', 'config.yaml'), 'utf8');
    const cfg = yaml.load(cfgRaw) as Record<string, unknown>;
    expect(cfg['team_name']).toBe('team-a');
  });

  it('preserves a pre-existing README without overwriting it', async () => {
    const dir = await makeTmp('drev-repo-');
    const customReadme = '# My Custom README\n';
    await writeFile(join(dir, 'README.md'), customReadme, 'utf8');

    const result = await ensureScaffold(dir, 'team-b');
    expect(result.created).toBe(true);

    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    expect(readme).toBe(customReadme);
  });

  it('creates README on second run when missing but .drev/ already exists', async () => {
    const dir = await makeTmp('drev-repo-');
    await ensureScaffold(dir, 'team-c');
    await rm(join(dir, 'README.md'));

    const result = await ensureScaffold(dir, 'team-c');
    expect(result.created).toBe(false);

    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('Drev');
  });

  it('restores users/.gitkeep when missing on a pre-existing repo', async () => {
    const dir = await makeTmp('drev-repo-');
    await ensureScaffold(dir, 'team-d');
    await rm(join(dir, 'users', '.gitkeep'));

    const result = await ensureScaffold(dir, 'team-d');
    expect(result.created).toBe(false);

    const s = await stat(join(dir, 'users', '.gitkeep'));
    expect(s.isFile()).toBe(true);
  });

  it('throws SCHEMA_VERSION_MISMATCH when schema-version disagrees', async () => {
    const dir = await makeTmp('drev-repo-');
    await mkdir(join(dir, '.drev'), { recursive: true });
    await writeFile(join(dir, '.drev', 'schema-version'), '2\n', 'utf8');

    await expect(ensureScaffold(dir, 'team-e')).rejects.toBeInstanceOf(RepoError);
    await expect(ensureScaffold(dir, 'team-e')).rejects.toThrow(
      /SCHEMA_VERSION_MISMATCH/,
    );
  });

  it('throws when .drev/ exists but schema-version file is missing', async () => {
    const dir = await makeTmp('drev-repo-');
    await mkdir(join(dir, '.drev'), { recursive: true });

    await expect(ensureScaffold(dir, 'team-f')).rejects.toBeInstanceOf(RepoError);
    await expect(ensureScaffold(dir, 'team-f')).rejects.toThrow(
      /SCHEMA_VERSION_MISMATCH/,
    );
  });

  it('writes config.yaml when .drev/ exists with valid schema-version but no config', async () => {
    const dir = await makeTmp('drev-repo-');
    await mkdir(join(dir, '.drev'), { recursive: true });
    await writeFile(join(dir, '.drev', 'schema-version'), '1\n', 'utf8');

    const result = await ensureScaffold(dir, 'team-g');
    expect(result.created).toBe(false);

    const cfgRaw = await readFile(join(dir, '.drev', 'config.yaml'), 'utf8');
    const cfg = yaml.load(cfgRaw) as Record<string, unknown>;
    expect(cfg['team_name']).toBe('team-g');
  });

  it('accepts schema-version with trailing whitespace', async () => {
    const dir = await makeTmp('drev-repo-');
    await mkdir(join(dir, '.drev'), { recursive: true });
    await writeFile(join(dir, '.drev', 'schema-version'), '1   \n\n', 'utf8');

    const result = await ensureScaffold(dir, 'team-h');
    expect(result.created).toBe(false);
  });
});

describe('listMetaFiles', () => {
  it('returns [] when users/ does not exist', async () => {
    const dir = await makeTmp('drev-repo-');
    expect(await listMetaFiles(dir)).toEqual([]);
  });

  it('returns [] when users/ is empty', async () => {
    const dir = await makeTmp('drev-repo-');
    await mkdir(join(dir, 'users'), { recursive: true });
    expect(await listMetaFiles(dir)).toEqual([]);
  });

  it('walks users/<u>/<dir>/meta.yaml and returns absolute sorted paths', async () => {
    const dir = await makeTmp('drev-repo-');
    const a = join(dir, 'users', 'alice', '2026-04-30-foo');
    const b = join(dir, 'users', 'alice', '2026-05-01-bar');
    const c = join(dir, 'users', 'bob', '2026-04-29-baz');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await mkdir(c, { recursive: true });
    await writeFile(join(a, 'meta.yaml'), 'a', 'utf8');
    await writeFile(join(b, 'meta.yaml'), 'b', 'utf8');
    await writeFile(join(c, 'meta.yaml'), 'c', 'utf8');

    const result = await listMetaFiles(dir);
    expect(result).toEqual([
      join(a, 'meta.yaml'),
      join(b, 'meta.yaml'),
      join(c, 'meta.yaml'),
    ].sort());
  });

  it('skips dirs without meta.yaml', async () => {
    const dir = await makeTmp('drev-repo-');
    const a = join(dir, 'users', 'alice', 'has-meta');
    const b = join(dir, 'users', 'alice', 'no-meta');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, 'meta.yaml'), 'a', 'utf8');
    await writeFile(join(b, 'other.yaml'), 'x', 'utf8');

    const result = await listMetaFiles(dir);
    expect(result).toEqual([join(a, 'meta.yaml')]);
  });

  it('skips dotfiles and non-directories at user and session levels', async () => {
    const dir = await makeTmp('drev-repo-');
    await mkdir(join(dir, 'users'), { recursive: true });
    await writeFile(join(dir, 'users', '.gitkeep'), '', 'utf8');
    await writeFile(join(dir, 'users', 'stray-file'), 'x', 'utf8');

    const u = join(dir, 'users', 'alice');
    await mkdir(u, { recursive: true });
    await writeFile(join(u, '.DS_Store'), '', 'utf8');
    await writeFile(join(u, 'rogue.txt'), '', 'utf8');

    const s = join(u, '2026-04-30-foo');
    await mkdir(s, { recursive: true });
    await writeFile(join(s, 'meta.yaml'), 'a', 'utf8');

    const result = await listMetaFiles(dir);
    expect(result).toEqual([join(s, 'meta.yaml')]);
  });
});

describe('sessionDir', () => {
  it('builds <repo>/users/<user>/<dateAndName>', () => {
    const result = sessionDir('/tmp/repo', 'alice', '2026-04-30-foo');
    expect(result).toBe(join('/tmp/repo', 'users', 'alice', '2026-04-30-foo'));
  });
});

describe('sanitizeName', () => {
  it('lowercases', () => {
    expect(sanitizeName('AuthRefactor')).toBe('authrefactor');
  });

  it('replaces whitespace runs with a single hyphen', () => {
    expect(sanitizeName('auth   refactor patch')).toBe('auth-refactor-patch');
  });

  it('strips emoji', () => {
    expect(sanitizeName('cool-feature-rocket')).toBe('cool-feature-rocket');
    expect(sanitizeName('cool feature ABC')).toBe('cool-feature-abc');
  });

  it('strips non-Latin-1 / non-allowed characters', () => {
    expect(sanitizeName('café-süß')).toBe('caf-s');
    expect(sanitizeName('hello@world!')).toBe('helloworld');
  });

  it('keeps underscores', () => {
    expect(sanitizeName('snake_case_name')).toBe('snake_case_name');
  });

  it('collapses runs of hyphens', () => {
    expect(sanitizeName('foo---bar----baz')).toBe('foo-bar-baz');
  });

  it('trims leading and trailing hyphens', () => {
    expect(sanitizeName('---hello---')).toBe('hello');
    expect(sanitizeName('  hello  ')).toBe('hello');
  });

  it('truncates to 64 chars', () => {
    const long = 'a'.repeat(100);
    const out = sanitizeName(long);
    expect(out.length).toBe(64);
    expect(out).toBe('a'.repeat(64));
  });

  it('trims trailing hyphen after truncation', () => {
    const input = `${'a'.repeat(63)}-extra`;
    const out = sanitizeName(input);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out.endsWith('-')).toBe(false);
  });

  it('throws RepoError when sanitization yields empty string', () => {
    expect(() => sanitizeName('!!!')).toThrow(RepoError);
    expect(() => sanitizeName('')).toThrow(RepoError);
    expect(() => sanitizeName('   ')).toThrow(RepoError);
    expect(() => sanitizeName('---')).toThrow(RepoError);
    expect(() => sanitizeName('🚀✨')).toThrow(RepoError);
  });
});

describe('dateAndNamePrefix', () => {
  it('produces YYYY-MM-DD-<name> when name is provided', () => {
    const d = new Date('2026-04-30T14:32:00Z');
    expect(dateAndNamePrefix(d, 'auth-refactor', 'deadbeef')).toBe(
      '2026-04-30-auth-refactor',
    );
  });

  it('produces YYYY-MM-DD-<shortId> when name is null', () => {
    const d = new Date('2026-04-30T14:32:00Z');
    expect(dateAndNamePrefix(d, null, '7f3a2b1c1234')).toBe('2026-04-30-7f3a2b1c');
  });

  it('uses UTC for the date even if local tz differs', () => {
    const d = new Date('2026-04-30T23:30:00Z');
    expect(dateAndNamePrefix(d, null, '7f3a2b1c')).toBe('2026-04-30-7f3a2b1c');

    const d2 = new Date('2026-04-30T00:00:00Z');
    expect(dateAndNamePrefix(d2, null, '7f3a2b1c')).toBe('2026-04-30-7f3a2b1c');
  });

  it('truncates shortId to first 8 chars', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(dateAndNamePrefix(d, null, 'abcdef0123456789')).toBe('2026-01-01-abcdef01');
  });

  it('sanitizes names through dateAndNamePrefix', () => {
    const d = new Date('2026-04-30T00:00:00Z');
    expect(dateAndNamePrefix(d, 'My Cool Feature!', 'unused')).toBe(
      '2026-04-30-my-cool-feature',
    );
  });

  it('zero-pads month and day', () => {
    const d = new Date('2026-01-05T00:00:00Z');
    expect(dateAndNamePrefix(d, null, 'aaaaaaaa')).toBe('2026-01-05-aaaaaaaa');
  });

  it('throws when shortId is empty and name is null', () => {
    const d = new Date('2026-04-30T00:00:00Z');
    expect(() => dateAndNamePrefix(d, null, '')).toThrow(RepoError);
  });

  it('throws when name sanitizes to empty', () => {
    const d = new Date('2026-04-30T00:00:00Z');
    expect(() => dateAndNamePrefix(d, '!!!', 'aaaaaaaa')).toThrow(RepoError);
  });
});
