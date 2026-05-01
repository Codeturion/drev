import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { claudeProjectsDir, drevHome } from '../../core/claude-paths.js';
import { readUserConfig } from '../../core/config.js';
import type { UserConfig } from '../../core/config.js';
import { currentUserEmail, shortUsername } from '../../core/identity.js';
import { parseMeta } from '../../core/metadata.js';
import * as gitOps from '../../core/git-ops.js';
import { listMetaFiles } from '../../core/repo.js';
import { createLogger } from '../../lib/logger.js';
import type { Logger } from '../../lib/logger.js';
import { executeShare } from './share.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  program
    .command('autoshare-sweep')
    .description(
      'Internal: scan Claude Code sessions and auto-share idle ones. Called by hooks.',
    )
    .action(async () => {
      // CRITICAL: this command runs from Claude Code hooks where any output to
      // stdout/stderr would surface in the user's terminal. Swallow everything.
      try {
        await runSweep();
      } catch {
        // Errors already logged inside runSweep. Anything escaping this far is
        // a logger failure or similar; still must not write to streams.
      }
    });
}

export interface SweepOptions {
  /** Override the pull --rebase timeout (ms). Defaults to 10s per §10. */
  pullTimeoutMs?: number;
  /** Inject an executeShare implementation for tests. */
  executeShare?: typeof executeShare;
  /** Inject a logger for tests. Defaults to the real autoshare-sweep logger. */
  logger?: Logger;
  /** Override "now" for idle-threshold tests. Defaults to () => new Date(). */
  now?: () => Date;
}

const PULL_TIMEOUT_MS = 10_000;
const LOCK_FILE = '.sweep.lock';
const FAILURE_COUNTER_FILE = 'sweep-failures';

/**
 * Run a single sweep. Never throws — all errors are logged and the failure
 * counter is incremented. Exposed for direct invocation by tests; the CLI
 * action handler always wraps this in another try/catch as belt-and-braces.
 */
