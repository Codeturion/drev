import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, normalize } from 'node:path';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { ConfigError, RepoError, SessionError } from '../../lib/errors.js';
import { claudeProjectsDir } from '../../core/claude-paths.js';
import { readUserConfig, readRepoConfig } from '../../core/config.js';
import { currentUserEmail, shortUsername } from '../../core/identity.js';
import * as gitOps from '../../core/git-ops.js';
import { writeMeta, serializeMeta } from '../../core/metadata.js';
import type { SessionMeta, Redaction } from '../../core/metadata.js';
import { enqueue } from '../../core/outbox.js';
import {
  compileUserPattern,
  DEFAULT_PATTERNS,
  findSuspiciousTokens,
  redact,
} from '../../core/redaction.js';
import type { RedactionPattern } from '../../core/redaction.js';
import {
  dateAndNamePrefix,
  listMetaFiles,
  sanitizeName,
  sessionDir,
} from '../../core/repo.js';
import {
  findMostRecentSession,
  findSessionFiles,
  readSessionStats,
} from '../../core/session.js';
import type { SessionFiles, SessionStats } from '../../core/session.js';
import { confirm, errorOut, info, isInteractive, spinner, warn } from '../ui.js';

export interface ExecuteShareOptions {
  sessionId?: string;
  name?: string;
  visibility?: 'team' | 'private';
  purpose?: 'share' | 'backup';
  interactive?: boolean;
}

export interface ExecuteShareResult {
  id: string;
  name: string;
  shortId: string;
  redactionCounts: Record<string, number>;
  pushed: boolean;
}

export function register(program: Command): void {
  program
    .command('share [name]')
    .description('Share the most recent (or selected) Claude Code session to the team repo.')
    .option('--name <name>', 'name for the shared session (sanitized; alias of the positional)')
    .option('--private', 'mark this share as private (overrides repo default visibility)')
    .option('--session-id <id>', 'share a specific session id instead of the most recent')
    .option('--auto', 'skip all interactive prompts (force non-interactive mode)')
    .action(
      async (
        positionalName: string | undefined,
        opts: {
          name?: string;
          private?: boolean;
          sessionId?: string;
          auto?: boolean;
        },
      ) => {
        try {
          // Positional and --name are equivalent; positional wins if both differ.
          const resolvedName = positionalName ?? opts.name;
          await executeShare({
            ...(resolvedName !== undefined ? { name: resolvedName } : {}),
            ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
            ...(opts.private ? { visibility: 'private' as const } : {}),
            purpose: 'share',
            interactive: !opts.auto && isInteractive(),
          });
        } catch (err) {
          if (err instanceof Error) {
            errorOut(err.message);
          } else {
            errorOut(String(err));
          }
          process.exitCode = 1;
        }
      },
    );
}

