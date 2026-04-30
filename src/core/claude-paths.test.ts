import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  claudeProjectsDir,
  drevHome,
  encodedCwd,
  sessionPath,
  subagentDir,
} from './claude-paths.js';

describe('encodedCwd', () => {
  it('encodes a POSIX path by replacing slashes with dashes', () => {
    expect(encodedCwd('/Users/fuat/work/forever-town')).toBe(
      '-Users-fuat-work-forever-town',
    );
  });

  it('encodes a Windows drive-letter path with backslashes and a space', () => {
    expect(encodedCwd('F:\\Nuts Projects\\drev')).toBe('F--Nuts-Projects-drev');
  });

  it('matches the real F:\\Unity Projects\\deep-cleaning-services example from this machine', () => {
    expect(encodedCwd('F:\\Unity Projects\\deep-cleaning-services')).toBe(
      'F--Unity-Projects-deep-cleaning-services',
    );
  });

  it('replaces special chars +, (, ), [, ] with dashes', () => {
    expect(encodedCwd('/foo/bar+baz')).toBe('-foo-bar-baz');
    expect(encodedCwd('/foo/(bar)')).toBe('-foo--bar-');
    expect(encodedCwd('/foo/[bar]')).toBe('-foo--bar-');
  });

  it('replaces every space with a dash', () => {
    expect(encodedCwd('C:\\Program Files\\My App')).toBe(
      'C--Program-Files-My-App',
    );
  });

  it('preserves digits alongside letters', () => {
    expect(encodedCwd('/var/log/app2024')).toBe('-var-log-app2024');
  });

  it('replaces dots and other punctuation', () => {
    expect(encodedCwd('/etc/foo.conf')).toBe('-etc-foo-conf');
    expect(encodedCwd('/a@b!c#d$e%f')).toBe('-a-b-c-d-e-f');
  });

  it('returns an empty string for an empty input', () => {
    expect(encodedCwd('')).toBe('');
  });

  it('replaces multi-byte / unicode chars per JS regex semantics', () => {
    // Each non-[a-zA-Z0-9] code unit becomes a dash. Astral chars are two
    // code units, so they collapse to two dashes — matches /[^a-zA-Z0-9]/g.
    expect(encodedCwd('/proj/café')).toBe('-proj-caf-');
    expect(encodedCwd('/привет')).toBe('-------');
  });

  it('leaves a purely alphanumeric input unchanged', () => {
    expect(encodedCwd('abc123XYZ')).toBe('abc123XYZ');
  });
});

describe('claudeProjectsDir', () => {
  it('resolves to <homedir>/.claude/projects', () => {
    expect(claudeProjectsDir()).toBe(join(homedir(), '.claude', 'projects'));
  });
});

describe('drevHome', () => {
  it('resolves to <homedir>/.drev', () => {
    expect(drevHome()).toBe(join(homedir(), '.drev'));
  });
});

describe('sessionPath', () => {
  it('joins claude projects dir, encoded cwd, and <id>.jsonl', () => {
    const id = '7f3a2b1c-1234-5678-90ab-cdef01234567';
    expect(sessionPath('/Users/fuat/work/forever-town', id)).toBe(
      join(
        homedir(),
        '.claude',
        'projects',
        '-Users-fuat-work-forever-town',
        `${id}.jsonl`,
      ),
    );
  });

  it('handles a Windows path', () => {
    const id = 'abc';
    expect(sessionPath('F:\\Nuts Projects\\drev', id)).toBe(
      join(
        homedir(),
        '.claude',
        'projects',
        'F--Nuts-Projects-drev',
        'abc.jsonl',
      ),
    );
  });
});

describe('subagentDir', () => {
  it('joins claude projects dir, encoded cwd, <id>, and subagents', () => {
    const id = '7f3a2b1c';
    expect(subagentDir('/Users/fuat/work/forever-town', id)).toBe(
      join(
        homedir(),
        '.claude',
        'projects',
        '-Users-fuat-work-forever-town',
        id,
        'subagents',
      ),
    );
  });

  it('handles a Windows path', () => {
    expect(subagentDir('F:\\Nuts Projects\\drev', 'xyz')).toBe(
      join(
        homedir(),
        '.claude',
        'projects',
        'F--Nuts-Projects-drev',
        'xyz',
        'subagents',
      ),
    );
  });
});
