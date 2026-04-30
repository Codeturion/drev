import { ConfigError } from '../lib/errors.js';
import { configGet } from './git-ops.js';

export async function currentUserEmail(): Promise<string> {
  const value = await configGet('user.email');
  const trimmed = value === null ? '' : value.trim();
  if (trimmed === '') {
    throw new ConfigError(
      '`git config user.email` is not set. Run `git config --global user.email "you@example.com"`.',
    );
  }
  return trimmed;
}

export function shortUsername(email: string): string {
  const at = email.indexOf('@');
  const local = at === -1 ? email : email.slice(0, at);
  const lowered = local.toLowerCase();
  const sanitized = lowered.replace(/[^a-z0-9-]/g, '-');
  const collapsed = sanitized.replace(/-+/g, '-').replace(/^-|-$/g, '');
  return collapsed;
}
