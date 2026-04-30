import { Command } from 'commander';
import type { Command as CommanderCommand } from 'commander';
import { errorOut } from './ui.js';
import { DrevError } from '../lib/errors.js';
import * as init from './commands/init.js';
import * as share from './commands/share.js';
import * as backup from './commands/backup.js';
import * as list from './commands/list.js';
import * as resume from './commands/resume.js';
import * as rename from './commands/rename.js';
import * as search from './commands/search.js';
import * as mark from './commands/mark.js';
import * as sync from './commands/sync.js';
import * as scrub from './commands/scrub.js';
import * as hooks from './commands/hooks.js';
import * as autoshareSweep from './commands/autoshare-sweep.js';

type CommandModule = { register?: (program: CommanderCommand) => void };

const modules: CommandModule[] = [
  init,
  share,
  backup,
  list,
  resume,
  rename,
  search,
  mark,
  sync,
  scrub,
  hooks,
  autoshareSweep,
];

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('drev')
    .description('Share Claude Code sessions through a Git repo.')
    .version('0.0.0')
    .allowExcessArguments(false)
    .showHelpAfterError();

  for (const m of modules) {
    if (typeof m.register === 'function') m.register(program);
  }

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  if (err instanceof DrevError) {
    errorOut(`${err.code}: ${err.message}`);
  } else if (err instanceof Error) {
    errorOut(`unexpected error: ${err.message}`);
    if (err.cause instanceof Error && err.cause.stack) {
      process.stderr.write(`${err.cause.stack}\n`);
    } else if (err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
  } else {
    errorOut(`unexpected error: ${String(err)}`);
  }
  process.exit(1);
});
