import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { ConfigError, ValidationError } from '../../lib/errors.js';
import { readUserConfig } from '../../core/config.js';
import { resolve as resolveSession } from '../../core/name-resolver.js';
import { listMetaFiles, sanitizeName } from '../../core/repo.js';
import { renderHtml } from '../../core/transcript-renderer.js';
import { errorOut, info } from '../ui.js';

export interface ExportOptions {
  format?: string;
  out?: string;
}

export function register(program: Command): void {
  program
    .command('export <name-or-id>')
    .description('Export a shared session as a self-contained HTML transcript.')
    .option('--format <fmt>', 'output format (only "html" is supported)', 'html')
    .option('--out <path>', 'override output path (default: <repo>/transcripts/<name>.html)')
    .action(async (query: string, opts: ExportOptions) => {
      try {
        await runExport(query, opts);
      } catch (err) {
        if (err instanceof Error) errorOut(err.message);
        else errorOut(String(err));
        process.exitCode = 1;
      }
    });
}

export async function runExport(query: string, opts: ExportOptions): Promise<void> {
  const format = (opts.format ?? 'html').toLowerCase();
  if (format !== 'html') {
    throw new ValidationError(
      `Unsupported format '${opts.format}'; only 'html' is available.`,
    );
  }

  const cfg = await readUserConfig();
  if (!cfg.default_repo) {
    throw new ConfigError(
      "default_repo is not set in user config; run 'drev init <repo-url>' first.",
    );
  }
  const repoDir = cfg.default_repo;

  const metaFiles = await listMetaFiles(repoDir);
  const resolved = await resolveSession(query, metaFiles);

  const sessionDirOnDisk = dirname(resolved.metaPath);
  const jsonlPath = join(sessionDirOnDisk, 'session.jsonl');
  const jsonl = await readFile(jsonlPath, 'utf8');

  const html = renderHtml(jsonl, resolved.meta);

  const outPath = opts.out ?? defaultOutPath(repoDir, resolved.meta.name, resolved.meta.id);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html, 'utf8');

  info(`Wrote ${outPath}`);
}

function defaultOutPath(repoDir: string, name: string | undefined, id: string): string {
  const slug = name && name.length > 0 ? sanitizeName(name) : id.slice(0, 8);
  return join(repoDir, 'transcripts', `${slug}.html`);
}
