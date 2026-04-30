import { readFile, writeFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { ValidationError } from '../lib/errors.js';

export interface Redaction {
  type: string;
  count: number;
}

export interface SessionMeta {
  schema_version: 1;
  id: string;
  name?: string;
  purpose: 'share' | 'backup';
  user: string;
  user_email: string;
  project?: string;
  project_root: string;
  branch?: string;
  commit_sha?: string;
  created_at: string;
  shared_at: string;
  title?: string;
  summary?: string;
  visibility: 'team' | 'private';
  files_touched?: string[];
  parent_session?: string | null;
  turns: number;
  size_bytes: number;
  redactions: Redaction[];
  [extra: string]: unknown;
}

const REQUIRED_FIELDS = [
  'schema_version',
  'id',
  'purpose',
  'user',
  'user_email',
  'project_root',
  'created_at',
  'shared_at',
  'visibility',
  'turns',
  'size_bytes',
  'redactions',
] as const;

const KNOWN_KEY_ORDER: readonly string[] = [
  'schema_version',
  'id',
  'name',
  'purpose',
  'user',
  'user_email',
  'project',
  'project_root',
  'branch',
  'commit_sha',
  'created_at',
  'shared_at',
  'title',
  'summary',
  'visibility',
  'files_touched',
  'parent_session',
  'turns',
  'size_bytes',
  'redactions',
];

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: string): boolean {
  if (!ISO_8601_RE.test(value)) return false;
  const ts = Date.parse(value);
  return Number.isFinite(ts);
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ValidationError(message);
}

