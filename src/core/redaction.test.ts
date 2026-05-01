import { describe, expect, it } from 'vitest';
import { ValidationError } from '../lib/errors.js';
import {
  DEFAULT_PATTERNS,
  compileUserPattern,
  findSuspiciousTokens,
  redact,
  type RedactionPattern,
} from './redaction.js';
import { LEAK_CORPUS } from './redaction.fixtures.js';

function patternByType(type: string): RedactionPattern {
  const p = DEFAULT_PATTERNS.find((x) => x.type === type);
  if (!p) throw new Error(`pattern not found: ${type}`);
  return p;
}

function runOne(type: string, input: string): { output: string; count: number } {
  const { output, counts } = redact(input, [patternByType(type)]);
  return { output, count: counts[type] ?? 0 };
}

describe('DEFAULT_PATTERNS', () => {
  it('contains exactly the 12 documented patterns from §8.1', () => {
    const expected = [
      'anthropic_key',
      'openai_key',
      'aws_access_key',
      'aws_secret_key',
      'github_pat',
      'github_oauth',
      'github_app',
      'slack_token',
      'private_key',
      'jwt',
      'google_api_key',
      'stripe_key',
    ];
    expect(DEFAULT_PATTERNS.map((p) => p.type)).toEqual(expected);
  });

  it('all default patterns use the global flag', () => {
    for (const p of DEFAULT_PATTERNS) {
      expect(p.regex.flags).toContain('g');
    }
  });
});

describe('default pattern: anthropic_key', () => {
  it('positive: matches sk-ant-<40+ chars>', () => {
    const sample = `prefix sk-ant-${'A'.repeat(50)}_-abc suffix`;
    const r = runOne('anthropic_key', sample);
    expect(r.output).toContain('<REDACTED:anthropic_key>');
    expect(r.count).toBe(1);
  });
  it('negative: does not match sk-ant- with too few chars', () => {
    const r = runOne('anthropic_key', `sk-ant-${'A'.repeat(10)}`);
    expect(r.count).toBe(0);
  });
});

describe('default pattern: openai_key', () => {
  it('positive: matches classic sk- key', () => {
    const r = runOne('openai_key', `key=sk-${'A'.repeat(48)}`);
    expect(r.count).toBe(1);
    expect(r.output).toContain('<REDACTED:openai_key>');
  });
  it('positive: matches sk-proj- variant', () => {
    const r = runOne('openai_key', `sk-proj-${'B'.repeat(45)}`);
    expect(r.count).toBe(1);
  });
  it('negative: does not match sk- with too few chars', () => {
    const r = runOne('openai_key', `sk-${'A'.repeat(10)}`);
    expect(r.count).toBe(0);
  });
});

describe('default pattern: aws_access_key', () => {
  it('positive: matches AKIA + 16 uppercase alnum', () => {
    const r = runOne('aws_access_key', 'token=AKIAIOSFODNN7EXAMPLE rest');
    expect(r.count).toBe(1);
    expect(r.output).toContain('<REDACTED:aws_access_key>');
  });
  it('negative: does not match lowercase or wrong prefix', () => {
    const r = runOne('aws_access_key', 'akiaiosfodnn7example BKIAIOSFODNN7EXAMPLE');
    expect(r.count).toBe(0);
  });
});