export async function executeShare(
  opts: ExecuteShareOptions,
): Promise<ExecuteShareResult> {
  const interactive = opts.interactive ?? false;
  const purpose = opts.purpose ?? 'share';

  // 1. User config + default repo.
  const userCfg = await readUserConfig();
  if (userCfg.default_repo === null || userCfg.default_repo.trim() === '') {
    throw new ConfigError(
      'No default repo configured. Run `drev init <repo-url>` first.',
    );
  }
  const repoDir = userCfg.default_repo;
  const repoCfg = await readRepoConfig(repoDir);

  // 2. Resolve session.
  const files = await resolveSessionFiles(opts.sessionId);
  if (files === null) {
    throw new SessionError(
      'No Claude Code session found. Use Claude Code to record a session first.',
    );
  }

  // 3. Stats.
  const stats = await readSessionStats(files);

  // 4. Capture git state (best-effort).
  let commitSha: string | null = null;
  let branch: string | null = null;
  if (stats.cwd !== '') {
    const top = await gitOps.showTopLevel(stats.cwd).catch(() => null);
    if (top !== null) {
      commitSha = await gitOps.revParse(stats.cwd, 'HEAD').catch(() => null);
      branch = await gitOps
        .revParse(stats.cwd, '--abbrev-ref HEAD')
        .catch(() => null);
    }
  }

  const shortId = stats.id.replace(/-/g, '').slice(0, 8);

  // 5. Resolve name.
  let resolvedName: string | null = null;
  if (opts.name !== undefined && opts.name !== '') {
    resolvedName = sanitizeName(opts.name);
  } else if (interactive) {
    const suggestion = await firstUserPromptSuggestion(files.parent);
    const answer = await promptForName(suggestion);
    if (answer !== null && answer !== '') {
      try {
        resolvedName = sanitizeName(answer);
      } catch {
        resolvedName = null;
      }
    }
  }

  // 6. Read parent JSONL and redact.
  const rawJsonl = await readFile(files.parent, 'utf8');
  const allPatterns = buildPatternList(
    repoCfg.redaction_extensions,
    userCfg.ignore_patterns,
  );
  const { output: redactedJsonl, counts: parentCounts } = redact(
    rawJsonl,
    allPatterns,
  );

  // Redact subagent JSONLs alongside the parent. We accumulate counts so the
  // meta.yaml redaction summary reflects the total payload, not just the parent.
  const subagentRedactions: Array<{ basename: string; output: string }> = [];
  const totalCounts: Record<string, number> = { ...parentCounts };
  for (const sub of files.subagents) {
    const raw = await readFile(sub, 'utf8');
    const r = redact(raw, allPatterns);
    subagentRedactions.push({ basename: basename(sub), output: r.output });
    for (const [type, n] of Object.entries(r.counts)) {
      totalCounts[type] = (totalCounts[type] ?? 0) + n;
    }
  }

  // 6b. Entropy safety net (item 3): scan the redacted output for high-entropy
  // tokens the regex layer didn't catch. Warn-only; never blocks the share.
  // Pass parent + each subagent payload as separate inputs so the scanner
  // doesn't allocate a concatenated copy of the entire session.
  const suspicious = findSuspiciousTokens([
    redactedJsonl,
    ...subagentRedactions.map((s) => s.output),
  ]);
  if (suspicious.count > 0) {
    const sampleHint = suspicious.samples.length > 0
      ? ` Examples: ${suspicious.samples.join(', ')}.`
      : '';
    warn(
      `${suspicious.count} high-entropy token(s) remain after redaction; review before sharing if any are secrets.${sampleHint}`,
    );
  }

  // 7. First-share confirmation (§8.4) — must happen BEFORE any write.
  // Non-interactive callers (Claude's Bash tool, scripts, --auto) still see the
  // redaction summary as info but skip the prompt and proceed (T30).
  const email = await currentUserEmail();
  const username = shortUsername(email);
  if (await isFirstShare(repoDir, username)) {
    // Summary always; prompt only when interactive. Do not re-merge these.
    showRedactionSummary(repoDir, totalCounts);
    if (interactive) {
      const ok = await confirm('Continue?');
      if (!ok) {
        info('Share cancelled.');
        return {
          id: stats.id,
          name: resolvedName ?? shortId,
          shortId,
          redactionCounts: totalCounts,
          pushed: false,
        };
      }
    }
  }

  // 8. Build meta.yaml (using totals from steps 6 + subagent loop).
  const sharedAt = new Date();
  const visibility =
    opts.visibility ?? (purpose === 'backup' ? 'private' : repoCfg.default_visibility);
  const meta = buildMeta({
    stats,
    name: resolvedName,
    purpose,
    visibility,
    user: username,
    userEmail: email,
    branch,
    commitSha,
    sharedAt,
    counts: totalCounts,
    redactedSize: byteLengthOfAll(redactedJsonl, subagentRedactions),
  });

  // 9. Pull --rebase, then compute target dir + write payload.
  const sp = spinner('Syncing repo...');
  try {
    await gitOps.pullRebase(repoDir);
    sp.stop();
  } catch (err) {
    sp.fail('pull --rebase failed');
    throw err;
  }

  const dirName = dateAndNamePrefix(sharedAt, resolvedName, shortId);
  const targetDir = sessionDir(repoDir, username, dirName);
  await mkdir(targetDir, { recursive: true });

  // 10. Write redacted parent + meta.yaml.
  const sessionTarget = join(targetDir, 'session.jsonl');
  await writeFile(sessionTarget, redactedJsonl, 'utf8');
  const metaTarget = join(targetDir, 'meta.yaml');
  await writeMeta(metaTarget, meta);

  // Subagent JSONLs (CORRECTIONS §2): mirror under <target>/subagents/.
  if (subagentRedactions.length > 0) {
    const subDir = join(targetDir, 'subagents');
    await mkdir(subDir, { recursive: true });
    for (const sub of subagentRedactions) {
      await writeFile(join(subDir, sub.basename), sub.output, 'utf8');
    }
  }

  // 11. Add + commit + push.
  const commitMsg = `${purpose}: ${resolvedName ?? shortId}`;
  await gitOps.add(repoDir, [targetDir]);
  await gitOps.commit(repoDir, commitMsg);

  let pushed = true;
  try {
    await gitOps.push(repoDir);
  } catch (pushErr) {
    pushed = false;
    // 12. Push failure: enqueue parent payload for `drev sync` to drain later.
    try {
      await enqueue(stats.id, redactedJsonl, serializeMeta(meta));
    } catch (queueErr) {
      warn(
        `Push failed and outbox enqueue also failed: ${
          queueErr instanceof Error ? queueErr.message : String(queueErr)
        }`,
      );
    }
    const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
    warn(
      `Push failed (${pushMsg}). Session queued to outbox; run \`drev sync\` to retry.`,
    );
  }

  // 13. Summary.
  const totalRedactions = sumCounts(totalCounts);
  if (pushed) {
    info(
      `Shared ${resolvedName ?? shortId} (id: ${shortId}, ${stats.turns} turns, ${totalRedactions} redactions).`,
    );
  }

  // 14. Layer-3 nudge: if pushed and the project isn't on the auto-share
  // whitelist, hint the user about `drev autoshare add`. Only surfaced for the
  // public CLI flow (interactive=true); sweep callers (interactive=false) must
  // not log this — it would be noise in the sweep log.
  if (pushed && interactive && meta.project_root !== '') {
    if (!isUnderAnyWhitelisted(meta.project_root, userCfg.auto_share_projects)) {
      info(`This project (${meta.project_root}) is not on the auto-share list.`);
      info('   Run `drev autoshare add` to keep sharing future sessions automatically.');
    }
  }

  return {
    id: stats.id,
    name: resolvedName ?? shortId,
    shortId,
    redactionCounts: totalCounts,
    pushed,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveSessionFiles(
  sessionId: string | undefined,
): Promise<SessionFiles | null> {
  if (sessionId === undefined || sessionId === '') {
    return findMostRecentSession();
  }
  // The encoded-cwd directory layout collapses non-alphanumerics to '-' which is
  // not reversible. To find the project root for an explicit session id, scan
  // every project dir for `<sessionId>.jsonl` and recover the absolute cwd from
  // the JSONL's first event.
  const projectRoot = await findProjectRootForSessionId(sessionId);
  if (projectRoot === null) {
    throw new SessionError(`No session JSONL found for id ${sessionId}.`);
  }
  return findSessionFiles(projectRoot, sessionId);
}

async function findProjectRootForSessionId(
  sessionId: string,
): Promise<string | null> {
  const root = claudeProjectsDir();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const target = `${sessionId}.jsonl`;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, target);
    const cwd = await readFirstEventCwd(candidate);
    if (cwd !== null) return cwd;
  }
  return null;
}

