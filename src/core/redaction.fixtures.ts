// Synthetic-leak corpus. Each entry is a fake-but-realistically-shaped secret
// that the matching DEFAULT_PATTERNS regex must scrub. If a pattern is ever
// weakened, the corpus test in redaction.test.ts will fail loudly.
//
// Values here are NOT real secrets. They are constructed at module-load time
// from parts so GitHub / GitLab secret scanners do not lex the source as
// containing real-shaped tokens. Runtime values still match our regex, which
// is what the tests need; the source file stays push-clean.

export interface LeakSample {
  type: string;
  // The exact substring expected to be replaced by `<REDACTED:${type}>`.
  secret: string;
  // A line of plausible context surrounding the secret (the redactor operates
  // on JSONL, so the surrounding text matters for boundary regexes).
  line: string;
}

// Prefixes split so source scanners can't match the partner-pattern shape.
const SK_ANT = 'sk' + '-' + 'ant-';
const SK_PROJ = 'sk' + '-' + 'proj-';
const AKIA = 'AK' + 'IA';
const GHP = 'gh' + 'p_';
const GHO = 'gh' + 'o_';
const GHU = 'gh' + 'u_';
const XOXB = 'xox' + 'b';
const AIZA = 'AI' + 'za';
const SK_TEST = 'sk' + '_test_';
const EYJ = 'ey' + 'J';

const ANTHROPIC_BODY = 'A'.repeat(50) + '_-XYZ';
const OPENAI_BODY = 'B'.repeat(48);
const AWS_ACCESS_BODY = 'IOSFODNN7EXAMPLE';
const AWS_SECRET = 'w' + 'JalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12';
const GHP_BODY = 'a'.repeat(36);
const GHO_BODY = 'b'.repeat(36);
const GHU_BODY = 'c'.repeat(36);
const SLACK_BODY = '1234567890-abcdefghijklmnopqr';
const GOOGLE_BODY = 'D'.repeat(35);
const STRIPE_BODY = 'E'.repeat(24);

// JWT: three base64url segments. Segments 1 and 2 start with eyJ; segment 3
// is opaque. Built from parts so scanners don't match the canonical shape.
const JWT_SEG1 = `${EYJ}${'a'.repeat(20)}`;
const JWT_SEG2 = `${EYJ}${'b'.repeat(20)}`;
// `_` and `-` are valid base64url and break any 40-char alnum run so the
// aws_secret_key pattern doesn't accidentally win the first-match race.
const JWT_SEG3 = `c-d_e${'c'.repeat(35)}`;
const JWT = `${JWT_SEG1}.${JWT_SEG2}.${JWT_SEG3}`;

export const LEAK_CORPUS: LeakSample[] = [
  {
    type: 'anthropic_key',
    secret: `${SK_ANT}${ANTHROPIC_BODY}`,
    line: `{"text":"export ANTHROPIC_API_KEY=${SK_ANT}${ANTHROPIC_BODY}"}`,
  },
  {
    type: 'openai_key',
    secret: `${SK_PROJ}${OPENAI_BODY}`,
    line: `{"text":"OPENAI_API_KEY=${SK_PROJ}${OPENAI_BODY}"}`,
  },
  {
    type: 'aws_access_key',
    secret: `${AKIA}${AWS_ACCESS_BODY}`,
    line: `{"text":"AWS_ACCESS_KEY_ID=${AKIA}${AWS_ACCESS_BODY}"}`,
  },
  {
    type: 'aws_secret_key',
    // Exactly 40 base64-ish chars with non-alnum boundaries.
    secret: AWS_SECRET,
    line: `{"text":"secret=\\"${AWS_SECRET}\\""}`,
  },
  {
    type: 'github_pat',
    secret: `${GHP}${GHP_BODY}`,
    line: `{"text":"git remote set-url origin https://x:${GHP}${GHP_BODY}@github.com/me/r.git"}`,
  },
  {
    type: 'github_oauth',
    secret: `${GHO}${GHO_BODY}`,
    line: `{"token":"${GHO}${GHO_BODY}"}`,
  },
  {
    type: 'github_app',
    secret: `${GHU}${GHU_BODY}`,
    line: `{"text":"x-access-token: ${GHU}${GHU_BODY}"}`,
  },
  {
    type: 'slack_token',
    secret: `${XOXB}-${SLACK_BODY}`,
    line: `{"text":"SLACK_BOT_TOKEN=${XOXB}-${SLACK_BODY}"}`,
  },
  {
    type: 'private_key',
    secret:
      '-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEAxxxxFAKExxxx\\n-----END RSA PRIVATE KEY-----',
    line: `{"text":"-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEAxxxxFAKExxxx\\n-----END RSA PRIVATE KEY-----"}`,
  },
  {
    type: 'jwt',
    secret: JWT,
    line: `{"text":"Authorization: Bearer ${JWT}"}`,
  },
  {
    type: 'google_api_key',
    secret: `${AIZA}${GOOGLE_BODY}`,
    line: `{"text":"GOOGLE_API_KEY=${AIZA}${GOOGLE_BODY}"}`,
  },
  {
    type: 'stripe_key',
    secret: `${SK_TEST}${STRIPE_BODY}`,
    line: `{"text":"STRIPE_SECRET=${SK_TEST}${STRIPE_BODY}"}`,
  },
];
