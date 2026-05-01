import { ValidationError } from '../lib/errors.js';

export type RedactionPattern = { type: string; regex: RegExp };

// Patterns are applied in order; the first match wins per §8.2.
export const DEFAULT_PATTERNS: RedactionPattern[] = [
  { type: 'anthropic_key', regex: /sk-ant-[A-Za-z0-9_-]{40,}/g },
  { type: 'openai_key', regex: /sk-(?:proj-)?[A-Za-z0-9_-]{40,}/g },
  { type: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/g },
  // Intentionally aggressive: any 40-char base64-ish run with non-alnum boundaries.
  // Per §8.1, false positives are accepted (harmless redaction marker) because
  // false negatives would leak a real AWS secret. Tests document this behavior.
  { type: 'aws_secret_key', regex: /(?<![A-Za-z0-9])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9])/g },
  { type: 'github_pat', regex: /ghp_[A-Za-z0-9]{36}/g },
  { type: 'github_oauth', regex: /gho_[A-Za-z0-9]{36}/g },
  { type: 'github_app', regex: /(?:ghu|ghs)_[A-Za-z0-9]{36}/g },
  { type: 'slack_token', regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  {
    type: 'private_key',
    regex: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
  },
  { type: 'jwt', regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { type: 'google_api_key', regex: /AIza[0-9A-Za-z_-]{35}/g },
  { type: 'stripe_key', regex: /(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{24,}/g },
];

export function redact(
  jsonl: string,
  patterns: RedactionPattern[],
): { output: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const { type } of patterns) {
    if (!(type in counts)) counts[type] = 0;
  }

  let output = jsonl;
  for (const { type, regex } of patterns) {
    // Re-clone to guarantee a fresh global regex with lastIndex = 0.
    const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
    const re = new RegExp(regex.source, flags);
    let matchCount = 0;
    output = output.replace(re, () => {
      matchCount += 1;
      return `<REDACTED:${type}>`;
    });
    counts[type] = (counts[type] ?? 0) + matchCount;
  }

  return { output, counts };
}

export function compileUserPattern(type: string, source: string): RedactionPattern {
  try {
    return { type, regex: new RegExp(source, 'g') };
  } catch (cause) {
    throw new ValidationError(
      `Invalid redaction pattern for "${type}": ${(cause as Error).message}`,
      { cause },
    );
  }
}

// --- Entropy-based safety net (post-regex pass) ----------------------------
// The regex set in DEFAULT_PATTERNS is the load-bearing redactor. This pass
// is a non-blocking observer that flags suspiciously high-entropy strings
// the regex layer did not catch, so callers can warn the operator before
// pushing. False positives are acceptable because this only ever warns.

const SUSPICIOUS_TOKEN_RE = /[A-Za-z0-9+/=_-]{32,}/g;
const PURE_HEX_RE = /^[0-9a-f]+$/;
const REDACTION_MARKER_RE = /^<REDACTED:[^>]+>$/;
// Claude Code MCP tool identifiers like `mcp__aseprite__draw_line` or
// `mcp__claude_ai_Gmail__create_draft`: long, base64-shaped, never secrets.
// Sessions with MCP tools enabled list dozens of these in deferred-tools
// metadata events, so they otherwise dominate the entropy warning output.
const MCP_TOOL_NAME_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
// Claude Code thinking-block cryptographic signatures live at
// `"signature":"<long-base64>"` inside thinking events. Legitimately
// high-entropy, never user-controlled content.
const SIGNATURE_FIELD_RE = /"signature"\s*:\s*"[^"]+"/g;
// Tokens with three or more forward slashes are path / URL fragments
// (`com/Codeturion/drev/actions/workflows/publish`,
// `users/fuat/2026-05-01-x/`, etc.). API keys / secrets in modern formats
// use base64url (`-`, `_`) rather than `/`, so a real leak with 3+ slashes
// is a vanishingly rare false negative versus dozens of false positives
// per shared session.
const MAX_PATH_SLASHES = 2;
const SUSPICIOUS_ENTROPY_THRESHOLD = 4.0;
const MAX_SAMPLES = 3;

function countSlashes(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === '/') n += 1;
  return n;
}

function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq: Record<string, number> = {};
  for (const ch of s) freq[ch] = (freq[ch] ?? 0) + 1;
  let h = 0;
  for (const n of Object.values(freq)) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export interface SuspiciousReport {
  count: number;
  samples: string[];
}

// Accepts either a single string or an array of strings. Callers with multiple
// payloads (e.g. parent JSONL + N subagent JSONLs) should pass the array form
// to avoid allocating a concatenated copy of the entire session.
export function findSuspiciousTokens(
  text: string | readonly string[],
): SuspiciousReport {
  const inputs = typeof text === 'string' ? [text] : text;
  const samples: string[] = [];
  const seen = new Set<string>();
  let count = 0;

  for (const input of inputs) {
    // Pre-strip Claude Code thinking-block signatures: stable JSON shape,
    // always high-entropy, never a secret. Replacing with empty content
    // (rather than deleting) preserves byte offsets in case callers ever
    // inspect them.
    const cleaned = input.replace(SIGNATURE_FIELD_RE, '"signature":""');
    for (const match of cleaned.matchAll(SUSPICIOUS_TOKEN_RE)) {
      const token = match[0];
      // Skip our own redaction markers so a previous pass doesn't flag itself.
      if (REDACTION_MARKER_RE.test(token)) continue;
      // Pure hex (git SHAs, file hashes) is common and low signal; skip.
      if (PURE_HEX_RE.test(token)) continue;
      // Claude Code MCP tool identifiers are not secrets even though they look
      // base64-shaped; skip them or every MCP-enabled session floods the warning.
      if (MCP_TOOL_NAME_RE.test(token)) continue;
      // Path / URL fragments have multiple slashes; modern API keys do not.
      if (countSlashes(token) > MAX_PATH_SLASHES) continue;
      if (shannonEntropy(token) < SUSPICIOUS_ENTROPY_THRESHOLD) continue;
      count += 1;
      if (samples.length < MAX_SAMPLES && !seen.has(token)) {
        samples.push(token);
        seen.add(token);
      }
    }
  }
  return { count, samples };
}
