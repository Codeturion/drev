// T26 — End-to-end share→repo→resume integration test.
//
// This test composes core/ modules directly (no cli/* imports, no claude
// subprocess) to exercise the producer→repo→consumer flow on a single machine
// using a temp bare git repo as the remote and two simulated users isolated
// via HOME / USERPROFILE / GIT_CONFIG_GLOBAL overrides.
//
// References: TASKS/T26-integration-test.md, ARCHITECTURE.md §13.2 / §16,
// docs/CORRECTIONS.md §1 (no separator normalization) and §2 (subagent JSONLs).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  claudeProjectsDir,
  encodedCwd,
  sessionPath,
  subagentDir,
} from '../../src/core/claude-paths.js';
import { writeUserConfig, defaultUserConfig } from '../../src/core/config.js';
import { currentUserEmail, shortUsername } from '../../src/core/identity.js';
import * as gitOps from '../../src/core/git-ops.js';
import type { SessionMeta } from '../../src/core/metadata.js';
import { readMeta, writeMeta } from '../../src/core/metadata.js';
import { resolve as resolveSession } from '../../src/core/name-resolver.js';
import { rewritePaths } from '../../src/core/path-rewriter.js';
import { DEFAULT_PATTERNS, redact } from '../../src/core/redaction.js';
import {
  dateAndNamePrefix,
  ensureScaffold,
  listMetaFiles,
  sessionDir as repoSessionDir,
} from '../../src/core/repo.js';
import { findSessionFiles, readSessionStats } from '../../src/core/session.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Test infra: per-user environment isolation.
// ---------------------------------------------------------------------------

interface UserEnv {
  home: string;            // overrides HOME / USERPROFILE → drevHome() + claudeProjectsDir()
  gitConfig: string;       // overrides GIT_CONFIG_GLOBAL → identity.currentUserEmail()
  email: string;
  name: string;
  username: string;        // shortUsername(email)
  repoClone: string;       // local clone of the bare remote
  projectRoot: string;     // simulated working directory for sessions
}

interface SavedEnv {
  HOME: string | undefined;
  USERPROFILE: string | undefined;
  GIT_CONFIG_GLOBAL: string | undefined;
}

function snapshotEnv(): SavedEnv {
  return {
    HOME: process.env['HOME'],
    USERPROFILE: process.env['USERPROFILE'],
    GIT_CONFIG_GLOBAL: process.env['GIT_CONFIG_GLOBAL'],
  };
}

