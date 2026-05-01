import { describe, expect, it } from 'vitest';
import { renderHtml } from './transcript-renderer.js';
import type { SessionMeta } from './metadata.js';

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    schema_version: 1,
    id: '7f3a2b1c-1234-5678-90ab-cdef01234567',
    name: 'auth-fix',
    purpose: 'share',
    user: 'alice',
    user_email: 'alice@example.com',
    project_root: '/Users/alice/work/proj',
    created_at: '2026-04-30T14:00:00Z',
    shared_at: '2026-04-30T18:00:00Z',
    visibility: 'team',
    turns: 1,
    size_bytes: 100,
    redactions: [],
    ...overrides,
  };
}

function lines(...events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

describe('renderHtml — structure', () => {
  it('emits a complete HTML5 document with charset and viewport', () => {
    const html = renderHtml('', makeMeta());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('</html>');
  });

  it('inlines a <style> block (self-contained, no CDN)', () => {
    const html = renderHtml('', makeMeta());
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<link\s+rel=["']stylesheet/);
    expect(html).not.toMatch(/<script\s+src=/);
  });

  it('uses meta.title for the document <title> when present', () => {
    const html = renderHtml('', makeMeta({ title: 'Refactoring Auth' }));
    expect(html).toMatch(/<title>Refactoring Auth · drev<\/title>/);
  });

  it('falls back to meta.name then to short id for the title', () => {
    const html1 = renderHtml('', makeMeta({ title: undefined, name: 'my-name' }));
    expect(html1).toContain('<title>my-name · drev</title>');

    const html2 = renderHtml(
      '',
      makeMeta({ title: undefined, name: undefined }),
    );
    expect(html2).toContain('<title>7f3a2b1c · drev</title>');
  });
});

describe('renderHtml — header', () => {
  it('shows user, project_root, shared_at, summary, and commit_sha when present', () => {
    const html = renderHtml(
      '',
      makeMeta({
        summary: 'Fixed the auth desync.',
        commit_sha: 'cafef00dcafef00dcafef00dcafef00dcafef00d',
      }),
    );
    expect(html).toContain('alice');
    expect(html).toContain('/Users/alice/work/proj');
    expect(html).toContain('2026-04-30T18:00:00Z');
    expect(html).toContain('Fixed the auth desync.');
    // Commit sha is shown truncated to 12.
    expect(html).toContain('cafef00dcafe');
    expect(html).not.toContain('cafef00dcafef00dcafef00dcafef00dcafef00d');
  });

  it('renders a redaction badge when redactions are present', () => {
    const html = renderHtml(
      '',
      makeMeta({
        redactions: [
          { type: 'github_pat', count: 2 },
          { type: 'aws_access_key', count: 1 },
        ],
      }),
    );
    expect(html).toContain('3 secret(s) redacted before share');
  });

  it('omits the redaction badge when no redactions occurred', () => {
    const html = renderHtml('', makeMeta({ redactions: [] }));
    expect(html).not.toContain('redacted before share');
  });
});

describe('renderHtml — turn rendering', () => {
  it('renders a string-content user turn as a user section', () => {
    const jsonl = lines({
      type: 'user',
      message: { role: 'user', content: 'help me debug this' },
    });
    const html = renderHtml(jsonl, makeMeta());
    expect(html).toContain('<section class="turn user">');
    expect(html).toContain('help me debug this');
  });

  it('renders an assistant text block as an assistant section', () => {
    const jsonl = lines({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'sure thing' }] },
    });
    const html = renderHtml(jsonl, makeMeta());
    expect(html).toContain('<section class="turn assistant">');
    expect(html).toContain('sure thing');
  });

  it('renders a tool_use as a collapsible <details> with name + input summary', () => {
    const jsonl = lines({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_xyz',
            name: 'Read',
            input: { file_path: '/tmp/foo.ts' },
          },
        ],
      },
    });
    const html = renderHtml(jsonl, makeMeta());
    expect(html).toContain('<details class="tool use">');
    expect(html).toContain('<span class="name">Read</span>');
    // Summary picks file_path as the informative field.
    expect(html).toContain('file_path=/tmp/foo.ts');
    // Full input also rendered as JSON for expand.
    expect(html).toContain('&quot;file_path&quot;: &quot;/tmp/foo.ts&quot;');
  });

  it('renders a tool_result block as a collapsible details', () => {
    const jsonl = lines({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_xyz',
            content: 'file contents',
            is_error: false,
          },
        ],
      },
    });
    const html = renderHtml(jsonl, makeMeta());
    expect(html).toContain('<details class="tool result">');
    expect(html).toContain('file contents');
  });

  it('marks tool_result as error when is_error is true', () => {
    const jsonl = lines({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_xyz',
            content: 'ENOENT',
            is_error: true,
          },
        ],
      },
    });
    const html = renderHtml(jsonl, makeMeta());
    expect(html).toContain('<details class="tool result error">');
    expect(html).toContain('tool error');
  });

  it('renders a thinking block as a collapsed details', () => {
    const jsonl = lines({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'planning the next step' }],
      },
    });
    const html = renderHtml(jsonl, makeMeta());
    expect(html).toContain('<details class="turn thinking">');
    expect(html).toContain('planning the next step');
  });

  it('skips empty thinking blocks (signed but no visible content)', () => {
    const jsonl = lines({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '' }],
      },
    });
    const html = renderHtml(jsonl, makeMeta());
    expect(html).not.toContain('class="turn thinking"');
  });

  it('preserves event ordering across user, assistant, tool_use, tool_result', () => {
    const jsonl = lines(
      {
        type: 'user',
        message: { role: 'user', content: 'do X' },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'on it' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }],
        },
      },
    );
    const html = renderHtml(jsonl, makeMeta());
    const userIdx = html.indexOf('do X');
    const assistantIdx = html.indexOf('on it');
    const toolUseIdx = html.indexOf('Bash</span>');
    const toolResultIdx = html.indexOf('file.txt');
    expect(userIdx).toBeGreaterThan(0);
    expect(assistantIdx).toBeGreaterThan(userIdx);
    expect(toolUseIdx).toBeGreaterThan(assistantIdx);
    expect(toolResultIdx).toBeGreaterThan(toolUseIdx);
  });

  it('ignores metadata events (permission-mode, file-history-snapshot)', () => {
    const jsonl = lines(
      { type: 'permission-mode', permissionMode: 'bypassPermissions' },
      { type: 'file-history-snapshot', snapshot: {} },
      { type: 'user', message: { role: 'user', content: 'real message' } },
    );
    const html = renderHtml(jsonl, makeMeta());
    expect(html).toContain('real message');
    expect(html).not.toContain('permission-mode');
    expect(html).not.toContain('file-history-snapshot');
  });

  it('ignores unparseable lines without throwing', () => {
    const jsonl = [
      'not json at all',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'after garbage' } }),
      '{"truncated":',
    ].join('\n');
    const html = renderHtml(jsonl, makeMeta());
    expect(html).toContain('after garbage');
  });
});

