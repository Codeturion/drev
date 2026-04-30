import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValidationError } from '../lib/errors.js';
import {
  migrateMeta,
  parseMeta,
  readMeta,
  serializeMeta,
  writeMeta,
  type SessionMeta,
} from './metadata.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (!d) continue;
    await rm(d, { recursive: true, force: true });
  }
});

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'drev-meta-'));
  tmpDirs.push(dir);
  return dir;
}

function canonicalSample(): SessionMeta {
  return {
    schema_version: 1,
    id: '7f3a2b1c-1234-5678-90ab-cdef01234567',
    name: 'auth-refactor',
    purpose: 'share',
    user: 'fuat',
    user_email: 'fuat@example.com',
    project: 'forever-town',
    project_root: '/Users/fuat/work/forever-town',
    branch: 'inventory-fix',
    commit_sha: 'a1b2c3d4e5f6',
    created_at: '2026-04-30T14:32:00Z',
    shared_at: '2026-04-30T18:15:00Z',
    title: 'Debugging inventory desync after merge animations',
    summary: 'Multi-line free-form text. Optional.\nAuto-generated or user-provided.\n',
    visibility: 'team',
    files_touched: [
      'Assets/Scripts/InventorySystem.cs',
      'Assets/Scripts/Merge/MergeHandler.cs',
    ],
    parent_session: null,
    turns: 47,
    size_bytes: 312584,
    redactions: [
      { type: 'anthropic_key', count: 0 },
      { type: 'openai_key', count: 0 },
      { type: 'aws_access_key', count: 0 },
    ],
  };
}

function minimalSample(): SessionMeta {
  return {
    schema_version: 1,
    id: '00000000-0000-0000-0000-000000000001',
    purpose: 'backup',
    user: 'alice',
    user_email: 'alice@example.com',
    project_root: '/home/alice/proj',
    created_at: '2026-01-02T03:04:05Z',
    shared_at: '2026-01-02T03:05:05Z',
    visibility: 'private',
    turns: 0,
    size_bytes: 0,
    redactions: [],
  };
}

describe('parseMeta', () => {
  it('parses a canonical YAML sample', () => {
    const yamlText = serializeMeta(canonicalSample());
    const meta = parseMeta(yamlText);
    expect(meta.id).toBe('7f3a2b1c-1234-5678-90ab-cdef01234567');
    expect(meta.purpose).toBe('share');
    expect(meta.visibility).toBe('team');
    expect(meta.redactions).toHaveLength(3);
  });

  it('parses a minimal valid sample', () => {
    const yamlText = serializeMeta(minimalSample());
    const meta = parseMeta(yamlText);
    expect(meta.user).toBe('alice');
    expect(meta.turns).toBe(0);
  });

  it('throws ValidationError on invalid YAML', () => {
    expect(() => parseMeta(':\n  - bad: [\n')).toThrow(ValidationError);
  });

  it('throws ValidationError when top-level is not a mapping', () => {
    expect(() => parseMeta('- a\n- b\n')).toThrow(ValidationError);
    expect(() => parseMeta('null\n')).toThrow(ValidationError);
    expect(() => parseMeta('"a string"\n')).toThrow(ValidationError);
  });

  it('throws "upgrade Drev" message on unsupported schema_version', () => {
    const yamlText = 'schema_version: 2\nid: x\n';
    expect(() => parseMeta(yamlText)).toThrow(/schema_version 2 not supported; upgrade Drev/);
  });

  it('throws on missing schema_version', () => {
    const yamlText = 'id: 7f3a2b1c-1234-5678-90ab-cdef01234567\n';
    expect(() => parseMeta(yamlText)).toThrow(/schema_version/);
  });

  it('preserves unknown extra fields for forward-compat', () => {
    const base = canonicalSample();
    const yamlText = serializeMeta(base) + 'future_field: hello\nfuture_obj:\n  nested: 1\n';
    const parsed = parseMeta(yamlText) as SessionMeta & {
      future_field?: string;
      future_obj?: { nested: number };
    };
    expect(parsed.future_field).toBe('hello');
    expect(parsed.future_obj).toEqual({ nested: 1 });
  });
});

