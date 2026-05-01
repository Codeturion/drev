# T12: cli/index.ts + cli/ui.ts

**Phase:** C · **Depends on:**, (can land before commands; commands plug in incrementally)
**Architecture refs:** §6 (entry), §17 (style)

## Scope

The CLI's entry point and shared output helpers. Establishes the Commander program shell that every command in T13-T24 will register against.

### `cli/index.ts`

```ts
#!/usr/bin/env node  // tsup banner already injects this; do not write it in source
// 1. Build a Commander program
// 2. Register each command from cli/commands/* via its `register(program)` export
// 3. await program.parseAsync(process.argv);
```

Each command file in `cli/commands/<name>.ts` exports:

```ts
import type { Command } from 'commander';
export function register(program: Command): void;
```

Why per-file `register` instead of central wiring: keeps commands self-contained. Adding a new command means adding a file and one line in `cli/index.ts`.

### `cli/ui.ts`

Thin helpers around `chalk` and `ora`:

```ts
function info(msg: string): void;        // green checkmark + msg
function warn(msg: string): void;        // yellow warning sign + msg
function error(msg: string): void;       // red cross + msg, to stderr
function spinner(msg: string): { stop(): void; succeed(s?: string): void; fail(s?: string): void };
function table(rows: Array<Record<string, string>>): string; // for `list` and `search`
function confirm(prompt: string): Promise<boolean>; // y/N reader on stdin
```

## Files

- `src/cli/index.ts`
- `src/cli/ui.ts`
- `src/cli/ui.test.ts` (table rendering, sanitization)

## Acceptance

- `npm run build` produces `dist/cli.js` that:
  - Has shebang (already from tsup banner, verify)
  - Runs `--help` and exits 0
  - Runs `--version` and prints package.json version
- Unknown command exits with helpful error
- `ui.confirm` is testable (inject stdin via dependency injection or by mocking `node:readline`)
- Tests cover: `info`/`warn`/`error` write to correct streams, `table` renders aligned columns

## Out of scope

- Telemetry / analytics, never
- Plugin system for third-party commands, out of v0
- i18n, not in v0
