import { describe, it, expect } from 'vitest';
import { rewritePaths } from './path-rewriter.js';

// Reference implementation mirroring experiment/rewrite.mjs. Used by the
// reproducibility test. Plain split/join, no boundary check, JSON-escaped first.
function experimentRewrite(jsonl: string, src: string, dst: string): string {
  if (src === dst) return jsonl;
  const escSrc = JSON.stringify(src).slice(1, -1);
  const escDst = JSON.stringify(dst).slice(1, -1);
  return jsonl
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      return line.split(escSrc).join(escDst).split(src).join(dst);
    })
    .join('\n');
}

describe('rewritePaths — edge cases (§7.4)', () => {
  it('case 1: substring collision is boundary-aware (/Users/fu vs /Users/fuat)', () => {
    const src = '/Users/fu';
    const dst = '/Users/bob';
    const input = [
      '{"cwd":"/Users/fuat/work"}',
      '{"cwd":"/Users/fu/work"}',
      '{"text":"/Users/fu and /Users/fuat are different"}',
    ].join('\n');
    const out = rewritePaths(input, src, dst);
    expect(out).toContain('/Users/fuat/work');
    expect(out).toContain('/Users/bob/work');
    expect(out).toContain('/Users/bob and /Users/fuat');
    expect(out).not.toContain('/Users/boat');
  });

  it('case 2: regex special chars in paths replace correctly (+ ( ) [ ])', () => {
    const src = '/tmp/pro+ject (v2)/[main]';
    const dst = '/tmp/dest';
    const input = `{"path":"/tmp/pro+ject (v2)/[main]/file.ts"}`;
    const out = rewritePaths(input, src, dst);
    expect(out).toBe(`{"path":"/tmp/dest/file.ts"}`);
  });

  it('case 3: Windows backslashes preserved, NOT normalized (CORRECTIONS §1)', () => {
    const src = 'F:\\Unity Projects\\dcs';
    const dst = 'F:\\drev-test';
    const input = `{"cwd":"F:\\\\Unity Projects\\\\dcs","file":"F:\\\\Unity Projects\\\\dcs\\\\src\\\\main.cs"}`;
    const out = rewritePaths(input, src, dst);
    expect(out).toContain('F:\\\\drev-test\\\\src\\\\main.cs');
    expect(out).not.toContain('F:\\\\Unity Projects\\\\dcs');
    // No forward-slash normalization should have occurred
    expect(out).not.toContain('F:/drev-test');
    expect(out).not.toContain('F:/Unity');
  });

  it('case 3b: Windows raw form (single backslashes) is also rewritten', () => {
    const src = 'F:\\Unity Projects\\dcs';
    const dst = 'F:\\drev-test';
    // Raw appearance (e.g. printed in stderr, not JSON-encoded)
    const input = `error at F:\\Unity Projects\\dcs\\src boom`;
    const out = rewritePaths(input, src, dst);
    expect(out).toBe('error at F:\\drev-test\\src boom');
  });

  it('case 4: trailing slash is stripped from inputs uniformly', () => {
    const src = '/home/me/project/';
    const dst = '/home/you/proj/';
    const input = `{"cwd":"/home/me/project","file":"/home/me/project/src/a.ts"}`;
    const out = rewritePaths(input, src, dst);
    expect(out).toBe(`{"cwd":"/home/you/proj","file":"/home/you/proj/src/a.ts"}`);
  });

  it('case 4b: trailing backslash on Windows-style is stripped', () => {
    const src = 'F:\\dev\\';
    const dst = 'C:\\work';
    const input = `{"path":"F:\\\\dev\\\\file.cs"}`;
    const out = rewritePaths(input, src, dst);
    expect(out).toContain('C:\\\\work\\\\file.cs');
  });

  it('case 5: case sensitivity — /Users/Fuat ≠ /Users/fuat', () => {
    const src = '/Users/Fuat/work';
    const dst = '/Users/X/work';
    const input = `{"a":"/Users/fuat/work/x","b":"/Users/Fuat/work/y"}`;
    const out = rewritePaths(input, src, dst);
    expect(out).toContain('/Users/fuat/work/x'); // unchanged
    expect(out).toContain('/Users/X/work/y'); // changed
  });

  it('case 6: source equals destination is a no-op', () => {
    const input = `{"cwd":"/a/b","x":"/a/b/c"}\n{"y":"/a/b"}`;
    const out = rewritePaths(input, '/a/b', '/a/b');
    expect(out).toBe(input);
  });

  it('case 6b: equal after trailing-separator normalization is also a no-op', () => {
    const input = `{"cwd":"/a/b"}`;
    const out = rewritePaths(input, '/a/b/', '/a/b');
    expect(out).toBe(input);
  });

  it('case 7: source not present in JSONL — unchanged output', () => {
    const input = `{"cwd":"/somewhere/else","x":"/totally/unrelated"}`;
    const out = rewritePaths(input, '/no/match/here', '/dest');
    expect(out).toBe(input);
  });

  it('case 8: path appears in assistant text (not just tool calls)', () => {
    const src = '/home/a/proj';
    const dst = '/home/b/proj';
    const input = `{"role":"assistant","content":"I edited /home/a/proj/src/x.ts and ran tests."}`;
    const out = rewritePaths(input, src, dst);
    expect(out).toContain('/home/b/proj/src/x.ts');
    expect(out).not.toContain('/home/a/proj');
  });

  it('case 9: path in stderr embedded in tool result', () => {
    const src = '/home/a/proj';
    const dst = '/home/b/proj';
    const input = `{"tool_result":{"stderr":"Error at /home/a/proj/src/main.ts:42:1\\n  at fn"}}`;
    const out = rewritePaths(input, src, dst);
    expect(out).toContain('/home/b/proj/src/main.ts');
    expect(out).not.toContain('/home/a/proj');
  });

  it('case 10: multi-byte chars in paths (Unicode)', () => {
    const src = '/home/üser/プロジェクト';
    const dst = '/home/user/project';
    const input = `{"file":"/home/üser/プロジェクト/src/データ.ts","x":"/home/üser/プロジェクト"}`;
    const out = rewritePaths(input, src, dst);
    expect(out).toContain('/home/user/project/src/データ.ts');
    expect(out).not.toContain('プロジェクト');
  });
});

