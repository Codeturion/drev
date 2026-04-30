// Path rewriter (load-bearing). See ARCHITECTURE.md §7 and docs/CORRECTIONS.md §1.
// Native separators are preserved: Claude Code stores backslashes on Windows.

const BOUNDARY_CHARS = new Set<string>(['/', '\\', '"', ' ', '\t', '\r', '\n']);

function stripTrailingSeparators(p: string): string {
  let end = p.length;
  while (end > 0) {
    const ch = p[end - 1];
    if (ch === '/' || ch === '\\') {
      end -= 1;
    } else {
      break;
    }
  }
  return p.slice(0, end);
}

function jsonEscapeInner(s: string): string {
  // JSON.stringify wraps in quotes; slice them off to get the escaped form
  // that appears inside JSON string literals (e.g. backslashes doubled).
  return JSON.stringify(s).slice(1, -1);
}

function isBoundaryAfter(haystack: string, index: number): boolean {
  if (index >= haystack.length) return true;
  const ch = haystack[index];
  if (ch === undefined) return true;
  return BOUNDARY_CHARS.has(ch);
}

function replaceBoundaryAware(haystack: string, needle: string, replacement: string): string {
  if (needle.length === 0) return haystack;
  if (!haystack.includes(needle)) return haystack;

  const parts: string[] = [];
  let cursor = 0;
  while (cursor <= haystack.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found === -1) {
      parts.push(haystack.slice(cursor));
      break;
    }
    const afterIdx = found + needle.length;
    if (isBoundaryAfter(haystack, afterIdx)) {
      parts.push(haystack.slice(cursor, found));
      parts.push(replacement);
      cursor = afterIdx;
    } else {
      // Not at a boundary: keep the literal needle and advance past its first char
      // so we can find overlapping matches without re-replacing.
      parts.push(haystack.slice(cursor, found + 1));
      cursor = found + 1;
    }
  }
  return parts.join('');
}

export function rewritePaths(jsonl: string, sourceRoot: string, destRoot: string): string {
  const sourceNorm = stripTrailingSeparators(sourceRoot);
  const destNorm = stripTrailingSeparators(destRoot);

  if (sourceNorm === destNorm) return jsonl;
  if (sourceNorm.length === 0) return jsonl;

  const escSource = jsonEscapeInner(sourceNorm);
  const escDest = jsonEscapeInner(destNorm);
  const rawSource = sourceNorm;
  const rawDest = destNorm;

  const lines = jsonl.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    // JSON-escaped form first (more specific), then raw form. Order matches
    // experiment/rewrite.mjs and §7.3.
    let next = replaceBoundaryAware(line, escSource, escDest);
    next = replaceBoundaryAware(next, rawSource, rawDest);
    lines[i] = next;
  }
  return lines.join('\n');
}
