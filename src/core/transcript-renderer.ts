// Renders a Claude Code session JSONL plus its meta into a self-contained
// HTML transcript. Pure function: no I/O, deterministic for a given input.
//
// Goals:
// - Self-contained: inlined CSS, no JS, no CDN. Open in any browser.
// - Strictly sanitized: every text node is HTML-escaped before insertion.
// - Faithful: tool calls and results show what was actually requested and
//   returned, without inventing summaries or rewording user/assistant prose.
//
// Non-goals for v1: markdown rendering inside messages, dark theme, search.
// Prose is rendered as <pre> so code blocks read fine and whitespace is
// preserved; markdown like **bold** appears literally. Adding a parser later
// is straightforward (replace the renderText helper).

import type { SessionMeta } from './metadata.js';

interface Turn {
  kind: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  isError?: boolean;
  timestamp?: string;
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
}

function parseLines(jsonl: string): unknown[] {
  const out: unknown[] = [];
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Drop unparseable lines silently; fidelity is best-effort.
    }
  }
  return out;
}

function normalize(events: unknown[]): Turn[] {
  const out: Turn[] = [];
  for (const e of events) {
    if (typeof e !== 'object' || e === null) continue;
    const ev = e as Record<string, unknown>;
    const type = ev['type'];
    if (type !== 'user' && type !== 'assistant') continue;

    const message = ev['message'];
    if (!message || typeof message !== 'object') continue;
    const m = message as Record<string, unknown>;
    const role = m['role'];
    const timestamp = ev['timestamp'] as string | undefined;
    const content = m['content'];

    if (role === 'user') {
      if (typeof content === 'string') {
        out.push({ kind: 'user', text: content, timestamp });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'object' || block === null) continue;
          const b = block as Record<string, unknown>;
          if (b['type'] === 'text' && typeof b['text'] === 'string') {
            out.push({ kind: 'user', text: b['text'], timestamp });
          } else if (b['type'] === 'tool_result') {
            const raw = b['content'];
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
            out.push({
              kind: 'tool_result',
              text,
              toolUseId: typeof b['tool_use_id'] === 'string' ? b['tool_use_id'] : undefined,
              isError: b['is_error'] === true,
              timestamp,
            });
          }
        }
      }
    } else if (role === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          out.push({ kind: 'assistant', text: b['text'], timestamp });
        } else if (b['type'] === 'thinking' && typeof b['thinking'] === 'string') {
          // Skip empty signed-only thinking blocks (no visible content).
          if (b['thinking'].trim() !== '') {
            out.push({ kind: 'thinking', text: b['thinking'], timestamp });
          }
        } else if (b['type'] === 'tool_use') {
          out.push({
            kind: 'tool_use',
            toolName: typeof b['name'] === 'string' ? b['name'] : undefined,
            toolInput: b['input'],
            toolUseId: typeof b['id'] === 'string' ? b['id'] : undefined,
            timestamp,
          });
        }
      }
    }
  }
  return out;
}

function summarizeToolInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'object') return String(input);
  // Prefer informative single-field summaries: file_path, command, pattern, query.
  const obj = input as Record<string, unknown>;
  for (const key of ['file_path', 'command', 'pattern', 'query', 'url', 'path']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) {
      return `${key}=${v}`;
    }
  }
  // Fall back to a truncated JSON.
  const json = JSON.stringify(input);
  return json.length > 100 ? `${json.slice(0, 100)}…` : json;
}

function renderTurn(t: Turn): string {
  const text = t.text ?? '';
  switch (t.kind) {
    case 'user':
      return `<section class="turn user"><pre>${escapeHtml(text)}</pre></section>`;
    case 'assistant':
      return `<section class="turn assistant"><pre>${escapeHtml(text)}</pre></section>`;
    case 'thinking':
      return `<details class="turn thinking"><summary>thinking</summary><pre>${escapeHtml(text)}</pre></details>`;
    case 'tool_use': {
      const name = escapeHtml(t.toolName ?? 'tool');
      const summary = escapeHtml(summarizeToolInput(t.toolInput));
      const inputJson = escapeHtml(JSON.stringify(t.toolInput, null, 2) ?? '');
      return `<details class="tool use"><summary><span class="name">${name}</span> <span class="args">${summary}</span></summary><div class="content"><pre>${inputJson}</pre></div></details>`;
    }
    case 'tool_result': {
      const cls = t.isError ? 'tool result error' : 'tool result';
      const label = t.isError ? 'tool error' : 'tool result';
      return `<details class="${cls}"><summary>${escapeHtml(label)}</summary><div class="content"><pre>${escapeHtml(text)}</pre></div></details>`;
    }
  }
}