function validate(input: Record<string, unknown>): SessionMeta {
  const sv = input['schema_version'];
  if (sv !== 1) {
    throw new ValidationError(
      `schema_version ${String(sv)} not supported; upgrade Drev`,
    );
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in input)) {
      throw new ValidationError(`meta.yaml: missing required field "${field}"`);
    }
  }

  const id = input['id'];
  ensure(typeof id === 'string', 'meta.yaml: "id" must be a string');
  ensure(UUID_RE.test(id), `meta.yaml: "id" is not a valid UUID: ${id}`);

  const purpose = input['purpose'];
  ensure(
    purpose === 'share' || purpose === 'backup',
    `meta.yaml: "purpose" must be "share" or "backup", got ${String(purpose)}`,
  );

  const user = input['user'];
  ensure(
    typeof user === 'string' && user.length > 0,
    'meta.yaml: "user" must be a non-empty string',
  );

  const userEmail = input['user_email'];
  ensure(
    typeof userEmail === 'string' && userEmail.length > 0,
    'meta.yaml: "user_email" must be a non-empty string',
  );

  const projectRoot = input['project_root'];
  ensure(
    typeof projectRoot === 'string' && projectRoot.length > 0,
    'meta.yaml: "project_root" must be a non-empty string',
  );

  const createdAt = input['created_at'];
  ensure(typeof createdAt === 'string', 'meta.yaml: "created_at" must be a string');
  ensure(isIsoDate(createdAt), `meta.yaml: "created_at" is not a valid ISO 8601 date: ${createdAt}`);

  const sharedAt = input['shared_at'];
  ensure(typeof sharedAt === 'string', 'meta.yaml: "shared_at" must be a string');
  ensure(isIsoDate(sharedAt), `meta.yaml: "shared_at" is not a valid ISO 8601 date: ${sharedAt}`);

  const visibility = input['visibility'];
  ensure(
    visibility === 'team' || visibility === 'private',
    `meta.yaml: "visibility" must be "team" or "private", got ${String(visibility)}`,
  );

  const turns = input['turns'];
  ensure(
    typeof turns === 'number' && Number.isInteger(turns) && turns >= 0,
    'meta.yaml: "turns" must be a non-negative integer',
  );

  const sizeBytes = input['size_bytes'];
  ensure(
    typeof sizeBytes === 'number' && Number.isInteger(sizeBytes) && sizeBytes >= 0,
    'meta.yaml: "size_bytes" must be a non-negative integer',
  );

  const redactions = input['redactions'];
  ensure(Array.isArray(redactions), 'meta.yaml: "redactions" must be an array');
  for (let i = 0; i < redactions.length; i++) {
    const r = redactions[i];
    ensure(isPlainObject(r), `meta.yaml: "redactions[${i}]" must be an object`);
    ensure(
      typeof r['type'] === 'string' && r['type'].length > 0,
      `meta.yaml: "redactions[${i}].type" must be a non-empty string`,
    );
    const count = r['count'];
    ensure(
      typeof count === 'number' && Number.isInteger(count) && count >= 0,
      `meta.yaml: "redactions[${i}].count" must be a non-negative integer`,
    );
  }

  if ('name' in input && input['name'] !== undefined) {
    ensure(typeof input['name'] === 'string', 'meta.yaml: "name" must be a string');
  }
  if ('project' in input && input['project'] !== undefined) {
    ensure(typeof input['project'] === 'string', 'meta.yaml: "project" must be a string');
  }
  if ('branch' in input && input['branch'] !== undefined) {
    ensure(typeof input['branch'] === 'string', 'meta.yaml: "branch" must be a string');
  }
  if ('commit_sha' in input && input['commit_sha'] !== undefined) {
    ensure(typeof input['commit_sha'] === 'string', 'meta.yaml: "commit_sha" must be a string');
  }
  if ('title' in input && input['title'] !== undefined) {
    ensure(typeof input['title'] === 'string', 'meta.yaml: "title" must be a string');
  }
  if ('summary' in input && input['summary'] !== undefined) {
    ensure(typeof input['summary'] === 'string', 'meta.yaml: "summary" must be a string');
  }
  if ('files_touched' in input && input['files_touched'] !== undefined) {
    const ft = input['files_touched'];
    ensure(Array.isArray(ft), 'meta.yaml: "files_touched" must be an array of strings');
    for (let i = 0; i < ft.length; i++) {
      ensure(
        typeof ft[i] === 'string',
        `meta.yaml: "files_touched[${i}]" must be a string`,
      );
    }
  }
  if ('parent_session' in input && input['parent_session'] !== undefined) {
    const ps = input['parent_session'];
    ensure(
      ps === null || typeof ps === 'string',
      'meta.yaml: "parent_session" must be a string or null',
    );
  }

  return input as unknown as SessionMeta;
}

export function migrateMeta(input: unknown): SessionMeta {
  if (!isPlainObject(input)) {
    throw new ValidationError('meta.yaml: top-level value must be a mapping');
  }
  const sv = input['schema_version'];
  if (sv === 1) {
    return validate(input);
  }
  throw new ValidationError(
    `schema_version ${String(sv)} not supported; upgrade Drev`,
  );
}

export function parseMeta(yamlText: string): SessionMeta {
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlText);
  } catch (cause) {
    throw new ValidationError('meta.yaml: invalid YAML', { cause });
  }
  return migrateMeta(parsed);
}

export function serializeMeta(meta: SessionMeta): string {
  validate(meta as unknown as Record<string, unknown>);
  const ordered: Record<string, unknown> = {};
  const source = meta as unknown as Record<string, unknown>;
  for (const key of KNOWN_KEY_ORDER) {
    if (key in source && source[key] !== undefined) {
      ordered[key] = source[key];
    }
  }
  for (const key of Object.keys(source)) {
    if (!(key in ordered) && source[key] !== undefined) {
      ordered[key] = source[key];
    }
  }
  return yaml.dump(ordered, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });
}

export async function readMeta(filePath: string): Promise<SessionMeta> {
  const text = await readFile(filePath, 'utf8');
  return parseMeta(text);
}

export async function writeMeta(filePath: string, meta: SessionMeta): Promise<void> {
  const text = serializeMeta(meta);
  await writeFile(filePath, text, 'utf8');
}