describe('default pattern: aws_secret_key (aggressive)', () => {
  // KNOWN FALSE-POSITIVE PRONE per §8.1: any 40-char base64-ish run with non-alnum
  // boundaries gets redacted. Trade-off: harmless over-redaction vs. leaking secrets.
  it('positive: matches a 40-char base64-ish run at boundaries', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    expect(secret).toHaveLength(40);
    const r = runOne('aws_secret_key', `secret="${secret}" end`);
    expect(r.count).toBe(1);
    expect(r.output).toContain('<REDACTED:aws_secret_key>');
  });
  it('known false positive: a benign 40-char alnum string also gets redacted', () => {
    // Documented limitation: any 40-char alnum-ish blob between non-alnum chars is
    // treated as a secret. Acceptable per §8.1.
    const benign = 'a'.repeat(40);
    const r = runOne('aws_secret_key', `value="${benign}"`);
    expect(r.count).toBe(1);
  });
  it('negative: 39-char run does not match', () => {
    const r = runOne('aws_secret_key', `value="${'a'.repeat(39)}"`);
    expect(r.count).toBe(0);
  });
  it('negative: 40-char run with alnum neighbors does not match (boundary check)', () => {
    const r = runOne('aws_secret_key', `Z${'a'.repeat(40)}Z`);
    expect(r.count).toBe(0);
  });
});

describe('default pattern: github_pat', () => {
  it('positive: ghp_ + 36 alnum', () => {
    const r = runOne('github_pat', `tok=ghp_${'A'.repeat(36)} more`);
    expect(r.count).toBe(1);
  });
  it('negative: wrong length', () => {
    const r = runOne('github_pat', `ghp_${'A'.repeat(20)}`);
    expect(r.count).toBe(0);
  });
});

describe('default pattern: github_oauth', () => {
  it('positive: gho_ + 36 alnum', () => {
    const r = runOne('github_oauth', `gho_${'B'.repeat(36)}`);
    expect(r.count).toBe(1);
  });
  it('negative: wrong prefix (ghp_)', () => {
    const r = runOne('github_oauth', `ghp_${'B'.repeat(36)}`);
    expect(r.count).toBe(0);
  });
});

describe('default pattern: github_app', () => {
  it('positive: ghu_ + 36 alnum', () => {
    const r = runOne('github_app', `ghu_${'C'.repeat(36)}`);
    expect(r.count).toBe(1);
  });
  it('positive: ghs_ + 36 alnum', () => {
    const r = runOne('github_app', `ghs_${'D'.repeat(36)}`);
    expect(r.count).toBe(1);
  });
  it('negative: ghr_ is not an app token', () => {
    const r = runOne('github_app', `ghr_${'C'.repeat(36)}`);
    expect(r.count).toBe(0);
  });
});

describe('default pattern: slack_token', () => {
  it('positive: matches xoxb- bot token', () => {
    const r = runOne('slack_token', 'xoxb-1234567890-abcdef-XYZ');
    expect(r.count).toBe(1);
  });
  it('negative: xoxz- is not a known prefix', () => {
    const r = runOne('slack_token', 'xoxz-1234567890-abcdef');
    expect(r.count).toBe(0);
  });
});

describe('default pattern: private_key', () => {
  it('positive: matches a PEM RSA private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj\nfoo\n-----END RSA PRIVATE KEY-----';
    const r = runOne('private_key', `header\n${pem}\nfooter`);
    expect(r.count).toBe(1);
    expect(r.output).toContain('<REDACTED:private_key>');
  });
  it('negative: PUBLIC KEY block is not redacted', () => {
    const pem = '-----BEGIN PUBLIC KEY-----\nMIIBOg\n-----END PUBLIC KEY-----';
    const r = runOne('private_key', pem);
    expect(r.count).toBe(0);
  });
});

describe('default pattern: jwt', () => {
  it('positive: three base64url segments separated by dots', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturePart_-abcDEF';
    const r = runOne('jwt', `auth=${jwt}`);
    expect(r.count).toBe(1);
  });
  it('negative: missing the eyJ prefix on second segment', () => {
    const r = runOne('jwt', 'eyJabc.notajwt.sig');
    expect(r.count).toBe(0);
  });
});

describe('default pattern: google_api_key', () => {
  it('positive: AIza + 35 alnum/_-', () => {
    const r = runOne('google_api_key', `key=AIza${'a'.repeat(35)}`);
    expect(r.count).toBe(1);
  });
  it('negative: wrong prefix', () => {
    const r = runOne('google_api_key', `BIza${'a'.repeat(35)}`);
    expect(r.count).toBe(0);
  });
});

