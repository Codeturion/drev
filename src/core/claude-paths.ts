import { homedir } from 'node:os';
import { join } from 'node:path';

export function encodedCwd(absolutePath: string): string {
  return absolutePath.replace(/[^a-zA-Z0-9]/g, '-');
}

export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

export function sessionPath(absolutePath: string, sessionId: string): string {
  return join(claudeProjectsDir(), encodedCwd(absolutePath), `${sessionId}.jsonl`);
}

export function subagentDir(absolutePath: string, sessionId: string): string {
  return join(claudeProjectsDir(), encodedCwd(absolutePath), sessionId, 'subagents');
}

export function drevHome(): string {
  return join(homedir(), '.drev');
}