function restoreEnv(saved: SavedEnv): void {
  if (saved.HOME === undefined) delete process.env['HOME'];
  else process.env['HOME'] = saved.HOME;
  if (saved.USERPROFILE === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = saved.USERPROFILE;
  if (saved.GIT_CONFIG_GLOBAL === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
  else process.env['GIT_CONFIG_GLOBAL'] = saved.GIT_CONFIG_GLOBAL;
}

function applyUser(u: UserEnv): void {
  process.env['HOME'] = u.home;
  process.env['USERPROFILE'] = u.home;
  process.env['GIT_CONFIG_GLOBAL'] = u.gitConfig;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout.toString().trim();
}

async function rmRetry(dir: string): Promise<void> {
  // Windows holds locks on freshly-closed git index files; retry a few times.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
  await rm(dir, { recursive: true, force: true });
}

async function buildUserEnv(
  root: string,
  slug: string,
  email: string,
  fullName: string,
): Promise<UserEnv> {
  const home = join(root, `${slug}-home`);
  await mkdir(home, { recursive: true });
  const gitConfig = join(home, '.gitconfig');
  // Disable signing/autocrlf so commits succeed in any environment.
  await writeFile(
    gitConfig,
    `[user]\n\temail = ${email}\n\tname = ${fullName}\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n`,
    'utf8',
  );
  const projectRoot = join(root, `${slug}-work`);
  await mkdir(projectRoot, { recursive: true });
  return {
    home,
    gitConfig,
    email,
    name: fullName,
    username: shortUsername(email),
    repoClone: join(root, `${slug}-clone`),
    projectRoot,
  };
}

// Plant a JSONL session under the given user's HOME at the encoded-cwd path
// Claude Code uses, including a tool_use block + a planted GitHub PAT for
// redaction coverage. Returns { sessionId, parentPath, subagentPath, ghPat }.
async function plantSession(
  user: UserEnv,
  sessionId: string,
  cwdInJsonl: string,
): Promise<{
  sessionId: string;
  parentPath: string;
  subagentPath: string;
  ghPat: string;
  filePathInJsonl: string;
}> {
  const projectsDir = join(user.home, '.claude', 'projects', encodedCwd(cwdInJsonl));
  await mkdir(projectsDir, { recursive: true });
  const parentPath = join(projectsDir, `${sessionId}.jsonl`);
  // 36-char body for ghp_ → matches DEFAULT_PATTERNS.github_pat exactly.
  const ghPat = `ghp_${'a'.repeat(36)}`;
  const filePathInJsonl = join(cwdInJsonl, 'src', 'index.ts');

  const lines: unknown[] = [
    {
      type: 'user',
      cwd: cwdInJsonl,
      timestamp: '2026-04-30T14:32:00Z',
      message: { role: 'user', content: 'Initial prompt' },
    },
    {
      type: 'assistant',
      cwd: cwdInJsonl,
      timestamp: '2026-04-30T14:32:05Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `Reading file at ${filePathInJsonl}` },
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'Read',
            input: { file_path: filePathInJsonl },
          },
        ],
      },
    },
    {
      type: 'user',
      cwd: cwdInJsonl,
      timestamp: '2026-04-30T14:32:10Z',
      message: {
        role: 'user',
        // Embed the planted PAT inside an otherwise-normal tool result so the
        // redactor must scan tool output, not just assistant text.
        content: `Tool result included token ${ghPat} (do not commit).`,
      },
    },
  ];
  const jsonl = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  await writeFile(parentPath, jsonl, 'utf8');

  // Subagent JSONL alongside the parent (CORRECTIONS §2).
  const subagentDirOnDisk = join(projectsDir, sessionId, 'subagents');
  await mkdir(subagentDirOnDisk, { recursive: true });
  const subagentPath = join(subagentDirOnDisk, 'agent-foo.jsonl');
  const subLines = [
    {
      type: 'user',
      cwd: cwdInJsonl,
      timestamp: '2026-04-30T14:32:20Z',
      message: { role: 'user', content: `Look at ${filePathInJsonl}` },
    },
    {
      type: 'assistant',
      cwd: cwdInJsonl,
      timestamp: '2026-04-30T14:32:25Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Inspecting ${filePathInJsonl}` }],
      },
    },
  ];
  const subJsonl = subLines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  await writeFile(subagentPath, subJsonl, 'utf8');

  return { sessionId, parentPath, subagentPath, ghPat, filePathInJsonl };
}

// ---------------------------------------------------------------------------
// Test fixture roots — one shared remote, one tmp root for both users.
// ---------------------------------------------------------------------------

const savedEnv = snapshotEnv();
let root: string;
let remoteUrl: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'drev-it-'));
  const remote = join(root, 'remote.git');
  await mkdir(remote, { recursive: true });
  // Bare repo with a default branch so the first push lands on `main`.
  await execFileAsync('git', ['init', '--bare', '-b', 'main', remote], {
    windowsHide: true,
  });
  remoteUrl = 'file://' + remote.replace(/\\/g, '/');
});

