import { mkdir, readdir, unlink, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string, data?: Record<string, unknown>): Promise<void>;
  warn(message: string, data?: Record<string, unknown>): Promise<void>;
  error(message: string, data?: Record<string, unknown>): Promise<void>;
}

export interface CreateLoggerOptions {
  /** Override log directory. Defaults to `~/.drev/logs`. Used by tests. */
  dir?: string;
  /** Override clock. Defaults to `() => new Date()`. Used by tests. */
  now?: () => Date;
  /** Minimum level to record. Defaults to `'info'`. */
  level?: LogLevel;
  /** Days of history to retain. Defaults to 30. */
  retentionDays?: number;
}

const LEVEL_RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
const DEFAULT_RETENTION_DAYS = 30;

export function createLogger(baseName: string, options: CreateLoggerOptions = {}): Logger {
  const dir = options.dir ?? join(homedir(), '.drev', 'logs');
  const now = options.now ?? (() => new Date());
  const minRank = LEVEL_RANK[options.level ?? 'info'];
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;

  // Sequential init: ensure dir exists, then sweep stale logs. Both best-effort.
  const ready = (async () => {
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      // ignore — write attempts will surface a meaningful error if anything is truly wrong
    }
    await cleanupStale(dir, baseName, now(), retentionDays);
  })();

  // Serialize writes per-logger so concurrent calls produce well-formed JSON lines.
  let writeChain: Promise<void> = ready;

  const write = (level: LogLevel, message: string, data?: Record<string, unknown>): Promise<void> => {
    if (LEVEL_RANK[level] < minRank) return Promise.resolve();
    const timestamp = now().toISOString();
    const entry: Record<string, unknown> = { timestamp, level, scope: baseName, message };
    if (data !== undefined) entry['data'] = data;
    const line = JSON.stringify(entry) + '\n';
    const filePath = join(dir, fileNameFor(baseName, now()));

    const next = writeChain.then(async () => {
      try {
        await appendFile(filePath, line, 'utf8');
      } catch {
        // Logging is best-effort; never throw out of a logger call.
      }
    });
    writeChain = next;
    return next;
  };

  return {
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
  };
}

export function fileNameFor(baseName: string, when: Date): string {
  return `${baseName}-${formatDate(when)}.log`;
}

function formatDate(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const LOG_FILE_RE = /^(.+)-(\d{4})-(\d{2})-(\d{2})\.log$/;

async function cleanupStale(dir: string, baseName: string, now: Date, retentionDays: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  await Promise.all(
    entries.map(async (name) => {
      const match = name.match(LOG_FILE_RE);
      if (!match) return;
      const base = match[1];
      const yyyy = match[2];
      const mm = match[3];
      const dd = match[4];
      if (base !== baseName) return;
      if (yyyy === undefined || mm === undefined || dd === undefined) return;
      // Parse the date from the filename (UTC, start of day) to decide eligibility.
      const ts = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd));
      if (Number.isNaN(ts)) return;
      if (ts < cutoff) {
        try {
          await unlink(join(dir, name));
        } catch {
          // best-effort
        }
      }
    }),
  );
}