describe('default pattern: stripe_key', () => {
  it('positive: sk_test_ key', () => {
    const r = runOne('stripe_key', `stripe=sk_test_${'A'.repeat(30)}`);
    expect(r.count).toBe(1);
  });
  it('positive: pk_live_ key', () => {
    const r = runOne('stripe_key', `pk_live_${'B'.repeat(24)}`);
    expect(r.count).toBe(1);
  });
  it('negative: sk_demo_ is not a valid env', () => {
    const r = runOne('stripe_key', `sk_demo_${'A'.repeat(30)}`);
    expect(r.count).toBe(0);
  });
});

describe('redact: counts accuracy with mixed JSONL', () => {
  it('counts each pattern type exactly across multiple lines', () => {
    const lines = [
      `{"text":"key1=sk-ant-${'A'.repeat(45)}"}`,
      `{"text":"key2=sk-ant-${'B'.repeat(50)}"}`,
      `{"text":"aws=AKIAIOSFODNN7EXAMPLE"}`,
      `{"text":"gh=ghp_${'C'.repeat(36)} other=ghp_${'D'.repeat(36)}"}`,
      `{"text":"google=AIza${'e'.repeat(35)}"}`,
      `{"text":"no secrets here"}`,
    ];
    const jsonl = lines.join('\n');
    const { output, counts } = redact(jsonl, DEFAULT_PATTERNS);

    expect(counts['anthropic_key']).toBe(2);
    expect(counts['aws_access_key']).toBe(1);
    expect(counts['github_pat']).toBe(2);
    expect(counts['google_api_key']).toBe(1);
    // Every default pattern type should be present in counts (zero or more).
    for (const p of DEFAULT_PATTERNS) {
      expect(counts).toHaveProperty(p.type);
    }
    expect(output).not.toContain('sk-ant-');
    expect(output).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(output).not.toContain('ghp_');
  });

  it('returns input unchanged and zero counts when nothing matches', () => {
    const jsonl = '{"text":"clean line"}\n{"text":"also clean"}';
    const { output, counts } = redact(jsonl, DEFAULT_PATTERNS);
    expect(output).toBe(jsonl);
    for (const p of DEFAULT_PATTERNS) {
      expect(counts[p.type]).toBe(0);
    }
  });
});

describe('redact: pattern order matters (first wins)', () => {
  it('first registered pattern consumes a string before later patterns see it', () => {
    const jsonl = 'value=sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    // anthropic_key is listed before openai_key — both could in principle match the
    // same prefix, but anthropic claims it first by being earlier in DEFAULT_PATTERNS.
    const { counts } = redact(jsonl, DEFAULT_PATTERNS);
    expect(counts['anthropic_key']).toBe(1);
    expect(counts['openai_key']).toBe(0);
  });

  it('reversing order changes which pattern wins', () => {
    const jsonl = 'value=sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const reversed = [...DEFAULT_PATTERNS].reverse();
    const { counts } = redact(jsonl, reversed);
    // openai_key appears earlier in the reversed list and matches sk-...
    expect(counts['openai_key']).toBe(1);
    expect(counts['anthropic_key']).toBe(0);
  });
});

