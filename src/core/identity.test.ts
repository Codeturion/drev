import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../lib/errors.js';
import { currentUserEmail, shortUsername } from './identity.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (!d) continue;
    await rm(d, { recursive: true, force: true });
  }
});

async function withGlobalGitConfig<T>(content: string, fn: () => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'drev-githome-'));
  tmpDirs.push(home);
  const cfg = join(home, '.gitconfig');
  await writeFile(cfg, content);
  const prev = process.env['GIT_CONFIG_GLOBAL'];
  process.env['GIT_CONFIG_GLOBAL'] = cfg;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
    else process.env['GIT_CONFIG_GLOBAL'] = prev;
  }
}

describe('currentUserEmail', () => {
  it('returns the trimmed email from git config', async () => {
    await withGlobalGitConfig('[user]\n\temail =   alice@example.com   \n', async () => {
      const email = await currentUserEmail();
      expect(email).toBe('alice@example.com');
    });
  });

  it('throws ConfigError when user.email is unset', async () => {
    await withGlobalGitConfig('', async () => {
      await expect(currentUserEmail()).rejects.toBeInstanceOf(ConfigError);
    });
  });

  it('throws ConfigError when user.email is whitespace only', async () => {
    await withGlobalGitConfig('[user]\n\temail = "   "\n', async () => {
      await expect(currentUserEmail()).rejects.toBeInstanceOf(ConfigError);
    });
  });
});

describe('shortUsername', () => {
  it('returns the lowercased local part of an email', () => {
    expect(shortUsername('Alice@Example.com')).toBe('alice');
  });

  it('replaces dots in local part with dashes', () => {
    expect(shortUsername('first.last@example.com')).toBe('first-last');
  });

  it('strips plus-addressing into a dash', () => {
    expect(shortUsername('alice+work@example.com')).toBe('alice-work');
  });

  it('collapses runs of dashes', () => {
    expect(shortUsername('a..b__c@example.com')).toBe('a-b-c');
  });

  it('trims leading/trailing dashes', () => {
    expect(shortUsername('.alice.@example.com')).toBe('alice');
  });

  it('preserves digits and existing dashes', () => {
    expect(shortUsername('user-123@example.com')).toBe('user-123');
  });

  it('handles a string without an at-sign by treating the whole input as local', () => {
    expect(shortUsername('Bob.Smith')).toBe('bob-smith');
  });

  it('lowercases uppercase letters', () => {
    expect(shortUsername('FUAT@example.com')).toBe('fuat');
  });

  it('replaces unicode and special chars with dashes', () => {
    expect(shortUsername('café+x@example.com')).toBe('caf-x');
  });
});
