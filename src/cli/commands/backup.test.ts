import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// Mock the underlying share implementation. The backup command is a thin
// wrapper that delegates here, so this is the seam under test.
vi.mock('./share.js', () => ({
  executeShare: vi.fn(),
}));

vi.mock('../ui.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  errorOut: vi.fn(),
}));

import { executeShare } from './share.js';
import * as ui from '../ui.js';
import { register } from './backup.js';

function buildProgram(): Command {
  // exitOverride prevents Commander from calling process.exit() on errors.
  // Using a fresh Command per test isolates option/action state.
  const program = new Command();
  program.exitOverride();
  register(program);
  return program;
}

afterEach(() => {
  vi.clearAllMocks();
  // Reset exitCode in case a previous test set it.
  process.exitCode = 0;
});

describe('drev backup — argument validation', () => {
  it('exits non-zero with helpful error when --name is missing', async () => {
    vi.mocked(executeShare).mockResolvedValue({
      id: 'x',
      name: 'x',
      shortId: 'x',
      redactionCounts: {},
      pushed: true,
    });

    const program = buildProgram();
    await program.parseAsync(['node', 'drev', 'backup']);

    expect(executeShare).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(ui.errorOut).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(ui.errorOut).mock.calls[0]![0];
    expect(msg.toLowerCase()).toContain('--name');
  });

  it('exits non-zero when --name is empty string', async () => {
    const program = buildProgram();
    await program.parseAsync(['node', 'drev', 'backup', '--name', '   ']);

    expect(executeShare).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(ui.errorOut).toHaveBeenCalledTimes(1);
  });
});

describe('drev backup — delegation to executeShare', () => {
  it('invokes executeShare with purpose=backup, visibility=private, interactive=true', async () => {
    vi.mocked(executeShare).mockResolvedValue({
      id: '7f3a2b1c-1234-5678-90ab-cdef01234567',
      name: 'nightly',
      shortId: '7f3a2b1c',
      redactionCounts: {},
      pushed: true,
    });

    const program = buildProgram();
    await program.parseAsync(['node', 'drev', 'backup', '--name', 'nightly']);

    expect(executeShare).toHaveBeenCalledTimes(1);
    const call = vi.mocked(executeShare).mock.calls[0]![0];
    expect(call.name).toBe('nightly');
    expect(call.purpose).toBe('backup');
    expect(call.visibility).toBe('private');
    expect(call.interactive).toBe(true);
    expect(process.exitCode).toBe(0);
    expect(ui.info).toHaveBeenCalled();
  });

  it('passes --session-id through to executeShare', async () => {
    vi.mocked(executeShare).mockResolvedValue({
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      name: 'manual',
      shortId: 'aaaaaaaa',
      redactionCounts: {},
      pushed: true,
    });

    const program = buildProgram();
    await program.parseAsync([
      'node',
      'drev',
      'backup',
      '--name',
      'manual',
      '--session-id',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ]);

    expect(executeShare).toHaveBeenCalledTimes(1);
    const call = vi.mocked(executeShare).mock.calls[0]![0];
    expect(call.sessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(call.name).toBe('manual');
    expect(call.purpose).toBe('backup');
    expect(call.visibility).toBe('private');
  });

  it('forces visibility=private (no flag exists to override it)', async () => {
    // Backup intentionally does not expose --private; visibility must always be
    // 'private' regardless of repo default_visibility. Verify by parsing every
    // sensible argv variant and confirming the call always carries 'private'.
    vi.mocked(executeShare).mockResolvedValue({
      id: 'id',
      name: 'b',
      shortId: 'id',
      redactionCounts: {},
      pushed: true,
    });

    const argvs: string[][] = [
      ['node', 'drev', 'backup', '--name', 'b'],
      ['node', 'drev', 'backup', '--name', 'b', '--session-id', 'sid'],
    ];
    for (const argv of argvs) {
      vi.mocked(executeShare).mockClear();
      const program = buildProgram();
      await program.parseAsync(argv);
      const call = vi.mocked(executeShare).mock.calls[0]![0];
      expect(call.visibility).toBe('private');
    }
  });

  it('surfaces executeShare errors and sets exitCode=1', async () => {
    vi.mocked(executeShare).mockRejectedValue(new Error('boom'));

    const program = buildProgram();
    await program.parseAsync(['node', 'drev', 'backup', '--name', 'x']);

    expect(process.exitCode).toBe(1);
    expect(ui.errorOut).toHaveBeenCalledWith('boom');
  });
});