async function readFirstEventCwd(jsonlPath: string): Promise<string | null> {
  // Stream the file line-by-line and bail on the first parsable object. Using a
  // stream avoids loading multi-MB JSONLs just to grab one field.
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
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const cwd = (parsed as Record<string, unknown>)['cwd'];
        if (typeof cwd === 'string' && cwd.length > 0) return cwd;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function firstUserPromptSuggestion(jsonlPath: string): Promise<string | null> {
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
      const event = parsed as Record<string, unknown>;
      if (event['type'] !== 'user') continue;
      const text = extractFirstUserText(event);
      if (text !== null) return text;
    }
    return null;
  } finally {
    rl.close();
    stream.destroy();
  }
}

function extractFirstUserText(event: Record<string, unknown>): string | null {
  const message = event['message'];
  if (message !== null && typeof message === 'object') {
    const content = (message as Record<string, unknown>)['content'];
    if (typeof content === 'string' && content.trim() !== '') return content.trim();
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block !== null && typeof block === 'object') {
          const t = (block as Record<string, unknown>)['type'];
          if (t === 'text') {
            const text = (block as Record<string, unknown>)['text'];
            if (typeof text === 'string' && text.trim() !== '') return text.trim();
          }
        }
      }
    }
  }
  return null;
}

async function promptForName(suggestion: string | null): Promise<string | null> {
  // Suggest a sanitized form derived from the first ~60 chars of the user prompt.
  // The user can accept (Enter), edit, or skip (empty + Enter when no suggestion).
  let suggested = '';
  if (suggestion !== null) {
    try {
      suggested = sanitizeName(suggestion.slice(0, 60));
    } catch {
      suggested = '';
    }
  }
  const promptText = suggested === ''
    ? 'Name (leave blank for short-id): '
    : `Name [${suggested}]: `;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(promptText, (a) => resolve(a));
    });
    const trimmed = answer.trim();
    if (trimmed === '') {
      return suggested === '' ? null : suggested;
    }
    return trimmed;
  } finally {
    rl.close();
  }
}

