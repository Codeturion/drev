import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionError } from '../lib/errors.js';
import { encodedCwd } from './claude-paths.js';
import {
  findMostRecentSession,
  findSessionFiles,
  readSessionStats,
  stripThinkingSignatures,
} from './session.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (!d) continue;
    await rm(d, { recursive: true, force: true });
  }
});

async function makeTmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await makeTmp('drev-home-');
  const prevHome = process.env['HOME'];
  const prevUser = process.env['USERPROFILE'];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  try {
    return await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    if (prevUser === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = prevUser;
  }
}

interface BuildOptions {
  cwd: string;
  events?: Array<Record<string, unknown>>;
  // If true, the session dir is created with subagent files even if events is empty.
  subagentEvents?: Array<Array<Record<string, unknown>>>;
  appendGarbage?: boolean;
}

async function buildSessionInHome(
  home: string,
  sessionId: string,
  opts: BuildOptions,
): Promise<{ parent: string; sessionDir: string; subagents: string[] }> {
  const projectDir = join(home, '.claude', 'projects', encodedCwd(opts.cwd));
  await mkdir(projectDir, { recursive: true });
  const parent = join(projectDir, `${sessionId}.jsonl`);
  const lines = (opts.events ?? []).map((e) => JSON.stringify(e));
  let body = lines.join('\n');
  if (opts.appendGarbage) {
    body += '\n{not valid json\n\n   \n';
  }
  await writeFile(parent, body, 'utf8');

  const subagentFiles: string[] = [];
  const subAgents = opts.subagentEvents ?? [];
  if (subAgents.length > 0) {
    const subDir = join(projectDir, sessionId, 'subagents');
    await mkdir(subDir, { recursive: true });
    // Sort-friendly names so the assertion ordering is deterministic.
    for (let i = 0; i < subAgents.length; i += 1) {
      const file = join(subDir, `agent-${i}.jsonl`);
      const subEvents = subAgents[i] ?? [];
      await writeFile(file, subEvents.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
      subagentFiles.push(file);
    }
  }

  return { parent, sessionDir: projectDir, subagents: subagentFiles };
}

describe('findSessionFiles', () => {
  it('returns parent and empty subagents when no subagents directory exists', async () => {
    await withFakeHome(async (home) => {
      const cwd = join(home, 'work', 'proj');
      const { parent } = await buildSessionInHome(home, 'sess-1', {
        cwd,
        events: [{ type: 'user' }],
      });
      const result = await findSessionFiles(cwd, 'sess-1');
      expect(result.parent).toBe(parent);
      expect(result.subagents).toEqual([]);
    });
  });

  it('discovers subagent JSONLs sorted by path', async () => {
    await withFakeHome(async (home) => {
      const cwd = join(home, 'work', 'proj');
      const built = await buildSessionInHome(home, 'sess-2', {
        cwd,
        events: [{ type: 'user' }],
        subagentEvents: [
          [{ type: 'assistant' }],
          [{ type: 'assistant' }, { type: 'user' }],
        ],
      });
      const result = await findSessionFiles(cwd, 'sess-2');
      expect(result.parent).toBe(built.parent);
      expect(result.subagents).toEqual([...built.subagents].sort());
      expect(result.subagents.length).toBe(2);
    });
  });

  it('throws SessionError when parent JSONL is missing', async () => {
    await withFakeHome(async (home) => {
      const cwd = join(home, 'work', 'missing');
      await expect(findSessionFiles(cwd, 'no-such')).rejects.toBeInstanceOf(
        SessionError,
      );
    });
  });

  it('ignores non-jsonl files inside the subagents directory', async () => {
    await withFakeHome(async (home) => {
      const cwd = join(home, 'work', 'proj');
      const built = await buildSessionInHome(home, 'sess-3', {
        cwd,
        events: [{ type: 'user' }],
        subagentEvents: [[{ type: 'user' }]],
      });
      const subDir = join(built.sessionDir, 'sess-3', 'subagents');
      await writeFile(join(subDir, 'README.md'), '# notes', 'utf8');
      const result = await findSessionFiles(cwd, 'sess-3');
      expect(result.subagents).toHaveLength(1);
      expect(result.subagents[0]?.endsWith('.jsonl')).toBe(true);
    });
  });
});

describe('findMostRecentSession', () => {
  it('returns null when ~/.claude/projects does not exist', async () => {
    await withFakeHome(async () => {
      const result = await findMostRecentSession();
      expect(result).toBeNull();
    });
  });

  it('returns null when projects dir exists but contains no jsonl files', async () => {
    await withFakeHome(async (home) => {
      await mkdir(join(home, '.claude', 'projects'), { recursive: true });
      const result = await findMostRecentSession();
      expect(result).toBeNull();
    });
  });

  it('picks the JSONL with latest mtime across multiple project dirs', async () => {
    await withFakeHome(async (home) => {
      const cwdA = join(home, 'projA');
      const cwdB = join(home, 'projB');
      const olderBuilt = await buildSessionInHome(home, 'older', {
        cwd: cwdA,
        events: [{ type: 'user' }],
      });
      const newerBuilt = await buildSessionInHome(home, 'newer', {
        cwd: cwdB,
        events: [{ type: 'assistant' }],
        subagentEvents: [[{ type: 'user' }]],
      });

      // Force ordered mtimes: older must be older than newer.
      const past = new Date(Date.now() - 60_000);
      const fs = await import('node:fs/promises');
      await fs.utimes(olderBuilt.parent, past, past);

      const result = await findMostRecentSession();
      expect(result).not.toBeNull();
      expect(result?.parent).toBe(newerBuilt.parent);
      expect(result?.subagents).toHaveLength(1);
    });
  });

  it('skips entries that are not files or not .jsonl', async () => {
    await withFakeHome(async (home) => {
      const cwd = join(home, 'proj');
      const built = await buildSessionInHome(home, 'only', {
        cwd,
        events: [{ type: 'user' }],
      });
      // Add a stray non-jsonl file and a nested directory inside the project dir.
      await writeFile(join(built.sessionDir, 'note.txt'), 'x', 'utf8');
      await mkdir(join(built.sessionDir, 'nested'), { recursive: true });
      const result = await findMostRecentSession();
      expect(result?.parent).toBe(built.parent);
    });
  });
});

describe('readSessionStats', () => {
  it('counts turns, tool_use blocks, and computes timestamps and size', async () => {
    await withFakeHome(async (home) => {
      const cwd = join(home, 'work', 'proj');
      const events: Array<Record<string, unknown>> = [
        {
          type: 'user',
          cwd,
          timestamp: '2026-04-30T10:00:00Z',
          message: { content: [{ type: 'text', text: 'hi' }] },
        },
        {
          type: 'assistant',
          timestamp: '2026-04-30T10:00:05Z',
          message: {
            content: [
              { type: 'text', text: 'sure' },
              {
                type: 'tool_use',
                input: { file_path: join(cwd, 'a.ts') },
              },
              {
                type: 'tool_use',
                input: { file_path: join(cwd, 'b.ts') },
              },
              {
                type: 'tool_use',
                input: { file_path: '/elsewhere/out-of-cwd.ts' },
              },
            ],
          },
        },
        {
          type: 'user',
          timestamp: '2026-04-30T10:00:10Z',
          // duplicate file_path on a second tool_use should not duplicate
          message: {
            content: [
              {
                type: 'tool_use',
                input: { file_path: join(cwd, 'a.ts') },
              },
            ],
          },
        },
        // A non-turn event (e.g. a system summary) with timestamp updates modifiedAt
        // but does not increment turns.
        { type: 'summary', timestamp: '2026-04-30T10:00:20Z' },
      ];
      const built = await buildSessionInHome(home, 'sess-stats', {
        cwd,
        events,
        appendGarbage: true,
      });

      const files = await findSessionFiles(cwd, 'sess-stats');
      const stats = await readSessionStats(files);

      expect(stats.id).toBe('sess-stats');
      expect(stats.cwd).toBe(cwd);
      expect(stats.turns).toBe(3);
      expect(stats.toolCalls).toBe(4);
      expect(stats.filesTouched).toEqual([join(cwd, 'a.ts'), join(cwd, 'b.ts')]);
      expect(stats.createdAt).toBe('2026-04-30T10:00:00Z');
      expect(stats.modifiedAt).toBe('2026-04-30T10:00:20Z');

      const parentStat = await stat(built.parent);
      expect(stats.sizeBytes).toBe(parentStat.size);
    });
  });

  it('sums sizeBytes across parent and subagent files', async () => {
    await withFakeHome(async (home) => {
      const cwd = join(home, 'p');
      const built = await buildSessionInHome(home, 'sub', {
        cwd,
        events: [{ type: 'user', cwd, timestamp: '2026-01-01T00:00:00Z' }],
        subagentEvents: [
          [{ type: 'user', timestamp: '2026-01-01T00:00:01Z' }],
          [{ type: 'assistant', timestamp: '2026-01-01T00:00:02Z' }],
        ],
      });
      const files = await findSessionFiles(cwd, 'sub');
      const stats = await readSessionStats(files);
      const expected =
        (await stat(built.parent)).size +
        (await stat(built.subagents[0]!)).size +
        (await stat(built.subagents[1]!)).size;
      expect(stats.sizeBytes).toBe(expected);
    });
  });

  it('handles a session with zero turns and no tool_use blocks', async () => {
    await withFakeHome(async (home) => {
      const cwd = join(home, 'empty');
      await buildSessionInHome(home, 'zero', {
        cwd,
        events: [{ type: 'summary', cwd }],
      });
      const files = await findSessionFiles(cwd, 'zero');
      const stats = await readSessionStats(files);
      expect(stats.turns).toBe(0);
      expect(stats.toolCalls).toBe(0);
      expect(stats.filesTouched).toEqual([]);
      expect(stats.createdAt).toBe('');
      expect(stats.modifiedAt).toBe('');
    });
  });

  it('handles flat content arrays at the event root', async () => {
    await withFakeHome(async (home) => {
      const cwd = join(home, 'flat');
      const events: Array<Record<string, unknown>> = [
        {
          type: 'assistant',
          cwd,
          timestamp: '2026-01-02T00:00:00Z',
          content: [{ type: 'tool_use', input: { file_path: join(cwd, 'x.ts') } }],
        },
      ];
      await buildSessionInHome(home, 'flat-sess', { cwd, events });
      const files = await findSessionFiles(cwd, 'flat-sess');
      const stats = await readSessionStats(files);
      expect(stats.toolCalls).toBe(1);
      expect(stats.filesTouched).toEqual([join(cwd, 'x.ts')]);
    });
  });

  it('throws SessionError if the parent file is removed before stat', async () => {
    await withFakeHome(async (home) => {
      const cwd = join(home, 'gone');
      const built = await buildSessionInHome(home, 'gone-sess', {
        cwd,
        events: [{ type: 'user' }],
      });
      const files = { parent: built.parent, subagents: [] as string[] };
      // Remove parent so the stat-pass fails after the JSONL stream completes.
      await rm(built.parent);
      await expect(readSessionStats(files)).rejects.toBeInstanceOf(SessionError);
    });
  });

  it('throws SessionError if a subagent file is removed before stat', async () => {
    await withFakeHome(async (home) => {
      const cwd = join(home, 'p2');
      const built = await buildSessionInHome(home, 's2', {
        cwd,
        events: [{ type: 'user' }],
        subagentEvents: [[{ type: 'user' }]],
      });
      const files = await findSessionFiles(cwd, 's2');
      await rm(built.subagents[0]!);
      await expect(readSessionStats(files)).rejects.toBeInstanceOf(SessionError);
    });
  });

  it('skips non-object JSONL lines (arrays, scalars)', async () => {
    await withFakeHome(async (home) => {
      const cwd = join(home, 'odd');
      const projectDir = join(home, '.claude', 'projects', encodedCwd(cwd));
      await mkdir(projectDir, { recursive: true });
      const parent = join(projectDir, 'odd.jsonl');
      const lines = [
        '[1,2,3]',
        '"a string"',
        '42',
        JSON.stringify({
          type: 'user',
          cwd,
          timestamp: '2026-02-01T00:00:00Z',
        }),
      ];
      await writeFile(parent, lines.join('\n'), 'utf8');
      const files = await findSessionFiles(cwd, 'odd');
      const stats = await readSessionStats(files);
      expect(stats.turns).toBe(1);
      expect(stats.cwd).toBe(cwd);
    });
  });
});

describe('stripThinkingSignatures', () => {
  it('removes signature from thinking blocks in assistant messages', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'some thoughts', signature: 'sig_abc123' },
          { type: 'text', text: 'hello' },
        ],
      },
    });
    const result = stripThinkingSignatures(line);
    const parsed = JSON.parse(result);
    const block = parsed.message.content[0];
    expect(block.thinking).toBe('some thoughts');
    expect('signature' in block).toBe(false);
  });

  it('leaves non-thinking blocks untouched', () => {
    const input = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    expect(stripThinkingSignatures(input)).toBe(input);
  });

  it('handles multiple thinking blocks in one message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'a', signature: 'sig_1' },
          { type: 'thinking', thinking: 'b', signature: 'sig_2' },
        ],
      },
    });
    const result = stripThinkingSignatures(line);
    const parsed = JSON.parse(result);
    for (const block of parsed.message.content) {
      expect('signature' in block).toBe(false);
    }
  });

  it('passes through empty lines unchanged', () => {
    expect(stripThinkingSignatures('')).toBe('');
    expect(stripThinkingSignatures('\n\n')).toBe('\n\n');
  });

  it('passes through unparseable lines unchanged', () => {
    const garbage = 'not json at all';
    expect(stripThinkingSignatures(garbage)).toBe(garbage);
  });

  it('processes multi-line JSONL correctly', () => {
    const line1 = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } });
    const line2 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'x', signature: 'sig_x' }] },
    });
    const result = stripThinkingSignatures(`${line1}\n${line2}`);
    const [r1, r2] = result.split('\n');
    expect(JSON.parse(r1)).toEqual(JSON.parse(line1));
    expect('signature' in JSON.parse(r2).message.content[0]).toBe(false);
  });
});