describe('rewritePaths — algorithmic guarantees', () => {
  it('replaces JSON-escaped form before raw form', () => {
    const src = 'F:\\a\\b';
    const dst = 'F:\\x\\y';
    // Both raw (post-decode) and JSON-escaped appearances on the same line
    const input = `prefix F:\\a\\b/raw end and "F:\\\\a\\\\b/escaped" tail`;
    const out = rewritePaths(input, src, dst);
    expect(out).toContain('F:\\x\\y/raw');
    expect(out).toContain('F:\\\\x\\\\y/escaped');
  });

  it('preserves blank lines', () => {
    const input = '{"a":"/x/y"}\n\n{"b":"/x/y/z"}\n';
    const out = rewritePaths(input, '/x/y', '/p/q');
    expect(out).toBe('{"a":"/p/q"}\n\n{"b":"/p/q/z"}\n');
  });

  it('does not replace mid-segment occurrences (boundary check)', () => {
    const src = '/Users/fu';
    const dst = '/USERS/BOB';
    // "/Users/fubar" should not match "/Users/fu" — followed by "b", not boundary
    const input = `{"x":"/Users/fubar/file"}`;
    const out = rewritePaths(input, src, dst);
    expect(out).toBe(`{"x":"/Users/fubar/file"}`);
  });

  it('handles empty input', () => {
    expect(rewritePaths('', '/a', '/b')).toBe('');
  });

  it('handles input without trailing newline', () => {
    const input = `{"x":"/a/b"}`;
    const out = rewritePaths(input, '/a', '/c');
    expect(out).toBe(`{"x":"/c/b"}`);
  });

  it('handles empty source root (no-op safeguard)', () => {
    const input = `{"x":"hello"}`;
    expect(rewritePaths(input, '', '/dest')).toBe(input);
  });

  it('boundary chars include / \\ " whitespace and end-of-line', () => {
    const src = '/p';
    const dst = '/Q';
    const cases = [
      ['{"x":"/p/sub"}', '{"x":"/Q/sub"}'], // followed by /
      ['{"x":"/p\\\\sub"}', '{"x":"/Q\\\\sub"}'], // followed by \
      ['{"x":"/p"}', '{"x":"/Q"}'], // followed by "
      ['line ends with /p', 'line ends with /Q'], // followed by EOL
      ['before /p after', 'before /Q after'], // followed by space
      ['tab\t/p\there', 'tab\t/Q\there'], // followed by tab
    ] as const;
    for (const [input, expected] of cases) {
      expect(rewritePaths(input, src, dst)).toBe(expected);
    }
  });
});

