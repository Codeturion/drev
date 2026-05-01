import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { info, warn, errorOut, table, confirm, prompt, isInteractive } from './ui.js';
import { ConfigError } from '../lib/errors.js';

let nextAnswer = '';
vi.mock('node:readline', () => ({
  default: {
    createInterface: () => ({
      question: (_q: string, cb: (a: string) => void) => cb(nextAnswer),
      close: () => {},
    }),
  },
  createInterface: () => ({
    question: (_q: string, cb: (a: string) => void) => cb(nextAnswer),
    close: () => {},
  }),
}));

// Most tests assume an interactive TTY so the existing readline mock is exercised.
// Individual non-TTY tests override these flags.
const originalStdinTTY = process.stdin.isTTY;
const originalStdoutTTY = process.stdout.isTTY;
beforeEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
});
afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: originalStdinTTY,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: originalStdoutTTY,
    configurable: true,
  });
});

function captureStdout(): { restore: () => void; output: () => string } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((data: unknown) => {
    chunks.push(typeof data === 'string' ? data : String(data));
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = original;
    },
    output: () => chunks.join(''),
  };
}

function captureStderr(): { restore: () => void; output: () => string } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((data: unknown) => {
    chunks.push(typeof data === 'string' ? data : String(data));
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => {
      process.stderr.write = original;
    },
    output: () => chunks.join(''),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('info', () => {
  it('writes to stdout with the message', () => {
    const out = captureStdout();
    const err = captureStderr();
    try {
      info('hello');
    } finally {
      out.restore();
      err.restore();
    }
    expect(out.output()).toContain('hello');
    expect(out.output().endsWith('\n')).toBe(true);
    expect(err.output()).toBe('');
  });
});

describe('warn', () => {
  it('writes to stdout with the message', () => {
    const out = captureStdout();
    const err = captureStderr();
    try {
      warn('careful');
    } finally {
      out.restore();
      err.restore();
    }
    expect(out.output()).toContain('careful');
    expect(err.output()).toBe('');
  });
});

describe('errorOut', () => {
  it('writes to stderr with the message', () => {
    const out = captureStdout();
    const err = captureStderr();
    try {
      errorOut('boom');
    } finally {
      out.restore();
      err.restore();
    }
    expect(err.output()).toContain('boom');
    expect(out.output()).toBe('');
  });
});

describe('table', () => {
  it('renders aligned columns', () => {
    const rows = [
      { id: 'a', name: 'short' },
      { id: 'bb', name: 'longer-name' },
    ];
    const out = table(rows, ['id', 'name']);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    // Header row contains both columns
    expect(lines[0]).toContain('id');
    expect(lines[0]).toContain('name');
    // Each data row aligns id column to width 2 (max of 'id', 'a', 'bb' = 2)
    expect(lines[1]).toMatch(/^a {2}/); // 'a' padded to width 2 + 2-space sep
    expect(lines[2]).toMatch(/^bb {2}/);
    // Data values present
    expect(lines[1]).toContain('short');
    expect(lines[2]).toContain('longer-name');
  });

  it('truncates cell content longer than 60 chars', () => {
    const long = 'x'.repeat(80);
    const out = table([{ a: long }], ['a']);
    const lines = out.split('\n');
    expect(lines[1]).toBe('x'.repeat(60));
  });

  it('renders missing keys as empty cells', () => {
    const rows: Array<Record<string, string>> = [{ a: 'hello' }, { b: 'world' }];
    const out = table(rows, ['a', 'b']);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    // Row 0: a='hello', b missing -> empty
    expect(lines[1]).toMatch(/^hello/);
    // Row 1: a missing -> empty, b='world'
    expect(lines[2]).toContain('world');
  });

  it('returns empty string for empty rows', () => {
    expect(table([], ['a', 'b'])).toBe('');
  });
});

describe('confirm', () => {
  async function runConfirm(answer: string): Promise<boolean> {
    nextAnswer = answer;
    return await confirm('proceed?');
  }

  it('returns true on lowercase y', async () => {
    expect(await runConfirm('y')).toBe(true);
  });

  it('returns true on uppercase Y', async () => {
    expect(await runConfirm('Y')).toBe(true);
  });

  it('returns true on yes', async () => {
    expect(await runConfirm('yes')).toBe(true);
  });

  it('returns false on n', async () => {
    expect(await runConfirm('n')).toBe(false);
  });

  it('returns false on empty input', async () => {
    expect(await runConfirm('')).toBe(false);
  });

  it('returns false on garbage input', async () => {
    expect(await runConfirm('maybe')).toBe(false);
  });
});

describe('prompt', () => {
  async function runPrompt(answer: string): Promise<string> {
    nextAnswer = answer;
    return await prompt('paste url: ');
  }

  it('returns empty string for empty input', async () => {
    expect(await runPrompt('')).toBe('');
  });

  it('returns the answer as-is when no surrounding whitespace', async () => {
    expect(await runPrompt('https://example.com/repo.git')).toBe(
      'https://example.com/repo.git',
    );
  });

  it('trims surrounding whitespace from the answer', async () => {
    expect(await runPrompt('   org/name  ')).toBe('org/name');
  });

  it('trims newlines and tabs', async () => {
    expect(await runPrompt('\n\tfoo/bar\t\n')).toBe('foo/bar');
  });
});

describe('isInteractive', () => {
  it('returns true when both stdin and stdout are TTYs', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    expect(isInteractive()).toBe(true);
  });

  it('returns false when stdin is not a TTY', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    expect(isInteractive()).toBe(false);
  });

  it('returns false when stdout is not a TTY', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    expect(isInteractive()).toBe(false);
  });

  it('returns false when isTTY is undefined (piped stdin)', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    expect(isInteractive()).toBe(false);
  });
});

describe('confirm non-interactive', () => {
  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  it('returns false by default without invoking readline', async () => {
    nextAnswer = 'y'; // would be true if readline ran
    expect(await confirm('proceed?')).toBe(false);
  });

  it('returns the override when defaultIfNonInteractive is true', async () => {
    nextAnswer = 'n';
    expect(await confirm('proceed?', { defaultIfNonInteractive: true })).toBe(true);
  });

  it('returns false when defaultIfNonInteractive is explicitly false', async () => {
    expect(await confirm('proceed?', { defaultIfNonInteractive: false })).toBe(false);
  });
});

describe('prompt non-interactive', () => {
  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  it('throws ConfigError instead of blocking', async () => {
    await expect(prompt('paste url: ')).rejects.toBeInstanceOf(ConfigError);
  });

  it("error message hints at passing a CLI flag", async () => {
    await expect(prompt('paste url: ')).rejects.toThrow(/CLI flag/i);
  });
});