function buildPatternList(
  repoExts: string[],
  userPats: string[],
): RedactionPattern[] {
  const out: RedactionPattern[] = [...DEFAULT_PATTERNS];
  for (let i = 0; i < repoExts.length; i += 1) {
    const src = repoExts[i] ?? '';
    out.push(compileUserPattern(`repo_${i}`, src));
  }
  for (let i = 0; i < userPats.length; i += 1) {
    const src = userPats[i] ?? '';
    out.push(compileUserPattern(`user_${i}`, src));
  }
  return out;
}

async function isFirstShare(repoDir: string, username: string): Promise<boolean> {
  const all = await listMetaFiles(repoDir).catch(() => [] as string[]);
  // listMetaFiles returns absolute paths shaped as <repoDir>/users/<u>/<dir>/meta.yaml.
  // Match by the <u> path segment, not substring, to avoid false positives.
  const usersRoot = join(repoDir, 'users');
  for (const m of all) {
    const userDir = dirname(dirname(m));
    if (dirname(userDir) === usersRoot && basename(userDir) === username) {
      return false;
    }
  }
  return true;
}

function showRedactionSummary(
  repoDir: string,
  counts: Record<string, number>,
): void {
  info(`First share to ${repoDir}.`);
  info('Drev will redact common secrets before pushing. Found in this session:');
  const types = Object.keys(counts).sort();
  for (const type of types) {
    info(`  - ${counts[type] ?? 0} ${type}`);
  }
}

interface BuildMetaArgs {
  stats: SessionStats;
  name: string | null;
  purpose: 'share' | 'backup';
  visibility: 'team' | 'private';
  user: string;
  userEmail: string;
  branch: string | null;
  commitSha: string | null;
  sharedAt: Date;
  counts: Record<string, number>;
  redactedSize: number;
}

function buildMeta(a: BuildMetaArgs): SessionMeta {
  const redactions: Redaction[] = Object.keys(a.counts)
    .sort()
    .map((type) => ({ type, count: a.counts[type] ?? 0 }));

  const meta: SessionMeta = {
    schema_version: 1,
    id: a.stats.id,
    purpose: a.purpose,
    user: a.user,
    user_email: a.userEmail,
    project_root: a.stats.cwd,
    created_at: a.stats.createdAt !== '' ? a.stats.createdAt : a.sharedAt.toISOString(),
    shared_at: a.sharedAt.toISOString(),
    visibility: a.visibility,
    turns: a.stats.turns,
    size_bytes: a.redactedSize,
    redactions,
    parent_session: null,
  };

  if (a.name !== null) meta.name = a.name;
  if (a.stats.cwd !== '') {
    const projectName = basename(a.stats.cwd);
    if (projectName !== '') meta.project = projectName;
  }
  if (a.branch !== null) meta.branch = a.branch;
  if (a.commitSha !== null) meta.commit_sha = a.commitSha;
  if (a.stats.filesTouched.length > 0) meta.files_touched = a.stats.filesTouched;

  if (a.stats.cwd === '') {
    // SessionMeta requires project_root non-empty. If the JSONL had no cwd,
    // surface that as a hard error rather than ship a meta that fails validation.
    throw new RepoError(
      'Session JSONL did not record a cwd; cannot determine project_root.',
    );
  }

  return meta;
}

function byteLengthOfAll(
  parent: string,
  subs: Array<{ basename: string; output: string }>,
): number {
  let total = Buffer.byteLength(parent, 'utf8');
  for (const s of subs) total += Buffer.byteLength(s.output, 'utf8');
  return total;
}

function sumCounts(counts: Record<string, number>): number {
  let n = 0;
  for (const v of Object.values(counts)) n += v;
  return n;
}

function isUnderAnyWhitelisted(cwd: string, paths: string[]): boolean {
  if (paths.length === 0) return false;
  const target = normalizeForCompare(cwd);
  const sep = process.platform === 'win32' ? '\\' : '/';
  for (const entry of paths) {
    const normalized = normalizeForCompare(entry);
    if (target === normalized) return true;
    if (target.startsWith(normalized + sep)) return true;
  }
  return false;
}

function normalizeForCompare(p: string): string {
  const n = normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}