export async function runSweep(opts: SweepOptions = {}): Promise<void> {
  const home = drevHome();
  const logger = opts.logger ?? createLogger('autoshare-sweep');
  const lockPath = join(home, LOCK_FILE);
  const share = opts.executeShare ?? executeShare;
  const now = opts.now ?? (() => new Date());

  // Step 1: acquire the lock. EEXIST means another sweep is in flight; exit
  // silently with no failure-counter touch (this is not a failure case).
  let lockAcquired = false;
  try {
    await mkdir(home, { recursive: true });
    const handle = await open(lockPath, 'wx');
    await handle.close();
    lockAcquired = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // Another sweep holds the lock — exit silently.
      return;
    }
    // Could not even create the lock (permissions, ENOSPC). Log and bail.
    await safeLog(logger, 'error', 'failed to acquire sweep lock', {
      error: errMessage(err),
    });
    await incrementFailureCounter(home).catch(() => {
      /* ignore */
    });
    return;
  }

  try {
    await sweepBody(home, logger, share, now, opts.pullTimeoutMs ?? PULL_TIMEOUT_MS);
    // Reset failure counter on a clean run.
    await resetFailureCounter(home).catch(() => {
      /* ignore */
    });
  } catch (err) {
    // Anything that escapes sweepBody is an uncaught bug; counter++ and log.
    await safeLog(logger, 'error', 'sweep aborted with uncaught error', {
      error: errMessage(err),
    });
    await incrementFailureCounter(home).catch(() => {
      /* ignore */
    });
  } finally {
    if (lockAcquired) {
      // Release the lock. unlink failures here are not actionable — log and move on.
      try {
        await unlink(lockPath);
      } catch (err) {
        await safeLog(logger, 'warn', 'failed to release sweep lock', {
          error: errMessage(err),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Body: steps 2-7 from §10
// ---------------------------------------------------------------------------

async function sweepBody(
  home: string,
  logger: Logger,
  share: typeof executeShare,
  now: () => Date,
  pullTimeoutMs: number,
): Promise<void> {
  // Step 2 + 3: read user config, short-circuit on manual mode.
  let userCfg: UserConfig;
  try {
    userCfg = await readUserConfig();
  } catch (err) {
    await safeLog(logger, 'error', 'failed to read user config', {
      error: errMessage(err),
    });
    throw err;
  }

  if (userCfg.auto_share === 'manual') {
    await safeLog(logger, 'info', 'auto_share=manual; sweep is a no-op');
    return;
  }

  if (userCfg.default_repo === null || userCfg.default_repo.trim() === '') {
    await safeLog(logger, 'warn', 'no default_repo configured; nothing to sweep');
    return;
  }

  const repoDir = userCfg.default_repo;
  const visibility: 'team' | 'private' =
    userCfg.auto_share === 'auto-private' ? 'private' : 'team';
  const idleThresholdSec = Number.isFinite(userCfg.auto_share_idle_threshold_seconds)
    ? userCfg.auto_share_idle_threshold_seconds
    : 60;

  // Step 4: pull --rebase with a 10s budget. On timeout/failure, proceed with
  // local state — losing freshness is acceptable, blocking the sweep is not.
  try {
    await gitOps.pullRebase(repoDir, pullTimeoutMs);
  } catch (err) {
    await safeLog(logger, 'warn', 'pull --rebase failed; proceeding with local state', {
      error: errMessage(err),
    });
  }

  // Step 5: collect already-shared session IDs from users/<self>/*/meta.yaml.
  let alreadyShared: Set<string>;
  try {
    alreadyShared = await collectSharedIds(repoDir);
  } catch (err) {
    await safeLog(logger, 'warn', 'failed to enumerate shared meta files', {
      error: errMessage(err),
    });
    alreadyShared = new Set();
  }

  // Step 6: walk JSONLs and process each. Per-file errors must not abort.
  const summary: SweepSummary = {
    scanned: 0,
    skippedIdle: 0,
    skippedShared: 0,
    skippedDisabled: 0,
    skippedNoCwd: 0,
    shared: 0,
    failed: 0,
  };

  const projectsRoot = claudeProjectsDir();
  let projectDirs: string[];
  try {
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      await safeLog(logger, 'info', 'no ~/.claude/projects directory; nothing to sweep');
      return;
    }
    await safeLog(logger, 'error', 'failed to read claude projects dir', {
      error: errMessage(err),
    });
    throw err;
  }

  const nowMs = now().getTime();
  const idleThresholdMs = idleThresholdSec * 1000;

  for (const projectName of projectDirs) {
    const projectDir = join(projectsRoot, projectName);
    let entries;
    try {
      entries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.jsonl')) continue;
      const jsonlPath = join(projectDir, entry.name);
      summary.scanned += 1;

      try {
        await processOne({
          jsonlPath,
          nowMs,
          idleThresholdMs,
          alreadyShared,
          share,
          visibility,
          logger,
          summary,
        });
      } catch (err) {
        summary.failed += 1;
        await safeLog(logger, 'error', 'unexpected error processing session', {
          path: jsonlPath,
          error: errMessage(err),
        });
      }
    }
  }

  // Step 7: log results. Per-event logs already happened; this is the rollup.
  await safeLog(logger, 'info', 'sweep complete', { summary });
}

// ---------------------------------------------------------------------------
// Per-session processing (step 6 inner loop)
// ---------------------------------------------------------------------------

interface SweepSummary {
  scanned: number;
  skippedIdle: number;
  skippedShared: number;
  skippedDisabled: number;
  skippedNoCwd: number;
  shared: number;
  failed: number;
}

interface ProcessArgs {
  jsonlPath: string;
  nowMs: number;
  idleThresholdMs: number;
  alreadyShared: Set<string>;
  share: typeof executeShare;
  visibility: 'team' | 'private';
  logger: Logger;
  summary: SweepSummary;
}

async function processOne(a: ProcessArgs): Promise<void> {
  // 6a: skip if mtime within idle threshold.
  let stats;
  try {
    stats = await stat(a.jsonlPath);
  } catch {
    return;
  }
  if (a.nowMs - stats.mtimeMs < a.idleThresholdMs) {
    a.summary.skippedIdle += 1;
    return;
  }

  // 6b: skip if session ID already shared.
  const sessionId = sessionIdFromPath(a.jsonlPath);
  if (sessionId === null) return;
  if (a.alreadyShared.has(sessionId)) {
    a.summary.skippedShared += 1;
    return;
  }

  // 6c: determine project root from JSONL events. The encoded-cwd directory
  // name is lossy (every non-alphanumeric collapsed to '-'), so reverse-mapping
  // the directory name is impossible. The JSONL itself records the absolute
  // cwd in every event — read the first parseable one.
  const projectRoot = await readFirstEventCwd(a.jsonlPath);
  if (projectRoot === null) {
    a.summary.skippedNoCwd += 1;
    await safeLog(a.logger, 'warn', 'session JSONL had no cwd; skipping', {
      path: a.jsonlPath,
    });
    return;
  }

  // .drev-disable opt-out flag at the project root.
  const disablePath = join(projectRoot, '.drev-disable');
  try {
    await stat(disablePath);
    a.summary.skippedDisabled += 1;
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      // Treat any other stat error as "don't share, but log it" — failing
      // closed is safer than auto-sharing a session whose disable flag we
      // could not read.
      a.summary.skippedDisabled += 1;
      await safeLog(a.logger, 'warn', 'could not stat .drev-disable; skipping session', {
        path: disablePath,
        error: errMessage(err),
      });
      return;
    }
    // ENOENT/ENOTDIR — no disable flag; fall through to share.
  }

  // 6d: share. Errors here are per-session; bump summary.failed and continue.
  try {
    await a.share({
      sessionId,
      visibility: a.visibility,
      purpose: 'share',
      interactive: false,
    });
    a.summary.shared += 1;
    await safeLog(a.logger, 'info', 'auto-shared session', {
      sessionId,
      visibility: a.visibility,
    });
  } catch (err) {
    a.summary.failed += 1;
    await safeLog(a.logger, 'error', 'failed to share session', {
      sessionId,
      error: errMessage(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionIdFromPath(jsonlPath: string): string | null {
  // Path looks like ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
  // Strip directory parts via a regex on path separators (works on both
  // POSIX and Windows since `path.join` may produce either separator).
  const match = /([^\\\/]+?)\.jsonl$/.exec(jsonlPath);
  if (match === null) return null;
  const id = match[1];
  return id !== undefined && id !== '' ? id : null;
}

async function readFirstEventCwd(jsonlPath: string): Promise<string | null> {
  let stream;
  try {
    stream = createReadStream(jsonlPath, { encoding: 'utf8' });
  } catch {
    return null;
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const cwd = (parsed as Record<string, unknown>)['cwd'];
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    }
    return null;
  } catch {
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function collectSharedIds(repoDir: string): Promise<Set<string>> {
  const all = await listMetaFiles(repoDir);

  // Filter to users/<self>/* per §10 step 5. Identity lookup may fail (no git
  // user.email); in that case fall back to the empty set so every session
  // looks unshared (which is safer than treating someone else's IDs as ours).
  let self: string;
  try {
    const email = await currentUserEmail();
    self = shortUsername(email);
  } catch {
    return new Set();
  }

  const ids = new Set<string>();
  const sep = process.platform === 'win32' ? '\\' : '/';
  const usersPrefix = join(repoDir, 'users', self) + sep;
  for (const metaPath of all) {
    if (!metaPath.startsWith(usersPrefix)) continue;
    try {
      const raw = await readFile(metaPath, 'utf8');
      const meta = parseMeta(raw);
      if (typeof meta.id === 'string' && meta.id !== '') ids.add(meta.id);
    } catch {
      // Bad meta — ignore, do not block the sweep.
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Failure counter (§10 escalation)
// ---------------------------------------------------------------------------

function failureCounterPath(home: string): string {
  return join(home, 'logs', FAILURE_COUNTER_FILE);
}

async function readFailureCounter(home: string): Promise<number> {
  try {
    const raw = await readFile(failureCounterPath(home), 'utf8');
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function writeFailureCounter(home: string, n: number): Promise<void> {
  const path = failureCounterPath(home);
  await mkdir(join(home, 'logs'), { recursive: true });
  await writeFile(path, `${n}\n`, 'utf8');
}

async function incrementFailureCounter(home: string): Promise<void> {
  const current = await readFailureCounter(home);
  await writeFailureCounter(home, current + 1);
}

async function resetFailureCounter(home: string): Promise<void> {
  await writeFailureCounter(home, 0);
}

// ---------------------------------------------------------------------------
// Logging glue
// ---------------------------------------------------------------------------

async function safeLog(
  logger: Logger,
  level: 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await logger[level](message, data);
  } catch {
    // Logger failures must never bubble; this is the last line of defence
    // for the silent-operation guarantee.
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