afterAll(async () => {
  restoreEnv(savedEnv);
  if (root) await rmRetry(root);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('share-resume integration (T26)', () => {
  it('happy path: User A shares, User B lists/resolves, file lands at correct encoded-cwd with paths rewritten', async () => {
    const userA = await buildUserEnv(root, 'happy-a', 'alice@example.com', 'Alice');
    const userB = await buildUserEnv(root, 'happy-b', 'bob@example.com', 'Bob');

    // ----- User A: clone, scaffold, push -----
    applyUser(userA);
    try {
      await gitOps.clone(remoteUrl, userA.repoClone);
      // Configure the clone with this user's identity (bare clone inherits no user.*)
      // — needed for commit to succeed even though GIT_CONFIG_GLOBAL is set.
      await execFileAsync('git', ['config', 'user.email', userA.email], {
        cwd: userA.repoClone,
        windowsHide: true,
      });
      await execFileAsync('git', ['config', 'user.name', userA.name], {
        cwd: userA.repoClone,
        windowsHide: true,
      });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], {
        cwd: userA.repoClone,
        windowsHide: true,
      });

      const scaffoldA = await ensureScaffold(userA.repoClone, 'integration-team');
      expect(scaffoldA.created).toBe(true);
      await gitOps.add(userA.repoClone, ['.drev', 'users', 'README.md']);
      await gitOps.commit(userA.repoClone, 'init: scaffold');
      await gitOps.push(userA.repoClone);

      // Persist user A's default_repo via core/config (tests writeUserConfig
      // observes HOME via drevHome()).
      const cfgA = defaultUserConfig();
      cfgA.default_repo = userA.repoClone;
      await writeUserConfig(cfgA);

      // identity.currentUserEmail() → reads git config --global, must match.
      expect(await currentUserEmail()).toBe(userA.email);

      // ----- User A: plant a fixture session -----
      const sessionId = '7f3a2b1c-1234-5678-90ab-cdef01234567';
      const planted = await plantSession(userA, sessionId, userA.projectRoot);

      // ----- User A: share via core/ composition -----
      const files = await findSessionFiles(userA.projectRoot, sessionId);
      expect(files.parent).toBe(planted.parentPath);
      expect(files.subagents).toEqual([planted.subagentPath]);

      const stats = await readSessionStats(files);
      expect(stats.id).toBe(sessionId);
      expect(stats.cwd).toBe(userA.projectRoot);
      expect(stats.turns).toBe(3);
      expect(stats.toolCalls).toBe(1);
      expect(stats.filesTouched).toContain(planted.filePathInJsonl);

      const parentRaw = await readFile(files.parent, 'utf8');
      const parentRedacted = redact(parentRaw, DEFAULT_PATTERNS);
      expect(parentRedacted.counts['github_pat']).toBe(1);
      expect(parentRedacted.output).not.toContain(planted.ghPat);
      expect(parentRedacted.output).toContain('<REDACTED:github_pat>');

      // Subagent JSONL is also redacted (no PAT in our subagent fixture, but
      // the share pass runs redact on it regardless — we just exercise the call).
      const subRaw = await readFile(files.subagents[0]!, 'utf8');
      const subRedacted = redact(subRaw, DEFAULT_PATTERNS);
      expect(subRedacted.counts['github_pat']).toBe(0);

      const sharedAt = new Date('2026-04-30T18:15:00Z');
      const dirName = dateAndNamePrefix(sharedAt, 'test-session', sessionId.replace(/-/g, ''));
      const targetDir = repoSessionDir(userA.repoClone, userA.username, dirName);
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(targetDir, 'session.jsonl'), parentRedacted.output, 'utf8');

      const meta: SessionMeta = {
        schema_version: 1,
        id: sessionId,
        name: 'test-session',
        purpose: 'share',
        user: userA.username,
        user_email: userA.email,
        project: 'happy-a-work',
        project_root: userA.projectRoot,
        created_at: stats.createdAt,
        shared_at: sharedAt.toISOString(),
        visibility: 'team',
        turns: stats.turns,
        size_bytes: Buffer.byteLength(parentRedacted.output, 'utf8') +
          Buffer.byteLength(subRedacted.output, 'utf8'),
        redactions: Object.entries(parentRedacted.counts).map(([type, count]) => ({
          type,
          count,
        })),
        files_touched: stats.filesTouched,
        parent_session: null,
      };
      await writeMeta(join(targetDir, 'meta.yaml'), meta);

      // Mirror subagent under <targetDir>/subagents/ (CORRECTIONS §2).
      const subOutDir = join(targetDir, 'subagents');
      await mkdir(subOutDir, { recursive: true });
      await writeFile(join(subOutDir, 'agent-foo.jsonl'), subRedacted.output, 'utf8');

      await gitOps.add(userA.repoClone, [join('users', userA.username)]);
      await gitOps.commit(userA.repoClone, `share: test-session`);
      await gitOps.push(userA.repoClone);
    } finally {
      restoreEnv(savedEnv);
    }

    // ----- User B: clone the same remote, scaffold-check, set default_repo -----
    applyUser(userB);
    try {
      await gitOps.clone(remoteUrl, userB.repoClone);
      await execFileAsync('git', ['config', 'user.email', userB.email], {
        cwd: userB.repoClone,
        windowsHide: true,
      });
      await execFileAsync('git', ['config', 'user.name', userB.name], {
        cwd: userB.repoClone,
        windowsHide: true,
      });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], {
        cwd: userB.repoClone,
        windowsHide: true,
      });

      const scaffoldB = await ensureScaffold(userB.repoClone, 'integration-team');
      expect(scaffoldB.created).toBe(false); // remote already had .drev/ from User A

      const cfgB = defaultUserConfig();
      cfgB.default_repo = userB.repoClone;
      await writeUserConfig(cfgB);

      expect(await currentUserEmail()).toBe(userB.email);

      // List: walks users/*/*/meta.yaml — exactly one match expected.
      const metaFiles = await listMetaFiles(userB.repoClone);
      expect(metaFiles.length).toBe(1);
      const onlyMeta = await readMeta(metaFiles[0]!);
      expect(onlyMeta.id).toBe('7f3a2b1c-1234-5678-90ab-cdef01234567');
      expect(onlyMeta.name).toBe('test-session');
      expect(onlyMeta.user).toBe(userA.username);
      expect(onlyMeta.project_root).toBe(userA.projectRoot);

      // Resolve by name.
      const resolved = await resolveSession('test-session', metaFiles);
      expect(resolved.meta.id).toBe(onlyMeta.id);

      // Read repo session.jsonl + rewrite paths to user B's destRoot.
      const repoSessionPath = join(dirname(resolved.metaPath), 'session.jsonl');
      const repoSessionJsonl = await readFile(repoSessionPath, 'utf8');
      const userB_destRoot = userB.projectRoot;
      const rewritten = rewritePaths(
        repoSessionJsonl,
        resolved.meta.project_root,
        userB_destRoot,
      );
      expect(rewritten).not.toContain(userA.projectRoot);
      // The dest path must appear in JSON-escaped form (matches the rewriter's
      // line-level pass that targets escaped string literals).
      const escDest = JSON.stringify(userB_destRoot).slice(1, -1);
      expect(rewritten).toContain(escDest);
      // Redaction marker survives the rewrite.
      expect(rewritten).toContain('<REDACTED:github_pat>');

      // Place at user B's encoded-cwd path.
      const userB_targetDir = join(
        userB.home,
        '.claude',
        'projects',
        encodedCwd(userB_destRoot),
      );
      await mkdir(userB_targetDir, { recursive: true });
      const userB_targetParent = sessionPath(userB_destRoot, resolved.meta.id);
      // sessionPath uses claudeProjectsDir() under the current HOME — sanity check.
      expect(userB_targetParent.startsWith(userB.home)).toBe(true);
      await writeFile(userB_targetParent, rewritten, 'utf8');

      // Verify the placed file is valid JSONL line-by-line.
      const placedRaw = await readFile(userB_targetParent, 'utf8');
      const placedLines = placedRaw.split('\n').filter((l) => l.trim() !== '');
      expect(placedLines.length).toBe(3);
      for (const line of placedLines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      // Subagent flow: rewrite + place under <encodedCwd>/<id>/subagents/.
      const repoSubDir = join(dirname(resolved.metaPath), 'subagents');
      const subRepoEntries = (await readdir(repoSubDir)).filter((n) =>
        n.endsWith('.jsonl'),
      );
      expect(subRepoEntries).toContain('agent-foo.jsonl');
      const subRaw = await readFile(join(repoSubDir, 'agent-foo.jsonl'), 'utf8');
      const subRewritten = rewritePaths(
        subRaw,
        resolved.meta.project_root,
        userB_destRoot,
      );
      expect(subRewritten).not.toContain(userA.projectRoot);
      expect(subRewritten).toContain(escDest);

      const userB_subagentDir = subagentDir(userB_destRoot, resolved.meta.id);
      await mkdir(userB_subagentDir, { recursive: true });
      const userB_subagentTarget = join(userB_subagentDir, 'agent-foo.jsonl');
      await writeFile(userB_subagentTarget, subRewritten, 'utf8');

      // Confirm the subagent landed at the §2 corrections layout:
      //   <home>/.claude/projects/<encoded(destRoot)>/<id>/subagents/agent-foo.jsonl
      const expectedSubagentPath = join(
        userB.home,
        '.claude',
        'projects',
        encodedCwd(userB_destRoot),
        resolved.meta.id,
        'subagents',
        'agent-foo.jsonl',
      );
      expect(userB_subagentTarget).toBe(expectedSubagentPath);
      const placedSubRaw = await readFile(expectedSubagentPath, 'utf8');
      const placedSubLines = placedSubRaw.split('\n').filter((l) => l.trim() !== '');
      expect(placedSubLines.length).toBe(2);
      for (const line of placedSubLines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      // claudeProjectsDir() honours the HOME override (sanity).
      expect(claudeProjectsDir().startsWith(userB.home)).toBe(true);
    } finally {
      restoreEnv(savedEnv);
    }
  });

  it('concurrent share: two users push to the same repo without colliding under users/<u>/', async () => {
    const userC = await buildUserEnv(root, 'cc-c', 'carol@example.com', 'Carol');
    const userD = await buildUserEnv(root, 'cc-d', 'dave@example.com', 'Dave');

    // Sequential pull-then-push from each user (per ARCHITECTURE.md §3.3 the
    // per-user directory layout is the conflict-avoidance mechanism).
    async function shareAs(user: UserEnv, name: string, sessionId: string): Promise<void> {
      applyUser(user);
      try {
        await gitOps.clone(remoteUrl, user.repoClone);
        await execFileAsync('git', ['config', 'user.email', user.email], {
          cwd: user.repoClone, windowsHide: true,
        });
        await execFileAsync('git', ['config', 'user.name', user.name], {
          cwd: user.repoClone, windowsHide: true,
        });
        await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], {
          cwd: user.repoClone, windowsHide: true,
        });

        await ensureScaffold(user.repoClone, 'integration-team');

        const planted = await plantSession(user, sessionId, user.projectRoot);
        const files = await findSessionFiles(user.projectRoot, sessionId);
        const stats = await readSessionStats(files);
        const raw = await readFile(files.parent, 'utf8');
        const r = redact(raw, DEFAULT_PATTERNS);

        await gitOps.pullRebase(user.repoClone);

        const sharedAt = new Date();
        const dirName = dateAndNamePrefix(sharedAt, name, sessionId.replace(/-/g, ''));
        const targetDir = repoSessionDir(user.repoClone, user.username, dirName);
        await mkdir(targetDir, { recursive: true });
        await writeFile(join(targetDir, 'session.jsonl'), r.output, 'utf8');
        const meta: SessionMeta = {
          schema_version: 1,
          id: sessionId,
          name,
          purpose: 'share',
          user: user.username,
          user_email: user.email,
          project_root: user.projectRoot,
          created_at: stats.createdAt,
          shared_at: sharedAt.toISOString(),
          visibility: 'team',
          turns: stats.turns,
          size_bytes: Buffer.byteLength(r.output, 'utf8'),
          redactions: Object.entries(r.counts).map(([type, count]) => ({ type, count })),
          parent_session: null,
        };
        await writeMeta(join(targetDir, 'meta.yaml'), meta);
        await gitOps.add(user.repoClone, [join('users', user.username)]);
        await gitOps.commit(user.repoClone, `share: ${name}`);
        await gitOps.push(user.repoClone);
        // Reference planted to silence unused-binding warnings without weakening
        // the assertion surface; readSessionStats already validated the file shape.
        expect(planted.parentPath).toBeTruthy();
      } finally {
        restoreEnv(savedEnv);
      }
    }

    await shareAs(userC, 'session-carol', '11111111-2222-3333-4444-555555555555');
    await shareAs(userD, 'session-dave', '66666666-7777-8888-9999-aaaaaaaaaaaa');

    // Final verification from a fresh clone: both sessions present under their
    // respective users/<username>/ directories with no collision.
    const verifyDir = join(root, 'cc-verify-clone');
    await gitOps.clone(remoteUrl, verifyDir);
    const all = await listMetaFiles(verifyDir);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const names = await Promise.all(
      all.map(async (m) => {
        const meta = await readMeta(m);
        return { user: meta.user, name: meta.name };
      }),
    );
    const carol = names.find((n) => n.user === userC.username);
    const dave = names.find((n) => n.user === userD.username);
    expect(carol).toBeDefined();
    expect(dave).toBeDefined();
    expect(carol!.name).toBe('session-carol');
    expect(dave!.name).toBe('session-dave');
  });
});