describe('compileUserPattern', () => {
  it('compiles a valid pattern with the global flag', () => {
    const p = compileUserPattern('custom', 'FOO_[A-Z]+');
    expect(p.type).toBe('custom');
    expect(p.regex.flags).toContain('g');
    const r = redact('FOO_BAR FOO_BAZ', [p]);
    expect(r.counts['custom']).toBe(2);
    expect(r.output).toBe('<REDACTED:custom> <REDACTED:custom>');
  });

  it('throws ValidationError on a malformed regex', () => {
    expect(() => compileUserPattern('bad', '([')).toThrow(ValidationError);
    try {
      compileUserPattern('bad', '([');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe('VALIDATION_ERROR');
      expect((err as ValidationError).message).toContain('bad');
    }
  });

  it('user-supplied pattern composes cleanly with defaults', () => {
    const user = compileUserPattern('internal', 'ACME_INTERNAL_[A-Z0-9]+');
    const patterns = [...DEFAULT_PATTERNS, user];
    const jsonl = 'mix=ACME_INTERNAL_ABC123 and AKIAIOSFODNN7EXAMPLE';
    const { output, counts } = redact(jsonl, patterns);
    expect(counts['internal']).toBe(1);
    expect(counts['aws_access_key']).toBe(1);
    expect(output).toContain('<REDACTED:internal>');
    expect(output).toContain('<REDACTED:aws_access_key>');
  });
});

// Synthetic-leak corpus (item 3). Each pattern has at least one fixture in
// LEAK_CORPUS that must be scrubbed. If anyone weakens a regex, this test
// fails loudly. Fixtures are obviously fake but realistically shaped.
describe('synthetic-leak corpus', () => {
  it('every default pattern has at least one corpus fixture', () => {
    const fixtureTypes = new Set(LEAK_CORPUS.map((s) => s.type));
    for (const p of DEFAULT_PATTERNS) {
      expect(fixtureTypes.has(p.type)).toBe(true);
    }
  });

  it.each(LEAK_CORPUS)(
    '$type: secret is replaced by the redaction marker',
    ({ type, secret, line }) => {
      const { output, counts } = redact(line, DEFAULT_PATTERNS);
      expect(output).not.toContain(secret);
      expect(output).toContain(`<REDACTED:${type}>`);
      // The secret-bearing pattern must have fired at least once. A different
      // pattern may legitimately also fire (e.g. aws_secret_key on padding),
      // so we don't assert on other counts.
      expect(counts[type]).toBeGreaterThanOrEqual(1);
    },
  );

  it('a single payload concatenating every fixture is fully scrubbed in one pass', () => {
    const concatenated = LEAK_CORPUS.map((s) => s.line).join('\n');
    const { output } = redact(concatenated, DEFAULT_PATTERNS);
    for (const { secret } of LEAK_CORPUS) {
      expect(output).not.toContain(secret);
    }
  });
});

