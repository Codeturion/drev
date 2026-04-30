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