function renderHeader(meta: SessionMeta): string {
  const parts: string[] = ['<header>'];
  const title = meta.title ?? meta.name ?? meta.id.slice(0, 8);
  parts.push(`<h1>${escapeHtml(title)}</h1>`);

  const sub: string[] = [];
  if (meta.user) sub.push(`shared by <strong>${escapeHtml(meta.user)}</strong>`);
  if (meta.project) sub.push(`project <code>${escapeHtml(meta.project)}</code>`);
  else if (meta.project_root) sub.push(`in <code>${escapeHtml(meta.project_root)}</code>`);
  if (meta.shared_at) sub.push(escapeHtml(meta.shared_at));
  if (sub.length > 0) parts.push(`<p class="meta">${sub.join(' · ')}</p>`);

  if (meta.summary) parts.push(`<p class="summary">${escapeHtml(meta.summary)}</p>`);

  if (meta.commit_sha) {
    parts.push(`<p class="commit">commit <code>${escapeHtml(meta.commit_sha.slice(0, 12))}</code></p>`);
  }

  const totalRedactions = (meta.redactions ?? []).reduce((a, r) => a + r.count, 0);
  if (totalRedactions > 0) {
    parts.push(`<p class="redactions">${totalRedactions} secret(s) redacted before share</p>`);
  }

  parts.push('</header>');
  return parts.join('\n');
}

const STYLE = `<style>
:root { --fg:#1a1a1a; --bg:#fff; --muted:#666; --accent:#0a64c8; --tool-bg:#f7f7f7; --tool-border:#e0e0e0; --user-bg:#f7f9fc; --error:#b30000; --error-bg:#fff4f4; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 880px; margin: 2rem auto; padding: 0 1rem; color: var(--fg); background: var(--bg); line-height: 1.55; }
header { border-bottom: 1px solid #eee; padding-bottom: 1rem; margin-bottom: 1.5rem; }
header h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
header p { margin: 0.25rem 0; color: var(--muted); font-size: 0.95rem; }
header strong { color: var(--fg); font-weight: 600; }
header code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
.summary { font-style: italic; }
.turn { margin: 1.25rem 0; }
.turn.user { padding: 0.75rem 1rem; background: var(--user-bg); border-left: 3px solid var(--accent); border-radius: 4px; }
.turn.assistant { padding: 0.5rem 0; }
.turn.thinking { padding: 0.25rem 0.5rem; background: #fafafa; border: 1px dashed #ddd; border-radius: 4px; font-size: 0.9rem; }
.turn.thinking summary { cursor: pointer; color: var(--muted); font-style: italic; user-select: none; }
.tool { margin: 0.5rem 0; padding: 0.4rem 0.75rem; background: var(--tool-bg); border: 1px solid var(--tool-border); border-radius: 4px; font-size: 0.9rem; }
.tool summary { cursor: pointer; user-select: none; font-family: ui-monospace, monospace; }
.tool summary .name { font-weight: 600; color: var(--accent); }
.tool summary .args { color: var(--muted); margin-left: 0.5rem; }
.tool .content pre { margin: 0.5rem 0 0; max-height: 600px; overflow: auto; background: #fff; border: 1px solid #eee; border-radius: 3px; padding: 0.5rem; }
.tool.error { border-color: var(--error); background: var(--error-bg); }
.tool.error summary { color: var(--error); }
pre { white-space: pre-wrap; word-wrap: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9rem; margin: 0; }
.turn.user pre, .turn.assistant pre { font-family: inherit; font-size: 1rem; }
footer { margin: 3rem 0 1rem; padding-top: 1rem; border-top: 1px solid #eee; color: var(--muted); font-size: 0.85rem; text-align: center; }
</style>`;

function renderFooter(meta: SessionMeta): string {
  const turns = typeof meta.turns === 'number' ? meta.turns : 0;
  return `<footer>${turns} turn${turns === 1 ? '' : 's'} · rendered by drev</footer>`;
}

export function renderHtml(jsonl: string, meta: SessionMeta): string {
  const events = parseLines(jsonl);
  const turns = normalize(events);
  const title = meta.title ?? meta.name ?? meta.id.slice(0, 8);
  const body = turns.map(renderTurn).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · drev</title>
${STYLE}
</head>
<body>
${renderHeader(meta)}
<main>
${body}
</main>
${renderFooter(meta)}
</body>
</html>`;
}
