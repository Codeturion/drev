import type { SessionMeta } from './metadata.js';
import { readMeta } from './metadata.js';
import { SessionError } from '../lib/errors.js';

export interface ResolvedSession {
  metaPath: string;
  meta: SessionMeta;
}

const HEX_RE = /^[0-9a-fA-F]+$/;

export function isIdPrefix(query: string): boolean {
  if (query.length < 8) return false;
  return HEX_RE.test(query);
}

export function matchById(query: string, meta: SessionMeta): boolean {
  return meta.id.toLowerCase().startsWith(query.toLowerCase());
}

export function matchByName(query: string, meta: SessionMeta): boolean {
  if (typeof meta.name !== 'string' || meta.name.length === 0) return false;
  return meta.name.toLowerCase().includes(query.toLowerCase());
}

interface Candidate {
  metaPath: string;
  meta: SessionMeta;
}

function formatCandidates(matches: Candidate[]): string {
  const lines = matches.map((c) => {
    const idPrefix = c.meta.id.slice(0, 8);
    const name = c.meta.name ?? '(unnamed)';
    return `  ${idPrefix}  ${name}  ${c.meta.user}`;
  });
  return lines.join('\n');
}

export async function resolve(
  query: string,
  metaFiles: string[],
): Promise<ResolvedSession> {
  const matches: Candidate[] = [];
  const usePrefix = isIdPrefix(query);
  for (const metaPath of metaFiles) {
    const meta = await readMeta(metaPath);
    const matched = usePrefix ? matchById(query, meta) : matchByName(query, meta);
    if (matched) {
      matches.push({ metaPath, meta });
    }
  }

  if (matches.length === 0) {
    throw new SessionError(`no session matches '${query}'`);
  }
  if (matches.length === 1) {
    const only = matches[0]!;
    return { metaPath: only.metaPath, meta: only.meta };
  }
  throw new SessionError(
    `multiple sessions match '${query}':\n${formatCandidates(matches)}`,
  );
}