describe('parseMeta required-field validation', () => {
  const required = [
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

  for (const field of required) {
    it(`throws when "${field}" is missing`, () => {
      const sample = minimalSample() as Record<string, unknown>;
      delete sample[field];
      const yamlText = `schema_version: 1\n${Object.entries(sample)
        .filter(([k]) => k !== 'schema_version')
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join('\n')}\n`;
      expect(() => parseMeta(yamlText)).toThrow(new RegExp(`"${field}"`));
    });
  }
});

describe('parseMeta type validation', () => {
  it('rejects malformed UUID', () => {
    const m = { ...minimalSample(), id: 'not-a-uuid' };
    expect(() => parseMeta(serializeFromObject(m))).toThrow(/"id"/);
  });

  it('rejects non-string id', () => {
    const yamlText = baseYaml({ id: 123 });
    expect(() => parseMeta(yamlText)).toThrow(/"id"/);
  });

  it('rejects invalid purpose', () => {
    const yamlText = baseYaml({ purpose: 'archive' });
    expect(() => parseMeta(yamlText)).toThrow(/"purpose"/);
  });

  it('rejects invalid visibility', () => {
    const yamlText = baseYaml({ visibility: 'public' });
    expect(() => parseMeta(yamlText)).toThrow(/"visibility"/);
  });

  it('rejects empty user', () => {
    const yamlText = baseYaml({ user: '' });
    expect(() => parseMeta(yamlText)).toThrow(/"user"/);
  });

  it('rejects empty user_email', () => {
    const yamlText = baseYaml({ user_email: '' });
    expect(() => parseMeta(yamlText)).toThrow(/"user_email"/);
  });

  it('rejects empty project_root', () => {
    const yamlText = baseYaml({ project_root: '' });
    expect(() => parseMeta(yamlText)).toThrow(/"project_root"/);
  });

  it('rejects non-ISO created_at', () => {
    const yamlText = baseYaml({ created_at: '2026/04/30' });
    expect(() => parseMeta(yamlText)).toThrow(/"created_at"/);
  });

  it('rejects non-ISO shared_at', () => {
    const yamlText = baseYaml({ shared_at: 'yesterday' });
    expect(() => parseMeta(yamlText)).toThrow(/"shared_at"/);
  });

  it('rejects ISO-shaped but invalid date', () => {
    const yamlText = baseYaml({ created_at: '2026-13-40T99:99:99Z' });
    expect(() => parseMeta(yamlText)).toThrow(/"created_at"/);
  });

  it('rejects non-integer turns', () => {
    const yamlText = baseYaml({ turns: 1.5 });
    expect(() => parseMeta(yamlText)).toThrow(/"turns"/);
  });

  it('rejects negative turns', () => {
    const yamlText = baseYaml({ turns: -1 });
    expect(() => parseMeta(yamlText)).toThrow(/"turns"/);
  });

  it('rejects non-integer size_bytes', () => {
    const yamlText = baseYaml({ size_bytes: 'big' });
    expect(() => parseMeta(yamlText)).toThrow(/"size_bytes"/);
  });

  it('rejects non-array redactions', () => {
    const yamlText = baseYaml({ redactions: 'none' });
    expect(() => parseMeta(yamlText)).toThrow(/"redactions"/);
  });

  it('rejects redaction with missing type', () => {
    const m = { ...minimalSample(), redactions: [{ count: 0 }] };
    expect(() => parseMeta(serializeFromObject(m))).toThrow(/redactions\[0\]\.type/);
  });

  it('rejects redaction entry that is not an object', () => {
    const m = { ...minimalSample(), redactions: ['x'] };
    expect(() => parseMeta(serializeFromObject(m))).toThrow(/redactions\[0\]/);
  });

  it('rejects redaction with negative count', () => {
    const m = { ...minimalSample(), redactions: [{ type: 't', count: -3 }] };
    expect(() => parseMeta(serializeFromObject(m))).toThrow(/redactions\[0\]\.count/);
  });

  it('rejects non-string optional name', () => {
    const yamlText = baseYaml({ name: 5 });
    expect(() => parseMeta(yamlText)).toThrow(/"name"/);
  });

  it('rejects non-string optional project', () => {
    const yamlText = baseYaml({ project: true });
    expect(() => parseMeta(yamlText)).toThrow(/"project"/);
  });

  it('rejects non-string optional branch', () => {
    const yamlText = baseYaml({ branch: 1 });
    expect(() => parseMeta(yamlText)).toThrow(/"branch"/);
  });

  it('rejects non-string optional commit_sha', () => {
    const yamlText = baseYaml({ commit_sha: 1 });
    expect(() => parseMeta(yamlText)).toThrow(/"commit_sha"/);
  });

  it('rejects non-string optional title', () => {
    const yamlText = baseYaml({ title: ['t'] });
    expect(() => parseMeta(yamlText)).toThrow(/"title"/);
  });

  it('rejects non-string optional summary', () => {
    const yamlText = baseYaml({ summary: 9 });
    expect(() => parseMeta(yamlText)).toThrow(/"summary"/);
  });

  it('rejects non-array files_touched', () => {
    const yamlText = baseYaml({ files_touched: 'a.cs' });
    expect(() => parseMeta(yamlText)).toThrow(/"files_touched"/);
  });

  it('rejects non-string item in files_touched', () => {
    const m = { ...minimalSample(), files_touched: ['ok.cs', 7] };
    expect(() => parseMeta(serializeFromObject(m))).toThrow(/files_touched\[1\]/);
  });

  it('accepts parent_session as null', () => {
    const m = { ...minimalSample(), parent_session: null };
    expect(() => parseMeta(serializeFromObject(m))).not.toThrow();
  });

  it('accepts parent_session as string', () => {
    const m = { ...minimalSample(), parent_session: 'abcd' };
    expect(() => parseMeta(serializeFromObject(m))).not.toThrow();
  });

  it('rejects invalid parent_session type', () => {
    const m = { ...minimalSample(), parent_session: 42 };
    expect(() => parseMeta(serializeFromObject(m))).toThrow(/parent_session/);
  });
});

describe('serializeMeta', () => {
  it('produces YAML that parses back to the same data (round-trip)', () => {
    const original = canonicalSample();
    const text = serializeMeta(original);
    const parsed = parseMeta(text);
    expect(parsed).toEqual(original);
  });

  it('round-trips a minimal sample', () => {
    const original = minimalSample();
    const text = serializeMeta(original);
    const parsed = parseMeta(text);
    expect(parsed).toEqual(original);
  });

  it('writes known keys in canonical order', () => {
    const text = serializeMeta(canonicalSample());
    const lines = text.split('\n');
    const keyLines = lines.filter((l) => /^[a-z_]+:/.test(l));
    const keys = keyLines.map((l) => l.split(':')[0]);
    const idx = (k: string) => keys.indexOf(k);
    expect(idx('schema_version')).toBeLessThan(idx('id'));
    expect(idx('id')).toBeLessThan(idx('purpose'));
    expect(idx('purpose')).toBeLessThan(idx('user'));
    expect(idx('visibility')).toBeLessThan(idx('turns'));
    expect(idx('turns')).toBeLessThan(idx('size_bytes'));
    expect(idx('size_bytes')).toBeLessThan(idx('redactions'));
  });

  it('preserves unknown fields after known fields on serialize', () => {
    const meta = { ...minimalSample(), zz_extra: 'x' } as SessionMeta;
    const text = serializeMeta(meta);
    expect(text).toMatch(/zz_extra: x/);
    const parsed = parseMeta(text) as SessionMeta & { zz_extra?: string };
    expect(parsed.zz_extra).toBe('x');
  });

  it('throws ValidationError when serializing invalid meta', () => {
    const broken = { ...minimalSample(), schema_version: 2 } as unknown as SessionMeta;
    expect(() => serializeMeta(broken)).toThrow(ValidationError);
  });
});

describe('migrateMeta', () => {
  it('returns a v1 object unchanged when valid', () => {
    const meta = migrateMeta(minimalSample());
    expect(meta.id).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('throws on non-object input', () => {
    expect(() => migrateMeta(null)).toThrow(ValidationError);
    expect(() => migrateMeta('a string')).toThrow(ValidationError);
    expect(() => migrateMeta(42)).toThrow(ValidationError);
    expect(() => migrateMeta([])).toThrow(ValidationError);
  });

  it('throws "upgrade Drev" on unknown schema_version', () => {
    expect(() => migrateMeta({ schema_version: 99 })).toThrow(
      /schema_version 99 not supported; upgrade Drev/,
    );
  });

  it('throws "upgrade Drev" on missing schema_version', () => {
    expect(() => migrateMeta({})).toThrow(/upgrade Drev/);
  });
});

describe('readMeta / writeMeta', () => {
  it('writes and reads a meta file round-trip', async () => {
    const dir = await makeTmpDir();
    const path = join(dir, 'meta.yaml');
    const original = canonicalSample();
    await writeMeta(path, original);
    const read = await readMeta(path);
    expect(read).toEqual(original);
  });

  it('writeMeta produces UTF-8 YAML on disk', async () => {
    const dir = await makeTmpDir();
    const path = join(dir, 'meta.yaml');
    await writeMeta(path, minimalSample());
    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).toMatch(/^schema_version: 1/);
  });

  it('readMeta throws ValidationError when file is malformed', async () => {
    const dir = await makeTmpDir();
    const path = join(dir, 'meta.yaml');
    await writeFile(path, 'schema_version: 2\n', 'utf8');
    await expect(readMeta(path)).rejects.toThrow(ValidationError);
  });

  it('writeMeta refuses to write invalid meta', async () => {
    const dir = await makeTmpDir();
    const path = join(dir, 'meta.yaml');
    const broken = { ...minimalSample(), id: 'nope' } as SessionMeta;
    await expect(writeMeta(path, broken)).rejects.toThrow(ValidationError);
  });
});

// ---------- helpers ----------

function baseYaml(overrides: Record<string, unknown>): string {
  const merged: Record<string, unknown> = { ...minimalSample(), ...overrides };
  return serializeFromObject(merged);
}

function serializeFromObject(obj: Record<string, unknown>): string {
  // Build YAML manually for invalid samples that serializeMeta would reject.
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    lines.push(`${k}: ${jsonish(v)}`);
  }
  return lines.join('\n') + '\n';
}

function jsonish(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return '\n' + v.map((item) => '  - ' + inlineJson(item)).join('\n');
  }
  if (typeof v === 'object') return inlineJson(v);
  return JSON.stringify(v);
}

function inlineJson(v: unknown): string {
  return JSON.stringify(v);
}
