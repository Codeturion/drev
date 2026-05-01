import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { claudeProjectsDir, sessionPath, subagentDir } from './claude-paths.js';
import { SessionError } from '../lib/errors.js';

export interface SessionFiles {
  parent: string;
  subagents: string[];
}

export interface SessionStats {
  id: string;
  cwd: string;
  turns: number;
  toolCalls: number;
  filesTouched: string[];
  createdAt: string;
  modifiedAt: string;
  sizeBytes: number;
}

/**
 * Strips the `signature` field from thinking blocks in a JSONL string.
 * Thinking block signatures are tied to the API key that created them;
 * resuming across accounts causes a 400 unless they are removed.
 */
export function stripThinkingSignatures(jsonl: string): string {
  return jsonl
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return line;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return line;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return line;
      const changed = scrubThinkingSignatures(parsed as Record<string, unknown>);
      return changed ? JSON.stringify(parsed) : line;
    })
    .join('\n');
}

function scrubThinkingSignatures(obj: Record<string, unknown>): boolean {
  let changed = false;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const block = item as Record<string, unknown>;
          if (block['type'] === 'thinking' && 'signature' in block) {
            delete block['signature'];
            changed = true;
          }
          if (scrubThinkingSignatures(block)) changed = true;
        }
      }
    } else if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      if (scrubThinkingSignatures(val as Record<string, unknown>)) changed = true;
    }
  }
  return changed;
}

export async function findSessionFiles(
  absolutePath: string,
  sessionId: string,
): Promise<SessionFiles> {
  const parent = sessionPath(absolutePath, sessionId);
  const parentStat = await statSafe(parent);
  if (!parentStat || !parentStat.isFile()) {
    throw new SessionError(`Session JSONL not found: ${parent}`);
  }

  const subagents = await listSubagents(subagentDir(absolutePath, sessionId));

  return { parent, subagents };
}

export async function findMostRecentSession(): Promise<SessionFiles | null> {
  const projectsRoot = claudeProjectsDir();
  let projectDirs: string[];
  try {
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    projectDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => join(projectsRoot, e.name));
  } catch {
    return null;
  }

  let best: { path: string; mtimeMs: number; projectDir: string } | null = null;
  for (const projectDir of projectDirs) {
    let entries;
    try {
      entries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.jsonl')) continue;
      const full = join(projectDir, entry.name);
      const s = await statSafe(full);
      if (!s) continue;
      if (best === null || s.mtimeMs > best.mtimeMs) {
        best = { path: full, mtimeMs: s.mtimeMs, projectDir };
      }
    }
  }

  if (best === null) return null;

  const sessionId = basename(best.path).replace(/\.jsonl$/, '');
  const subagents = await listSubagents(join(best.projectDir, sessionId, 'subagents'));
  return { parent: best.path, subagents };
}

export async function readSessionStats(files: SessionFiles): Promise<SessionStats> {
  const id = basename(files.parent).replace(/\.jsonl$/, '');

  let cwd = '';
  let turns = 0;
  let toolCalls = 0;
  const filesTouchedSet = new Set<string>();
  let createdAt = '';
  let modifiedAt = '';

  // Stream-parse the parent file. Subagent JSONLs contribute to size only —
  // turn/tool counts are scoped to the parent transcript per the SessionStats
  // contract (cwd belongs to the parent). Subagent contents would need their
  // own stats surface and that is not in scope for T09.
  try {
    await parseJsonl(files.parent, (event) => {
    const t = typeof event['type'] === 'string' ? (event['type'] as string) : '';
    if (t === 'user' || t === 'assistant') turns += 1;

    if (!cwd) {
      const c = event['cwd'];
      if (typeof c === 'string' && c.length > 0) cwd = c;
    }

    const ts = event['timestamp'];
    if (typeof ts === 'string' && ts.length > 0) {
      if (!createdAt) createdAt = ts;
      modifiedAt = ts;
    }

    const blocks = extractContentBlocks(event);
    for (const block of blocks) {
      if (
        block !== null &&
        typeof block === 'object' &&
        (block as Record<string, unknown>)['type'] === 'tool_use'
      ) {
        toolCalls += 1;
        const input = (block as Record<string, unknown>)['input'];
        if (input !== null && typeof input === 'object') {
          const fp = (input as Record<string, unknown>)['file_path'];
          if (typeof fp === 'string' && fp.length > 0) {
            if (cwd && fp.startsWith(cwd)) filesTouchedSet.add(fp);
          }
        }
      }
    }
    });
  } catch (err) {
    throw new SessionError(`Failed to read session JSONL: ${files.parent}`, {
      cause: err,
    });
  }

  // Size is the sum of parent + each subagent file. fs.stat per-file so a
  // missing/unreadable subagent surfaces as a SessionError rather than a
  // silently-undercounted total.
  let sizeBytes = 0;
  const parentStat = await statSafe(files.parent);
  if (!parentStat) throw new SessionError(`Cannot stat parent: ${files.parent}`);
  sizeBytes += parentStat.size;
  for (const sub of files.subagents) {
    const s = await statSafe(sub);
    if (!s) throw new SessionError(`Cannot stat subagent: ${sub}`);
    sizeBytes += s.size;
  }

  const filesTouched = Array.from(filesTouchedSet).sort();

  return {
    id,
    cwd,
    turns,
    toolCalls,
    filesTouched,
    createdAt,
    modifiedAt,
    sizeBytes,
  };
}

function extractContentBlocks(event: Record<string, unknown>): unknown[] {
  // Claude Code JSONL events nest message content in different shapes:
  //   { type:'assistant', message:{ content:[...] } }
  //   { type:'user', message:{ content:[...] } }
  //   { content:[...] }  (occasional flatter form)
  // Walk both paths and concatenate.
  const out: unknown[] = [];
  const direct = event['content'];
  if (Array.isArray(direct)) out.push(...direct);
  const message = event['message'];
  if (message !== null && typeof message === 'object') {
    const inner = (message as Record<string, unknown>)['content'];
    if (Array.isArray(inner)) out.push(...inner);
  }
  return out;
}

async function parseJsonl(
  path: string,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Skip unparseable lines — the JSONL spec admits trailing partial
        // writes and we want to be tolerant per acceptance "stream-parses".
        continue;
      }
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        onEvent(parsed as Record<string, unknown>);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function listSubagents(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(join(dir, entry.name));
    }
  }
  out.sort();
  return out;
}

async function statSafe(path: string): Promise<Stats | null> {
  try {
    return (await stat(path)) as Stats;
  } catch {
    return null;
  }
}