describe('renderHtml — sanitization', () => {
  it('escapes HTML in user content (XSS guard)', () => {
    const jsonl = lines({
      type: 'user',
      message: { role: 'user', content: '<script>alert(1)</script>' },
    });
    const html = renderHtml(jsonl, makeMeta());
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes HTML in assistant text', () => {
    const jsonl = lines({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }],
      },
    });
    const html = renderHtml(jsonl, makeMeta());
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes HTML in meta.summary and meta.title', () => {
    const html = renderHtml(
      '',
      makeMeta({
        title: '<b>boom</b>',
        summary: '<script>x</script>',
      }),
    );
    expect(html).not.toMatch(/<title><b>boom<\/b>/);
    expect(html).toContain('&lt;b&gt;boom&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('escapes HTML inside tool input JSON', () => {
    const jsonl = lines({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Read',
            input: { file_path: '<script>x</script>' },
          },
        ],
      },
    });
    const html = renderHtml(jsonl, makeMeta());
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('escapes HTML in tool_result content', () => {
    const jsonl = lines({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: '<iframe src="evil"></iframe>',
          },
        ],
      },
    });
    const html = renderHtml(jsonl, makeMeta());
    expect(html).not.toContain('<iframe src="evil"></iframe>');
    expect(html).toContain('&lt;iframe');
  });
});

describe('renderHtml — empty / malformed input', () => {
  it('renders successfully with empty jsonl (header + empty main)', () => {
    const html = renderHtml('', makeMeta());
    expect(html).toContain('<main>');
    expect(html).toContain('</main>');
  });

  it('renders successfully with only metadata events', () => {
    const jsonl = lines(
      { type: 'permission-mode' },
      { type: 'file-history-snapshot' },
    );
    const html = renderHtml(jsonl, makeMeta());
    expect(html).toContain('<main>');
  });

  it('does not crash on a tool_use with non-string name or non-object input', () => {
    const jsonl = lines({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 42, input: 'oops' }],
      },
    });
    expect(() => renderHtml(jsonl, makeMeta())).not.toThrow();
  });
});

describe('renderHtml — footer', () => {
  it('shows turn count and singular/plural correctly', () => {
    const html1 = renderHtml('', makeMeta({ turns: 1 }));
    expect(html1).toContain('1 turn ');

    const html2 = renderHtml('', makeMeta({ turns: 23 }));
    expect(html2).toContain('23 turns ');
  });
});
