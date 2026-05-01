import type { Command } from 'commander';
import { ValidationError } from '../../lib/errors.js';
import { errorOut, info } from '../ui.js';
import { executeShare } from './share.js';

export function register(program: Command): void {
  program
    .command('backup')
    .description('Back up the most recent (or selected) Claude Code session privately to the team repo.')
    .option('--name <name>', 'name for the backup (required, sanitized)')
    .option('--session-id <id>', 'back up a specific session id instead of the most recent')
    .action(async (opts: { name?: string; sessionId?: string }) => {
      try {
        if (opts.name === undefined || opts.name.trim() === '') {
          throw new ValidationError(
            '--name is required for `drev backup`. Provide a name to identify this backup.',
          );
        }

        const result = await executeShare({
          name: opts.name,
          ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
          visibility: 'private',
          purpose: 'backup',
          interactive: true,
        });

        info(
          `Backed up ${result.name} (id: ${result.shortId}, pushed: ${result.pushed ? 'yes' : 'no'}).`,
        );
      } catch (err) {
        if (err instanceof Error) {
          errorOut(err.message);
        } else {
          errorOut(String(err));
        }
        process.exitCode = 1;
      }
    });
}
