import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RepoError } from '../lib/errors.js';
import { defaultRepoConfig, writeRepoConfig } from './config.js';

const SCHEMA_VERSION = '1';
const MAX_NAME_LENGTH = 64;

const README_TEMPLATE = `# Drev Sessions

This repository is managed by [Drev](https://github.com/Codeturion/drev).
It stores Claude Code sessions shared by team members under \`users/<username>/\`.

Use \`drev list\` to browse, \`drev resume <name>\` to continue a session.
`;

export async function ensureScaffold(
  repoDir: string,
  teamName: string,
): Promise<{ created: boolean }> {
  const drevDir = join(repoDir, '.drev');
  const schemaPath = join(drevDir, 'schema-version');
  const configPath = join(drevDir, 'config.yaml');
  const usersDir = join(repoDir, 'users');
  const usersKeep = join(usersDir, '.gitkeep');
  const readmePath = join(repoDir, 'README.md');

  const drevExists = await pathExists(drevDir);

  if (drevExists) {
    const existing = await readSchemaVersion(schemaPath);
    if (existing !== SCHEMA_VERSION) {
      throw new RepoError(
        `SCHEMA_VERSION_MISMATCH: .drev/schema-version is '${existing}' but Drev expects '${SCHEMA_VERSION}'.`,
      );
    }
    if (!(await pathExists(configPath))) {
      await writeRepoConfig(repoDir, defaultRepoConfig(teamName));
    }
    if (!(await pathExists(usersDir))) {
      await mkdir(usersDir, { recursive: true });
    }
    if (!(await pathExists(usersKeep))) {
      await writeFile(usersKeep, '', 'utf8');
    }
    if (!(await pathExists(readmePath))) {
      await writeFile(readmePath, README_TEMPLATE, 'utf8');
    }
    return { created: false };
  }

  try {
    await mkdir(drevDir, { recursive: true });
    await writeFile(schemaPath, `${SCHEMA_VERSION}\n`, 'utf8');
    await writeRepoConfig(repoDir, defaultRepoConfig(teamName));
    await mkdir(usersDir, { recursive: true });
    await writeFile(usersKeep, '', 'utf8');
    if (!(await pathExists(readmePath))) {
      await writeFile(readmePath, README_TEMPLATE, 'utf8');
    }
  } catch (cause) {
    if (cause instanceof RepoError) throw cause;
    throw new RepoError(`Failed to scaffold repo at ${repoDir}.`, { cause });
  }

  return { created: true };
}

export async function listMetaFiles(repoDir: string): Promise<string[]> {
  const usersDir = join(repoDir, 'users');
  if (!(await pathExists(usersDir))) return [];

  const results: string[] = [];
  let userEntries: string[];
  try {
    userEntries = await readdir(usersDir);
  } catch (cause) {
    throw new RepoError(`Failed to list users dir at ${usersDir}.`, { cause });
  }

  for (const userName of userEntries) {
    if (userName.startsWith('.')) continue;
    const userDir = join(usersDir, userName);
    if (!(await isDirectory(userDir))) continue;

    let sessionEntries: string[];
    try {
      sessionEntries = await readdir(userDir);
    } catch {
      continue;
    }

    for (const sessionName of sessionEntries) {
      if (sessionName.startsWith('.')) continue;
      const sessionDirPath = join(userDir, sessionName);
      if (!(await isDirectory(sessionDirPath))) continue;
      const metaPath = join(sessionDirPath, 'meta.yaml');
      if (await isFile(metaPath)) {
        results.push(metaPath);
      }
    }
  }

  results.sort();
  return results;
}

export function sessionDir(
  repoDir: string,
  username: string,
  dateAndName: string,
): string {
  return join(repoDir, 'users', username, dateAndName);
}

export function sanitizeName(input: string): string {
  const lower = input.toLowerCase();
  const whitespaceReplaced = lower.replace(/\s+/g, '-');
  const stripped = whitespaceReplaced.replace(/[^a-z0-9\-_]/g, '');
  const collapsed = stripped.replace(/-+/g, '-');
  const trimmed = collapsed.replace(/^-+/, '').replace(/-+$/, '');
  const truncated = trimmed.slice(0, MAX_NAME_LENGTH);
  const finalTrimmed = truncated.replace(/-+$/, '');
  if (finalTrimmed.length === 0) {
    throw new RepoError(`Name '${input}' sanitizes to empty string.`);
  }
  return finalTrimmed;
}

export function dateAndNamePrefix(
  date: Date,
  name: string | null,
  shortId: string,
): string {
  const datePart = formatDateUtc(date);
  if (name !== null) {
    const sanitized = sanitizeName(name);
    return `${datePart}-${sanitized}`;
  }
  const id = shortId.slice(0, 8);
  if (id.length === 0) {
    throw new RepoError('shortId must be non-empty when name is null.');
  }
  return `${datePart}-${id}`;
}

function formatDateUtc(date: Date): string {
  const yyyy = date.getUTCFullYear().toString().padStart(4, '0');
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = date.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw new RepoError(`Failed to stat ${p}.`, { cause: err });
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function readSchemaVersion(path: string): Promise<string> {
  try {
    const raw = await readFile(path, 'utf8');
    return raw.trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new RepoError(
        `SCHEMA_VERSION_MISMATCH: .drev/ exists but schema-version file is missing at ${path}.`,
      );
    }
    throw new RepoError(`Failed to read schema-version at ${path}.`, { cause: err });
  }
}
