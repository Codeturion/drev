// Path rewriter (load-bearing). See ARCHITECTURE.md §7 and docs/CORRECTIONS.md §1.
// Native separators are preserved: Claude Code stores backslashes on Windows.
// Cross-OS separator translation kicks in only when source and dest styles
// differ — see translateTrailingSeparators below.

const BOUNDARY_CHARS = new Set<string>(['/', '\\', '"', ' ', '\t', '\r', '\n']);

// Where a path "ends" inside a JSONL line for the purposes of separator
// translation. Note: '/' and '\\' are intentionally NOT in this set — they
// are mid-path separators we want to translate, not stop at.
const PATH_END_CHARS = new Set<string>(['"', ' ', '\t', '\r', '\n']);

type SepStyle = 'win32' | 'posix';

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

export function detectSeparatorStyle(absPath: string): SepStyle {
  // Drive-letter Windows path (e.g. F:\... or C:/...).
  if (/^[A-Za-z]:[\\/]/.test(absPath)) return 'win32';
  // UNC path: starts with two backslashes. In a raw string this is the
  // literal two-char sequence "\\".
  if (absPath.startsWith('\\\\')) return 'win32';
  // POSIX absolute.
  if (absPath.startsWith('/')) return 'posix';
  // Fallback: whichever separator dominates wins. In practice paths reaching
  // this rewriter are absolute, so this branch is rarely hit.
  let back = 0;
  let fwd = 0;
  for (const ch of absPath) {
    if (ch === '\\') back += 1;
    else if (ch === '/') fwd += 1;
  }
  return back > fwd ? 'win32' : 'posix';
}

// After the prefix has been swapped, walk forward from each occurrence of
// `prefix` until a path-end boundary, replacing every `fromSep` with `toSep`.
// `fromSep`/`toSep` may be multi-char (the escaped backslash form is "\\"
// — two characters in the JSONL byte stream).
function translateTrailingSeparators(
  haystack: string,
  prefix: string,
  fromSep: string,
  toSep: string,
): string {
  if (prefix.length === 0 || fromSep.length === 0) return haystack;
  if (fromSep === toSep) return haystack;
  if (!haystack.includes(prefix)) return haystack;

  const parts: string[] = [];
  let cursor = 0;
  while (cursor < haystack.length) {
    const found = haystack.indexOf(prefix, cursor);
    if (found === -1) {
      parts.push(haystack.slice(cursor));
      break;
    }
    // Emit text up to and including the prefix verbatim — the prefix itself
    // already has the destination's separator style applied to it.
    parts.push(haystack.slice(cursor, found + prefix.length));

    // Scan the trailing path until we hit a path-end boundary or EOL,
    // translating fromSep to toSep along the way.
    let scan = found + prefix.length;
    while (scan < haystack.length) {
      const ch = haystack[scan];
      if (ch === undefined || PATH_END_CHARS.has(ch)) break;
      if (haystack.startsWith(fromSep, scan)) {
        parts.push(toSep);
        scan += fromSep.length;
      } else {
        parts.push(ch);
        scan += 1;
      }
    }
    cursor = scan;
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

  // Cross-OS detection — only translate trailing separators when the source
  // and destination use different separator styles. Same-OS rewrites must
  // remain byte-identical to the pre-cross-OS implementation (reproducibility
  // gate vs experiment/rewrite.mjs).
  const sourceStyle = detectSeparatorStyle(sourceNorm);
  const destStyle = detectSeparatorStyle(destNorm);
  const crossOS = sourceStyle !== destStyle;

  const lines = jsonl.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    // JSON-escaped form first (more specific), then raw form. Order matches
    // experiment/rewrite.mjs and §7.3.
    let next = replaceBoundaryAware(line, escSource, escDest);
    next = replaceBoundaryAware(next, rawSource, rawDest);

    if (crossOS) {
      // Escaped pass: Windows uses the two-char sequence "\\" inside JSONL
      // strings; POSIX uses the single char "/". Anchored on the escaped
      // dest prefix so we only translate within paths the rewriter just
      // produced, not unrelated separators in the line.
      const escFromSep = sourceStyle === 'win32' ? '\\\\' : '/';
      const escToSep = destStyle === 'win32' ? '\\\\' : '/';
      next = translateTrailingSeparators(next, escDest, escFromSep, escToSep);

      // Raw pass: covers paths that appear un-JSON-encoded (e.g. embedded in
      // stderr text). Both Windows and POSIX use a single-char separator in
      // raw form ("\\" the JS literal is one char).
      const rawFromSep = sourceStyle === 'win32' ? '\\' : '/';
      const rawToSep = destStyle === 'win32' ? '\\' : '/';
      next = translateTrailingSeparators(next, rawDest, rawFromSep, rawToSep);
    }

    lines[i] = next;
  }
  return lines.join('\n');
}