describe('findSuspiciousTokens', () => {
  it('returns zero on plain prose', () => {
    const r = findSuspiciousTokens(
      'this is a normal log line with words and short tokens like abc123',
    );
    expect(r.count).toBe(0);
  });

  it('returns zero when text contains only redaction markers', () => {
    const r = findSuspiciousTokens(
      'before <REDACTED:anthropic_key> middle <REDACTED:github_pat> after',
    );
    expect(r.count).toBe(0);
  });

  it('skips pure-hex tokens (git SHAs, file hashes) to avoid noise', () => {
    // 40-char git SHA. Entropy ~4.0 but pure hex.
    const sha = 'a'.repeat(20) + '1'.repeat(20);
    const r = findSuspiciousTokens(`commit ${sha}`);
    expect(r.count).toBe(0);
  });

  it('flags a high-entropy mixed-class token of length >= 32', () => {
    // 37 chars, mixed upper/lower/digit, plenty of variety => high entropy.
    // Surrounding quotes are not in the token character class, so the token
    // boundary is clean for assertion.
    const token = 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Lm2N';
    const r = findSuspiciousTokens(`"${token}"`);
    expect(r.count).toBe(1);
    expect(r.samples).toContain(token);
  });

  it('caps samples at 3 even when many suspicious tokens exist', () => {
    const tokens = Array.from(
      { length: 5 },
      (_, i) => `Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Lm${i}xyz`,
    );
    const r = findSuspiciousTokens(tokens.join(' '));
    expect(r.count).toBe(5);
    expect(r.samples.length).toBe(3);
  });

  it('counts a real-shaped key the regex layer would otherwise miss (safety net)', () => {
    // Hypothetical vendor key: prefix the regex set does not know about,
    // mixed character classes, high entropy.
    const key = 'vendor_live_Hk9XmP2qLfV4nWcR8jZ5tBdY7sNgEa6oFi';
    const r = findSuspiciousTokens(`API_KEY=${key}`);
    expect(r.count).toBeGreaterThanOrEqual(1);
  });

  // Real-world tuning (post v0 share): MCP tool identifiers and Claude Code
  // thinking signatures dominated the warning on a 293-turn share with 284
  // false positives. Both have stable shapes and are never secrets.
  it('does not flag Claude Code MCP tool identifiers', () => {
    const tools = [
      'mcp__aseprite__animation_workflow_guide',
      'mcp__context7__resolve-library-id',
      'mcp__claude_ai_Gmail__create_draft',
      'mcp__aseprite__draw_rectangle_at',
    ].join(' ');
    const r = findSuspiciousTokens(tools);
    // Some tokens may contain `-` which is in the allowed-char class; either
    // way none of them should fire.
    expect(r.count).toBe(0);
  });

  it('does not flag thinking-block signature fields', () => {
    // Real-shaped: the value inside `"signature":"..."` is a long base64
    // string. The pre-strip pass blanks it before scanning.
    const line = '{"type":"thinking","thinking":"","signature":"ErYCClkIDRgCKkBF4hNIqqyj5+M0BnENvLWzxJ9iRRTf+eJseA24xhpGa+N9NCWEcK33gJY1wyvrPPRaFTqVtXmVsXWCqeBtOZTSMg9jbGF1ZGUtb3B1cy00LTc4ABIM"}';
    const r = findSuspiciousTokens(line);
    expect(r.count).toBe(0);
  });

  it('still flags a high-entropy token outside both Claude Code shapes', () => {
    // Same long base64 as a thinking signature, but in a generic context
    // (no `"signature":` key). Must still fire.
    const blob = 'ErYCClkIDRgCKkBF4hNIqqyj5+M0BnENvLWzxJ9iRRTf+eJseA24xhpGa+N9NCWE';
    const r = findSuspiciousTokens(`leaked=${blob}`);
    expect(r.count).toBeGreaterThanOrEqual(1);
  });

  it('does not flag path or URL fragments (3+ slashes)', () => {
    const fragments = [
      'com/Codeturion/drev/actions/workflows/publish',
      'io/github/last-commit/Codeturion/drev',
      'users/fuat/2026-05-01-inventory-sync-fix/',
      'https://example.com/api/v1/things/abc/def',
    ].join(' ');
    const r = findSuspiciousTokens(fragments);
    expect(r.count).toBe(0);
  });

  it('still flags a high-entropy token that happens to contain one or two slashes', () => {
    // base64-ish secret with a couple of `/` chars (legitimate base64 alphabet).
    const key = 'Aa1Bb2Cc3Dd4/Ee5Ff6Gg7Hh8Ii9Jj0Kk1Lm2N/xyz';
    const r = findSuspiciousTokens(`"${key}"`);
    expect(r.count).toBeGreaterThanOrEqual(1);
  });

  it('handles a mixed payload (MCP tools + signatures + a real leak)', () => {
    const realLeak = 'vendor_live_Hk9XmP2qLfV4nWcR8jZ5tBdY7sNgEa6oFi';
    const payload = [
      'mcp__aseprite__draw_line mcp__claude_ai_Gmail__list_drafts',
      '{"signature":"ErYCClkIDRgCKkBF4hNIqqyj5+M0BnENvLWzxJ9iRRTf"}',
      // Space (not `=`) so the matched token is just realLeak.
      `API_KEY ${realLeak}`,
    ].join('\n');
    const r = findSuspiciousTokens(payload);
    expect(r.count).toBe(1);
    expect(r.samples).toContain(realLeak);
  });
});