describe('rewritePaths — reproducibility vs experiment/rewrite.mjs', () => {
  it('produces byte-identical output to the experiment on equivalent JSONL input', () => {
    // Construct realistic Windows JSONL like the §14.1 experiment used.
    const src = 'F:\\Unity Projects\\deep-cleaning-services';
    const dst = 'F:\\drev-experiment';
    const lines: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      lines.push(
        JSON.stringify({
          type: 'tool_use',
          cwd: src,
          file_path: `${src}\\Assets\\Scripts\\Mod${i}.cs`,
        }),
      );
      lines.push(
        JSON.stringify({
          type: 'assistant',
          text: `Edited file at ${src}\\Assets\\Scripts\\Mod${i}.cs successfully.`,
        }),
      );
    }
    lines.push(''); // blank line
    lines.push(JSON.stringify({ type: 'note', x: 'no path here' }));
    const input = lines.join('\n');

    const ours = rewritePaths(input, src, dst);
    const reference = experimentRewrite(input, src, dst);
    expect(ours).toBe(reference);
  });

  it('matches experiment on POSIX-style realistic input', () => {
    const src = '/Users/alice/work/app';
    const dst = '/Users/bob/work/app';
    const lines: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      lines.push(
        JSON.stringify({
          file: `${src}/src/file${i}.ts`,
          msg: `read ${src}/README.md`,
        }),
      );
    }
    const input = lines.join('\n');
    expect(rewritePaths(input, src, dst)).toBe(experimentRewrite(input, src, dst));
  });
});

describe('rewritePaths — property test (100 random pairs)', () => {
  // Deterministic LCG so failures are reproducible.
  function makeRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  function randomSegment(rand: () => number): string {
    const alphabets = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
    const len = 3 + Math.floor(rand() * 8);
    let s = '';
    for (let i = 0; i < len; i += 1) {
      s += alphabets[Math.floor(rand() * alphabets.length)];
    }
    return s;
  }

  function randomAbsPath(rand: () => number, sep: string): string {
    const root = sep === '/' ? '/' : 'F:' + sep;
    const depth = 2 + Math.floor(rand() * 4);
    const parts: string[] = [];
    for (let i = 0; i < depth; i += 1) parts.push(randomSegment(rand));
    return root + parts.join(sep);
  }

  function countOccurrences(haystack: string, needle: string): number {
    if (needle.length === 0) return 0;
    let n = 0;
    let pos = 0;
    while (true) {
      const idx = haystack.indexOf(needle, pos);
      if (idx === -1) return n;
      n += 1;
      pos = idx + needle.length;
    }
  }

  it('output never contains source path; dest count matches source count', () => {
    const rand = makeRng(0xc0ffee);
    let runs = 0;
    for (let i = 0; i < 100; i += 1) {
      const sep = rand() < 0.5 ? '/' : '\\';
      const src = randomAbsPath(rand, sep);
      const dst = randomAbsPath(rand, sep);
      if (src === dst) continue;

      // Build a JSONL that contains src in a few realistic positions, plus
      // some lines with no path at all.
      const lines: string[] = [];
      const sourceOccurrences = 3 + Math.floor(rand() * 5);
      for (let k = 0; k < sourceOccurrences; k += 1) {
        const tail = `${sep}sub${k}${sep}file.ts`;
        lines.push(JSON.stringify({ idx: k, file: src + tail }));
      }
      lines.push(JSON.stringify({ note: 'no path here' }));
      const input = lines.join('\n');

      const out = rewritePaths(input, src, dst);

      // For escaped-form counting, build the JSON-escaped strings.
      const escSrc = JSON.stringify(src).slice(1, -1);
      const escDst = JSON.stringify(dst).slice(1, -1);

      // After replacement, escaped source must not appear at all.
      expect(out.includes(escSrc)).toBe(false);

      // Count of escaped dest in output should equal count of escaped source
      // in input (boundary-aware, but synthetic input always has boundaries).
      const inEsc = countOccurrences(input, escSrc);
      const outEscDst = countOccurrences(out, escDst);
      expect(outEscDst).toBe(inEsc);

      runs += 1;
    }
    expect(runs).toBeGreaterThanOrEqual(95); // tolerate occasional src===dst skips
  });
});
