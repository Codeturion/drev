import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, fileNameFor } from './logger.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'drev-logger-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readLines(file: string): Promise<unknown[]> {
  const raw = await readFile(file, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe('createLogger', () => {
  it('creates the log directory and writes a JSON-line entry', async () => {
    const nestedDir = join(dir, 'nested', 'logs');
    const fixedNow = new Date('2026-04-30T12:00:00Z');
    const log = createLogger('test', { dir: nestedDir, now: () => fixedNow });
    await log.info('hello world', { foo: 'bar' });

    const file = join(nestedDir, fileNameFor('test', fixedNow));
    const entries = await readLines(file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      timestamp: '2026-04-30T12:00:00.000Z',
      level: 'info',
      scope: 'test',
      message: 'hello world',
      data: { foo: 'bar' },
    });
  });

  it('omits the data field when none provided', async () => {
    const fixedNow = new Date('2026-04-30T12:00:00Z');
    const log = createLogger('test', { dir, now: () => fixedNow });
    await log.warn('plain');
    const entries = await readLines(join(dir, fileNameFor('test', fixedNow)));
    expect(entries[0]).not.toHaveProperty('data');
    expect((entries[0] as { level: string }).level).toBe('warn');
  });

  it('respects level filtering', async () => {
    const fixedNow = new Date('2026-04-30T12:00:00Z');
    const log = createLogger('test', { dir, now: () => fixedNow, level: 'warn' });
    await log.info('skipped');
    await log.warn('kept');
    await log.error('also kept');
    const entries = await readLines(join(dir, fileNameFor('test', fixedNow)));
    expect(entries.map((e) => (e as { level: string }).level)).toEqual(['warn', 'error']);
  });

  it('rotates by date — entries on different days land in different files', async () => {
    let current = new Date('2026-04-30T23:59:59Z');
    const log = createLogger('test', { dir, now: () => current });
    await log.info('day-one');

    current = new Date('2026-05-01T00:00:01Z');
    await log.info('day-two');

    const day1 = await readLines(join(dir, fileNameFor('test', new Date('2026-04-30T00:00:00Z'))));
    const day2 = await readLines(join(dir, fileNameFor('test', new Date('2026-05-01T00:00:00Z'))));
    expect((day1[0] as { message: string }).message).toBe('day-one');
    expect((day2[0] as { message: string }).message).toBe('day-two');
  });

  it('appends to today\'s file across multiple calls', async () => {
    const fixedNow = new Date('2026-04-30T12:00:00Z');
    const log = createLogger('test', { dir, now: () => fixedNow });
    await log.info('one');
    await log.info('two');
    await log.error('three');
    const entries = await readLines(join(dir, fileNameFor('test', fixedNow)));
    expect(entries.map((e) => (e as { message: string }).message)).toEqual(['one', 'two', 'three']);
  });

  it('cleans up files older than retention on init', async () => {
    // Pre-seed files: one within retention, one beyond.
    const fresh = 'test-2026-04-25.log';
    const stale = 'test-2026-03-01.log';
    const otherBase = 'autoshare-2026-01-01.log';
    await writeFile(join(dir, fresh), 'pre-existing\n');
    await writeFile(join(dir, stale), 'pre-existing\n');
    await writeFile(join(dir, otherBase), 'pre-existing\n');

    const fixedNow = new Date('2026-04-30T00:00:00Z');
    const log = createLogger('test', { dir, now: () => fixedNow, retentionDays: 30 });
    await log.info('trigger init flush');

    const remaining = await readdir(dir);
    expect(remaining).toContain(fresh);
    expect(remaining).not.toContain(stale);
    // Other baseName is not the logger's concern.
    expect(remaining).toContain(otherBase);
  });

  it('does not throw if the log directory cannot be created or read', async () => {
    // Point at an obviously bogus, non-creatable path on Windows; on POSIX use a NUL-ish marker.
    // On both platforms we simply expect best-effort silence — no rejection.
    const bogus = process.platform === 'win32'
      ? 'Z:\\\\definitely\\\\not\\\\writable\\\\drev-tests'
      : '/proc/definitely/not/writable/drev-tests';
    const log = createLogger('test', { dir: bogus, now: () => new Date('2026-04-30T12:00:00Z') });
    await expect(log.info('should not throw')).resolves.toBeUndefined();
  });

  it('all three level methods exist and return promises', async () => {
    const log = createLogger('test', { dir, now: () => new Date('2026-04-30T12:00:00Z') });
    expect(log.info('a')).toBeInstanceOf(Promise);
    expect(log.warn('b')).toBeInstanceOf(Promise);
    expect(log.error('c')).toBeInstanceOf(Promise);
    await Promise.all([log.info('a'), log.warn('b'), log.error('c')]);
  });
});
