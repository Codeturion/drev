import { describe, it, expect, vi, afterEach } from 'vitest';
import { info, warn, errorOut, table, confirm } from './ui.js';

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
